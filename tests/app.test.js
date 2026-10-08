'use strict';
const test = require('node:test'), assert = require('node:assert/strict');
const fs = require('fs'), path = require('path');
const { seal, fixture, boot, read, ROOT, tick } = require('./helpers');
const core = require('../core.js');
const { webcrypto } = require('node:crypto');
const PASS = 'synthetic-pass-1';
let sealed;
test.before(async () => { sealed = await seal(fixture(), PASS); });
const hasMoneyZero = (t) => /\$0(?![\d.,])/.test(t);

/* ---------- crypto ---------- */
test('decrypts a bundle built from the documented format', async () => {
  const b = await core.open(sealed, PASS, webcrypto.subtle);
  assert.equal(b.version, 1); assert.equal(b.customers.length, 3); assert.equal(b.checks.length, 4);
});
test('wrong passphrase fails cleanly', async () => {
  await assert.rejects(core.open(sealed, 'nope-nope-nope', webcrypto.subtle), /Wrong passphrase/);
});
test('tampered file and non-bundles fail cleanly', async () => {
  const f = JSON.parse(sealed), ct = Buffer.from(f.ct, 'base64'); ct[5] ^= 1; f.ct = ct.toString('base64');
  await assert.rejects(core.open(JSON.stringify(f), PASS, webcrypto.subtle), /damaged/);
  await assert.rejects(core.open('hello', PASS, webcrypto.subtle), /not a phone bundle/);
  await assert.rejects(core.open(JSON.stringify({ v: 2 }), PASS, webcrypto.subtle), /not a phone bundle/);
});

/* ---------- prices ---------- */
test('tier boundaries', () => {
  const c = fixture().catalog[0];
  [[1, 100], [9, 100], [10, 90], [29, 90], [30, 80], [100, 80], [0, 100]].forEach(([q, p]) => assert.equal(core.tierPrice(c, q), p, 'qty ' + q));
  assert.deepEqual(core.tierLabels(c), ['1–9', '10–29', '30+']);
});
test('Master Panda pooling, free board and title add', () => {
  const b = fixture(), q = (rows) => core.priceQuote(rows, b.catalog, b.rules);
  assert.deepEqual(q([{ item: 'Panda A', qty: 6 }, { item: 'Panda B', qty: 4 }]).units, [90, 90]);
  assert.deepEqual(q([{ item: 'Panda A', qty: 5 }]).promo, []);
  assert.deepEqual(q([{ item: 'Panda A', qty: 6 }]).promo, [-100]);
  assert.equal(q([{ item: 'Panda A', qty: 11 }]).promo.length, 1);
  assert.deepEqual(q([{ item: 'Panda A', qty: 12 }]).promo, [-180]);
  assert.deepEqual(q([{ item: 'OT', qty: 3, title: 'Golden Test' }]).extra, [600]);
  assert.deepEqual(q([{ item: 'OT', qty: 3, title: 'Other' }]).extra, []);
});
test('self-check passes a good bundle and fails bad ones', () => {
  assert.equal(core.selfCheck(fixture()).ok, true);
  const bad = (mut) => { const b = fixture(); mut(b); return core.selfCheck(b); };
  assert.deepEqual(bad((b) => { b.checks[0].expect.unit = 79; }).failed.map((f) => f.id), [1]);
  assert.deepEqual(bad((b) => { b.checks[1].expect.total = 811; }).failed.map((f) => f.id), [2]);
  assert.deepEqual(bad((b) => { b.checks[3].expect.extra = [400]; }).failed.map((f) => f.id), [4]);
  assert.deepEqual(bad((b) => { b.checks[2].rows[0].item = 'Nope'; }).failed.map((f) => f.id), [3]);
  assert.equal(bad((b) => { delete b.rules; }).ok, false);
  assert.equal(bad((b) => { b.checks = []; }).ok, false);
});
test('call-for-price (and a zero price) is never shown as $0', async () => {
  const t = boot(); await tick();
  await t.chooseFile('b.aaib', sealed); await t.unlock(PASS);
  const body = t.text();
  assert.match(body, /Prices verified, 4 checks/);
  assert.match(body, /Call for price/);
  assert.ok(!hasMoneyZero(body), 'a $0 appeared');
  assert.equal(core.isCall(fixture().catalog[4]), true);
});
test('price screen shows tiers, flags, notes, dates and filters', async () => {
  const t = boot(); await tick();
  await t.chooseFile('b.aaib', sealed); await t.unlock(PASS);
  const box = t.$('tab-prices');
  ['$100', '$90', '$80', '10–29', 'Limited stock', 'Must call', 'Price TBD', 'Master Panda test', 'Price list TEST', 'Bundle from'].forEach((s) => assert.ok(box.textContent.includes(s), s));
  const q = box.querySelector('input'); q.value = 'pnd a'; q.dispatchEvent(new t.w.Event('input'));
  assert.match(box.textContent, /1 items/);
  q.value = 'ask sales'; q.dispatchEvent(new t.w.Event('input'));
  assert.match(box.textContent, /Printer X/);
  const g = box.querySelector('select'); q.value = ''; g.value = 'Fish'; g.dispatchEvent(new t.w.Event('change'));
  assert.match(box.textContent, /1 items/);
});
test('a failed bundle shows the red block and does not open the price screens', async () => {
  const b = fixture(); b.checks[0].expect.unit = 1;
  const t = boot(); await tick();
  await t.chooseFile('bad.aaib', await seal(b, PASS)); await t.unlock(PASS);
  assert.match(t.text(), /Price check failed, do not quote from this phone/);
  assert.match(t.text(), /Panda A at 30/);
  assert.ok(!t.$('tab-prices').textContent.includes('$100'));
  assert.ok(!t.$('tab-prices').textContent.includes('Limited stock'));
});

