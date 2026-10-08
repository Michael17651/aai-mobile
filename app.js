/* UI. Decrypted data lives only in `data` (memory); lock() drops it and empties the screens.
   Passphrases and the PIN are read, used and cleared; never stored in the clear, logged or put in a URL.
   On disk: the bundle sealed under a random data key, that key wrapped under the PIN (a screen lock, not strong protection). */
(function () {
  'use strict';
  const C = AAICore, $ = (id) => document.getElementById(id);
  const IDLE_MS = 5 * 60 * 1000;
  const APP_VERSION = '2.1.0', CACHE_NAME = 'aai-mobile-v6' /* must equal CACHE in sw.js (tested) */, KEEP_DAYS = 30, MAX_TRIES = 5, PINRE = /^\d{4,8}$/;
  const WRONG_END = 'Too many wrong PINs. Import the phone bundle again with its passphrase.';
  let data = null, dk = null, staged = null, check = null, pending = null, lastActive = Date.now(), customers = [], selected = null;
  let ob = [], deviceLabel = 'iPhone', xport = null, qtys = new Map();

  /* ----- storage: the still-encrypted file text, in IndexedDB ----- */
  const idb = () => new Promise((res, rej) => { const r = indexedDB.open('aai-mobile', 2); r.onupgradeneeded = () => { const d = r.result; if (!d.objectStoreNames.contains('kv')) d.createObjectStore('kv'); if (!d.objectStoreNames.contains('outbox')) d.createObjectStore('outbox', { keyPath: 'id' }); }; r.onsuccess = () => res(r.result); r.onerror = () => rej(r.error); });
  const kv = async (mode, fn, store) => { store = store || 'kv'; const db = await idb(); return new Promise((res, rej) => { const t = db.transaction(store, mode), rq = fn(t.objectStore(store)); t.oncomplete = () => { db.close(); res(rq.result); }; t.onerror = () => rej(t.error); }); };
  const get = (k) => kv('readonly', (s) => s.get(k));
  const set = (k, v) => kv('readwrite', (s) => s.put(v, k));
  // Bundle data only. The outbox store and the device label are untouched.
  const wipeBundle = () => kv('readwrite', (s) => ['wrap', 'vault', 'bundle', 'obpass', 'fails'].map((k) => s.delete(k)).pop());
  const obAll = () => kv('readonly', (s) => s.getAll(), 'outbox');
  const obPut = (r) => kv('readwrite', (s) => s.put(r), 'outbox');
  const obDel = (id) => kv('readwrite', (s) => s.delete(id), 'outbox');

  /* ----- tiny DOM helper (text only, never innerHTML) ----- */
  function h(tag, attrs, ...kids) {
    const e = document.createElement(tag);
    Object.entries(attrs || {}).forEach(([k, v]) => (k === 'class' ? (e.className = v) : e.setAttribute(k, v)));
    kids.flat(Infinity).forEach((k) => k != null && e.append(k));
    return e;
  }
  const put = (e, ...k) => e.replaceChildren(...k.flat(Infinity).filter((x) => x != null));
  const money = (n) => '$' + Number(n).toLocaleString('en-US', { minimumFractionDigits: n % 1 ? 2 : 0, maximumFractionDigits: 2 });
  const dateText = (iso) => { const d = /^\d{4}-\d\d-\d\d$/.test(iso) ? new Date(iso + 'T12:00:00') : new Date(iso); return isNaN(d) ? String(iso || '') : d.toLocaleDateString('en-US', { year: 'numeric', month: 'short', day: 'numeric' }); };
  const link = (scheme, val, label) => h('a', { class: 'act', href: scheme + ':' + val }, label);

  /* ----- lock / unlock ----- */
  const verText = () => 'Version ' + APP_VERSION + ' · cache ' + CACHE_NAME;
  function touch() { lastActive = Date.now(); }
  function lock() {
    endExport(); data = null; dk = null; staged = null; check = null; customers = []; selected = null; pending = null; ob = []; qtys = new Map();
    $('badge').hidden = true;
    ['tab-prices', 'tab-customers', 'tab-followups', 'tab-new', 'tab-outbox', 'tab-settings', 'banner'].forEach((id) => $(id).replaceChildren());
    ['pass', 'pin', 'pin1', 'pin2', 'file'].forEach((id) => { $(id).value = ''; });
    $('appView').hidden = true; $('lockView').hidden = false; $('lockBtn').hidden = true; $('setBtn').hidden = true;
    $('bundleAge').textContent = 'Locked'; $('bundleAge').className = '';
    refreshLockScreen();
  }
  // Which step the lock screen is on: none | pin (saved vault) | pass (a file, or a bundle from before PINs) | setpin (opened, choosing a PIN).
  async function refreshLockScreen() {
    let vault = null, old = null;
    try { vault = await get('vault'); old = await get('bundle'); } catch (e) { /* no storage: import only */ }
    const mode = staged ? 'setpin' : pending || old ? 'pass' : vault ? 'pin' : 'none';
    $('pinForm').hidden = mode !== 'pin'; $('passForm').hidden = mode !== 'pass'; $('newPinForm').hidden = mode !== 'setpin';
    $('cancelBtn').hidden = !(pending || staged); $('importBtn').hidden = mode === 'setpin';
    $('lockHint').textContent = { none: 'No bundle yet. Import the .aaib file from the console.', pin: 'Enter your PIN.',
      pass: pending ? 'Enter the passphrase for ' + pending.name + '. You will then choose a PIN.' : 'This phone holds a bundle from an older version. Enter its passphrase one last time, then choose a PIN.',
      setpin: 'Bundle opened. Choose a PIN (4 to 8 digits). It unlocks the app on this phone; the passphrase is not kept.' }[mode];
    $('importBtn').textContent = vault || old || pending ? 'Import a different bundle' : 'Import a bundle file';
    $('ver').textContent = verText();
  }
  // Checks a PIN against the saved wrapped key and keeps the wrong-try count in IndexedDB. Returns the data key.
  // Throws: a short wait after each wrong try (1, 2, 4, 8 s); on the 5th in a row, wipes the bundle (e.wiped).
  async function tryPin(pin) {
    const f = (await get('fails')) || { n: 0, until: 0 }, now = Date.now();
    if (now < f.until) throw new Error('Wait ' + Math.ceil((f.until - now) / 1000) + ' s before trying again.');
    const w = await get('wrap'); if (!w) throw new Error('No bundle on this phone.');
    try { const k = await C.unwrap(w, pin); if (f.n) await set('fails', { n: 0, until: 0 }); return k; } catch (e) { /* wrong */ }
    const n = f.n + 1;
    if (n >= MAX_TRIES) { await wipeBundle(); const x = new Error(WRONG_END); x.wiped = true; throw x; }
    const wait = 2 ** (n - 1);
    await set('fails', { n, until: Date.now() + wait * 1000 });
    throw new Error('Wrong PIN. Try again in ' + wait + ' s.');
  }
  const guard = async (msg, fn) => {
    try { await fn(); } catch (e) { if (e.wiped) { lock(); $('lockMsg').textContent = e.message; } else msg.textContent = e.message; }
  };
  async function unlockPin(e) {
    e.preventDefault();
    const pin = $('pin').value; $('pin').value = '';
    $('lockMsg').textContent = '';
    if (!pin) return;
    $('pinBtn').disabled = true;
    await guard($('lockMsg'), async () => {
      const k = await tryPin(pin);
      const b = C.checkBundle(await C.openKey(k, await get('vault')));
      dk = k; show(b);
    });
    $('pinBtn').disabled = false; if (!data) refreshLockScreen();
  }
  async function unlockPass(e) {
    e.preventDefault();
    const pass = $('pass').value; $('pass').value = '';
    $('lockMsg').textContent = '';
    if (!pass) return;
    $('passBtn').disabled = true; $('lockMsg').textContent = 'Opening…';
    try { staged = await C.open(pending ? pending.text : await get('bundle'), pass); $('lockMsg').textContent = ''; } catch (err) { $('lockMsg').textContent = err.message; }
    $('passBtn').disabled = false; refreshLockScreen();
  }
  async function savePin(e) {
    e.preventDefault();
    const a = $('pin1').value, b = $('pin2').value, m = $('lockMsg'); $('pin1').value = $('pin2').value = '';
    if (!PINRE.test(a)) { m.textContent = 'Use 4 to 8 digits.'; return; }
    if (a !== b) { m.textContent = 'The two PINs differ.'; return; }
    $('newPinBtn').disabled = true; m.textContent = 'Saving…';
    try {
      const v = await C.newVault(staged, a);
      // New data key, so any earlier outbox passphrase (sealed under the old key) goes; the old-format bundle goes too.
      await kv('readwrite', (s) => { s.put(v.wrap, 'wrap'); s.put(v.vault, 'vault'); s.put({ n: 0, until: 0 }, 'fails'); s.delete('obpass'); return s.delete('bundle'); });
      const bundle = staged; staged = null; pending = null; dk = v.dk; show(bundle);
    } catch (err) { m.textContent = 'Could not save on this phone.'; }
    $('newPinBtn').disabled = false;
  }
  async function pick() {
    const f = $('file').files[0]; if (!f) return;
    pending = { name: f.name, text: await f.text() }; staged = null;
    $('lockMsg').textContent = ''; refreshLockScreen(); $('pass').focus();
  }

  function show(b) {
    data = b; check = C.selfCheck(b); customers = b.customers.slice().sort((a, b) => a.name.localeCompare(b.name)); qtys = new Map(); touch();
    $('lockMsg').textContent = '';
    $('lockView').hidden = true; $('appView').hidden = false; $('lockBtn').hidden = false; $('setBtn').hidden = false;
    const age = $('bundleAge'); age.textContent = 'Bundle from ' + dateText(b.createdAt); age.className = C.ageClass(b.createdAt, new Date());
    const bn = $('banner');
    put(bn, check.ok
      ? h('div', { class: 'banner' }, 'Prices verified, ' + check.total + ' checks')
      : h('div', { class: 'banner bad' }, 'Price check failed, do not quote from this phone', h('ul', {}, check.failed.map((f) => h('li', {}, '#' + f.id + ' ' + f.text))),
        check.total ? null : h('div', {}, 'The bundle has no price checks.')));
    renderPrices(); renderCustomers(); renderFollowUps(); renderNew(); renderOutbox(); tab('prices');
    loadOb().then(renderOutbox);
  }
  function tab(name) {
    ['prices', 'customers', 'followups', 'new', 'outbox', 'settings'].forEach((t) => { $('tab-' + t).hidden = t !== name; });
    document.querySelectorAll('#tabs button').forEach((x) => x.classList.toggle('on', x.dataset.tab === name));
  }

  /* ----- prices ----- */
  function renderPrices() {
    const box = $('tab-prices');
    if (!check.ok) { put(box, h('p', { class: 'meta' }, 'Price screens are closed until the bundle passes its price check. Re-export it from the console.')); return; }
    const groups = [...new Set(data.catalog.map((c) => c.group).filter(Boolean))].sort();
    const q = h('input', { type: 'search', placeholder: 'Search name, alias or note', 'aria-label': 'Search prices', autocomplete: 'off' });
    const g = h('select', { 'aria-label': 'Group' }, h('option', { value: '' }, 'All groups'), groups.map((x) => h('option', { value: x }, x)));
    const out = h('div');
    const draw = () => {
      const list = C.searchCatalog(data.catalog, q.value, g.value);
      put(out, h('p', { class: 'meta' }, list.length + ' items'), list.map(priceCard));
      calc();
    };
    q.oninput = g.onchange = draw;
    put(box, h('div', { class: 'pin' }, taNote(), h('p', { class: 'meta' }, data.priceListDate + ' · Bundle from ' + dateText(data.createdAt)), q, h('div', { class: 'gap' }, g)), out);
    draw();
  }
  // Whole numbers 1..9999 only: digits are kept, 4 at most, and 0 is empty.
  const cleanQty = (v) => String(v).replace(/\D/g, '').replace(/^0+/, '').slice(0, 4);
  // Prices every card that has a quantity in one go (Master Panda boards pool), then paints the visible cards.
  function calc() {
    const rows = data.catalog.filter((c) => qtys.get(c.name)).map((c) => ({ item: c.name, qty: Number(qtys.get(c.name)) }));
    const q = C.priceLines(rows, data.catalog, data.rules), by = new Map(q.lines.map((l, i) => [rows[i].item, l]));
    const pool = rows.reduce((a, r) => a + (C.find(data.catalog, r.item).mp ? r.qty : 0), 0);
    const credit = q.promo.reduce((a, x) => a + x, 0);
    document.querySelectorAll('#tab-prices .card[data-name]').forEach((card) => {
      const c = C.find(data.catalog, card.dataset.name), l = by.get(c.name), out = card.querySelector('.calc');
      card.querySelectorAll('.tiers .hit').forEach((x) => x.classList.remove('hit'));
      if (!l) { put(out); return; }
      if (l.call) { put(out, h('span', { class: 'call' }, 'Call for price')); return; }
      const n = c.mp ? pool : l.qty, tiers = c.tiers;
      let hit = 0; tiers.forEach((t, i) => { if (t[0] <= n) hit = i; });
      const cells = card.querySelectorAll('.tiers span'); if (cells[hit]) { cells[hit].classList.add('hit'); }
      put(out, l.qty + ' × ' + money(l.unit) + ' = ' + money(l.total) + (c.mp && pool !== l.qty ? ' (tier from ' + pool + ' Master Panda boards)' : '') + (c.mp && credit ? ' · free board credit ' + money(credit) + ' across boards' : ''));
    });
  }
  function priceCard(c) {
    const call = C.isCall(c), labels = call ? [] : C.tierLabels(c);
    const qi = h('input', { type: 'text', inputmode: 'numeric', pattern: '[0-9]*', maxlength: '4', placeholder: 'Qty', 'aria-label': 'Quantity for ' + c.name, autocomplete: 'off' });
    qi.value = qtys.get(c.name) || '';
    qi.oninput = () => { const v = cleanQty(qi.value); qi.value = v; if (v) qtys.set(c.name, v); else qtys.delete(c.name); calc(); };
    return h('div', { class: 'card', 'data-name': c.name }, h('h3', {}, c.name),
      call ? h('div', { class: 'call' }, 'Call for price') : h('div', { class: 'tiers' }, c.tiers.map((t, i) => [h('span', {}, labels[i]), h('b', {}, money(t[1]))])),
      (c.flags || []).map((f) => h('span', { class: 'flag' }, f)),
      c.note ? h('div', { class: 'note' }, c.note) : null,
      h('div', { class: 'qty' }, qi), h('div', { class: 'calc', role: 'status' }));
  }

  /* ----- customers ----- */
  function renderCustomers() {
    const box = $('tab-customers');
    box.onscroll = null;
    if (selected) return renderDetail(selected);
    const q = h('input', { type: 'search', placeholder: 'Name, contact, city, state, zip, phone, email', 'aria-label': 'Search customers', autocomplete: 'off' });
    const out = h('div'), STEP = 50;
    let list = [], shown = 0, rows = null, more = null;
    const row = (c) => { const b = h('button', { type: 'button', class: 'row' }, c.name, h('small', {}, [c.city, c.state].filter(Boolean).join(', ') + (c.lastOrder ? ' · last order ' + dateText(c.lastOrder) : ''))); b.onclick = () => { selected = c; renderCustomers(); }; return b; };
    // Chunked: 50 rows at a time, more on scroll near the bottom or with the Show more row.
    const next = () => {
      rows.append(...list.slice(shown, shown + STEP).map(row)); shown = Math.min(list.length, shown + STEP);
      more.hidden = shown >= list.length;
    };
    q.oninput = () => {
      const typed = q.value.trim();
      list = typed ? C.searchCustomers(customers, q.value) : customers; shown = 0;
      rows = h('div'); more = btn('Show more', next, 'secondary wide');
      put(out, h('p', { class: 'meta' }, typed ? list.length + ' found' : customers.length + ' customers'), rows, more);
      next(); box.scrollTop = 0;
    };
    box.onscroll = () => { if (!more.hidden && box.scrollTop + box.clientHeight > box.scrollHeight - 300) next(); };
    put(box, h('div', { class: 'pin' }, q), out); q.oninput();
  }
  function renderDetail(c) {
    const addr = [c.address, c.city, c.state, c.zip].filter(Boolean).join(', ');
    const back = h('button', { type: 'button', class: 'secondary' }, 'Back'); back.onclick = () => { selected = null; renderCustomers(); };
    put($('tab-customers'), back, h('div', { class: 'card' }, h('h3', {}, c.name), c.contact ? h('div', {}, c.contact) : null,
      (c.phones || []).map((p) => h('div', {}, p, h('br'), link('tel', C.digits(p), 'Call'), link('sms', C.digits(p), 'Text'))),
      c.email ? h('div', {}, c.email, h('br'), link('mailto', c.email, 'Email')) : null,
      addr ? h('div', {}, addr, h('br'), h('a', { class: 'act', href: 'https://www.google.com/maps/search/?api=1&query=' + encodeURIComponent(addr), rel: 'noopener noreferrer' }, 'Maps')) : null,
      h('p', { class: 'meta' }, 'Last 12 months net: ' + money(c.net12 || 0) + (c.lastOrder ? ' · last order ' + dateText(c.lastOrder) : ''))),
      h('div', { class: 'meta' }, 'Last invoices'),
      (c.invoices || []).map((i) => h('div', { class: 'card' }, h('b', {}, '#' + i.no), ' ' + dateText(i.date) + ' · ' + money(i.total), h('div', { class: 'note' }, (i.items || []).join(', ')))));
  }

  /* ----- follow-ups ----- */
  function renderFollowUps() {
    const now = new Date(), list = data.followUps.slice().sort((a, b) => (a.due || '9999').localeCompare(b.due || '9999'));
    put($('tab-followups'), h('p', { class: 'meta' }, list.length + ' open follow-ups'), list.map((f) =>
      h('div', { class: 'card ' + C.dueClass(f.due, now) }, h('h3', {}, f.name), h('div', { class: 'due' }, f.due ? 'Due ' + dateText(f.due) : 'No due date'),
        f.note ? h('div', { class: 'note' }, f.note) : null, f.phone ? h('div', {}, f.phone, h('br'), link('tel', C.digits(f.phone), 'Call')) : null)));
  }

  /* ----- capture: records are saved to the outbox (IndexedDB on this phone) and never sent anywhere by the app ----- */
  const btn = (label, fn, cls) => { const b = h('button', { type: 'button', class: cls || '' }, label); b.onclick = fn; return b; };
  const field = (label, input) => h('div', {}, h('label', {}, label), input);
  const inp = (v, attrs) => { const e = h('input', Object.assign({ autocomplete: 'off' }, attrs)); e.value = v == null ? '' : v; return e; };
  const ta = (v, label) => { const e = h('textarea', { rows: '3', 'aria-label': label || 'Notes' }); e.value = v || ''; return e; };
  const sel = (opts, v, label) => { const e = h('select', { 'aria-label': label }, opts.map(([val, t]) => h('option', { value: val }, t))); e.value = v || opts[0][0]; return e; };
  const PERSON = [['company', 'Company'], ['contact', 'Contact name'], ['phone', 'Phone', 'tel'], ['email', 'Email', 'email'], ['address', 'Address'], ['city', 'City'], ['state', 'State'], ['zip', 'Zip']];
  function personFields(v, extra) {
    const ins = {};
    const nodes = PERSON.concat(extra || []).map(([k, l, t]) => { ins[k] = inp(v[k], { type: t || 'text', 'aria-label': l }); return field(l, ins[k]); });
    return { nodes, read: () => Object.fromEntries(Object.entries(ins).map(([k, e]) => [k, e.value.trim()])) };
  }
  const LABEL = { lead: 'Lead', order: 'Order', quote: 'Quote request', followup: 'Follow-up' };
  const who = (r) => r.kind === 'lead' ? r.company || r.contact : r.kind === 'followup' ? r.target.name : r.customer.existing ? r.customer.name : r.customer.company;
  const totalText = (r) => r.total == null ? 'Call for price' : money(r.total) + (r.totalExcludesCallItems ? ' + call-for-price items' : '');

  async function loadOb() {
    try {
      const all = await obAll(), cut = Date.now() - KEEP_DAYS * 864e5;
      ob = [];
      for (const r of all) { if (r.exportedAt && new Date(r.exportedAt).getTime() < cut) await obDel(r.id); else ob.push(r); }
      ob.sort((a, b) => a.createdAt.localeCompare(b.createdAt));
      const l = await kv('readonly', (s) => s.get('deviceLabel')); if (l) deviceLabel = l;
    } catch (e) { ob = []; }
    const n = ob.filter((r) => !r.exportedAt).length;
    $('badge').textContent = n; $('badge').hidden = !n;
  }
  // Create (no `old`) or update (keeps id and createdAt). Returns an error text, or nothing on success.
  async function save(old, kind, fields) {
    const now = new Date().toISOString();
    const r = old && old.id ? Object.assign({}, old, fields, { kind, updatedAt: now })
      : Object.assign({ id: crypto.randomUUID(), createdAt: now, appVersion: APP_VERSION, kind, exportedAt: null }, fields);
    try { await obPut(r); await loadOb(); } catch (e) { return 'Could not save on this phone.'; }
    renderNew(); renderOutbox(); tab('outbox');
  }
  function foot(msg, run, editing) {
    return [msg, btn('Save to outbox', async () => { msg.textContent = ''; const err = await run(); if (err) msg.textContent = err; }),
      btn('Cancel', () => { renderNew(); tab(editing ? 'outbox' : 'new'); }, 'secondary')];
  }

  function renderNew(v) {
    const box = $('tab-new');
    if (!v) { put(box, h('p', { class: 'meta' }, 'Saved on this phone only. Send them from Outbox.'), ['lead', 'quote', 'followup'].map((k) => btn(k === 'lead' ? 'New customer or lead' : k === 'quote' ? 'Quote request or order' : 'Follow-up note', () => renderNew({ kind: k }), 'wide'))); return; }
    put(box, v.kind === 'lead' ? leadForm(v.rec) : v.kind === 'followup' ? followForm(v.rec) : quoteForm(v.rec));
  }

  function leadForm(rec) {
    rec = rec || {};
    const p = personFields(rec, [['metAt', 'Met at (show or site)']]), temp = sel([['', 'Hot / warm / cold…'], ['hot', 'Hot'], ['warm', 'Warm'], ['cold', 'Cold']], rec.temp, 'Hot, warm or cold'), notes = ta(rec.notes), msg = h('p', { class: 'err', role: 'alert' });
    return h('div', {}, h('h2', {}, 'New customer or lead'), p.nodes, field('Hot / warm / cold', temp), field('Notes', notes),
      foot(msg, () => {
        const v = p.read();
        if (!v.company && !v.contact) return 'Enter a company or a contact name.';
        if (!temp.value) return 'Pick hot, warm or cold.';
        return save(rec, 'lead', Object.assign(v, { temp: temp.value, notes: notes.value.trim() }));
      }, !!rec.id));
  }

  function followForm(rec) {
    rec = rec || {};
    let target = rec.target || null;
    const box = h('div'), due = inp(rec.due, { type: 'date', 'aria-label': 'Due date' }), note = ta(rec.note, 'Note'), msg = h('p', { class: 'err', role: 'alert' });
    const draw = () => {
      if (target) { put(box, h('div', { class: 'card' }, h('b', {}, target.name), h('div', { class: 'note' }, target.type === 'lead' ? 'Lead on this phone' : [target.city, target.state].filter(Boolean).join(', ')), btn('Change', () => { target = null; draw(); }, 'secondary'))); return; }
      const q = inp('', { type: 'search', placeholder: 'Search customers and your leads', 'aria-label': 'Search customers and leads' }), out = h('div');
      q.oninput = () => {
        const t = q.value.trim().toLowerCase();
        const leads = !t ? [] : ob.filter((r) => r.kind === 'lead' && t.split(/\s+/).every((w) => [r.company, r.contact].join(' ').toLowerCase().indexOf(w) > -1));
        const cs = C.searchCustomers(customers, q.value);
        put(out, leads.slice(0, 20).map((l) => pickRow(who(l), 'Lead on this phone', { type: 'lead', id: l.id, name: who(l) })),
          cs.slice(0, 20).map((c) => pickRow(c.name, [c.city, c.state].filter(Boolean).join(', '), { type: 'customer', key: c.key, name: c.name, city: c.city, state: c.state, zip: c.zip })));
      };
      const pickRow = (name, sub, t) => { const b = h('button', { type: 'button', class: 'row' }, name, h('small', {}, sub)); b.onclick = () => { target = t; draw(); }; return b; };
      put(box, q, out);
    };
    draw();
    return h('div', {}, h('h2', {}, 'Follow-up note'), box, field('Note', note), field('Due date', due),
      foot(msg, () => {
        if (!target) return 'Pick a customer or a lead.';
        if (!note.value.trim()) return 'Enter a note.';
        if (!due.value) return 'Pick a due date.';
        return save(rec, 'followup', { target, note: note.value.trim(), due: due.value });
      }, !!rec.id));
  }

  const taNote = () => data.catalog.some((c) => c.ta !== undefined) ? null : h('p', { class: 'meta' }, 'Re-export the phone bundle to enable title add');

  function quoteForm(rec) {
    rec = rec || {};
    if (!check.ok) return h('p', { class: 'meta' }, 'Quotes are closed until the bundle passes its price check. Re-export it from the console.');
    const rules = data.rules, titles = rules.titleAdd.titles;
    let cust = rec.customer && rec.customer.existing ? rec.customer : null;
    const canTitle = (name) => { const c = C.find(data.catalog, name); return !!c && c.ta === true; };
    const rows = (rec.lines || []).map((l) => ({ item: l.name, qty: l.qty, title: canTitle(l.name) ? l.title || '' : '' }));
    const kind = sel([['quote', 'Quote request'], ['order', 'Order']], rec.kind, 'Order or quote request');
    const mode = sel([['existing', 'Existing customer'], ['new', 'New customer']], rec.customer && !rec.customer.existing ? 'new' : 'existing', 'Customer');
    const np = personFields(rec.customer && !rec.customer.existing ? rec.customer : {});
    const custBox = h('div'), lineBox = h('div'), sumBox = h('div'), notes = ta(rec.notes), msg = h('p', { class: 'err', role: 'alert' });
    let spans = [];

    const drawCust = () => {
      if (mode.value === 'new') { put(custBox, np.nodes); return; }
      if (cust) { put(custBox, h('div', { class: 'card' }, h('b', {}, cust.name), h('div', { class: 'note' }, [cust.city, cust.state].filter(Boolean).join(', ')), btn('Change', () => { cust = null; drawCust(); }, 'secondary'))); return; }
      const q = inp('', { type: 'search', placeholder: 'Search customers', 'aria-label': 'Search customers' }), out = h('div');
      q.oninput = () => put(out, C.searchCustomers(customers, q.value).slice(0, 20).map((c) => {
        const b = h('button', { type: 'button', class: 'row' }, c.name, h('small', {}, [c.city, c.state].filter(Boolean).join(', ')));
        b.onclick = () => { cust = { existing: true, key: c.key, name: c.name, city: c.city, state: c.state, zip: c.zip }; drawCust(); };
        return b;
      }));
      put(custBox, q, out);
    };
    mode.onchange = drawCust;

    const reprice = () => {
      const pr = C.priceLines(rows, data.catalog, rules), allCall = pr.lines.every((l) => l.call);
      pr.lines.forEach((l, i) => put(spans[i], l.call ? h('span', { class: 'call' }, 'Call for price') : !(l.qty >= 1) ? 'Enter a quantity' : money(l.unit) + ' × ' + l.qty + ' = ' + money(l.total)));
      put(sumBox, !rows.length ? null : [pr.promo.map((p) => h('div', { class: 'note' }, 'Free board ' + '−' + money(-p))), pr.extra.map((x) => h('div', { class: 'note' }, 'Title add +' + money(x))),
        h('div', { class: 'total' }, 'Total: ', allCall ? h('span', { class: 'call' }, 'Call for price') : money(pr.total)),
        pr.incomplete && !allCall ? h('div', { class: 'call' }, 'Total leaves out the call-for-price items.') : null]);
      return pr;
    };
    const drawLines = () => {
      spans = [];
      put(lineBox, rows.map((r, i) => {
        const qty = inp(r.qty, { type: 'number', inputmode: 'numeric', min: '1', step: '1', 'aria-label': 'Quantity ' + r.item });
        qty.oninput = () => { r.qty = qty.value; reprice(); };
        const ttl = titles.length && canTitle(r.item) ? field('Title (adds a charge for listed titles)', sel([['', 'None']].concat(titles.map((t) => [t, t])), r.title, 'Title')) : null;
        if (ttl) ttl.querySelector('select').onchange = (e) => { r.title = e.target.value; reprice(); };
        const span = h('div', { class: 'price' }); spans.push(span);
        return h('div', { class: 'card' }, h('h3', {}, r.item), field('Qty', qty), ttl, span, btn('Remove', () => { rows.splice(i, 1); drawLines(); }, 'secondary'));
      }));
      reprice();
    };
    const add = (c) => {
      const x = rows.find((r) => r.item === c.name && !r.title);
      if (x) x.qty = (Number(x.qty) || 0) + 1; else rows.push({ item: c.name, qty: 1, title: '' });
      drawLines();
    };
    const cq = inp('', { type: 'search', placeholder: 'Search the catalog by name', 'aria-label': 'Search catalog' }), cout = h('div');
    cq.oninput = () => put(cout, !cq.value.trim() ? null : C.searchCatalog(data.catalog, cq.value).slice(0, 10).map((c) => {
      const b = h('button', { type: 'button', class: 'row' }, c.name, C.isCall(c) ? h('small', {}, 'Call for price') : null); b.onclick = () => { add(c); cq.value = ''; cq.oninput(); }; return b;
    }));
    drawCust(); drawLines();

    return h('div', {}, h('h2', {}, 'Quote request or order'), field('Type', kind), field('Customer', mode), custBox,
      taNote(), h('div', { class: 'meta' }, 'Lines · ' + data.priceListDate), lineBox, sumBox, field('Add a line', cq), cout, field('Notes', notes),
      foot(msg, () => {
        const c = mode.value === 'new' ? Object.assign({ existing: false }, np.read()) : cust;
        if (!c || (!c.existing && !c.company)) return "Pick a customer, or enter the new customer's company.";
        if (!rows.length) return 'Add at least one line.';
        if (rows.some((r) => !Number.isInteger(Number(r.qty)) || Number(r.qty) < 1)) return 'Every line needs a whole quantity of 1 or more.';
        const pr = C.priceLines(rows, data.catalog, rules);
        return save(rec, kind.value, {
          customer: c, notes: notes.value.trim(), priceListDate: data.priceListDate, promo: pr.promo, titleAdd: pr.extra,
          total: pr.lines.every((l) => l.call) ? null : pr.total, totalExcludesCallItems: pr.incomplete,
          lines: pr.lines.map((l) => ({ name: l.name, qty: l.qty, unitPrice: l.unit, lineTotal: l.total, callForPrice: l.call, title: l.title, priceListDate: data.priceListDate }))
        });
      }, !!rec.id));
  }

  /* ----- outbox ----- */
  function recCard(r, actions) {
    const detail = r.kind === 'followup' ? 'Due ' + dateText(r.due) + ' · ' + r.note : r.kind === 'lead' ? (r.temp || '') + (r.metAt ? ' · met at ' + r.metAt : '') : r.lines.length + ' lines · ' + totalText(r);
    return h('div', { class: 'card' }, h('h3', {}, LABEL[r.kind] + ': ' + who(r)), h('div', { class: 'note' }, detail),
      h('div', { class: 'meta' }, r.exportedAt ? 'Exported ' + dateText(r.exportedAt) : 'Saved ' + dateText(r.createdAt)), actions);
  }
  function renderOutbox() {
    const todo = ob.filter((r) => !r.exportedAt), done = ob.filter((r) => r.exportedAt);
    const label = inp(deviceLabel, { 'aria-label': 'Device label' });
    label.onchange = () => { deviceLabel = label.value.trim() || 'iPhone'; kv('readwrite', (s) => s.put(deviceLabel, 'deviceLabel')).catch(() => {}); };
    put($('tab-outbox'), h('p', { class: 'meta' }, todo.length + ' waiting to send'),
      todo.map((r) => {
        let armed = false;
        const del = btn('Delete', async () => { if (!armed) { armed = true; del.textContent = 'Tap again to delete'; return; } await obDel(r.id); await loadOb(); renderOutbox(); }, 'secondary');
        return recCard(r, [btn('Edit', () => { renderNew({ kind: r.kind, rec: r }); tab('new'); }, 'secondary'), del]);
      }),
      xport ? exportPanel() : [todo.length ? btn('Export ' + todo.length + ' record' + (todo.length > 1 ? 's' : ''), () => startExport(todo)) : null],
      done.length ? [h('div', { class: 'meta' }, 'Exported, kept ' + KEEP_DAYS + ' days'), done.map((r) => recCard(r)), xport ? null : btn('Re-export these ' + done.length, () => startExport(done), 'secondary')] : null,
      field('Device label (goes in the export)', label));
  }
  function endExport() { if (xport && xport.url && URL.revokeObjectURL) URL.revokeObjectURL(xport.url); xport = null; }
  const getObPass = async () => { const r = await get('obpass'); return r ? (await C.openKey(dk, r)).pass : null; };
  const setObPass = async (p) => set('obpass', await C.sealKey(dk, { pass: p }));
  // With a saved outbox passphrase the file is built straight away; otherwise the panel asks for one (twice) and saves it.
  async function startExport(recs) {
    const x = xport = { ids: recs.map((r) => r.id), busy: true }; renderOutbox();
    let p = null; try { p = await getObPass(); } catch (e) { /* ask again */ }
    if (xport !== x) return;
    if (p) await buildFile(p); else x.busy = false;
    if (xport === x) renderOutbox();
  }
  async function buildFile(pass) {
    const x = xport, recs = ob.filter((r) => x.ids.includes(r.id)).map((r) => { const { exportedAt, ...pub } = r; return pub; });
    const now = new Date();
    const text = await C.seal({ version: 1, createdAt: now.toISOString(), deviceLabel, records: recs }, pass);
    if (xport !== x) return;
    x.ids = recs.map((r) => r.id); x.busy = false;
    x.file = new File([text], 'aai-outbox-' + C.stamp(now) + '.aaio', { type: 'application/octet-stream' });
    x.url = URL.createObjectURL ? URL.createObjectURL(x.file) : null;
  }
  async function markSent() {
    const now = new Date().toISOString();
    try { for (const id of xport.ids) { const r = ob.find((x) => x.id === id); if (r && !r.exportedAt) await obPut(Object.assign({}, r, { exportedAt: now })); } } catch (e) { xport.msg = 'Could not mark them as sent.'; renderOutbox(); return; }
    endExport(); await loadOb(); renderOutbox();
  }
  function exportPanel() {
    const x = xport, msg = h('p', { class: 'meta', role: 'status' }, x.msg || '');
    if (x.file) {
      const can = navigator.canShare && navigator.canShare({ files: [x.file] });
      const share = async () => {
        try { await navigator.share({ files: [x.file], title: x.file.name }); } catch (e) { x.msg = e && e.name === 'AbortError' ? 'Share cancelled. Nothing is marked as sent.' : 'Sharing failed. Use Download.'; renderOutbox(); return; }
        markSent();
      };
      return h('div', { class: 'card' }, h('p', {}, 'File ready: ' + x.file.name + ' (' + x.ids.length + ' records). Send it, then confirm. Records are marked exported only after the share finishes or you tap "I sent it".'),
        can ? btn('Share…', share) : null, x.url ? h('a', { class: 'act', href: x.url, download: x.file.name }, 'Download') : null,
        btn('I sent it', markSent), btn('Cancel', () => { endExport(); renderOutbox(); }, 'secondary'), msg);
    }
    if (x.busy) return h('div', { class: 'card' }, h('p', { role: 'status' }, 'Encrypting…'));
    const p1 = passIn('Outbox passphrase'), p2 = passIn('Outbox passphrase again');
    const go = btn('Create file', async () => {
      const a = p1.value, b = p2.value; p1.value = p2.value = '';
      if (a.length < 8) { msg.textContent = 'Use 8 or more characters.'; return; }
      if (a !== b) { msg.textContent = 'The two passphrases differ.'; return; }
      go.disabled = true; msg.textContent = 'Encrypting…';
      try { await setObPass(a); await buildFile(a); } catch (e) { msg.textContent = 'Could not create the file.'; go.disabled = false; return; }
      renderOutbox();
    });
    return h('div', { class: 'card' }, h('p', {}, 'Choose the Outbox passphrase. It is kept on this phone under your PIN, so you type it only once. You give it to the console when you import.'), field('Outbox passphrase', p1), field('Again', p2), go, btn('Cancel', () => { endExport(); renderOutbox(); }, 'secondary'), msg);
  }

  /* ----- settings ----- */
  const passIn = (label) => inp('', { type: 'password', 'aria-label': label, autocapitalize: 'off', autocorrect: 'off', spellcheck: 'false' });
  const pinIn = (label) => inp('', { type: 'password', inputmode: 'numeric', pattern: '[0-9]*', maxlength: '8', 'aria-label': label });
  async function renderSettings() {
    const box = $('tab-settings'); let has = false;
    try { has = !!(await get('obpass')); } catch (e) { /* treated as not set */ }
    const m1 = h('p', { class: 'err', role: 'alert' }), m2 = h('p', { class: 'err', role: 'alert' }), m3 = h('p', { class: 'err', role: 'alert' });
    const cur = pinIn('Current PIN'), n1 = pinIn('New PIN'), n2 = pinIn('New PIN again');
    const changePin = btn('Change PIN', () => guard(m1, async () => {
      const a = cur.value, b = n1.value, c = n2.value; cur.value = n1.value = n2.value = ''; m1.textContent = '';
      if (!PINRE.test(b)) throw new Error('Use 4 to 8 digits.');
      if (b !== c) throw new Error('The two PINs differ.');
      await tryPin(a);
      await set('wrap', await C.wrapKey(dk, b)); m1.textContent = 'PIN changed.';
    }));
    const o1 = passIn('Outbox passphrase'), o2 = passIn('Outbox passphrase again'), shown = h('div'), sp = pinIn('PIN to show the outbox passphrase');
    const saveOb = btn(has ? 'Replace outbox passphrase' : 'Set outbox passphrase', () => guard(m2, async () => {
      const a = o1.value, b = o2.value; o1.value = o2.value = ''; m2.textContent = '';
      if (a.length < 8) throw new Error('Use 8 or more characters.');
      if (a !== b) throw new Error('The two passphrases differ.');
      await setObPass(a); await renderSettings();
    }), 'secondary');
    const showBtn = btn('Show', () => guard(m2, async () => {
      const pin = sp.value; sp.value = ''; m2.textContent = '';
      await tryPin(pin);
      put(shown, h('div', { class: 'card' }, h('div', { class: 'meta' }, 'Outbox passphrase'), h('b', {}, await getObPass())));
    }), 'secondary');
    const delBox = h('div'), drawDel = () => put(delBox, btn('Delete bundle from this phone', () => put(delBox,
      h('p', {}, 'This removes the bundle, the PIN and the outbox passphrase from this phone. Unsent outbox records stay. To use the app again you need the bundle file and its passphrase.'),
      btn('Yes, delete the bundle', () => guard(m3, async () => { await wipeBundle(); lock(); $('lockMsg').textContent = 'Bundle deleted from this phone.'; })), btn('Cancel', drawDel, 'secondary')), 'secondary'));
    drawDel();
    put(box, h('h2', {}, 'Settings'), h('p', { class: 'meta' }, verText()),
      h('h2', {}, 'Change PIN'), field('Current PIN', cur), field('New PIN (4 to 8 digits)', n1), field('New PIN again', n2), changePin, m1,
      h('h2', {}, 'Outbox passphrase'), h('p', { class: 'meta' }, has ? 'Set. Exports use it with no typing; the console asks for it on import.' : 'Not set. Set it here or on your first export (8 or more characters).'),
      field('Passphrase', o1), field('Again', o2), saveOb, has ? [field('PIN', sp), showBtn, shown] : null, m2,
      h('h2', {}, 'Bundle'), delBox, m3);
  }

  /* ----- wiring ----- */
  $('pinForm').addEventListener('submit', unlockPin);
  $('passForm').addEventListener('submit', unlockPass);
  $('newPinForm').addEventListener('submit', savePin);
  $('importBtn').onclick = () => { $('file').value = ''; $('file').click(); };
  $('cancelBtn').onclick = () => { pending = null; staged = null; $('lockMsg').textContent = ''; refreshLockScreen(); };
  $('file').onchange = pick;
  $('lockBtn').onclick = lock;
  $('setBtn').onclick = () => { renderSettings(); tab('settings'); };
  $('update').onclick = () => window.AAIApp.reload();
  document.querySelectorAll('#tabs button').forEach((b) => { b.onclick = () => tab(b.dataset.tab); });
  ['click', 'keydown', 'touchstart', 'scroll', 'input'].forEach((ev) => document.addEventListener(ev, touch, { capture: true, passive: true }));
  const idleCheck = () => { if (data && Date.now() - lastActive >= IDLE_MS) lock(); };
  setInterval(idleCheck, 15000);
  document.addEventListener('visibilitychange', idleCheck);
  // iOS can leave the page scrolled after the keyboard or a select closes; put the shell back.
  addEventListener('focusout', () => setTimeout(() => scrollTo(0, 0), 50));
  window.AAIApp = { lock, idleCheck, state: () => data, IDLE_MS, APP_VERSION, CACHE_NAME, reload: () => location.reload() };
  // A new service worker that finishes installing while the app is open (an older one already controls it) shows the banner.
  if ('serviceWorker' in navigator) {
    const sw = navigator.serviceWorker, had = !!sw.controller, ready = () => { $('update').hidden = false; };
    const watch = (w) => w && w.addEventListener('statechange', () => { if (w.state === 'installed' && sw.controller) ready(); });
    sw.addEventListener('controllerchange', () => { if (had) ready(); });
    sw.register('sw.js', { updateViaCache: 'none' }).then((reg) => {
      if (!reg) return;
      if (reg.waiting && sw.controller) ready();
      watch(reg.installing); reg.addEventListener('updatefound', () => watch(reg.installing));
      document.addEventListener('visibilitychange', () => { if (!document.hidden) reg.update().catch(() => {}); });
    }).catch(() => {});
  }
  lock();
})();
