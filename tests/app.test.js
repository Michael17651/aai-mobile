'use strict';
const test = require('node:test'), assert = require('node:assert/strict');
const fs = require('fs'), path = require('path');
const { waitFor, seal, unseal, fixture, boot, read, ROOT, tick, PIN, rndPin, otherPin } = require('./helpers');
const { execFileSync } = require('child_process'), vm = require('vm');
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
  const t = boot(); await t.ready();
  await t.chooseFile('b.aaib', sealed); await t.unlock(PASS);
  const body = t.text();
  assert.match(body, /Prices verified, 4 checks/);
  assert.match(body, /Call for price/);
  assert.ok(!hasMoneyZero(body), 'a $0 appeared');
  assert.equal(core.isCall(fixture().catalog[4]), true);
});
test('price screen shows tiers, flags, notes, dates and filters', async () => {
  const t = boot(); await t.ready();
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
  const t = boot(); await t.ready();
  await t.chooseFile('bad.aaib', await seal(b, PASS)); await t.unlock(PASS);
  assert.match(t.text(), /Price check failed, do not quote from this phone/);
  assert.match(t.text(), /Panda A at 30/);
  assert.ok(!t.$('tab-prices').textContent.includes('$100'));
  assert.ok(!t.$('tab-prices').textContent.includes('Limited stock'));
});

/* ---------- import, storage, lock ---------- */
const rawKv = (w) => new Promise((res) => { const r = w.indexedDB.open('aai-mobile'); r.onsuccess = () => { const tx = r.result.transaction('kv'), st = tx.objectStore('kv'), k = st.getAllKeys(), v = st.getAll(); tx.oncomplete = () => res(Object.fromEntries(k.result.map((x, i) => [x, v.result[i]]))); }; });
const rawPut = (w, key, val) => new Promise((res) => { const r = w.indexedDB.open('aai-mobile'); r.onsuccess = () => { const tx = r.result.transaction('kv', 'readwrite'); tx.objectStore('kv').put(val, key); tx.oncomplete = res; }; });
const setT = (t, ms) => { const base = t.w.Date.now(); t.w.Date.now = () => base + ms; return base; };