/* ---------- import, storage, lock ---------- */
test('import stores the still-encrypted file; unlock after a cold start needs the passphrase', async () => {
  const t = boot(); await tick();
  await t.chooseFile('b.aaib', sealed); await t.unlock('wrong-wrong-wrong');
  assert.match(t.$('lockMsg').textContent, /Wrong passphrase/);
  assert.equal(t.w.AAIApp.state(), null);
  await t.unlock(PASS);
  assert.ok(t.w.AAIApp.state());
  const stored = await new Promise((res) => { const r = t.w.indexedDB.open('aai-mobile', 1); r.onsuccess = () => { const g = r.result.transaction('kv').objectStore('kv').get('bundle'); g.onsuccess = () => res(g.result); }; });
  assert.equal(stored, sealed);
  assert.ok(!stored.includes('Acme'));
  // cold start in the same storage: locked, nothing decrypted, unlock works
  const w2 = boot(t.w.indexedDB); await tick(50);
  assert.equal(w2.w.AAIApp.state(), null);
  assert.ok(!w2.$('lockView').hidden);
  await w2.unlock(PASS);
  assert.ok(w2.w.AAIApp.state());
});
test('lock wipes memory and the screen; passphrase is not kept anywhere', async () => {
  const t = boot(); await tick();
  await t.chooseFile('b.aaib', sealed); await t.unlock(PASS);
  assert.match(t.text(), /Acme Test|Panda A/);
  t.$('lockBtn').click();
  assert.equal(t.w.AAIApp.state(), null);
  assert.ok(!/Acme|Panda|Overdue Co/.test(t.text()));
  assert.equal(t.$('pass').value, '');
  assert.ok(!t.w.location.href.includes(PASS));
  assert.equal(t.w.localStorage.length + t.w.sessionStorage.length, 0);
});
test('idle for 5 minutes locks the app', async () => {
  const t = boot(); await tick();
  await t.chooseFile('b.aaib', sealed); await t.unlock(PASS);
  const real = t.w.Date.now, start = real();
  t.w.Date.now = () => start + 4 * 60 * 1000; t.w.AAIApp.idleCheck();
  assert.ok(t.w.AAIApp.state(), 'still unlocked at 4 min');
  t.w.Date.now = () => start + 5 * 60 * 1000 + 1000; t.w.AAIApp.idleCheck();
  assert.equal(t.w.AAIApp.state(), null);
});
test('header shows bundle age: neutral, amber after 7 days, red after 30', async () => {
  const day = 864e5, age = async (d) => { const t = boot(); await tick(); await t.chooseFile('b', await seal(fixture({ createdAt: new Date(Date.now() - d * day).toISOString() }), PASS)); await t.unlock(PASS); return t.$('bundleAge'); };
  const a = await age(1), b = await age(8), c = await age(31);
  assert.match(a.textContent, /^Bundle from /); assert.equal(a.className, '');
  assert.equal(b.className, 'amber'); assert.equal(c.className, 'red');
});

