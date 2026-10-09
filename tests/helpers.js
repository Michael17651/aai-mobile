'use strict';
// Synthetic fixtures + a jsdom harness. Nothing here is real company data.
const fs = require('fs'), path = require('path');
const { webcrypto } = require('node:crypto');
const { JSDOM } = require('jsdom');
const { IDBFactory } = require('fake-indexeddb');
const ROOT = path.join(__dirname, '..');
const read = (f) => fs.readFileSync(path.join(ROOT, f), 'utf8');
const b64 = (u8) => Buffer.from(u8).toString('base64');

// Built straight from the documented format, not with the app's code.
async function seal(bundle, pass) {
  const s = webcrypto.subtle, salt = webcrypto.getRandomValues(new Uint8Array(16)), iv = webcrypto.getRandomValues(new Uint8Array(12));
  const base = await s.importKey('raw', new TextEncoder().encode(pass), 'PBKDF2', false, ['deriveKey']);
  const key = await s.deriveKey({ name: 'PBKDF2', salt, iterations: 600000, hash: 'SHA-256' }, base, { name: 'AES-GCM', length: 256 }, false, ['encrypt']);
  const ct = new Uint8Array(await s.encrypt({ name: 'AES-GCM', iv }, key, new TextEncoder().encode(JSON.stringify(bundle))));
  return JSON.stringify({ v: 1, salt: b64(salt), iv: b64(iv), ct: b64(ct) });
}

// Obviously fake values, generated per test run; nothing secret is written in the repo.
const rndPin = () => String(webcrypto.getRandomValues(new Uint32Array(1))[0] % 9000 + 1000);
const otherPin = (p) => String((Number(p) + 1) % 10000).padStart(4, '0');
const PIN = rndPin();

// Independent decrypt of the documented .aaib/.aaio layout (the console's path), not the app's code.
async function unseal(text, pass) {
  const f = JSON.parse(text), s = webcrypto.subtle, d = (x) => new Uint8Array(Buffer.from(x, 'base64'));
  const base = await s.importKey('raw', new TextEncoder().encode(pass), 'PBKDF2', false, ['deriveKey']);
  const key = await s.deriveKey({ name: 'PBKDF2', salt: d(f.salt), iterations: 600000, hash: 'SHA-256' }, base, { name: 'AES-GCM', length: 256 }, false, ['decrypt']);
  return JSON.parse(new TextDecoder().decode(await s.decrypt({ name: 'AES-GCM', iv: d(f.iv) }, key, d(f.ct))));
}

const tiers = [[1, 100], [10, 90], [30, 80]];
function fixture(over) {
  const b = {
    version: 1, createdAt: new Date().toISOString(), priceListDate: 'Price list TEST',
    customers: [
      { key: 'acme|60008', name: 'Acme Test Co', contact: 'Ann Tester', address: '1 Main St', city: 'Rolling Meadows', state: 'IL', zip: '60008', phones: ['(555) 123-4567', '555-222-0000'], email: 'ann@acme.test', lastOrder: '2026-09-01', net12: 1234.5,
        invoices: [{ no: '26090101', date: '2026-09-01', total: 500, items: ['Widget', 'Gadget'] }] },
      { key: 'twin|10001', name: 'Twin Test', contact: 'A', address: '5 A St', city: 'Albany', state: 'NY', zip: '10001', phones: ['555-000-1111'], email: '', lastOrder: '2025-01-01', net12: 0, invoices: [] },
      { key: 'twin|10001', name: 'Twin Test', contact: 'B', address: '9 B St', city: 'Buffalo', state: 'NY', zip: '10001', phones: ['555-000-2222'], email: 'b@twin.test', lastOrder: '2025-02-02', net12: 0, invoices: [] }
    ],
    catalog: [
      { name: 'Panda A', tiers, note: 'Master Panda test', flags: ['Limited stock'], group: 'Boards', aliases: ['Pnd A'], mp: true },
      { name: 'Panda B', tiers, note: '', flags: [], group: 'Boards', aliases: [], mp: true },
      { name: 'Ocean Test', tiers: [[1, 1000]], note: 'fish board', flags: [], group: 'Fish', aliases: ['OT'], mp: false, ta: true },
      { name: 'Printer X', tiers: [], note: 'ask sales', flags: ['Must call'], group: 'Parts', aliases: [], mp: false },
      { name: 'Zero Bug', tiers: [[1, 0]], note: '', flags: ['Price TBD'], group: 'Parts', aliases: [], mp: false }
    ],
    followUps: [
      { id: 'c', key: 'k', name: 'Later Co', phone: '555-333-0003', due: '2999-01-01', note: 'far' },
      { id: 'a', key: 'k', name: 'Overdue Co', phone: '555-333-0001', due: '2000-01-01', note: 'old' },
      { id: 'b', key: 'k', name: 'Today Co', phone: '555-333-0002', due: null, note: '' }
    ],
    rules: { titleAdd: { amount: 200, titles: ['Golden Test'] }, freeBoard: { every: 6, basis: 'average' }, mpTierPool: 'pool' },
    checks: [
      { id: 1, kind: 'tier', item: 'Panda A', qty: 30, expect: { unit: 80, total: 2400 } },
      { id: 2, kind: 'quote', desc: 'pool 6+4', rows: [{ item: 'Panda A', qty: 6 }, { item: 'Panda B', qty: 4 }], expect: { units: [90, 90], promo: [-90], extra: [], total: 810 } },
      { id: 3, kind: 'quote', desc: '5 boards', rows: [{ item: 'Panda A', qty: 5 }], expect: { units: [100], promo: [], extra: [], total: 500 } },
      { id: 4, kind: 'quote', desc: 'title add', rows: [{ item: 'OT', qty: 3, title: 'Golden Test' }], expect: { units: [1000], promo: [], extra: [600], total: 3600 } }
    ]
  };
  return Object.assign(b, over || {});
}