test('first import: passphrase, self-check, choose a PIN twice, vault stored with nothing secret in the clear', async () => {
  const t = boot(); await t.ready();
  assert.match(t.$('ver').textContent, /Version 2\.1\.0 · cache aai-mobile-v6/);
  await t.chooseFile('b.aaib', sealed);
  assert.ok(!t.$('passForm').hidden); await t.passphrase('wrong-wrong-wrong');
  assert.match(t.$('lockMsg').textContent, /Wrong passphrase/); assert.equal(t.w.AAIApp.state(), null);
  await t.passphrase(PASS);
  assert.ok(!t.$('newPinForm').hidden); assert.equal(t.w.AAIApp.state(), null, 'not open until a PIN is chosen');
  assert.deepEqual(Object.keys(await rawKv(t.w)), [], 'nothing stored before the PIN');
  for (const [a, b, re] of [['123', '123', /4 to 8 digits/], ['123456789', '123456789', /4 to 8 digits/], ['12ab', '12ab', /4 to 8 digits/], [PIN, otherPin(PIN), /differ/]]) {
    await t.setPin(a, b); assert.match(t.$('lockMsg').textContent, re); assert.equal(t.w.AAIApp.state(), null);
  }
  await t.setPin(PIN);
  assert.ok(t.w.AAIApp.state()); assert.match(t.text(), /Prices verified, 4 checks/);
  const kv = await rawKv(t.w), all = JSON.stringify(kv);
  assert.deepEqual(Object.keys(kv).sort(), ['fails', 'vault', 'wrap']);
  assert.ok(!all.includes('Acme') && !all.includes(PASS) && !all.includes(PIN), 'no plaintext, passphrase or PIN stored');
  assert.deepEqual(Object.keys(kv.wrap).sort(), ['ct', 'iv', 'salt', 'v']);
  // the wrap is PBKDF2-SHA256, 600,000 iterations, 16-byte salt over the PIN, AES-GCM around a 32-byte key
  const sub = webcrypto.subtle, d = (x) => new Uint8Array(Buffer.from(x, 'base64')), base = await sub.importKey('raw', new TextEncoder().encode(PIN), 'PBKDF2', false, ['deriveKey']);
  const k = await sub.deriveKey({ name: 'PBKDF2', salt: d(kv.wrap.salt), iterations: 600000, hash: 'SHA-256' }, base, { name: 'AES-GCM', length: 256 }, false, ['decrypt']);
  const raw = await sub.decrypt({ name: 'AES-GCM', iv: d(kv.wrap.iv) }, k, d(kv.wrap.ct));
  assert.equal(d(kv.wrap.salt).length, 16); assert.equal(raw.byteLength, 32);
  const dkey = await sub.importKey('raw', raw, 'AES-GCM', false, ['decrypt']);
  const plain = JSON.parse(new TextDecoder().decode(await sub.decrypt({ name: 'AES-GCM', iv: d(kv.vault.iv) }, dkey, d(kv.vault.ct))));
  assert.equal(plain.customers.length, 3);
});
test('PIN unlock after a cold start; wrong PIN is refused; a failed price check still closes the price screens', async () => {
  const t = boot(); await t.ready();
  await t.chooseFile('b.aaib', sealed); await t.unlock(PASS);
  const w2 = boot(t.w.indexedDB); await w2.ready();
  assert.equal(w2.w.AAIApp.state(), null); assert.ok(!w2.$('lockView').hidden); assert.ok(!w2.$('pinForm').hidden); assert.ok(w2.$('passForm').hidden);
  assert.match(w2.$('ver').textContent, /aai-mobile-v6/);
  await w2.pin(otherPin(PIN)); assert.match(w2.$('lockMsg').textContent, /Wrong PIN/); assert.equal(w2.w.AAIApp.state(), null);
  setT(w2, 20000); await w2.pin(PIN);
  assert.ok(w2.w.AAIApp.state()); assert.match(w2.text(), /Prices verified/);
  const b = fixture(); b.checks[0].expect.unit = 1;
  const t3 = boot(); await t3.ready(); await t3.chooseFile('b', await seal(b, PASS)); await t3.unlock(PASS);
  const w4 = boot(t3.w.indexedDB); await w4.ready(); await w4.pin(PIN);
  assert.match(w4.text(), /Price check failed/); assert.ok(!w4.$('tab-prices').textContent.includes('$100'));
});
test('wrong PINs: waits of 1, 2, 4, 8 s; lockout refuses even the right PIN; counter resets on success', async () => {
  const t = boot(); await t.ready(); await t.chooseFile('b', sealed); await t.unlock(PASS);
  const c = boot(t.w.indexedDB); await c.ready();
  let now = c.w.Date.now(); const clock = () => { c.w.Date.now = () => now; }; clock();
  const fails = async () => (await rawKv(c.w)).fails;
  for (const [n, wait] of [[1, 1], [2, 2], [3, 4], [4, 8]]) {
    await c.pin(otherPin(PIN));
    const f = await fails(); assert.equal(f.n, n); assert.equal(f.until - now, wait * 1000, 'wait after try ' + n);
    assert.match(c.$('lockMsg').textContent, new RegExp('Try again in ' + wait + ' s'));
    await c.pin(PIN); assert.match(c.$('lockMsg').textContent, /Wait \d+ s/, 'right PIN refused during the wait');
    assert.equal((await fails()).n, n, 'a refused try is not counted'); assert.equal(c.w.AAIApp.state(), null);
    now += wait * 1000; clock();
  }
  await c.pin(PIN); assert.ok(c.w.AAIApp.state());
  assert.deepEqual(await fails(), { n: 0, until: 0 });
});
test('5th wrong PIN in a row wipes the bundle but keeps the outbox', async () => {
  const t = await unlocked(); await lead(t, 'Kept Lead Co');
  await new Promise((res) => { const r = t.w.indexedDB.open('aai-mobile'); r.onsuccess = () => { const tx = r.result.transaction('kv', 'readwrite'); tx.objectStore('kv').put('PX', 'deviceLabel'); tx.oncomplete = res; }; });
  const c = boot(t.w.indexedDB); await c.ready();
  let now = c.w.Date.now();
  for (let i = 0; i < 5; i++) { c.w.Date.now = () => now; await c.pin(otherPin(PIN)); now += 10000; }
  assert.equal(c.w.AAIApp.state(), null);
  assert.match(c.$('lockMsg').textContent, /^Too many wrong PINs\. Import the phone bundle again with its passphrase\.$/);
  assert.deepEqual(Object.keys(await rawKv(c.w)), ['deviceLabel']);
  const recs = await dump(c.w); assert.equal(recs.length, 1); assert.equal(recs[0].company, 'Kept Lead Co');
  assert.ok(c.$('pinForm').hidden && c.$('passForm').hidden); assert.match(c.$('lockHint').textContent, /No bundle yet/);
  // a fresh import works and the surviving outbox record is there
  await c.chooseFile('b', sealed); await c.unlock(PASS);
  await waitFor(() => /Kept Lead Co/.test(c.$('tab-outbox').textContent), 'the outbox to render'); await tick(10);
  assert.match(c.$('tab-outbox').textContent, /Kept Lead Co/);
});
test('Settings: change PIN needs the current PIN; new PIN works, old does not; bundle and outbox passphrase survive', async () => {
  const t = await unlocked(); const S = t.$('tab-settings'), NEW = otherPin(otherPin(PIN));
  await setObpass(t, OPASS);
  await openSettings(t);
  assert.match(S.textContent, /Version 2\.1\.0 · cache aai-mobile-v6/);
  const fill = (lab, v) => type(t.w, S.querySelector('[aria-label="' + lab + '"]'), v);
  const go = async (re) => { click(S, 'Change PIN'); await waitFor(() => re.test(S.textContent), 'the Change PIN result ' + re); await tick(10); };
  fill('Current PIN', otherPin(PIN)); fill('New PIN', NEW); fill('New PIN again', NEW); await go(/Wrong PIN/);
  assert.match(S.textContent, /Wrong PIN/);
  fill('Current PIN', PIN); fill('New PIN', NEW); fill('New PIN again', NEW + '1'); await go(/differ/); assert.match(S.textContent, /differ/);
  fill('Current PIN', PIN); fill('New PIN', '12'); fill('New PIN again', '12'); await go(/4 to 8 digits/); assert.match(S.textContent, /4 to 8 digits/);
  setT(t, 20000);
  fill('Current PIN', PIN); fill('New PIN', NEW); fill('New PIN again', NEW); await go(/PIN changed/); assert.match(S.textContent, /PIN changed/);
  const c = boot(t.w.indexedDB); await c.ready();
  setT(c, 40000); await c.pin(PIN); assert.equal(c.w.AAIApp.state(), null, 'old PIN refused');
  setT(c, 80000); await c.pin(NEW); assert.ok(c.w.AAIApp.state());
  assert.equal(await shownPass(c, NEW), OPASS);
});
test('Settings: Delete bundle asks first, removes the bundle, keeps the outbox', async () => {
  const t = await unlocked(); await lead(t, 'Kept Lead Co');
  await openSettings(t);
  click(t.$('tab-settings'), 'Delete bundle'); assert.ok(t.w.AAIApp.state(), 'still there until confirmed'); assert.match(t.$('tab-settings').textContent, /Unsent outbox records stay/);
  click(t.$('tab-settings'), 'Cancel'); assert.ok(t.w.AAIApp.state());
  click(t.$('tab-settings'), 'Delete bundle'); click(t.$('tab-settings'), 'Yes, delete'); await waitFor(() => t.w.AAIApp.state() === null && /Bundle deleted/.test(t.$('lockMsg').textContent), 'the bundle to be deleted'); await tick(10);
  assert.equal(t.w.AAIApp.state(), null); assert.deepEqual(Object.keys(await rawKv(t.w)).filter((k) => k !== 'deviceLabel'), []);
  assert.equal((await dump(t.w)).length, 1); assert.match(t.$('lockMsg').textContent, /Bundle deleted/);
});
test('migration: a phone with an old-format bundle asks the passphrase once, then walks through choosing a PIN', async () => {
  const t = boot(); await t.ready(); await rawPut(t.w, 'bundle', sealed);
  const m = boot(t.w.indexedDB); await m.ready();
  assert.ok(!m.$('passForm').hidden); assert.ok(m.$('pinForm').hidden); assert.match(m.$('lockHint').textContent, /older version/);
  await m.passphrase('wrong-wrong-wrong'); assert.match(m.$('lockMsg').textContent, /Wrong passphrase/);
  await m.passphrase(PASS); assert.ok(!m.$('newPinForm').hidden); assert.equal(m.w.AAIApp.state(), null);
  assert.ok((await rawKv(m.w)).bundle, 'old copy kept until the PIN is saved');
  await m.setPin(PIN);
  assert.ok(m.w.AAIApp.state()); const kv = await rawKv(m.w);
  assert.deepEqual(Object.keys(kv).sort(), ['fails', 'vault', 'wrap']);
  const n = boot(m.w.indexedDB); await n.ready(); assert.ok(!n.$('pinForm').hidden); assert.ok(n.$('passForm').hidden);
  await n.pin(PIN); assert.ok(n.w.AAIApp.state());
});
test('lock wipes memory and the screen; passphrase is not kept anywhere', async () => {
  const t = boot(); await t.ready();
  await t.chooseFile('b.aaib', sealed); await t.unlock(PASS);
  assert.match(t.text(), /Acme Test|Panda A/);
  t.$('lockBtn').click();
  assert.equal(t.w.AAIApp.state(), null);
  assert.ok(!/Acme|Panda|Overdue Co/.test(t.text()));
  assert.equal(t.$('pass').value + t.$('pin').value, '');
  assert.ok(!t.w.location.href.includes(PASS) && !t.w.location.href.includes(PIN));
  assert.equal(t.w.localStorage.length + t.w.sessionStorage.length, 0);
});
test('idle for 5 minutes locks the app', async () => {
  const t = boot(); await t.ready();
  await t.chooseFile('b.aaib', sealed); await t.unlock(PASS);
  const real = t.w.Date.now, start = real();
  t.w.Date.now = () => start + 4 * 60 * 1000; t.w.AAIApp.idleCheck();
  assert.ok(t.w.AAIApp.state(), 'still unlocked at 4 min');
  t.w.Date.now = () => start + 5 * 60 * 1000 + 1000; t.w.AAIApp.idleCheck();
  assert.equal(t.w.AAIApp.state(), null);
  await waitFor(() => !t.$('lockView').hidden && !t.$('pinForm').hidden, 'the PIN screen'); assert.ok(!t.$('lockView').hidden); assert.ok(!t.$('pinForm').hidden, 'back at the PIN screen'); assert.ok(t.$('passForm').hidden);
});
test('header shows bundle age: neutral, amber after 7 days, red after 30', async () => {
  const day = 864e5, age = async (d) => { const t = boot(); await t.ready(); await t.chooseFile('b', await seal(fixture({ createdAt: new Date(Date.now() - d * day).toISOString() }), PASS)); await t.unlock(PASS); return t.$('bundleAge'); };
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
  const t = boot(); await t.ready();
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
  const t = boot(); await t.ready();
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
  const t = boot(); await t.ready();
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
  assert.equal(/CACHE = '([^']+)'/.exec(read('sw.js'))[1], /CACHE_NAME = '([^']+)'/.exec(read('app.js'))[1], 'the version shown is the cache name');
});
test('public-repo safety: no .aaib or .aaio file and no JSON over 100 KB', () => {
  const bad = [];
  (function walk(d) {
    for (const e of fs.readdirSync(d, { withFileTypes: true })) {
      if (['.git', 'node_modules', 'phone-test'].includes(e.name) || (d === ROOT && e.name === 'graphify-out')) continue;
      const p = path.join(d, e.name);
      if (e.isDirectory()) walk(p);
      else if (/\.aaio?$/i.test(e.name) || (/\.json$/i.test(e.name) && fs.statSync(p).size > 100 * 1024)) bad.push(path.relative(ROOT, p));
    }
  })(ROOT);
  assert.deepEqual(bad, []);
  const ig = read('.gitignore'); assert.ok(ig.includes('*.aaib') && ig.includes('*.aaio') && ig.includes('phone-test/'));
});

