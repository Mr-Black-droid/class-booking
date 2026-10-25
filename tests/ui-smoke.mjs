// Browser smoke test of web/index.html against the in-memory mock. Run: node tests/ui-smoke.mjs
import { chromium } from '/opt/node22/lib/node_modules/playwright/index.mjs';
import http from 'node:http'; import fs from 'node:fs'; import path from 'node:path';

const here = import.meta.dirname, root = path.resolve(here, '../web');
const srv = http.createServer((q, s) => {
  let p = path.join(root, decodeURIComponent(q.url.split('?')[0])); if (p.endsWith('/')) p += 'index.html';
  fs.readFile(p, (e, d) => { if (e) { s.writeHead(404); s.end(); return; }
    s.writeHead(200, { 'content-type': p.endsWith('.js') ? 'text/javascript' : 'text/html' }); s.end(d); });
}).listen(0);
const port = srv.address().port;
const iso = (d) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
const tomorrow = iso(new Date(Date.now() + 864e5));
const br = await chromium.launch(); let fails = 0;
const ok = (c, m) => { console.log((c ? 'ok   ' : 'FAIL ') + m); if (!c) fails++; };

async function newCtx(width = 1200) { return br.newContext({ viewport: { width, height: 900 } }); }
async function open(ctx, loginAs, seed = {}, cfg = true) {
  const pg = await ctx.newPage(); const errs = []; pg.on('pageerror', (e) => errs.push(e.message));
  await pg.route('**/vendor/supabase-2.45.4.js', (r) => r.fulfill({ contentType: 'text/javascript',
    body: 'window.__seed=' + JSON.stringify(seed) + ';window.__loginAs=' + JSON.stringify(loginAs) + ';' + fs.readFileSync(path.join(here, 'mock-supabase.js'), 'utf8') }));
  if (!cfg) await pg.route('**/config.js', (r) => r.fulfill({ contentType: 'text/javascript', body: 'window.APP_CONFIG={SUPABASE_URL:"",SUPABASE_ANON_KEY:""};' }));
  else await pg.route('**/config.js', (r) => r.fulfill({ contentType: 'text/javascript', body: 'window.APP_CONFIG={SUPABASE_URL:"https://abc.supabase.co",SUPABASE_ANON_KEY:"k"};' }));
  await pg.route(/fonts\.(googleapis|gstatic)\.com/, (r) => r.abort());
  await pg.goto(`http://localhost:${port}/`);
  return { pg, errs };
}
const boss = { id: 'b1', owner_email: 'boss@t.test', name: 'Boss class', date: tomorrow, start_min: 540, end_min: 600, status: 'confirmed', created_at: new Date(Date.now() - 1e5).toISOString() };

// 0. not configured
{ const ctx = await newCtx(); const { pg, errs } = await open(ctx, null, {}, false);
  await pg.waitForSelector('#gate:not([hidden])');
  ok((await pg.textContent('#gate-msg')).includes('not connected'), 'unconfigured copy explains what is missing');
  ok(await pg.locator('#gate-signin').isHidden(), 'no sign-in button when unconfigured'); ok(!errs.length, 'no script errors (unconfigured)'); await ctx.close(); }

// 1. person not on the list
{ const ctx = await newCtx(); const { pg, errs } = await open(ctx, 'stranger@t.test');
  await pg.waitForSelector('#gate-signin'); await pg.click('#gate-signin');
  await pg.waitForSelector('#gate-signout:not([hidden])');
  ok((await pg.textContent('#gate-msg')).includes('stranger@t.test') && (await pg.textContent('#gate-msg')).includes('not on the list'), 'unlisted Google account is told they are not on the list');
  ok(await pg.locator('#app').isHidden(), 'timetable stays hidden for unlisted account');
  await pg.click('#gate-signout'); await pg.waitForSelector('#gate-signin:not([hidden])');
  ok(true, 'can go back and use a different account'); ok(!errs.length, 'no script errors (unlisted)'); await ctx.close(); }