// A fresh page with the real index.html + core.js + app.js, fake IndexedDB, real WebCrypto.
function boot(idb, pre) {
  const html = read('index.html').replace(/<script[^>]*><\/script>/g, '');
  const dom = new JSDOM(html, { runScripts: 'outside-only', url: 'https://aai.test/aai-mobile/', pretendToBeVisual: true });
  const w = dom.window; pages.push(w);
  Object.defineProperty(w, 'crypto', { value: webcrypto });
  w.TextEncoder = TextEncoder; w.TextDecoder = TextDecoder;
  w.indexedDB = idb || new IDBFactory();
  if (pre) pre(w);
  w.eval(read('core.js')); w.eval(read('app.js'));
  const $ = (id) => w.document.getElementById(id);
  return {
    w, $, text: () => w.document.body.textContent,
    async chooseFile(name, text) {
      Object.defineProperty($('file'), 'files', { configurable: true, value: [{ name, text: async () => text }] });
      $('file').dispatchEvent(new w.Event('change'));
      await waitFor(() => $('lockHint').textContent.includes('passphrase for ' + name + '.'), 'the lock screen to show the chosen file ' + name);
    },
    // The first lock-screen refresh (reads IndexedDB) has finished: it always writes a hint.
    ready: () => waitFor(() => $('lockHint').textContent !== '', 'the lock screen to render'),
    // Waits for the lock screen's work (PBKDF2 etc.) to finish.
    async settle() { for (let i = 0; i < 200 && (['pinBtn', 'passBtn', 'newPinBtn'].some((id) => $(id).disabled) || /Opening|Saving/.test($('lockMsg').textContent) || i < 2); i++) await sleep(30); },
    async pin(v) { $('pin').value = v; $('pinForm').dispatchEvent(new w.Event('submit', { cancelable: true })); await this.settle(); },
    async passphrase(v) { $('pass').value = v; $('passForm').dispatchEvent(new w.Event('submit', { cancelable: true })); await this.settle(); },
    async setPin(a, b) { $('pin1').value = a; $('pin2').value = b === undefined ? a : b; $('newPinForm').dispatchEvent(new w.Event('submit', { cancelable: true })); await this.settle(); },
    // Whatever the lock screen asks for: the PIN, or the passphrase then a new PIN (PIN is the shared fake).
    async unlock(pass) {
      // A form from before Lock may still be visible, so wait for the screen to stop changing, then require a form.
      await tick(60);
      // The choose-a-PIN hint ('Bundle opened...') is what a stale screen shows right after a passphrase import, so it never counts.
      await waitFor(() => ['pinForm', 'passForm', 'newPinForm'].some((id) => !$(id).hidden) && !/Bundle opened/.test($('lockHint').textContent), 'a lock-screen form');
      const msg = () => $('lockMsg').textContent, before = msg();
      const stopped = () => msg() !== '' && msg() !== before && !/Opening|Saving/.test(msg()); // a NEW error is shown
      const opened = () => !$('appView').hidden;
      if (!$('pinForm').hidden) { await this.pin(PIN); await waitFor(() => opened() || stopped(), 'the app to open'); return; }
      await this.passphrase(pass);
      // The PIN form appears only after the lock screen re-reads IndexedDB, which can lag behind the passphrase work.
      await waitFor(() => !$('newPinForm').hidden || opened() || stopped(), 'the choose-a-PIN step');
      if (!$('newPinForm').hidden) await this.setPin(PIN);
      await waitFor(() => opened() || stopped(), 'the app to open');
    }
  };
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
// "Let the app finish what it is doing": sleep the nominal time, then keep waiting until the page text of every
// booted window has stopped changing for 60 ms (IndexedDB and PBKDF2 work finish later on a loaded machine).
const pages = [];
async function tick(ms) {
  await sleep(ms || 20);
  const snap = () => pages.slice(-4).map((w) => w.document.body.innerHTML).join('\u0000');
  let last = snap(), same = 0;
  for (const t0 = Date.now(); same < 4 && Date.now() - t0 < 2000;) {
    await sleep(15); const now = snap();
    if (now === last) same++; else { same = 0; last = now; }
  }
}
// Poll until cond() (may be async) is truthy; fail loudly with what we were waiting for. Replaces fixed sleeps, which flake under CPU load.
async function waitFor(cond, what, ms = 10000) {
  const t0 = Date.now();
  while (!(await cond())) { if (Date.now() - t0 > ms) throw new Error('timed out waiting for ' + what); await tick(10); }
}
module.exports = { waitFor, seal, unseal, fixture, boot, read, ROOT, tick, PIN, rndPin, otherPin };