/* ---------- capture and outbox ---------- */
const OPASS = 'outbox-pass-1';
const click = (root, txt) => { const b = [...root.querySelectorAll('button, a')].find((x) => x.textContent.trim().startsWith(txt)); assert.ok(b, 'no button ' + txt); b.click(); return b; };
const type = (w, el, v) => { el.value = v; el.dispatchEvent(new w.Event('input', { bubbles: true })); el.dispatchEvent(new w.Event('change', { bubbles: true })); };
const unlocked = async (b) => { const t = boot(); await t.ready(); await t.chooseFile('b', await seal(b || fixture(), PASS)); await t.unlock(PASS); return t; };
const dump = (w) => new Promise((res) => { const r = w.indexedDB.open('aai-mobile'); r.onsuccess = () => { const g = r.result.transaction('outbox').objectStore('outbox').getAll(); g.onsuccess = () => res(g.result); }; });
// Save and wait until the record is really in IndexedDB (the app writes asynchronously).
const clickSave = async (t, root, n = 1) => {
  const before = (await dump(t.w)).length;
  click(root, 'Save to outbox');
  await waitFor(async () => (await dump(t.w)).length >= before + n, 'the record to be saved');
  await tick(10);
};
// renderSettings() is async and replaces the screen's children, so wait for a NEW first child: typing into the old one would be lost.
const openSettings = async (t) => {
  const old = t.$('tab-settings').firstChild;
  t.$('setBtn').click();
  await waitFor(() => !t.$('tab-settings').hidden && t.$('tab-settings').firstChild && t.$('tab-settings').firstChild !== old && t.$('tab-settings').textContent.includes('Outbox passphrase'), 'Settings to render');
};
const lead = async (t, company, temp) => {
  click(t.$('tab-new'), 'New customer or lead');
  const f = t.$('tab-new'); type(t.w, f.querySelector('[aria-label=Company]'), company); type(t.w, f.querySelector('[aria-label="Met at (show or site)"]'), 'Test Show');
  f.querySelector('select').value = temp || 'hot'; await clickSave(t, f);
};
async function quote(t, lines, custSearch) {
  click(t.$('tab-new'), 'Quote request or order');
  const f = () => t.$('tab-new');
  type(t.w, f().querySelector('[aria-label="Search customers"]'), custSearch || 'acme'); f().querySelector('button.row').click();
  for (const [name, qty] of lines) {
    type(t.w, f().querySelector('[aria-label="Search catalog"]'), name); f().querySelector('button.row').click();
    const q = f().querySelector('[aria-label="Quantity ' + name + '"]'); type(t.w, q, String(qty));
  }
  return f();
}