/* ---------- customers & follow-ups ---------- */
test('search: fields and phone-digit rules', () => {
  const L = fixture().customers, n = (q) => core.searchCustomers(L, q).map((c) => c.contact || c.name);
  assert.equal(n('acme').length, 1); assert.equal(n('ann tester').length, 1); assert.equal(n('rolling').length, 1);
  assert.equal(n('il').length, 1); assert.equal(n('60008').length, 1); assert.equal(n('ANN@ACME.TEST').length, 1);
  assert.equal(n('5551234567').length, 1, 'full digits');
  assert.equal(n('(555) 123-4567').length, 1, 'punctuation');
  assert.equal(n('15551234567').length, 1, 'leading 1 ignored');
  assert.equal(n('234-5').length, 1, 'anywhere in the number');
  assert.equal(n('2220').length, 1, 'second phone');
  assert.equal(n('123').length, 0, 'under 4 digits is not a phone search');
  assert.equal(n('twin').length, 2);
  assert.equal(n('').length, 0);
});
test('customer rows and detail: twins separate, tel/sms/mailto/maps, invoices', async () => {
  const t = boot(); await tick();
  await t.chooseFile('b', sealed); await t.unlock(PASS);
  const box = t.$('tab-customers'), q = box.querySelector('input');
  q.value = 'twin'; q.dispatchEvent(new t.w.Event('input'));
  const rows = box.querySelectorAll('button.row'); assert.equal(rows.length, 2);
  assert.match(rows[0].textContent, /Albany, NY · last order Jan 1, 2025/); assert.match(rows[1].textContent, /Buffalo/);
  q.value = 'acme'; q.dispatchEvent(new t.w.Event('input'));
  box.querySelector('button.row').click();
  const hrefs = [...box.querySelectorAll('a')].map((a) => a.getAttribute('href'));
  ['tel:5551234567', 'sms:5551234567', 'tel:5552220000', 'mailto:ann@acme.test'].forEach((h) => assert.ok(hrefs.includes(h), h));
  assert.ok(hrefs.some((h) => h.startsWith('https://www.google.com/maps/search/?api=1&query=1%20Main%20St')));
  assert.match(box.textContent, /\$1,234\.50/); assert.match(box.textContent, /#26090101/); assert.match(box.textContent, /Widget, Gadget/);
});
test('Maps link is Google Maps, URL-encodes commas, apostrophes and # units', async () => {
  const b = fixture(); b.customers[0].address = "5 O'Brien Ave #12"; b.customers[0].name = 'Quote Co';
  const t = boot(); await tick();
  await t.chooseFile('b', await seal(b, PASS)); await t.unlock(PASS);
  const box = t.$('tab-customers'), q = box.querySelector('input');
  q.value = 'quote'; q.dispatchEvent(new t.w.Event('input'));
  box.querySelector('button.row').click();
  const href = [...box.querySelectorAll('a')].map((a) => a.getAttribute('href')).find((h) => h.includes('google.com/maps'));
  const full = "5 O'Brien Ave #12, " + b.customers[0].city + ', ' + b.customers[0].state + ', ' + b.customers[0].zip;
  assert.equal(href, 'https://www.google.com/maps/search/?api=1&query=' + encodeURIComponent(full));
  assert.ok(href.includes('%2C%20') && href.includes("O'Brien") && href.includes('%2312') && !href.includes('#'));
});
test('follow-ups sort by due date, highlight overdue and soon, tap to call', async () => {
  const soon = new Date(); soon.setDate(soon.getDate() + 2);
  const b = fixture(); b.followUps[2].due = core.dayStr(soon);
  const t = boot(); await tick();
  await t.chooseFile('b', await seal(b, PASS)); await t.unlock(PASS);
  const cards = [...t.$('tab-followups').querySelectorAll('.card')];
  assert.deepEqual(cards.map((c) => c.querySelector('h3').textContent), ['Overdue Co', 'Today Co', 'Later Co']);
  assert.deepEqual(cards.map((c) => c.className.replace('card', '').trim()), ['overdue', 'soon', '']);
  assert.equal(cards[0].querySelector('a').getAttribute('href'), 'tel:5553330001');
});

/* ---------- the app makes no network requests; the repo stays code only ---------- */
test('no network code and no external references in the app', () => {
  ['app.js', 'core.js'].forEach((f) => assert.ok(!/fetch\(|XMLHttpRequest|WebSocket|sendBeacon|EventSource|import\(/.test(read(f)), f));
  assert.ok(!/https?:\/\//.test(read('index.html') + read('styles.css') + read('manifest.webmanifest')));
  assert.ok(!/<script[^>]*src="(https?:)?\/\//.test(read('index.html')));
  const urls = read('app.js').match(/https?:\/\/[^'"\s]+/g) || [];
  assert.deepEqual(urls, ['https://www.google.com/maps/search/?api=1&query=']);
  assert.ok(!/localStorage|sessionStorage|console\.(log|info|warn|error|debug)/.test(read('app.js')), 'passphrase/data never logged or kept in web storage');
});
test('manifest, icons and service worker are in place', () => {
  const m = JSON.parse(read('manifest.webmanifest'));
  assert.equal(m.display, 'standalone');
  m.icons.forEach((i) => assert.ok(fs.existsSync(path.join(ROOT, i.src)), i.src));
  assert.ok(read('sw.js').includes('addAll'));
});
test('public-repo safety: no .aaib file and no JSON over 100 KB', () => {
  const bad = [];
  (function walk(d) {
    for (const e of fs.readdirSync(d, { withFileTypes: true })) {
      if (['.git', 'node_modules', 'phone-test'].includes(e.name)) continue;
      const p = path.join(d, e.name);
      if (e.isDirectory()) walk(p);
      else if (/\.aaib$/i.test(e.name) || (/\.json$/i.test(e.name) && fs.statSync(p).size > 100 * 1024)) bad.push(path.relative(ROOT, p));
    }
  })(ROOT);
  assert.deepEqual(bad, []);
  const ig = read('.gitignore'); assert.ok(ig.includes('*.aaib') && ig.includes('phone-test/'));
});
