(function(){
'use strict';

var DAYS=['Monday','Tuesday','Wednesday','Thursday','Friday','Saturday','Sunday'];
var SHORT=['Mon','Tue','Wed','Thu','Fri','Sat','Sun'];
var MONTHS=['Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec'];
var START=7*60, END=22*60, STEP=15;
var ATT={ontime:'On time',late:'Late',noshow:'No-show'};

function $(s,r){return (r||document).querySelector(s);}
function pad(n){return String(n).padStart(2,'0');}
function iso(d){return d.getFullYear()+'-'+pad(d.getMonth()+1)+'-'+pad(d.getDate());}
function parseISO(s){var p=s.split('-').map(Number);return new Date(p[0],p[1]-1,p[2]);}
function addDays(d,n){var x=new Date(d.getFullYear(),d.getMonth(),d.getDate());x.setDate(x.getDate()+n);return x;}
function mondayOf(d){var x=new Date(d.getFullYear(),d.getMonth(),d.getDate());x.setDate(x.getDate()-((x.getDay()+6)%7));return x;}
function fmtT(m){return pad(Math.floor(m/60))+':'+pad(m%60);}
function dayIdx(s){return (parseISO(s).getDay()+6)%7;}
function dayName(s){return DAYS[dayIdx(s)];}
function fmtDate(s){var d=parseISO(s);return SHORT[dayIdx(s)]+' '+d.getDate()+' '+MONTHS[d.getMonth()];}
function todayISO(){return iso(zonedNow());}
function nowMin(){var d=zonedNow();return d.getHours()*60+d.getMinutes();}
function floorStep(m){return Math.floor(m/STEP)*STEP;}
function isPast(date,start){var t=todayISO();if(date<t)return true;if(date>t)return false;return start<floorStep(nowMin());}
function overlaps(a,b){return a.date===b.date&&a.start<b.end&&b.start<a.end;}
function hoursOf(b){return +((b.end-b.start)/60).toFixed(2);}
function byTime(a,b){return a.date<b.date?-1:a.date>b.date?1:a.start-b.start;}

function h(tag,props){
  var el=document.createElement(tag);
  if(props){Object.keys(props).forEach(function(k){
    var v=props[k];
    if(v===null||v===undefined||v===false)return;
    if(k==='class')el.className=v;
    else if(k==='text')el.textContent=v;
    else if(k==='style')el.style.cssText=v;
    else if(k.slice(0,2)==='on')el.addEventListener(k.slice(2),v);
    else if(k==='value')el.value=v;
    else if(k==='checked')el.checked=!!v;
    else if(k==='disabled')el.disabled=!!v;
    else el.setAttribute(k,v===true?'':String(v));
  });}
  put(el,Array.prototype.slice.call(arguments,2));
  return el;
}
function put(el,kids){
  kids.forEach(function(kid){
    if(Array.isArray(kid))put(el,kid);
    else if(kid===null||kid===undefined||kid===false)return;
    else el.append(kid.nodeType?kid:document.createTextNode(String(kid)));
  });
}
function lsGet(k,d){try{var v=localStorage.getItem(k);return v===null?d:JSON.parse(v);}catch(e){return d;}}
function lsSet(k,v){try{localStorage.setItem(k,JSON.stringify(v));}catch(e){}}
function sleep(ms){return new Promise(function(r){setTimeout(r,ms);});}


var CFG=window.APP_CONFIG||{};
var TZ=CFG.TIMEZONE||'Europe/Warsaw';
var tzFmt=null;
try{tzFmt=new Intl.DateTimeFormat('en-US',{timeZone:TZ,year:'numeric',month:'2-digit',day:'2-digit',hour:'2-digit',minute:'2-digit',second:'2-digit',hourCycle:'h23'});}catch(e){}
/* A Date whose local fields show the wall clock in the school's time zone. */
function zonedNow(){
  if(!tzFmt)return new Date();
  var p={};tzFmt.formatToParts(new Date()).forEach(function(x){p[x.type]=x.value;});
  return new Date(+p.year,+p.month-1,+p.day,+p.hour,+p.minute,+p.second);
}

var state={
  me:{email:'',name:''}, isAdmin:false,
  bookings:[], people:[], ready:false, status:'loading', loadTime:Date.now(),
  weekStart:mondayOf(zonedNow()), selDay:(zonedNow().getDay()+6)%7,
  hideEmpty:false, tab:'timetable', narrow:false
};
var sb=null;

/* ---------- data ---------- */
function norm(x){
  return {
    id:x.id, name:String(x.name||'Unnamed').slice(0,40), email:String(x.user_email||''),
    date:x.date, start:Number(x.start_min), end:Number(x.end_min),
    status:x.status==='waitlisted'?'waitlisted':'confirmed',
    createdAt:Date.parse(x.created_at)||0, promotedAt:x.promoted_at?Date.parse(x.promoted_at):0,
    teacher:x.teacher||'', attendance:ATT[x.attendance]?x.attendance:'', remark:x.remark||'',
    internship:!!x.internship, entered:!!x.entered
  };
}
function confirmed(){return state.bookings.filter(function(b){return b.status==='confirmed';});}
function waiting(){return state.bookings.filter(function(b){return b.status==='waitlisted';}).sort(function(a,b){return a.createdAt-b.createdAt;});}
function isMine(b){return !!state.me.email&&b.email===state.me.email;}
function waitPos(w){return waiting().filter(function(x){return x.date===w.date&&overlaps(x,w)&&x.createdAt<=w.createdAt;}).length;}
function pendingList(){var t=todayISO();return waiting().filter(function(w){return w.date>=t;});}

async function fetchBookings(){
  var from=iso(addDays(zonedNow(),-120)),out=[],page=1000;
  for(var i=0;i<20;i++){
    var r=await sb.from('bookings').select('*').gte('date',from).order('date').order('start_min').range(i*page,i*page+page-1);
    if(r.error)throw r.error;
    out=out.concat(r.data);
    if(r.data.length<page)break;
  }
  return out.map(norm);
}
async function refresh(){
  try{
    var next=await fetchBookings();
    if(state.ready){
      var prev=new Map(state.bookings.map(function(b){return [b.id,b];}));
      next.forEach(function(b){
        var p=prev.get(b.id);
        if(!p){
          if(b.status==='waitlisted'&&b.createdAt>state.loadTime&&state.isAdmin&&!isMine(b))toast(b.name+' joined the waitlist for '+fmtDate(b.date)+', '+fmtT(b.start)+'.','wait');
        }else if(isMine(b)&&p.status!==b.status){
          if(b.status==='confirmed')toast('Your slot on '+fmtDate(b.date)+', '+fmtT(b.start)+' is now confirmed.','ok');
          else toast('Your booking on '+fmtDate(b.date)+', '+fmtT(b.start)+' was moved to the waitlist by the admin.','wait');
        }
      });
    }
    state.bookings=next;state.ready=true;state.status='ok';
  }catch(e){state.status='error';}
  render();
}
var refreshTimer=null;
function scheduleRefresh(){clearTimeout(refreshTimer);refreshTimer=setTimeout(refresh,250);}

async function createBooking(p){
  var r=await sb.rpc('book_slot',{p_name:p.name,p_date:p.date,p_start:p.start,p_end:p.end});
  if(r.error)throw r.error;
  await refresh();
  return {id:r.data.id,status:r.data.status};
}
async function removeBooking(b){
  var r=await sb.rpc('cancel_booking',{p_id:b.id});
  if(r.error)throw r.error;
  await refresh();
}
async function saveEdit(b,p){
  var r=await sb.from('bookings').update({name:p.name,date:p.date,start_min:p.start,end_min:p.end,status:p.status}).eq('id',b.id);
  if(r.error){
    if(r.error.code==='23P01'){
      await refresh();
      var clash=confirmed().filter(function(x){return x.id!==b.id&&overlaps(x,p);});
      return {conflict:clash};
    }
    throw r.error;
  }
  await refresh();
  return {ok:true};
}
async function swapIn(w){
  var r=await sb.rpc('swap_in',{p_id:w.id});
  if(r.error)throw r.error;
  await refresh();
}
function freeStarts(date,len,excludeId,near){
  var conf=confirmed().filter(function(b){return b.date===date&&b.id!==excludeId;});
  var out=[];
  for(var st=START;st+len<=END;st+=STEP){
    if(isPast(date,st))continue;
    var r={date:date,start:st,end:st+len};
    if(!conf.some(function(c){return overlaps(c,r);}))out.push(st);
  }
  out.sort(function(a,b){return Math.abs(a-near)-Math.abs(b-near);});
  return out;
}
var wq=new Map();
function queueWrite(id,patch){
  var prev=wq.get(id)||Promise.resolve();
  var p=prev.catch(function(){}).then(async function(){var r=await sb.from('bookings').update(patch).eq('id',id);if(r.error)throw r.error;});
  wq.set(id,p);
  p.catch(function(e){toast(errMsg(e),'alert');});
  return p;
}
async function loadPeople(){
  if(!state.isAdmin)return;
  var r=await sb.from('allowed_users').select('*').order('email');
  if(!r.error){state.people=r.data;}
  render();
}
async function addPerson(email,fullName){
  var r=await sb.from('allowed_users').insert({email:email.trim().toLowerCase(),full_name:fullName.trim().slice(0,80),added_by:state.me.email});
  if(r.error)throw r.error;
  await loadPeople();
}
async function removePerson(email){
  var r=await sb.from('allowed_users').delete().eq('email',email);
  if(r.error)throw r.error;
  await loadPeople();
}
function errMsg(e){
  var m=(e&&e.message)||'';
  if(/not_allowed/.test(m)||(e&&e.code==='42501'))return 'You do not have permission to do that.';
  if(/in_the_past/.test(m))return 'That time has already started. Pick a later one.';
  if(/already_yours/.test(m))return 'You already have a booking that overlaps this time.';
  if(/bad_time/.test(m))return 'Bookings run from 07:00 to 22:00 in 15-minute steps.';
  if(/name_required/.test(m))return 'Enter a name so the admin knows who the slot is for.';
  if(e&&e.code==='23P01')return 'That time was just taken by someone else.';
  if(e&&e.code==='23505')return 'That email is already on the list.';
  if(e&&e.code==='23514')return 'Check the values you entered.';
  if(/Failed to fetch|NetworkError|network/i.test(m))return 'No connection. Check your internet and try again.';
  return m||'Something went wrong. Try again.';
}

/* ---------- small UI helpers ---------- */
function toast(msg,kind){
  var host=$('#toasts');
  while(host.children.length>=3)host.firstChild.remove();
  var t=h('div',{class:'toast'+(kind?' '+kind:''),text:msg});
  host.append(t);
  setTimeout(function(){t.remove();},kind==='alert'?8000:6000);
}
function btn(label,onclick,cls){return h('button',{type:'button',class:'btn small'+(cls?' '+cls:''),text:label,onclick:onclick});}
function twoStep(label,armed,action,cls){
  var t=null;
  var b=h('button',{type:'button',class:'btn small warn'+(cls?' '+cls:''),text:label});
  function reset(){t=null;b.textContent=label;b.classList.remove('danger-armed');}
  b.addEventListener('click',async function(){
    if(!t){b.textContent=armed;b.classList.add('danger-armed');t=setTimeout(reset,4000);return;}
    clearTimeout(t);t=null;b.disabled=true;
    try{await action();}catch(e){toast(errMsg(e),'alert');b.disabled=false;reset();}
  });
  return b;
}
function runAction(b,fn,okMsg){
  b.disabled=true;
  return fn().then(function(r){if(okMsg)toast(okMsg,'ok');return r;}).catch(function(e){toast(errMsg(e),'alert');b.disabled=false;});
}
function openDlg(d){if(d.showModal)d.showModal();else d.setAttribute('open','');}
function closeDlg(d){if(d.close)d.close();else d.removeAttribute('open');}
function opt(v,label,sel){var o=h('option',{value:String(v),text:label});if(String(sel)===String(v))o.selected=true;return o;}
function timeSelect(id,min,max,sel){
  var s=h('select',{id:id});
  for(var m=min;m<=max;m+=STEP)s.append(opt(m,fmtT(m),sel));
  s.value=String(sel);
  return s;
}
function field(label,id,control){return h('div',{class:'field'},h('label',{for:id,text:label}),control);}

/* ---------- rendering ---------- */
var tabEls={};
var TABS=[{id:'timetable',label:'Timetable'},{id:'mine',label:'My bookings'},{id:'attention',label:'Needs attention',admin:true},{id:'log',label:'Session log',admin:true},{id:'people',label:'People',admin:true}];
function buildTabs(){
  var host=$('#tabs');
  TABS.forEach(function(t){
    var count=h('span',{class:'count',hidden:true});
    var b=h('button',{type:'button',class:'tab',role:'tab',id:'tab-'+t.id,'aria-controls':'p-'+t.id,onclick:function(){state.tab=t.id;render();}},h('span',{text:t.label}),count);
    tabEls[t.id]={btn:b,count:count,admin:!!t.admin};
    host.append(b);
  });
}
function renderTabs(){
  var t=todayISO();
  var mineUp=state.bookings.filter(function(b){return isMine(b)&&b.date>=t;}).length;
  var pend=pendingList().length;
  TABS.forEach(function(d){
    var e=tabEls[d.id];
    e.btn.hidden=e.admin&&!state.isAdmin;
    e.btn.setAttribute('aria-selected',String(state.tab===d.id));
    e.btn.tabIndex=state.tab===d.id?0:-1;
  });
  var m=tabEls.mine.count;m.textContent=String(mineUp);m.hidden=!mineUp;
  var a=tabEls.attention.count;a.textContent=String(pend);a.hidden=!pend;a.className='count'+(pend?' alert':'');
}
function renderWho(){
  var w=$('#who');w.textContent='';
  w.append(h('span',{},'Signed in as ',h('strong',{text:state.me.name||state.me.email})));
  if(state.isAdmin)w.append(h('span',{class:'chip mine',text:'Admin'}));
  w.append(btn('Sign out',function(){sb.auth.signOut();},'ghost'));
}
function renderBanners(){
  var host=$('#banners');host.textContent='';
  if(state.status==='error')host.append(h('div',{class:'banner alert'},h('span',{text:'Could not reach the database. Showing the last data loaded.'}),btn('Retry',refresh)));
  else if(state.status==='loading')host.append(h('div',{class:'banner info'},h('span',{text:'Loading bookings...'})));
  var pend=pendingList().length;
  if(state.isAdmin&&pend&&state.tab!=='attention'){
    host.append(h('div',{class:'banner alert'},
      h('span',{},h('strong',{text:pend+(pend===1?' person is':' people are')}),' waiting for a slot that was already taken.'),
      btn('Review',function(){state.tab='attention';render();})));
  }
}
function renderControls(){
  $('#ttc').hidden=state.tab!=='timetable';
  var a=state.weekStart,z=addDays(a,6);
  $('#weeklabel').textContent=a.getDate()+' '+MONTHS[a.getMonth()]+' – '+z.getDate()+' '+MONTHS[z.getMonth()]+' '+z.getFullYear();
  $('#hide-empty').checked=state.hideEmpty;
  $('#book').disabled=!state.ready;
}
function renderDayStrip(){
  var strip=$('#daystrip');strip.textContent='';
  strip.hidden=!state.narrow;
  if(!state.narrow)return;
  var t=todayISO(),conf=confirmed();
  for(var i=0;i<7;i++){(function(i){
    var d=addDays(state.weekStart,i),s=iso(d);
    strip.append(h('button',{type:'button',class:'dsb'+(i===state.selDay?' on':'')+(s===t?' today':''),'aria-pressed':String(i===state.selDay),'aria-label':DAYS[i]+' '+d.getDate()+' '+MONTHS[d.getMonth()],onclick:function(){state.selDay=i;render();}},
      h('span',{class:'dsb-n',text:SHORT[i]}),h('span',{class:'dsb-d mono',text:String(d.getDate())}),
      conf.some(function(b){return b.date===s;})?h('span',{class:'dsb-dot'}):null));
  })(i);}
}
function renderTimetable(){
  renderDayStrip();
  var host=$('#grid');
  var fk=document.activeElement&&document.activeElement.dataset?document.activeElement.dataset.key:null;
  host.textContent='';
  var idxs=state.narrow?[state.selDay]:[0,1,2,3,4,5,6];
  var weekDates=[0,1,2,3,4,5,6].map(function(i){return iso(addDays(state.weekStart,i));});
  var dates=idxs.map(function(i){return weekDates[i];});
  var today=todayISO();
  var conf=confirmed();
  var lo=START,hi=END;
  if(state.hideEmpty){
    var inWeek=conf.filter(function(b){return weekDates.indexOf(b.date)>=0;});
    if(inWeek.length){
      lo=Math.max(START,Math.min.apply(null,inWeek.map(function(b){return b.start;})));
      hi=Math.min(END,Math.max.apply(null,inWeek.map(function(b){return b.end;})));
      if(hi<=lo){lo=START;hi=END;}
    }
  }
  var nRows=Math.max(1,Math.round((hi-lo)/STEP));
  var grid=h('div',{class:'tt',style:'grid-template-columns:var(--tcol) var(--tcol) repeat('+dates.length+',minmax(0,1fr));grid-template-rows:auto repeat('+nRows+',var(--row))'});
  grid.append(h('div',{class:'th',style:'grid-row:1;grid-column:1',text:'From'}),h('div',{class:'th',style:'grid-row:1;grid-column:2',text:'To'}));
  idxs.forEach(function(di,ci){
    var d=addDays(state.weekStart,di);
    grid.append(h('div',{class:'th'+(dates[ci]===today?' is-today':''),style:'grid-row:1;grid-column:'+(ci+3)},
      h('span',{class:'long',text:DAYS[di]}),h('span',{class:'short',text:SHORT[di]}),
      h('span',{class:'th-date',text:d.getDate()+' '+MONTHS[d.getMonth()]})));
  });
  var covered=dates.map(function(date){
    var set=new Set();
    conf.filter(function(b){return b.date===date;}).forEach(function(b){
      var r0=Math.round((Math.max(b.start,lo)-lo)/STEP),span=Math.round((Math.min(b.end,hi)-Math.max(b.start,lo))/STEP);
      for(var k=0;k<span;k++)set.add(r0+k);
    });
    return set;
  });
  for(var i=0;i<nRows;i++){
    var t=lo+i*STEP,hr=t%60===0;
    grid.append(
      h('div',{class:'tc'+(hr?' hr':''),style:'grid-row:'+(i+2)+';grid-column:1',text:fmtT(t)}),
      h('div',{class:'tc t2'+(hr?' hr':''),style:'grid-row:'+(i+2)+';grid-column:2',text:fmtT(t+STEP)}));
    dates.forEach(function(date,ci){
      if(covered[ci].has(i))return;
      var past=isPast(date,t);
      grid.append(h('button',{type:'button',class:'cell'+(hr?' hr':'')+(date===today?' is-today':''),
        style:'grid-row:'+(i+2)+';grid-column:'+(ci+3),'data-key':date+'_'+t,disabled:past,
        'aria-label':'Book '+fmtDate(date)+' '+fmtT(t)+' to '+fmtT(t+STEP),
        onclick:function(){openBook({date:date,start:t});}}));
    });
  }
  var wl=waiting();
  dates.forEach(function(date,ci){
    conf.filter(function(b){return b.date===date;}).forEach(function(b){
      var s=Math.max(b.start,lo),e=Math.min(b.end,hi);
      if(e<=s)return;
      var r0=Math.round((s-lo)/STEP),span=Math.max(1,Math.round((e-s)/STEP));
      var mine=isMine(b);
      var nw=wl.filter(function(w){return overlaps(w,b);}).length;
      grid.append(h('button',{type:'button',class:'blk'+(mine?' mine':''),'data-key':'b:'+b.id,
        style:'grid-column:'+(ci+3)+';grid-row:'+(r0+2)+' / span '+span,
        'aria-label':b.name+', '+fmtDate(b.date)+' '+fmtT(b.start)+' to '+fmtT(b.end)+(mine?', yours':'')+(nw?', '+nw+' waiting':''),
        onclick:function(){openDetail(b.id);}},
        h('span',{class:'bn',text:b.name}),
        span>=2?h('span',{class:'bt',text:fmtT(b.start)+'–'+fmtT(b.end)}):null,
        nw?h('span',{class:'wb',text:'+'+nw}):null));
    });
  });
  host.append(grid);
  if(fk){var again=host.querySelector('[data-key="'+fk+'"]');if(again)again.focus();}
}
function bookingRow(b){
  var mine=isMine(b);
  var row=h('li',{class:'brow'});
  row.append(h('div',{class:'when mono'},h('span',{class:'d',text:fmtDate(b.date)}),h('span',{text:fmtT(b.start)+'–'+fmtT(b.end)})));
  var what=h('div',{class:'what'},h('strong',{text:b.name}));
  if(b.status==='waitlisted')what.append(h('span',{class:'chip wait',text:'Waitlist #'+waitPos(b)}),h('span',{class:'foot',style:'margin:0',text:'You are confirmed automatically if the slot frees up.'}));
  else{what.append(h('span',{class:'chip ok',text:'Confirmed'}));if(b.promotedAt)what.append(h('span',{class:'chip plain',text:'Moved up from the waitlist'}));}
  row.append(what);
  var past=b.date<todayISO();
  if(!past){
    row.append(twoStep(b.status==='waitlisted'?'Leave waitlist':'Cancel booking','Tap again to confirm',function(){return removeBooking(b);}));
  }
  return row;
}
function renderMine(){
  var host=$('#mine-host');host.textContent='';
  var t=todayISO();
  var all=state.bookings.filter(isMine).sort(byTime);
  var up=all.filter(function(b){return b.date>=t;});
  var old=all.filter(function(b){return b.date<t;}).reverse().slice(0,8);
  if(!up.length){
    host.append(h('p',{class:'empty',text:'You have nothing booked. Tap a free cell in the timetable, or press Book a slot.'}));
  }else{
    host.append(h('h2',{class:'list-title',text:'Coming up'}),h('ul',{class:'list'},up.map(bookingRow)));
  }
  if(old.length)host.append(h('h2',{class:'list-title',text:'Earlier'}),h('ul',{class:'list'},old.map(bookingRow)));
}
function renderAttention(){
  var host=$('#att-host');host.textContent='';
  var list=pendingList();
  if(!list.length){
    host.style.display='block';
    host.append(h('p',{class:'empty',text:'Nothing to fix. When someone books a slot that is already taken, they show up here.'}));
    return;
  }
  host.style.display='';
  list.forEach(function(w){
    var clash=confirmed().filter(function(c){return overlaps(c,w);});
    var len=w.end-w.start;
    var card=h('article',{class:'card'});
    card.append(h('div',{class:'card-head'},h('strong',{text:w.name}),h('span',{class:'chip wait',text:'Waitlist #'+waitPos(w)})));
    card.append(h('p',{class:'when mono',text:fmtDate(w.date)+'  '+fmtT(w.start)+'–'+fmtT(w.end)}));
    if(clash.length){
      var why=h('p',{class:'why'},'Taken by ');
      clash.forEach(function(c,i){why.append((i?', ':''),h('strong',{text:c.name}),' ('+fmtT(c.start)+'–'+fmtT(c.end)+')');});
      card.append(why);
    }else card.append(h('p',{class:'why',text:'This time is free now.'}));
    var acts=h('div',{class:'acts'});
    if(!clash.length){
      var cb=btn('Confirm',function(){return runAction(cb,function(){return saveEdit(w,{name:w.name,date:w.date,start:w.start,end:w.end,status:'confirmed'});},'Confirmed '+w.name+'.');},'primary');
      acts.append(cb);
    }else{
      var alts=freeStarts(w.date,len,w.id,w.start).slice(0,3);
      alts.forEach(function(st){
        var ab=btn('Move to '+fmtT(st)+'–'+fmtT(st+len),function(){
          return runAction(ab,function(){return saveEdit(w,{name:w.name,date:w.date,start:st,end:st+len,status:'confirmed'});},'Moved '+w.name+' to '+fmtT(st)+'.');
        });
        acts.append(ab);
      });
      var who=clash.length===1?clash[0].name:clash.length+' people';
      acts.append(twoStep('Swap in, '+who+' to waitlist','Tap again to swap',function(){return swapIn(w);}));
    }
    acts.append(btn('Edit',function(){openDetail(w.id);}));
    acts.append(twoStep('Remove','Tap again to remove',function(){return removeBooking(w);}));
    card.append(acts);
    host.append(card);
  });
}
function logRows(){
  var t=todayISO(),range=$('#log-range').value;
  var from=iso(addDays(zonedNow(),-Number(range)));
  return confirmed().filter(function(b){return b.date<=t&&b.date>=from;}).sort(byTime);
}
var logDirty=false;
function renderLog(){
  if(!state.isAdmin||state.tab!=='log')return;
  var host=$('#log-host');
  var ae=document.activeElement;
  if(ae&&host.contains(ae)&&/^(INPUT|SELECT)$/.test(ae.tagName)){logDirty=true;return;}
  host.textContent='';
  var rows=logRows();
  var total=rows.reduce(function(s,b){return s+hoursOf(b);},0);
  $('#log-total').textContent='Total '+(+total.toFixed(2))+' h · '+rows.length+(rows.length===1?' session':' sessions');
  $('#log-export').disabled=!rows.length;
  if(!rows.length){host.append(h('p',{class:'empty',style:'border:0',text:'No past sessions in this range yet.'}));return;}
  var head=['Teacher','Date','Day','Hours','Qty of h','Name and forename','Attendance','Remarks','Internship','Entered'];
  var table=h('table',{},h('thead',{},h('tr',{},head.map(function(x){return h('th',{text:x});}))));
  var tb=h('tbody');
  rows.forEach(function(b){
    var tIn=h('input',{type:'text',id:'lg-t-'+b.id,value:b.teacher,maxlength:'60','aria-label':'Teacher for '+b.name+' on '+b.date,onchange:function(e){queueWrite(b.id,{teacher:e.target.value.trim().slice(0,60)});}});
    var aSel=h('select',{id:'lg-a-'+b.id,'aria-label':'Attendance for '+b.name+' on '+b.date,onchange:function(e){queueWrite(b.id,{attendance:e.target.value});}},
      opt('','—',b.attendance),opt('ontime',ATT.ontime,b.attendance),opt('late',ATT.late,b.attendance),opt('noshow','No-show (did not cancel)',b.attendance));
    var rIn=h('input',{type:'text',id:'lg-r-'+b.id,value:b.remark,maxlength:'200','aria-label':'Remarks for '+b.name+' on '+b.date,onchange:function(e){queueWrite(b.id,{remark:e.target.value.trim().slice(0,200)});}});
    var iCb=h('input',{type:'checkbox',id:'lg-i-'+b.id,checked:b.internship,'aria-label':'Internship, '+b.name+' on '+b.date,onchange:function(e){queueWrite(b.id,{internship:e.target.checked});}});
    var eCb=h('input',{type:'checkbox',id:'lg-e-'+b.id,checked:b.entered,'aria-label':'Entered, '+b.name+' on '+b.date,onchange:function(e){queueWrite(b.id,{entered:e.target.checked});}});
    tb.append(h('tr',{},
      h('td',{},tIn),
      h('td',{class:'mono',text:b.date}),
      h('td',{text:dayName(b.date)}),
      h('td',{class:'mono',text:fmtT(b.start)+'–'+fmtT(b.end)}),
      h('td',{class:'mono',text:String(hoursOf(b))}),
      h('td',{text:b.name}),
      h('td',{},aSel),
      h('td',{},rIn),
      h('td',{class:'c'},iCb),
      h('td',{class:'c'},eCb)));
  });
  table.append(tb);
  host.append(table);
}
function exportCsv(){
  var rows=logRows();
  function esc(v){var s=String(v);if(/^[=+\-@\t\r]/.test(s))s="'"+s;return '"'+s.replace(/"/g,'""')+'"';}
  var head=['Teacher','Date','Day','From','To','Quantity of hours','Name and forename','Attendance','Remarks','Internship','Entered'];
  var lines=rows.map(function(b){
    return [b.teacher,b.date,dayName(b.date),fmtT(b.start),fmtT(b.end),hoursOf(b),b.name,b.attendance?ATT[b.attendance]:'',b.remark,b.internship?'Yes':'',b.entered?'Yes':''].map(esc).join(';');
  });
  var data='\ufeffsep=;\n'+[head.map(esc).join(';')].concat(lines).join('\n');
  var blob=new Blob([data],{type:'text/csv;charset=utf-8'});
  var a=h('a',{href:URL.createObjectURL(blob),download:'class-log-'+todayISO()+'.csv'});
  document.body.append(a);a.click();a.remove();
  setTimeout(function(){URL.revokeObjectURL(a.href);},2000);
  toast('Log saved.','ok');
}

function render(){
  if(tabEls.attention&&tabEls.attention.admin&&!state.isAdmin&&(state.tab==='attention'||state.tab==='log'||state.tab==='people'))state.tab='timetable';
  renderWho();renderBanners();renderTabs();renderControls();
  ['timetable','mine','attention','log','people'].forEach(function(id){$('#p-'+id).hidden=state.tab!==id;});
  if(state.tab==='timetable')renderTimetable();
  else if(state.tab==='mine')renderMine();
  else if(state.tab==='attention')renderAttention();
  else if(state.tab==='people')renderPeople();
  else renderLog();
}

/* ---------- booking dialog ---------- */
var bkDef=null;
function refillTimes(){
  var date=$('#bk-date').value;
  var from=$('#bk-from'),to=$('#bk-to');
  var curFrom=Number(from.value)||START,curTo=Number(to.value)||0;
  from.textContent='';to.textContent='';
  for(var m=START;m<END;m+=STEP){var o=h('option',{value:String(m),text:fmtT(m)});if(isPast(date,m))o.disabled=true;from.append(o);}
  from.value=String(curFrom);
  if(from.selectedOptions[0]&&from.selectedOptions[0].disabled){
    var first=Array.prototype.find.call(from.options,function(o){return !o.disabled;});
    if(first)from.value=first.value;
  }
  var f=Number(from.value);
  if(curTo<=f)curTo=Math.min(END,f+60);
  for(var e=f+STEP;e<=END;e+=STEP)to.append(h('option',{value:String(e),text:fmtT(e)}));
  to.value=String(Math.min(curTo,END));
  if(to.value!==String(Math.min(curTo,END)))to.value=to.options[to.options.length-1].value;
}
function checkSlot(date,start,end){
  var r={date:date,start:start,end:end};
  if(isPast(date,start))return {kind:'past'};
  if(confirmed().some(function(b){return isMine(b)&&overlaps(b,r);}))return {kind:'dup'};
  var clash=confirmed().filter(function(b){return overlaps(b,r);});
  if(clash.length)return {kind:'taken',clash:clash,ahead:waiting().filter(function(w){return overlaps(w,r);}).length};
  return {kind:'free'};
}
function refreshHint(){
  var date=$('#bk-date').value,s=Number($('#bk-from').value),e=Number($('#bk-to').value);
  var hint=$('#bk-hint'),sub=$('#bk-submit');
  var res=checkSlot(date,s,e);
  hint.className='hint';sub.disabled=false;sub.textContent='Reserve slot';
  if(res.kind==='free'){hint.classList.add('ok');hint.textContent='This time is free. It is yours as soon as you press Reserve.';}
  else if(res.kind==='taken'){
    hint.classList.add('wait');
    hint.textContent='Already taken by '+res.clash.map(function(c){return c.name;}).join(', ')+'. You can join the waitlist'+(res.ahead?' ('+res.ahead+' already waiting)':'')+'. The admin will see it.';
    sub.textContent='Join waitlist';
  }else if(res.kind==='dup'){hint.classList.add('bad');hint.textContent='You already have a booking that overlaps this time.';sub.disabled=true;}
  else{hint.classList.add('bad');hint.textContent='That time has already started. Pick a later one.';sub.disabled=true;}
}
function openBook(pref){
  pref=pref||{};
  var dsel=$('#bk-date');dsel.textContent='';
  var t0=zonedNow(),want=pref.date;
  var def=want||(nowMin()>END-STEP*2?iso(addDays(t0,1)):todayISO());
  var seen=false;
  for(var i=0;i<42;i++){
    var d=addDays(t0,i),s=iso(d);
    if(s===def)seen=true;
    dsel.append(h('option',{value:s,text:fmtDate(s)+(i===0?' (today)':'')}));
  }
  if(!seen)dsel.prepend(h('option',{value:def,text:fmtDate(def)}));
  dsel.value=def;
  var start=pref.start!==undefined?pref.start:Math.max(9*60,def===todayISO()?floorStep(nowMin())+STEP:0);
  start=Math.min(Math.max(start,START),END-STEP);
  $('#bk-from').textContent='';$('#bk-to').textContent='';
  $('#bk-from').append(h('option',{value:String(start),text:fmtT(start)}));
  refillTimes();
  $('#bk-from').value=String(start);
  if(pref.end!==undefined){
    refillTimes();
    $('#bk-to').value=String(Math.min(pref.end,END));
  }else{
    var f=Number($('#bk-from').value);
    refillToFor(f);
  }
  $('#bk-name').value=lsGet('cs_name','')||state.me.name||'';
  refreshHint();
  openDlg($('#dlg-book'));
  setTimeout(function(){var n=$('#bk-name');if(!n.value)n.focus();},0);
}
function refillToFor(f){
  var to=$('#bk-to');to.textContent='';
  for(var e=f+STEP;e<=END;e+=STEP)to.append(h('option',{value:String(e),text:fmtT(e)}));
  to.value=String(Math.min(END,f+60));
}
async function submitBook(ev){
  ev.preventDefault();
  var name=$('#bk-name').value.trim().slice(0,40);
  var date=$('#bk-date').value,s=Number($('#bk-from').value),e=Number($('#bk-to').value);
  if(!name){$('#bk-name').focus();var hint=$('#bk-hint');hint.className='hint bad';hint.textContent='Enter your name so the admin knows who the slot is for.';return;}
  if(!(e>s)||isPast(date,s))return;
  var sub=$('#bk-submit');sub.disabled=true;
  try{
    var r=await createBooking({name:name,date:date,start:s,end:e});
    lsSet('cs_name',name);
    state.weekStart=mondayOf(parseISO(date));state.selDay=dayIdx(date);state.tab='timetable';
    closeDlg($('#dlg-book'));
    if(r.status==='confirmed')toast('Reserved '+fmtDate(date)+', '+fmtT(s)+'–'+fmtT(e)+'.','ok');
    else toast('That time was taken, so you are on the waitlist. The admin will see it under Needs attention.','wait');
    render();
  }catch(err){toast(errMsg(err),'alert');}
  sub.disabled=false;
}

/* ---------- detail dialog ---------- */
function openDetail(id){
  var b=state.bookings.find(function(x){return x.id===id;});
  if(!b)return;
  var body=$('#dt-body');body.textContent='';
  var mine=isMine(b);
  $('#dt-title').textContent=state.isAdmin?'Edit booking':'Booking';
  var statusChip=b.status==='waitlisted'?h('span',{class:'chip wait',text:'Waitlist #'+waitPos(b)}):h('span',{class:'chip ok',text:'Confirmed'});
  if(state.isAdmin){
    var msg=h('div',{id:'dt-msg',role:'status'});
    var nameIn=h('input',{id:'dt-name',type:'text',maxlength:'40',value:b.name});
    var dateIn=h('input',{id:'dt-date',type:'date',value:b.date});
    var fromS=timeSelect('dt-from',START,END-STEP,b.start);
    var toS=timeSelect('dt-to',START+STEP,END,b.end);
    var stS=h('select',{id:'dt-status'},opt('confirmed','Confirmed',b.status),opt('waitlisted','Waitlisted',b.status));
    stS.value=b.status;
    body.append(
      field('Name and forename','dt-name',nameIn),
      field('Day','dt-date',dateIn),
      h('div',{class:'two'},field('From','dt-from',fromS),field('To','dt-to',toS)),
      field('Status','dt-status',stS),
      msg);
    function collect(status){
      var n=nameIn.value.trim().slice(0,40),d=dateIn.value,s=Number(fromS.value),e=Number(toS.value);
      if(!n||!/^\d{4}-\d{2}-\d{2}$/.test(d)){msg.className='hint bad';msg.textContent='Enter a name and a day.';return null;}
      if(!(e>s)){msg.className='hint bad';msg.textContent='The end time must be after the start time.';return null;}
      return {name:n,date:d,start:s,end:e,status:status};
    }
    function doSave(status){
      var p=collect(status);if(!p)return Promise.resolve();
      saveBtn.disabled=true;
      return saveEdit(b,p).then(function(res){
        if(res.conflict){
          msg.className='hint wait';msg.textContent='Overlaps with '+res.conflict.map(function(c){return c.name+' ('+fmtT(c.start)+'–'+fmtT(c.end)+')';}).join(', ')+'. ';
          msg.append(btn('Save as waitlisted instead',function(){doSave('waitlisted');}));
          saveBtn.disabled=false;
        }else{closeDlg($('#dlg-detail'));toast('Saved.','ok');}
      }).catch(function(e){toast(errMsg(e),'alert');saveBtn.disabled=false;});
    }
    var saveBtn=h('button',{type:'button',class:'btn primary',text:'Save changes',onclick:function(){doSave(stS.value);}});
    body.append(h('div',{class:'dlg-actions'},
      twoStep('Delete booking','Tap again to delete',function(){return removeBooking(b).then(function(){closeDlg($('#dlg-detail'));toast('Booking deleted.','ok');});}),
      saveBtn));
  }else{
    body.append(h('dl',{class:'kv'},
      h('dt',{text:'Name'}),h('dd',{text:b.name}),
      h('dt',{text:'Day'}),h('dd',{text:dayName(b.date)+' '+fmtDate(b.date)}),
      h('dt',{text:'Time'}),h('dd',{class:'mono',text:fmtT(b.start)+'–'+fmtT(b.end)}),
      h('dt',{text:'Status'}),h('dd',{},statusChip,mine?h('span',{class:'chip mine',style:'margin-left:6px',text:'Yours'}):null)));
    var acts=h('div',{class:'dlg-actions'});
    if(mine&&b.date>=todayISO()){
      acts.append(twoStep(b.status==='waitlisted'?'Leave waitlist':'Cancel my booking','Tap again to confirm',function(){return removeBooking(b).then(function(){closeDlg($('#dlg-detail'));toast('Cancelled.','ok');});}));
    }else if(!mine&&b.status==='confirmed'&&!isPast(b.date,b.start)){
      acts.append(h('button',{type:'button',class:'btn primary',text:'Join waitlist for this time',onclick:function(){closeDlg($('#dlg-detail'));openBook({date:b.date,start:b.start,end:b.end});}}));
    }
    body.append(acts);
  }
  openDlg($('#dlg-detail'));
}

/* ---------- wiring ---------- */
function wire(){
  buildTabs();
  $('#prev').addEventListener('click',function(){state.weekStart=addDays(state.weekStart,-7);render();});
  $('#next').addEventListener('click',function(){state.weekStart=addDays(state.weekStart,7);render();});
  $('#today').addEventListener('click',function(){state.weekStart=mondayOf(zonedNow());state.selDay=(zonedNow().getDay()+6)%7;render();});
  $('#hide-empty').addEventListener('change',function(e){state.hideEmpty=e.target.checked;lsSet('cs_hide',state.hideEmpty);render();});
  $('#book').addEventListener('click',function(){openBook({});});
  $('#bk-close').addEventListener('click',function(){closeDlg($('#dlg-book'));});
  $('#bk-cancel').addEventListener('click',function(){closeDlg($('#dlg-book'));});
  $('#dt-close').addEventListener('click',function(){closeDlg($('#dlg-detail'));});
  ['dlg-book','dlg-detail'].forEach(function(id){var d=$('#'+id);d.addEventListener('click',function(e){if(e.target===d)closeDlg(d);});});
  $('#bk-form').addEventListener('submit',submitBook);
  $('#bk-date').addEventListener('change',function(){refillTimes();refreshHint();});
  $('#bk-from').addEventListener('change',function(){refillToFor(Number($('#bk-from').value));refreshHint();});
  $('#bk-to').addEventListener('change',refreshHint);
  $('#log-range').addEventListener('change',renderLog);
  $('#log-export').addEventListener('click',exportCsv);
  $('#log-host').addEventListener('focusout',function(){if(logDirty){logDirty=false;setTimeout(renderLog,0);}});
  state.hideEmpty=!!lsGet('cs_hide',false);
  var mq=window.matchMedia?window.matchMedia('(max-width:720px)'):null;
  if(mq){state.narrow=mq.matches;var f=function(e){state.narrow=e.matches;render();};if(mq.addEventListener)mq.addEventListener('change',f);else if(mq.addListener)mq.addListener(f);}
}

/* ---------- people (admins only) ---------- */
function renderPeople(){
  var host=$('#people-list');if(!host)return;
  host.textContent='';
  if(!state.people.length){host.append(h('p',{class:'empty',text:'No one is on the list yet.'}));return;}
  var admins=state.people.filter(function(p){return p.is_admin;}),staff=state.people.filter(function(p){return !p.is_admin;});
  function row(p){
    var r=h('li',{class:'brow'});
    r.append(h('div',{class:'what'},h('strong',{text:p.full_name||p.email}),p.full_name?h('span',{class:'mono foot',style:'margin:0',text:p.email}):null,
      h('span',{class:'chip '+(p.is_admin?'mine':'plain'),text:p.is_admin?'Admin':'Staff'})));
    if(!p.is_admin)r.append(twoStep('Remove','Tap again to remove',function(){return removePerson(p.email).then(function(){toast('Removed '+p.email+'.','ok');});}));
    return r;
  }
  host.append(h('h2',{class:'list-title',text:'Admins ('+admins.length+')'}),h('ul',{class:'list'},admins.map(row)),
    h('h2',{class:'list-title',text:'Staff ('+staff.length+')'}),h('ul',{class:'list'},staff.map(row)));
}
function wirePeople(){
  $('#pp-form').addEventListener('submit',async function(ev){
    ev.preventDefault();
    var em=$('#pp-email').value.trim().toLowerCase(),nm=$('#pp-name').value.trim();
    if(!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(em)){toast('Enter a valid email address.','alert');return;}
    var b=$('#pp-add');b.disabled=true;
    try{await addPerson(em,nm);$('#pp-email').value='';$('#pp-name').value='';toast('Added '+em+'.','ok');}
    catch(e){toast(errMsg(e),'alert');}
    b.disabled=false;
  });
}

/* ---------- sign-in gate ---------- */
var storage={
  pick:function(){try{return lsGet('cs_remember',true)?window.localStorage:window.sessionStorage;}catch(e){return null;}},
  getItem:function(k){
    var s=this.pick(),v=null;
    try{v=s?s.getItem(k):null;if(v===null&&s){v=(s===window.localStorage?window.sessionStorage:window.localStorage).getItem(k);}}catch(e){}
    return v;
  },
  setItem:function(k,v){var s=this.pick();try{if(s)s.setItem(k,v);}catch(e){}},
  removeItem:function(k){try{window.localStorage.removeItem(k);window.sessionStorage.removeItem(k);}catch(e){}}
};
function gate(kind,info){
  var g=$('#gate'),app=$('#app');
  g.textContent='';
  var show=kind!=='app';
  g.hidden=!show;app.hidden=show;
  if(show){['dlg-book','dlg-detail'].forEach(function(id){closeDlg($('#'+id));});}
  if(!show)return;
  var card=h('div',{class:'gate-card'});
  card.append(h('h1',{text:CFG.APP_NAME||'Class slot booking'}));
  if(kind==='login'){
    card.append(h('p',{class:'sub',text:'Sign in with your Google account to see the timetable and book a slot. Only people on the access list can get in.'}));
    var cb=h('input',{type:'checkbox',id:'remember',checked:lsGet('cs_remember',true)});
    card.append(h('label',{class:'check',for:'remember'},cb,' Keep me signed in on this device'));
    var sbtn=h('button',{type:'button',class:'btn primary gbtn',id:'signin',text:'Sign in with Google'});
    sbtn.addEventListener('click',async function(){
      lsSet('cs_remember',$('#remember').checked);
      sbtn.disabled=true;
      var opts={redirectTo:location.origin+location.pathname,queryParams:{prompt:'select_account'}};
      if(CFG.GOOGLE_HD)opts.queryParams.hd=CFG.GOOGLE_HD;
      var r=await sb.auth.signInWithOAuth({provider:'google',options:opts});
      if(r.error){toast(errMsg(r.error),'alert');sbtn.disabled=false;}
    });
    card.append(sbtn);
  }else if(kind==='denied'){
    card.append(h('p',{class:'hint bad',text:'You are signed in as '+info+', but that email is not on the access list.'}),
      h('p',{class:'sub',text:'Ask an admin to add it, or sign out and use another Google account.'}),
      btn('Sign out',function(){sb.auth.signOut();},'primary'));
  }else if(kind==='error'){
    card.append(h('p',{class:'hint bad',text:info||'Something went wrong.'}),
      btn('Try again',function(){location.reload();},'primary'),btn('Sign out',function(){sb.auth.signOut();}));
  }else if(kind==='config'){
    card.append(h('p',{class:'hint bad',text:'This site is not connected to its database yet.'}),
      h('p',{class:'sub',text:'The developers need to finish the setup in README.md (steps 2 and 5), then reload.'}));
  }else{
    card.append(h('p',{class:'sub',text:'Loading…'}));
  }
  g.append(card);
}

/* ---------- start-up ---------- */
var entered=null,channel=null,poll=null;
function teardown(){
  entered=null;
  try{if(channel)sb.removeChannel(channel);}catch(e){}
  channel=null;clearInterval(poll);poll=null;
  state.bookings=[];state.people=[];state.ready=false;state.isAdmin=false;state.me={email:'',name:''};state.tab='timetable';
}
function subscribe(){
  channel=sb.channel('bookings-live').on('postgres_changes',{event:'*',schema:'public',table:'bookings'},scheduleRefresh).subscribe();
  clearInterval(poll);
  poll=setInterval(function(){if(!document.hidden)refresh();},60000);
}
async function enter(session){
  var email=String(session.user.email||'').toLowerCase();
  if(entered===email)return;
  entered=email;
  gate('loading');
  var r=await sb.from('allowed_users').select('*').eq('email',email).maybeSingle();
  if(r.error){entered=null;gate('error',errMsg(r.error));return;}
  if(!r.data){gate('denied',email);return;}
  var meta=session.user.user_metadata||{};
  state.me={email:email,name:r.data.full_name||meta.full_name||meta.name||''};
  state.isAdmin=!!r.data.is_admin;
  state.loadTime=Date.now();state.ready=false;state.status='loading';
  gate('app');
  render();
  await refresh();
  if(state.isAdmin)loadPeople();
  subscribe();
}
async function boot(){
  wire();wirePeople();
  document.addEventListener('visibilitychange',function(){if(!document.hidden&&entered)refresh();});
  if(!window.supabase||!CFG.SUPABASE_URL||!CFG.SUPABASE_ANON_KEY||/YOUR_|example\.supabase/i.test(CFG.SUPABASE_URL+CFG.SUPABASE_ANON_KEY)){gate('config');return;}
  sb=window.supabase.createClient(CFG.SUPABASE_URL,CFG.SUPABASE_ANON_KEY,{auth:{persistSession:true,autoRefreshToken:true,detectSessionInUrl:true,flowType:'pkce',storage:storage}});
  sb.auth.onAuthStateChange(function(ev,session){
    setTimeout(function(){
      if(ev==='SIGNED_OUT'){teardown();gate('login');}
      else if(session&&(ev==='SIGNED_IN'||ev==='INITIAL_SESSION'))enter(session);
    },0);
  });
  var s=await sb.auth.getSession();
  if(!s.data.session)gate('login');
}
boot();

})();