test('quote pricing matches the Price check cases (core and screen)', async () => {
  const b = fixture();
  b.checks.filter((k) => k.kind === 'quote').forEach((k) => {
    const got = core.priceLines(k.rows, b.catalog, b.rules);
    assert.deepEqual(got.lines.map((l) => l.unit), k.expect.units, k.desc); assert.deepEqual(got.promo, k.expect.promo); assert.deepEqual(got.extra, k.expect.extra); assert.equal(got.total, k.expect.total, k.desc);
  });
  const call = core.priceLines([{ item: 'Printer X', qty: 2 }, { item: 'Zero Bug', qty: 1 }, { item: 'Panda A', qty: 5 }], b.catalog, b.rules);
  assert.deepEqual(call.lines.map((l) => [l.call, l.unit, l.total]), [[true, null, null], [true, null, null], [false, 100, 500]]);
  assert.equal(call.total, 500); assert.equal(call.incomplete, true);
  const t = await unlocked();
  const f = await quote(t, [['Panda A', 6], ['Panda B', 4]]);
  assert.match(f.textContent, /\$90 × 6 = \$540/); assert.match(f.textContent, /Free board −\$90/); assert.match(f.textContent, /Total: \$810/);
  type(t.w, f.querySelector('[aria-label="Search catalog"]'), 'printer'); f.querySelector('button.row').click();
  type(t.w, t.$('tab-new').querySelector('[aria-label="Search catalog"]'), 'Ocean'); t.$('tab-new').querySelector('button.row').click();
  const g = t.$('tab-new'); g.querySelectorAll('select')[g.querySelectorAll('select').length - 1].value = 'Golden Test'; g.querySelectorAll('select')[g.querySelectorAll('select').length - 1].dispatchEvent(new t.w.Event('change', { bubbles: true }));
  assert.match(g.textContent, /Call for price/); assert.match(g.textContent, /Title add \+\$200/); assert.match(g.textContent, /Total: \$2,010/);
  assert.ok(!hasMoneyZero(g.textContent), 'a $0 appeared');
});
test('a lone call-for-price line totals "Call for price", never $0', async () => {
  const t = await unlocked(); const f = await quote(t, [['Printer X', 2]]);
  assert.match(f.textContent, /Total: Call for price/); assert.ok(!hasMoneyZero(f.textContent));
  await clickSave(t, f);
  const [r] = await dump(t.w);
  assert.equal(r.total, null); assert.equal(r.lines[0].unitPrice, null); assert.equal(r.lines[0].lineTotal, null); assert.equal(r.lines[0].callForPrice, true);
});
test('outbox: save, edit, delete; ids, createdAt, app version; badge', async () => {
  const t = await unlocked();
  await lead(t, 'Show Lead Co');
  let [r] = await dump(t.w);
  assert.match(r.id, /^[0-9a-f-]{36}$/); assert.ok(!isNaN(new Date(r.createdAt))); assert.equal(r.appVersion, t.w.AAIApp.APP_VERSION);
  assert.deepEqual([r.kind, r.company, r.metAt, r.temp, r.exportedAt], ['lead', 'Show Lead Co', 'Test Show', 'hot', null]);
  assert.equal(t.$('badge').textContent, '1'); assert.match(t.$('tab-outbox').textContent, /Lead: Show Lead Co/);
  click(t.$('tab-outbox'), 'Edit');
  type(t.w, t.$('tab-new').querySelector('[aria-label=Company]'), 'Renamed Co'); click(t.$('tab-new'), 'Save to outbox');
  await waitFor(async () => ((await dump(t.w))[0] || {}).company === 'Renamed Co', 'the edit to be saved'); await tick(10);
  const all = await dump(t.w); assert.equal(all.length, 1);
  assert.equal(all[0].company, 'Renamed Co'); assert.equal(all[0].id, r.id); assert.equal(all[0].createdAt, r.createdAt); assert.ok(all[0].updatedAt);
  const del = click(t.$('tab-outbox'), 'Delete'); assert.equal((await dump(t.w)).length, 1, 'first tap only arms');
  del.click(); await waitFor(async () => (await dump(t.w)).length === 0, 'the record to be deleted'); await tick(10);
  assert.equal((await dump(t.w)).length, 0); assert.equal(t.$('badge').hidden, true);
});
test('follow-up attaches to a customer or to a lead entered on the phone', async () => {
  const t = await unlocked(); await lead(t, 'Show Lead Co');
  for (const [q, type_] of [['show lead', 'lead'], ['acme', 'customer']]) {
    click(t.$('tab-new'), 'Follow-up note'); const f = t.$('tab-new');
    type(t.w, f.querySelector('[aria-label="Search customers and leads"]'), q); f.querySelector('button.row').click();
    type(t.w, f.querySelector('[aria-label=Note]'), 'call back'); type(t.w, f.querySelector('[aria-label="Due date"]'), '2026-11-01'); await clickSave(t, f);
  }
  const fu = (await dump(t.w)).filter((r) => r.kind === 'followup');
  assert.deepEqual(fu.map((r) => r.target.type).sort(), ['customer', 'lead']);
  assert.equal(fu.find((r) => r.target.type === 'lead').target.id, (await dump(t.w)).find((r) => r.kind === 'lead').id);
  assert.equal(fu[0].due, '2026-11-01');
});

