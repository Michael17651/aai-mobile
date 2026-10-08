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
  const stored = await new Promise((res) => { const r = t.w.indexedDB.open('aai-mobile'); r.onsuccess = () => { const g = r.result.transaction('kv').objectStore('kv').get('bundle'); g.onsuccess = () => res(g.result); }; });
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
test('public-repo safety: no .aaib or .aaio file and no JSON over 100 KB', () => {
  const bad = [];
  (function walk(d) {
    for (const e of fs.readdirSync(d, { withFileTypes: true })) {
      if (['.git', 'node_modules', 'phone-test'].includes(e.name)) continue;
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
const unlocked = async (b) => { const t = boot(); await tick(); await t.chooseFile('b', await seal(b || fixture(), PASS)); await t.unlock(PASS); return t; };
const dump = (w) => new Promise((res) => { const r = w.indexedDB.open('aai-mobile'); r.onsuccess = () => { const g = r.result.transaction('outbox').objectStore('outbox').getAll(); g.onsuccess = () => res(g.result); }; });
const lead = async (t, company, temp) => {
  click(t.$('tab-new'), 'New customer or lead');
  const f = t.$('tab-new'); type(t.w, f.querySelector('[aria-label=Company]'), company); type(t.w, f.querySelector('[aria-label="Met at (show or site)"]'), 'Test Show');
  f.querySelector('select').value = temp || 'hot'; click(f, 'Save to outbox'); await tick(60);
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
  click(f, 'Save to outbox'); await tick(60);
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
  type(t.w, t.$('tab-new').querySelector('[aria-label=Company]'), 'Renamed Co'); click(t.$('tab-new'), 'Save to outbox'); await tick(60);
  const all = await dump(t.w); assert.equal(all.length, 1);
  assert.equal(all[0].company, 'Renamed Co'); assert.equal(all[0].id, r.id); assert.equal(all[0].createdAt, r.createdAt); assert.ok(all[0].updatedAt);
  const del = click(t.$('tab-outbox'), 'Delete'); assert.equal((await dump(t.w)).length, 1, 'first tap only arms');
  del.click(); await tick(60);
  assert.equal((await dump(t.w)).length, 0); assert.equal(t.$('badge').hidden, true);
});
test('follow-up attaches to a customer or to a lead entered on the phone', async () => {
  const t = await unlocked(); await lead(t, 'Show Lead Co');
  for (const [q, type_] of [['show lead', 'lead'], ['acme', 'customer']]) {
    click(t.$('tab-new'), 'Follow-up note'); const f = t.$('tab-new');
    type(t.w, f.querySelector('[aria-label="Search customers and leads"]'), q); f.querySelector('button.row').click();
    type(t.w, f.querySelector('[aria-label=Note]'), 'call back'); type(t.w, f.querySelector('[aria-label="Due date"]'), '2026-11-01'); click(f, 'Save to outbox'); await tick(60);
  }
  const fu = (await dump(t.w)).filter((r) => r.kind === 'followup');
  assert.deepEqual(fu.map((r) => r.target.type).sort(), ['customer', 'lead']);
  assert.equal(fu.find((r) => r.target.type === 'lead').target.id, (await dump(t.w)).find((r) => r.kind === 'lead').id);
  assert.equal(fu[0].due, '2026-11-01');
});

// Drives Export -> passphrases -> Create file. Returns what share() was given (if share exists).
async function exportFlow(t, { share, pass } = {}) {
  const shared = [];
  Object.defineProperty(t.w.navigator, 'canShare', { configurable: true, value: share ? () => true : undefined });
  Object.defineProperty(t.w.navigator, 'share', { configurable: true, value: share ? async (d) => { shared.push(d); if (share === 'abort') { const e = new Error('x'); e.name = 'AbortError'; throw e; } } : undefined });
  t.w.URL.createObjectURL = () => 'blob:test'; t.w.URL.revokeObjectURL = () => {};
  const box = t.$('tab-outbox'); click(box, 'Export');
  const [a, b] = box.querySelectorAll('input[type=password]'); a.value = pass || OPASS; b.value = pass || OPASS;
  click(box, 'Create file'); for (let i = 0; i < 100 && !/File ready/.test(box.textContent); i++) await tick(30);
  return shared;
}
const readFile = (w, f) => new Promise((res) => { const r = new w.FileReader(); r.onload = () => res(r.result); r.readAsText(f); });

test('export round trip: file layout, decrypt, JSON shape, marks only after share completes', async () => {
  const t = await unlocked(); await lead(t, 'Show Lead Co');
  await quote(t, [['Panda A', 6], ['Panda B', 4]]); click(t.$('tab-new'), 'Save to outbox'); await tick(60);
  const shared = await exportFlow(t, { share: true });
  assert.match(t.$('tab-outbox').textContent, /aai-outbox-\d{4}-\d\d-\d\d-\d{4}\.aaio/);
  assert.equal((await dump(t.w)).filter((r) => r.exportedAt).length, 0, 'not marked before sharing');
  click(t.$('tab-outbox'), 'Share'); await tick(80);
  assert.equal(shared.length, 1);
  const text = await readFile(t.w, shared[0].files[0]);
  assert.deepEqual(Object.keys(JSON.parse(text)).sort(), ['ct', 'iv', 'salt', 'v']); assert.ok(!text.includes('Show Lead'));
  const o = await core.openOutbox(text, OPASS, webcrypto.subtle);
  assert.equal(o.version, 1); assert.ok(o.createdAt); assert.equal(o.deviceLabel, 'iPhone'); assert.equal(o.records.length, 2);
  const q = o.records.find((r) => r.kind === 'quote');
  assert.deepEqual([q.total, q.priceListDate, q.lines[0].name, q.lines[0].qty, q.lines[0].unitPrice, q.lines[0].lineTotal, q.lines[0].priceListDate], [810, 'Price list TEST', 'Panda A', 6, 90, 540, 'Price list TEST']);
  assert.ok(o.records.every((r) => !('exportedAt' in r) && r.id && r.createdAt && r.appVersion));
  assert.equal((await dump(t.w)).filter((r) => r.exportedAt).length, 2, 'marked after share completed');
  assert.equal(t.$('badge').hidden, true);
  assert.match(t.$('tab-outbox').textContent, /Exported, kept 30 days/);
});
test('wrong passphrase on the exported file fails; tampering fails', async () => {
  const t = await unlocked(); await lead(t, 'Show Lead Co');
  const shared = await exportFlow(t, { share: true }); click(t.$('tab-outbox'), 'Share'); await tick(80);
  const text = await readFile(t.w, shared[0].files[0]);
  await assert.rejects(core.openOutbox(text, 'wrong-wrong-wrong', webcrypto.subtle), /Wrong passphrase/);
  await assert.rejects(core.openOutbox(await seal(fixture(), PASS), OPASS, webcrypto.subtle), /not a version 1 outbox|Wrong passphrase/);
});
test('export marks nothing when share is cancelled; "I sent it" marks; mismatched passphrases are refused', async () => {
  const t = await unlocked(); await lead(t, 'Show Lead Co');
  await exportFlow(t, { share: 'abort' }); click(t.$('tab-outbox'), 'Share'); await tick(80);
  assert.match(t.$('tab-outbox').textContent, /Nothing is marked as sent/);
  assert.equal((await dump(t.w)).filter((r) => r.exportedAt).length, 0);
  click(t.$('tab-outbox'), 'Cancel'); assert.equal((await dump(t.w))[0].exportedAt, null);
  // no share support: download link, then "I sent it"
  await exportFlow(t, {}); assert.ok(t.$('tab-outbox').querySelector('a[download]'));
  assert.equal(t.$('tab-outbox').querySelector('a[download]').getAttribute('download').endsWith('.aaio'), true);
  assert.equal((await dump(t.w))[0].exportedAt, null);
  click(t.$('tab-outbox'), 'I sent it'); await tick(80);
  assert.ok((await dump(t.w))[0].exportedAt);
  // mismatched passphrases
  await lead(t, 'Second Co'); const box = t.$('tab-outbox'); click(box, 'Export');
  const [a, b] = box.querySelectorAll('input[type=password]'); a.value = OPASS; b.value = OPASS + 'x'; click(box, 'Create file');
  assert.match(box.textContent, /differ/); assert.ok(!/File ready/.test(box.textContent));
});
test('exported records are kept 30 days for re-export, then purged', async () => {
  const t = await unlocked(); await lead(t, 'Show Lead Co');
  await exportFlow(t, {}); click(t.$('tab-outbox'), 'I sent it'); await tick(80);
  const [r] = await dump(t.w);
  const real = t.w.Date.now, nowMs = real();
  t.w.Date.now = () => nowMs + 29 * 864e5; t.$('lockBtn').click(); await t.unlock(PASS); await tick(80);
  assert.match(t.$('tab-outbox').textContent, /Show Lead Co/); assert.match(t.$('tab-outbox').textContent, /Re-export these 1/);
  // purge compares against the real clock inside the app, so age the stored record instead
  r.exportedAt = new Date(Date.now() - 31 * 864e5).toISOString();
  await new Promise((res) => { const q = t.w.indexedDB.open('aai-mobile'); q.onsuccess = () => { const tx = q.result.transaction('outbox', 'readwrite'); tx.objectStore('outbox').put(r); tx.oncomplete = res; }; });
  t.$('lockBtn').click(); await t.unlock(PASS); await tick(80);
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
