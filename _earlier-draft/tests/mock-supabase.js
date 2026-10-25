// In-memory stand-in for the Supabase client, used only by smoke.mjs.
(function(){
  var db={allowed_users:[
    {email:'boss@example.com',full_name:'Boss',is_admin:true},{email:'staff@example.com',full_name:'Stella Staff',is_admin:false}],
    bookings:[]};
  var session=null,listeners=[],seq=1;
  function me(){return session&&session.user.email;}
  function admin(){return !!db.allowed_users.find(function(u){return u.email===me()&&u.is_admin;});}
  function ov(a,b){return a.date===b.date&&a.start_min<b.end_min&&b.start_min<a.end_min;}
  function promote(date){db.bookings.filter(function(b){return b.date===date&&b.status==='waitlisted';}).sort(function(a,b){return a.created_at<b.created_at?-1:1;}).forEach(function(w){
    if(!db.bookings.some(function(c){return c.status==='confirmed'&&ov(c,w);}))w.status='confirmed';});}
  function q(table){
    var st={op:'select',f:[],lo:null,patch:null,single:false};
    var api={
      select:function(){return api;},
      eq:function(k,v){st.f.push(function(r){return r[k]===v;});return api;},
      gte:function(k,v){st.f.push(function(r){return r[k]>=v;});return api;},
      order:function(){return api;},range:function(){return api;},
      maybeSingle:function(){st.single=true;return api;},
      insert:function(row){st.op='insert';st.patch=row;return api;},
      update:function(p){st.op='update';st.patch=p;return api;},
      delete:function(){st.op='delete';return api;},
      then:function(res,rej){
        var rows=db[table],out;
        var m=rows.filter(function(r){return st.f.every(function(f){return f(r);});});
        if(table==='allowed_users'&&!admin())m=m.filter(function(r){return r.email===me();});
        if(st.op==='insert'){rows.push(Object.assign({is_admin:false},st.patch));out={data:null,error:null};}
        else if(st.op==='update'){
          if(!admin())out={data:null,error:null};
          else{
            var clash=false;
            m.forEach(function(r){var n=Object.assign({},r,st.patch);if(n.status==='confirmed'&&db.bookings.some(function(c){return c!==r&&c.status==='confirmed'&&ov(c,n);}))clash=true;});
            if(clash)out={data:null,error:{code:'23P01',message:'conflicting key value violates exclusion constraint'}};
            else{m.forEach(function(r){Object.assign(r,st.patch);});out={data:null,error:null};}
          }}
        else if(st.op==='delete'){m.forEach(function(r){rows.splice(rows.indexOf(r),1);});out={data:null,error:null};}
        else out={data:st.single?(m[0]||null):m,error:null};
        return Promise.resolve(out).then(res,rej);
      }
    };
    return api;
  }
  var client={
    from:q,
    rpc:function(fn,a){
      return new Promise(function(resolve){
        if(fn==='book_slot'){
          var r={id:'b'+(seq++),user_email:me(),name:a.p_name,date:a.p_date,start_min:a.p_start,end_min:a.p_end,created_at:new Date(Date.now()+seq).toISOString(),promoted_at:null,teacher:'',attendance:'',remark:'',internship:false,entered:false};
          r.status=db.bookings.some(function(c){return c.status==='confirmed'&&ov(c,r);})?'waitlisted':'confirmed';
          db.bookings.push(r);resolve({data:r,error:null});
        }else if(fn==='cancel_booking'){
          var b=db.bookings.find(function(x){return x.id===a.p_id;});
          if(b){db.bookings.splice(db.bookings.indexOf(b),1);promote(b.date);}
          resolve({data:null,error:null});
        }else if(fn==='swap_in'){
          var w=db.bookings.find(function(x){return x.id===a.p_id;});
          db.bookings.forEach(function(c){if(c!==w&&c.status==='confirmed'&&ov(c,w))c.status='waitlisted';});
          w.status='confirmed';resolve({data:null,error:null});
        }
      });
    },
    channel:function(){var c={on:function(){return c;},subscribe:function(){return c;}};return c;},
    removeChannel:function(){},
    auth:{
      onAuthStateChange:function(f){listeners.push(f);},
      getSession:function(){return Promise.resolve({data:{session:session}});},
      signInWithOAuth:function(){
        var email=window.__loginAs||'staff@example.com';
        session={user:{email:email,user_metadata:{full_name:'Google Name'}}};
        listeners.forEach(function(f){f('SIGNED_IN',session);});
        return Promise.resolve({error:null});
      },
      signOut:function(){session=null;listeners.forEach(function(f){f('SIGNED_OUT',null);});return Promise.resolve({});}
    }
  };
  window.supabase={createClient:function(){return client;}};
  window.__db=db;
})();