// Sets the outbox passphrase from Settings (typed twice).
async function setObpass(t, pass) {
  await openSettings(t);
  const S = t.$('tab-settings'); type(t.w, S.querySelector('[aria-label="Outbox passphrase"]'), pass); type(t.w, S.querySelector('[aria-label="Outbox passphrase again"]'), pass);
  click(S, 'Set outbox passphrase'); await waitFor(async () => (await rawKv(t.w)).obpass, 'the outbox passphrase to be stored'); await tick(10); t.$('tab-outbox').hidden = true;
}
// Settings -> PIN -> Show. Returns the passphrase text shown (or the error).
async function shownPass(t, pin) {
  await openSettings(t);
  const S = t.$('tab-settings'); type(t.w, S.querySelector('[aria-label="PIN to show the outbox passphrase"]'), pin); click(S, 'Show'); await waitFor(() => S.querySelector('.card b') || /Wrong PIN/.test(S.textContent), 'the passphrase or a Wrong PIN message'); await tick(10);
  const b = S.querySelector('.card b'); return b ? b.textContent : S.textContent;
}
// Drives Export. With a saved outbox passphrase there is nothing to type; otherwise types it twice. Returns what share() was given.
async function exportFlow(t, { share, pass, ask } = {}) {
  const shared = [];
  Object.defineProperty(t.w.navigator, 'canShare', { configurable: true, value: share ? () => true : undefined });
  Object.defineProperty(t.w.navigator, 'share', { configurable: true, value: share ? async (d) => { shared.push(d); if (share === 'abort') { const e = new Error('x'); e.name = 'AbortError'; throw e; } } : undefined });
  t.w.URL.createObjectURL = () => 'blob:test'; t.w.URL.revokeObjectURL = () => {};
  t.$('tab-outbox').hidden = false;
  const box = t.$('tab-outbox');
  await waitFor(() => [...box.querySelectorAll('button, a')].some((x) => x.textContent.trim().startsWith('Export')), 'the Export button');
  click(box, 'Export');
  if (ask) {
    await waitFor(() => box.querySelectorAll('input[type=password]').length === 2, 'the two passphrase fields');
    const [a, b] = box.querySelectorAll('input[type=password]'); a.value = pass || OPASS; b.value = pass || OPASS; click(box, 'Create file');
  } else assert.ok(!box.querySelector('input[type=password]'), 'no typing once the outbox passphrase is saved');
  await waitFor(() => /File ready/.test(box.textContent), 'the export file to be ready');
  return shared;
}
const readFile = (w, f) => new Promise((res) => { const r = new w.FileReader(); r.onload = () => res(r.result); r.readAsText(f); });

