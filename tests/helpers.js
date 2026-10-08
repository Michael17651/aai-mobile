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
function boot(idb) {
  const html = read('index.html').replace(/<script[^>]*><\/script>/g, '');
  const dom = new JSDOM(html, { runScripts: 'outside-only', url: 'https://aai.test/aai-mobile/', pretendToBeVisual: true });
  const w = dom.window;
  Object.defineProperty(w, 'crypto', { value: webcrypto });
  w.TextEncoder = TextEncoder; w.TextDecoder = TextDecoder;
  w.indexedDB = idb || new IDBFactory();
  w.eval(read('core.js')); w.eval(read('app.js'));
  const $ = (id) => w.document.getElementById(id);
  return {
    w, $, text: () => w.document.body.textContent,
    async chooseFile(name, text) {
      Object.defineProperty($('file'), 'files', { configurable: true, value: [{ name, text: async () => text }] });
      $('file').dispatchEvent(new w.Event('change'));
      await tick();
    },
    async unlock(pass) {
      $('pass').value = pass;
      $('unlockForm').dispatchEvent(new w.Event('submit', { cancelable: true }));
      for (let i = 0; i < 100 && ($('unlockBtn').disabled || $('lockMsg').textContent === 'Opening…' || i < 2); i++) await tick(30);
    }
  };
}
const tick = (ms) => new Promise((r) => setTimeout(r, ms || 20));
module.exports = { seal, fixture, boot, read, ROOT, tick };