// 2. staff member: sign in, book, clash goes to waitlist, remember me
{ const ctx = await newCtx(); const { pg, errs } = await open(ctx, 'ann@t.test', { bookings: [boss] });
  ok(await pg.locator('#remember').isChecked(), '"keep me signed in" is on by default');
  await pg.click('#gate-signin'); await pg.waitForSelector('#app:not([hidden])'); await pg.waitForSelector('#grid .tt');
  ok((await pg.textContent('#who')).includes('Ann'), 'staff sees their own name');
  ok(await pg.locator('#tab-attention').isHidden() && await pg.locator('#tab-people').isHidden() && await pg.locator('#tab-log').isHidden(), 'admin tabs hidden from staff');
  await pg.click('#book'); await pg.waitForSelector('#dlg-book[open]');
  await pg.fill('#bk-name', 'Ann'); await pg.selectOption('#bk-date', tomorrow); await pg.selectOption('#bk-from', '600'); await pg.selectOption('#bk-to', '660');
  await pg.click('#bk-submit'); await pg.waitForSelector('.toast.ok');
  ok((await pg.textContent('.toast')).includes('Reserved'), 'free slot is reserved');
  ok(await pg.locator('.blk.mine').count() === 1, 'own booking shows in the timetable, highlighted');
  await pg.click('#book'); await pg.waitForSelector('#dlg-book[open]');
  await pg.selectOption('#bk-date', tomorrow); await pg.selectOption('#bk-from', '540'); await pg.selectOption('#bk-to', '570');
  ok((await pg.textContent('#bk-submit')).includes('Join waitlist') && (await pg.textContent('#bk-hint')).includes('Boss class'), 'dialog warns the time is taken and offers the waitlist');
  await pg.click('#bk-submit'); await pg.waitForSelector('.toast.wait');
  ok(await pg.locator('.blk .wb').count() === 1, 'timetable shows +1 waiting on the taken block');
  await pg.click('#tab-mine');
  ok((await pg.textContent('#mine-host')).includes('Waitlist #1'), 'My bookings shows waitlist position');
  const page2 = await ctx.newPage(); await page2.route('**/vendor/supabase-2.45.4.js', (r) => r.fulfill({ contentType: 'text/javascript', body: 'window.__loginAs="ann@t.test";' + fs.readFileSync(path.join(here, 'mock-supabase.js'), 'utf8') }));
  await page2.route('**/config.js', (r) => r.fulfill({ contentType: 'text/javascript', body: 'window.APP_CONFIG={SUPABASE_URL:"https://abc.supabase.co",SUPABASE_ANON_KEY:"k"};' }));
  await page2.route(/fonts\./, (r) => r.abort()); await page2.goto(`http://localhost:${port}/`);
  await page2.waitForSelector('#app:not([hidden])', { timeout: 5000 });
  ok(true, 'new tab on the same device is already signed in (remember me)');
  await pg.click('#who button'); await pg.waitForSelector('#gate-signin:not([hidden])');
  ok(true, 'sign out returns to the sign-in screen'); ok(!errs.length, 'no script errors (staff) ' + errs.join('|')); await ctx.close(); }

// 3. remember me switched off
{ const ctx = await newCtx(); const { pg } = await open(ctx, 'ann@t.test');
  await pg.uncheck('#remember'); await pg.click('#gate-signin'); await pg.waitForSelector('#app:not([hidden])');
  const p2 = await ctx.newPage(); await p2.route('**/vendor/supabase-2.45.4.js', (r) => r.fulfill({ contentType: 'text/javascript', body: 'window.__loginAs="ann@t.test";' + fs.readFileSync(path.join(here, 'mock-supabase.js'), 'utf8') }));
  await p2.route('**/config.js', (r) => r.fulfill({ contentType: 'text/javascript', body: 'window.APP_CONFIG={SUPABASE_URL:"https://abc.supabase.co",SUPABASE_ANON_KEY:"k"};' }));
  await p2.route(/fonts\./, (r) => r.abort()); await p2.goto(`http://localhost:${port}/`); await p2.waitForSelector('#gate-signin:not([hidden])');
  ok(true, 'with "keep me signed in" off, a fresh tab asks to sign in again'); await ctx.close(); }

// 4. admin: attention queue, swap, people, log tab
{ const ctx = await newCtx(); const wait = { id: 'w1', owner_email: 'ann@t.test', name: 'Ann', date: tomorrow, start_min: 570, end_min: 630, status: 'waitlisted', created_at: new Date().toISOString() };
  const { pg, errs } = await open(ctx, 'boss@t.test', { bookings: [boss, wait] });
  await pg.click('#gate-signin'); await pg.waitForSelector('#app:not([hidden])');
  ok(await pg.locator('#tab-attention').isVisible() && await pg.locator('#tab-people').isVisible(), 'admin sees the admin tabs');
  ok((await pg.textContent('#banners')).includes('1 person is'), 'red banner counts people waiting');
  await pg.click('#tab-attention'); await pg.waitForSelector('#att-host .card');
  ok((await pg.textContent('#att-host')).includes('Taken by') && (await pg.textContent('#att-host')).includes('Boss class'), 'needs-attention card names who holds the time');
  const swap = pg.locator('#att-host button', { hasText: 'Swap in' }); await swap.click(); await swap.click();
  await pg.waitForSelector('#att-host .card:has-text("Taken by") >> text=Ann');
  ok((await pg.textContent('#att-host')).includes('Boss class'), 'swap in confirms the waiting person and sends the previous holder to the queue');
  await pg.click('#tab-people'); await pg.waitForSelector('#people-host .brow');
  await pg.fill('#pp-email', 'New.Person@t.test'); await pg.fill('#pp-name', 'Newbie'); await pg.click('#pp-add');
  await pg.waitForSelector('#people-host :text("new.person@t.test")');
  ok(true, 'admin can add a person by email');
  ok(await pg.locator('#people-host .brow', { hasText: 'Boss' }).locator('button').count() === 0, 'admins cannot be removed from the page');
  await pg.fill('#pp-email', 'nonsense'); await pg.click('#pp-add'); await pg.waitForSelector('.toast.alert');
  ok((await pg.textContent('.toast.alert')).includes('valid email'), 'bad email is rejected with a clear message');
  await pg.click('#tab-log'); ok(await pg.locator('#p-log').isVisible(), 'session log opens'); ok(!errs.length, 'no script errors (admin) ' + errs.join('|')); await ctx.close(); }

// 5. phone width
{ const ctx = await newCtx(390); const { pg } = await open(ctx, 'ann@t.test', { bookings: [boss] });
  await pg.click('#gate-signin'); await pg.waitForSelector('#grid .tt');
  ok(await pg.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth), 'no sideways scrolling at phone width');
  ok(await pg.locator('#daystrip').isVisible(), 'phone shows the one-day view with a day strip'); await ctx.close(); }

await br.close(); srv.close();
console.log(fails ? `\n${fails} FAILED` : '\nALL UI CHECKS PASSED'); process.exit(fails ? 1 : 0);