test('export round trip: first export asks once, then reuses; file decrypts on the console path; marks only after share', async () => {
  const t = await unlocked(); await lead(t, 'Show Lead Co');
  await quote(t, [['Panda A', 6], ['Panda B', 4]]); await clickSave(t, t.$('tab-new'));
  const shared = await exportFlow(t, { share: true, ask: true });
  assert.match(t.$('tab-outbox').textContent, /aai-outbox-\d{4}-\d\d-\d\d-\d{4}\.aaio/);
  assert.equal((await dump(t.w)).filter((r) => r.exportedAt).length, 0, 'not marked before sharing');
  click(t.$('tab-outbox'), 'Share'); await waitFor(() => shared.length === 1, 'share() to be called');
  assert.equal(shared.length, 1);
  const text = await readFile(t.w, shared[0].files[0]);
  assert.deepEqual(Object.keys(JSON.parse(text)).sort(), ['ct', 'iv', 'salt', 'v']); assert.ok(!text.includes('Show Lead'));
  const o = await unseal(text, OPASS);                 // independent of the app's code, as the console does it
  assert.equal(o.version, 1); assert.ok(o.createdAt); assert.equal(o.deviceLabel, 'iPhone'); assert.equal(o.records.length, 2);
  assert.deepEqual(Object.keys(await core.openOutbox(text, OPASS, webcrypto.subtle)), Object.keys(o));
  const q = o.records.find((r) => r.kind === 'quote');
  assert.deepEqual([q.total, q.priceListDate, q.lines[0].name, q.lines[0].qty, q.lines[0].unitPrice, q.lines[0].lineTotal, q.lines[0].priceListDate], [810, 'Price list TEST', 'Panda A', 6, 90, 540, 'Price list TEST']);
  assert.ok(o.records.every((r) => !('exportedAt' in r) && r.id && r.createdAt && r.appVersion));
  await waitFor(async () => (await dump(t.w)).filter((r) => r.exportedAt).length === 2, 'records to be marked exported'); await tick(10);
  assert.equal((await dump(t.w)).filter((r) => r.exportedAt).length, 2, 'marked after share completed');
  assert.equal(t.$('badge').hidden, true); assert.match(t.$('tab-outbox').textContent, /Exported, kept 30 days/);
  // second export, even after a lock and a PIN unlock: no typing, same passphrase
  await lead(t, 'Second Co'); t.$('lockBtn').click(); await t.unlock(PASS);
  const again = await exportFlow(t, { share: true }); click(t.$('tab-outbox'), 'Share'); await waitFor(() => again.length === 1, 'share() to be called');
  const o2 = await unseal(await readFile(t.w, again[0].files[0]), OPASS);
  assert.deepEqual(o2.records.map((r) => r.company), ['Second Co']);
  const stored = JSON.stringify(await rawKv(t.w)); assert.ok(!stored.includes(OPASS), 'outbox passphrase is not stored in the clear');
});
test('outbox passphrase from Settings: 8+ chars twice; shown only after the PIN; used by export', async () => {
  const t = await unlocked(); await lead(t, 'Show Lead Co');
  await openSettings(t);
  const S = t.$('tab-settings'), fill = (l, v) => type(t.w, S.querySelector('[aria-label="' + l + '"]'), v);
  fill('Outbox passphrase', 'short'); fill('Outbox passphrase again', 'short'); click(S, 'Set outbox passphrase'); await waitFor(() => /8 or more/.test(S.textContent), 'the too-short message'); assert.match(S.textContent, /8 or more/);
  fill('Outbox passphrase', OPASS); fill('Outbox passphrase again', OPASS + 'x'); click(S, 'Set outbox passphrase'); await waitFor(() => /differ/.test(S.textContent), 'the passphrases-differ message'); assert.match(S.textContent, /differ/);
  await openSettings(t); assert.ok(![...t.$('tab-settings').querySelectorAll('button')].some((b) => b.textContent === 'Show'), 'no Show button before it is set');
  assert.ok(!(await rawKv(t.w)).obpass);
  await setObpass(t, OPASS); assert.ok((await rawKv(t.w)).obpass);
  assert.notEqual(await shownPass(t, otherPin(PIN)), OPASS); assert.match(t.$('tab-settings').textContent, /Wrong PIN/);
  setT(t, 20000); assert.equal(await shownPass(t, PIN), OPASS);
  const shared = await exportFlow(t, { share: true }); click(t.$('tab-outbox'), 'Share'); await waitFor(() => shared.length === 1, 'share() to be called');
  assert.deepEqual((await unseal(await readFile(t.w, shared[0].files[0]), OPASS)).records.map((r) => r.company), ['Show Lead Co']);
  t.$('lockBtn').click(); assert.ok(!/outbox-pass|Outbox passphrase/.test(t.$('tab-settings').textContent), 'cleared on lock');
});
test('wrong passphrase on the exported file fails; tampering fails', async () => {
  const t = await unlocked(); await lead(t, 'Show Lead Co'); await setObpass(t, OPASS);
  const shared = await exportFlow(t, { share: true }); click(t.$('tab-outbox'), 'Share'); await waitFor(() => shared.length === 1, 'share() to be called');
  const text = await readFile(t.w, shared[0].files[0]);
  await assert.rejects(core.openOutbox(text, 'wrong-wrong-wrong', webcrypto.subtle), /Wrong passphrase/);
  await assert.rejects(core.openOutbox(await seal(fixture(), PASS), OPASS, webcrypto.subtle), /not a version 1 outbox|Wrong passphrase/);
});
test('export marks nothing when share is cancelled; "I sent it" marks; mismatched first-export passphrases are refused', async () => {
  const t = await unlocked(); await lead(t, 'Show Lead Co'); await setObpass(t, OPASS);
  await exportFlow(t, { share: 'abort' }); click(t.$('tab-outbox'), 'Share');
  await waitFor(() => /Nothing is marked as sent/.test(t.$('tab-outbox').textContent), 'the cancelled-share message'); await tick(10);
  assert.match(t.$('tab-outbox').textContent, /Nothing is marked as sent/);
  assert.equal((await dump(t.w)).filter((r) => r.exportedAt).length, 0);
  click(t.$('tab-outbox'), 'Cancel'); assert.equal((await dump(t.w))[0].exportedAt, null);
  // no share support: download link, then "I sent it"
  await exportFlow(t, {}); assert.ok(t.$('tab-outbox').querySelector('a[download]'));
  assert.equal(t.$('tab-outbox').querySelector('a[download]').getAttribute('download').endsWith('.aaio'), true);
  assert.equal((await dump(t.w))[0].exportedAt, null);
  click(t.$('tab-outbox'), 'I sent it'); await waitFor(async () => (await dump(t.w))[0].exportedAt, 'the record to be marked sent'); await tick(10);
  assert.ok((await dump(t.w))[0].exportedAt);
  // a phone with no saved outbox passphrase: mismatched or short entries are refused
  const u = await unlocked(); await lead(u, 'Second Co'); const box = u.$('tab-outbox'); click(box, 'Export'); await waitFor(() => box.querySelectorAll('input[type=password]').length === 2, 'the two passphrase fields');
  const [a, b] = box.querySelectorAll('input[type=password]'); a.value = OPASS; b.value = OPASS + 'x'; click(box, 'Create file');
  assert.match(box.textContent, /differ/); assert.ok(!/File ready/.test(box.textContent)); assert.ok(!(await rawKv(u.w)).obpass);
  a.value = 'short'; b.value = 'short'; click(box, 'Create file'); assert.match(box.textContent, /8 or more/);
});
test('exported records are kept 30 days for re-export, then purged', async () => {
  const t = await unlocked(); await lead(t, 'Show Lead Co'); await setObpass(t, OPASS);
  await exportFlow(t, {}); click(t.$('tab-outbox'), 'I sent it'); await waitFor(async () => (await dump(t.w))[0].exportedAt, 'the record to be marked sent'); await tick(10);
  const [r] = await dump(t.w);
  const real = t.w.Date.now, nowMs = real();
  t.w.Date.now = () => nowMs + 29 * 864e5; t.$('lockBtn').click(); await t.unlock(PASS);
  await waitFor(() => /Re-export these 1/.test(t.$('tab-outbox').textContent), 'the outbox to list the exported record'); await tick(10);
  assert.match(t.$('tab-outbox').textContent, /Show Lead Co/); assert.match(t.$('tab-outbox').textContent, /Re-export these 1/);
  // purge compares against the real clock inside the app, so age the stored record instead
  r.exportedAt = new Date(Date.now() - 31 * 864e5).toISOString();
  await new Promise((res) => { const q = t.w.indexedDB.open('aai-mobile'); q.onsuccess = () => { const tx = q.result.transaction('outbox', 'readwrite'); tx.objectStore('outbox').put(r); tx.oncomplete = res; }; });
  t.$('lockBtn').click(); await t.unlock(PASS);
  await waitFor(async () => (await dump(t.w)).length === 0, 'the purge'); await tick(10);
  assert.equal((await dump(t.w)).length, 0); assert.ok(!/Show Lead Co/.test(t.$('tab-outbox').textContent));
});
test('lock empties the capture and outbox screens; idle lock still applies', async () => {
  const t = await unlocked(); await lead(t, 'Secret Lead Co');
  click(t.$('tab-new'), 'New customer or lead'); type(t.w, t.$('tab-new').querySelector('[aria-label=Company]'), 'Typed Draft Co');
  assert.match(t.text(), /Secret Lead Co/);
  const start = t.w.Date.now(); t.w.Date.now = () => start + 5 * 60 * 1000 + 1000; t.w.AAIApp.idleCheck();
  assert.equal(t.w.AAIApp.state(), null);
  assert.ok(!/Secret Lead|Typed Draft/.test(t.text())); assert.equal(t.$('tab-outbox').childNodes.length + t.$('tab-new').childNodes.length, 0); assert.equal(t.$('badge').hidden, true);
});

