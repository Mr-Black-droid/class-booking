// Headless smoke test of the front end against the in-memory mock. Run: node smoke.mjs
import { chromium } from '/opt/node22/lib/node_modules/playwright/index.mjs';
import http from 'node:http'; import fs from 'node:fs'; import path from 'node:path';
const root = path.resolve(import.meta.dirname, '../web');
const srv = http.createServer((q, s) => {
  let p = path.join(root, decodeURIComponent(q.url.split('?')[0])); if (p.endsWith('/')) p += 'index.html';
  fs.readFile(p, (e, d) => { if (e) { s.writeHead(404); s.end(); return; } s.writeHead(200, {'content-type': p.endsWith('.js') ? 'text/javascript' : p.endsWith('.css') ? 'text/css' : 'text/html'}); s.end(d); });
}).listen(0);
const port = srv.address().port;
const br = await chromium.launch(); let fails = 0;
const ok = (c, m) => { console.log((c ? 'ok   ' : 'FAIL ') + m); if (!c) fails++; };
async function open(loginAs) {
  const ctx = await br.newContext({ viewport: { width: 1200, height: 900 } });
  const pg = await ctx.newPage(); const errs = []; pg.on('pageerror', e => errs.push(e.message));
  await pg.route('**/vendor/supabase.js', r => r.fulfill({ contentType: 'text/javascript', body: fs.readFileSync(path.join(import.meta.dirname, 'mock-supabase.js')) }));
  await pg.route('**/config.js', r => r.fulfill({ contentType: 'text/javascript', body: "window.APP_CONFIG={SUPABASE_URL:'https://abc.supabase.co',SUPABASE_ANON_KEY:'k',TIMEZONE:'Europe/Warsaw'};window.__loginAs=" + JSON.stringify(loginAs) }));
  await pg.route(/fonts\.(googleapis|gstatic)\.com/, r => r.abort());
  await pg.goto(`http://localhost:${port}/`); return { pg, errs };
}
// staff user
let { pg, errs } = await open('staff@example.com');
ok(await pg.locator('#signin').isVisible(), 'signed-out visitor sees the Google sign-in button');
ok(await pg.locator('#remember').isChecked(), 'keep-me-signed-in is on by default');
await pg.click('#signin'); await pg.waitForSelector('#grid .tt');
ok((await pg.textContent('#who')).includes('Stella Staff'), 'staff member sees their name');
ok(await pg.locator('#tab-attention').isHidden() && await pg.locator('#tab-people').isHidden(), 'admin tabs are hidden from staff');
// book a free slot via the dialog (tomorrow 09:00-10:00)
await pg.click('#book'); await pg.waitForSelector('#dlg-book[open]');
const d = await pg.$eval('#bk-date', s => s.options[1].value);
await pg.fill('#bk-name', 'Stella'); await pg.selectOption('#bk-date', d); await pg.selectOption('#bk-from', '540'); await pg.selectOption('#bk-to', '600');
ok((await pg.textContent('#bk-hint')).includes('free'), 'dialog says the slot is free');
await pg.click('#bk-submit'); await pg.waitForSelector('#toasts .toast.ok');
ok(await pg.evaluate(() => window.__db.bookings.length === 1 && window.__db.bookings[0].status === 'confirmed'), 'booking is confirmed');
// second person (same browser context, switch user) books overlapping -> waitlist
await pg.click('text=Sign out'); await pg.waitForSelector('#signin');
await pg.evaluate(() => { window.__loginAs = 'boss@example.com'; });
await pg.click('#signin'); await pg.waitForSelector('#grid .tt');
ok(await pg.locator('#tab-attention').isVisible() && await pg.locator('#tab-people').isVisible() && await pg.locator('#tab-log').isVisible(), 'admin sees Needs attention, Session log and People');
await pg.click('#book'); await pg.waitForSelector('#dlg-book[open]');
await pg.fill('#bk-name', 'Boss booking'); await pg.selectOption('#bk-date', d); await pg.selectOption('#bk-from', '570'); await pg.selectOption('#bk-to', '630');
ok((await pg.textContent('#bk-hint')).includes('Already taken'), 'dialog warns that the time is taken');
ok((await pg.textContent('#bk-submit')).includes('Join waitlist'), 'button becomes Join waitlist');
await pg.click('#bk-submit'); await pg.waitForSelector('#toasts .toast.wait');
ok(await pg.evaluate(() => window.__db.bookings.filter(b => b.status === 'waitlisted').length === 1), 'second booking is waitlisted');
ok((await pg.textContent('#banners')).includes('waiting for a slot'), 'admin banner announces the waiting person');
await pg.click('#tab-attention');
ok(await pg.locator('#att-host .card').count() === 1, 'Needs attention lists one card');
await pg.click('text=Swap in');  await pg.click('text=Tap again to swap');
await pg.waitForFunction(() => window.__db.bookings.find(b => b.name === 'Boss booking').status === 'confirmed');
ok(true, 'admin swap-in works');
await pg.click('#tab-people');
ok(await pg.locator('#people-list .brow').count() === 2, 'People tab lists both people');
await pg.fill('#pp-email', 'new.teacher@school.pl'); await pg.click('#pp-add'); await pg.waitForSelector('#people-list .brow >> nth=2');
ok(await pg.evaluate(() => window.__db.allowed_users.some(u => u.email === 'new.teacher@school.pl' && !u.is_admin)), 'admin adds a staff email');
await pg.click('#tab-log'); ok(await pg.locator('#log-host').count() === 1, 'session log tab opens');
ok(errs.length === 0, 'no script errors' + (errs.length ? ': ' + errs.join('; ') : ''));
// phone width
await pg.setViewportSize({ width: 390, height: 800 }); await pg.click('#tab-timetable');
ok(await pg.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1), 'no horizontal scroll at phone width');
ok(await pg.locator('#daystrip').isVisible(), 'phone shows the day strip');
await pg.screenshot({ path: '/tmp/phone.png' });
await pg.setViewportSize({ width: 1200, height: 900 }); await pg.screenshot({ path: '/tmp/desk.png' });
// stranger
({ pg, errs } = await open('stranger@example.com'));
await pg.click('#signin'); await pg.waitForSelector('.gate-card .hint.bad');
ok((await pg.textContent('.gate-card')).includes('not on the access list'), 'unlisted Google account is turned away');
ok(await pg.locator('#app').isHidden(), 'timetable stays hidden for unlisted accounts');
await br.close(); srv.close(); console.log(fails ? `${fails} FAILED` : 'ALL PASSED'); process.exit(fails ? 1 : 0);