/* ---------- layout, quantity entry, full customer list ---------- */
test('layout CSS: fixed full-viewport shell, one scroll region, safe-area insets, cover viewport', () => {
  const css = read('styles.css'), html = read('index.html');
  assert.match(css, /body\{[^}]*position:fixed;inset:0;(?![^}]*height)[^}]*overflow:hidden/);
  assert.match(css, /html\{[^}]*height:100%[^}]*overflow:hidden[^}]*background:var\(--paper\)/);
  assert.match(css, /#tabs\{[^}]*background:var\(--surface\)[^}]*padding:0 0 env\(safe-area-inset-bottom\)/);
  assert.ok(!/body\{[^}]*padding[^}]*safe-area-inset-bottom/.test(css));
  assert.match(css, /#appView>section\{[^}]*overflow-y:auto[^}]*-webkit-overflow-scrolling:touch[^}]*overscroll-behavior:contain/);
  assert.match(css, /env\(safe-area-inset-top\)/); assert.match(css, /env\(safe-area-inset-bottom\)/);
  assert.match(css, /#tabs\{(?![^}]*position:fixed)/);
  assert.match(html, /viewport-fit=cover/); assert.match(html, /black-translucent/);
});
test('quantity entry: tier boundaries, highlight, call-for-price, clears on Lock', async () => {
  const t = await unlocked(), box = t.$('tab-prices');
  const card = (n) => [...box.querySelectorAll('.card')].find((c) => c.dataset.name === n);
  const qty = card('Panda A').querySelector('input[inputmode="numeric"]');
  assert.equal(qty.getAttribute('pattern'), '[0-9]*');
  for (const [n, unit, tier] of [[1, 100, '1–9'], [9, 100, '1–9'], [10, 90, '10–29'], [29, 90, '10–29'], [30, 80, '30+'], [99, 80, '30+'], [100, 80, '30+']]) {
    type(t.w, qty, String(n));
    const c = card('Panda A');
    assert.equal(c.querySelector('.hit').textContent, tier, 'tier at ' + n);
    assert.ok(c.querySelector('.calc').textContent.includes(n + ' × $' + unit + ' = $' + (n * unit).toLocaleString('en-US')), 'line at ' + n);
  }
  type(t.w, qty, '99999'); assert.equal(qty.value, '9999');
  type(t.w, qty, 'a0b'); assert.equal(qty.value, ''); assert.equal(card('Panda A').querySelector('.calc').textContent, '');
  const call = card('Printer X').querySelector('input'); type(t.w, call, '5');
  assert.match(card('Printer X').querySelector('.calc').textContent, /Call for price/); assert.ok(!hasMoneyZero(card('Printer X').textContent));
  type(t.w, qty, '6'); type(t.w, card('Panda B').querySelector('input'), '4'); // pooled 10 -> $90 tier on both
  assert.match(card('Panda A').querySelector('.calc').textContent, /6 × \$90 = \$540.*free board credit/);
  type(t.w, box.querySelector('input[type=search]'), 'panda a'); // survives re-filter
  assert.equal(card('Panda A').querySelector('input').value, '6');
  t.$('lockBtn').click();
  assert.equal(t.$('tab-prices').childNodes.length, 0);
});
test('customers: full sorted list when the search is empty, chunked, filter still works', async () => {
  const b = fixture(); b.customers = [];
  for (let i = 0; i < 120; i++) b.customers.push({ key: 'k' + i, name: 'Cust ' + String(119 - i).padStart(3, '0'), contact: '', address: '', city: 'X', state: 'IL', zip: '60000', phones: [], email: '', lastOrder: null, net12: 0, invoices: [] });
  const t = await unlocked(b), box = t.$('tab-customers');
  assert.match(box.textContent, /120 customers/);
  let rows = box.querySelectorAll('button.row'); assert.equal(rows.length, 50);
  assert.match(rows[0].textContent, /Cust 000/); assert.match(rows[49].textContent, /Cust 049/);
  [...box.querySelectorAll('button')].find((x) => x.textContent === 'Show more').click();
  assert.equal(box.querySelectorAll('button.row').length, 100);
  type(t.w, box.querySelector('input'), 'cust 11'); assert.match(box.textContent, /11 found/);
  type(t.w, box.querySelector('input'), ''); assert.match(box.textContent, /120 customers/);
});

/* ---------- title add only where the bundle says ta === true ---------- */
const titleSelects = (t) => [...t.$('tab-new').querySelectorAll('select')].filter((s) => s.getAttribute('aria-label') === 'Title');
const withTa = (ta) => { const b = fixture(); b.catalog.forEach((c) => { if (c.name === 'Ocean Test') { if (ta === undefined) delete c.ta; else c.ta = ta; } }); return b; };
test('title picker: ta true shows it, false or missing hides it', async () => {
  for (const [ta, shown] of [[true, 1], [false, 0], [undefined, 0]]) {
    const t = await unlocked(withTa(ta)); await quote(t, [['Ocean Test', 1], ['Panda A', 1]]);
    assert.equal(titleSelects(t).length, shown, 'ta=' + ta);
  }
});
test('no title means no $200 add, even on a ta item', async () => {
  const t = await unlocked(withTa(true)); const f = await quote(t, [['Ocean Test', 3]]);
  assert.ok(!/Title add/.test(f.textContent)); assert.match(f.textContent, /Total: \$3,000/);
  const [s] = titleSelects(t); s.value = 'Golden Test'; s.dispatchEvent(new t.w.Event('change', { bubbles: true }));
  assert.match(t.$('tab-new').textContent, /Title add \+\$600/);
});
test('re-export note shows only when the bundle has no ta data', async () => {
  const NOTE = /Re-export the phone bundle to enable title add/;
  const old = await unlocked(withTa(undefined)); assert.match(old.$('tab-prices').textContent, NOTE);
  click(old.$('tab-new'), 'Quote request or order'); assert.match(old.$('tab-new').textContent, NOTE);
  const cur = await unlocked(withTa(false)); assert.ok(!NOTE.test(cur.$('tab-prices').textContent));
});

/* ---------- visible version, uncached shell fetches, update banner ---------- */
function loadSw(cached) {
  const log = { added: [], fetched: [] }, handlers = {};
  class Request { constructor(u, o) { this.url = typeof u === 'string' ? 'https://aai.test/aai-mobile/' + u : u.url; this.method = 'GET'; this.cache = o && o.cache; } }
  const cache = { addAll: async (rs) => { log.added.push(...rs); }, match: async () => cached, put: async () => {} };
  const ctx = { URL, Request, caches: { open: async () => cache, keys: async () => [], delete: async () => {} }, fetch: async (r) => { log.fetched.push(r); return { ok: true, clone() { return this; } }; },
    self: { addEventListener: (n, f) => { handlers[n] = f; }, location: { origin: 'https://aai.test' }, skipWaiting: async () => {}, clients: { claim: async () => {} } } };
  ctx.self.caches = ctx.caches; vm.createContext(ctx);
  const shell = vm.runInContext(read('sw.js') + '\n;SHELL', ctx);
  return { log, handlers, shell, Request };
}
test('service worker fetches every shell file uncached (cache: reload) on install and on refresh', async () => {
  const s = loadSw(null);
  let p; s.handlers.install({ waitUntil: (x) => { p = x; } }); await p;
  assert.deepEqual(s.log.added.map((r) => r.url.replace('https://aai.test/aai-mobile/', '')), [...s.shell]);
  assert.ok(s.log.added.every((r) => r.cache === 'reload'), 'install requests bypass the HTTP cache');
  for (const hit of [null, { cached: true }]) {   // with or without a cached copy, the background refresh is uncached
    const w = loadSw(hit); let resp;
    w.handlers.fetch({ request: new w.Request('app.js'), respondWith: (x) => { resp = x; } }); await resp;
    await waitFor(() => w.log.fetched.length === 1, 'the background refresh'); assert.equal(w.log.fetched.length, 1); assert.equal(w.log.fetched[0].cache, 'reload');
  }
});
test('update banner: shows when a new worker finishes installing under an old one, reloads on tap, survives Lock, not on first install', async () => {
  const mk = (controller) => {
    const l = {}, wl = {}, worker = { state: 'installing', addEventListener: (n, f) => { wl[n] = f; } };
    const reg = { installing: null, waiting: null, addEventListener: (n, f) => { l[n] = f; }, update: async () => {} };
    return { l, wl, worker, reg, sw: { controller, register: async () => reg, addEventListener() {} } };
  };
  const m = mk({}), t = boot(undefined, (w) => Object.defineProperty(w.navigator, 'serviceWorker', { value: m.sw, configurable: true })); await waitFor(() => m.l.updatefound, 'the app to listen for worker updates');
  assert.equal(t.$('update').hidden, true); assert.equal(t.$('update').textContent, 'Update ready, tap to reload');
  m.reg.installing = m.worker; m.l.updatefound(); m.wl.statechange(); assert.equal(t.$('update').hidden, true, 'still installing');
  m.worker.state = 'installed'; m.wl.statechange(); assert.equal(t.$('update').hidden, false);
  t.$('lockBtn').click(); assert.equal(t.$('update').hidden, false, 'Lock does not hide it');
  let reloaded = 0; t.w.AAIApp.reload = () => { reloaded++; }; t.$('update').click(); assert.equal(reloaded, 1);
  const f = mk(null), t2 = boot(undefined, (w) => Object.defineProperty(w.navigator, 'serviceWorker', { value: f.sw, configurable: true })); await waitFor(() => f.l.updatefound, 'the app to listen for worker updates');
  f.reg.installing = f.worker; f.l.updatefound(); f.worker.state = 'installed'; f.wl.statechange();
  assert.equal(t2.$('update').hidden, true, 'first install has no older worker, so no banner');
});

/* ---------- repo safety: no PINs, no secrets, no data files tracked ---------- */
test('repo safety: no .aaib/.aaio tracked and no PIN-like literal in any tracked file', () => {
  const files = execFileSync('git', ['ls-files'], { cwd: ROOT, encoding: 'utf8' }).split('\n').filter(Boolean);
  assert.deepEqual(files.filter((f) => /\.aaio?$/i.test(f)), []);
  const hits = [];
  for (const f of files) {
    if (/\.(png|jpg|ico)$/i.test(f) || !fs.existsSync(path.join(ROOT, f))) continue;
    read(f).split('\n').forEach((line, i) => {
      if (/\b\w*pin\w*\b\s*[:=,(]\s*['"`]\d{4,8}['"`]/i.test(line) || /\bpin\b[^\n]{0,24}['"`]\d{4,8}['"`]/i.test(line)) hits.push(f + ':' + (i + 1));
    });
  }
  assert.deepEqual(hits, [], 'PIN-like literal tracked');
});
