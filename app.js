/* UI. Decrypted data lives only in `data` (memory); lock() drops it and empties the screens.
   The passphrase is read, used and cleared; never stored, logged or put in a URL. */
(function () {
  'use strict';
  const C = AAICore, $ = (id) => document.getElementById(id);
  const IDLE_MS = 5 * 60 * 1000;
  let data = null, check = null, pending = null, lastActive = Date.now(), customers = [], selected = null;

  /* ----- storage: the still-encrypted file text, in IndexedDB ----- */
  const idb = () => new Promise((res, rej) => { const r = indexedDB.open('aai-mobile', 1); r.onupgradeneeded = () => r.result.createObjectStore('kv'); r.onsuccess = () => res(r.result); r.onerror = () => rej(r.error); });
  const kv = async (mode, fn) => { const db = await idb(); return new Promise((res, rej) => { const t = db.transaction('kv', mode), rq = fn(t.objectStore('kv')); t.oncomplete = () => { db.close(); res(rq.result); }; t.onerror = () => rej(t.error); }); };
  const loadStored = () => kv('readonly', (s) => s.get('bundle'));
  const saveStored = (text) => kv('readwrite', (s) => s.put(text, 'bundle'));

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
  function touch() { lastActive = Date.now(); }
  function lock() {
    data = null; check = null; customers = []; selected = null; pending = null;
    ['tab-prices', 'tab-customers', 'tab-followups', 'banner'].forEach((id) => $(id).replaceChildren());
    $('pass').value = ''; $('file').value = '';
    $('appView').hidden = true; $('lockView').hidden = false; $('lockBtn').hidden = true;
    $('bundleAge').textContent = 'Locked'; $('bundleAge').className = '';
    refreshLockScreen();
  }
  async function refreshLockScreen() {
    let stored = null;
    try { stored = await loadStored(); } catch (e) { /* no storage: import only */ }
    const hasFile = stored || pending;
    $('lockHint').textContent = pending ? 'Enter the passphrase for ' + pending.name + '.' : stored ? 'Enter the passphrase to unlock the saved bundle.' : 'No bundle yet. Import the .aaib file from the console.';
    $('unlockForm').hidden = !hasFile;
    $('importBtn').textContent = stored || pending ? 'Import a different bundle' : 'Import a bundle file';
  }
  async function unlock(e) {
    e.preventDefault();
    const pass = $('pass').value; $('pass').value = '';
    $('lockMsg').textContent = '';
    if (!pass) return;
    try {
      const text = pending ? pending.text : await loadStored();
      $('unlockBtn').disabled = true; $('lockMsg').textContent = 'Opening…';
      const b = await C.open(text, pass);
      if (pending) { await saveStored(text); pending = null; }
      show(b);
    } catch (err) { $('lockMsg').textContent = err.message; }
    $('unlockBtn').disabled = false;
  }
  async function pick() {
    const f = $('file').files[0]; if (!f) return;
    pending = { name: f.name, text: await f.text() };
    $('lockMsg').textContent = ''; refreshLockScreen(); $('pass').focus();
  }

  function show(b) {
    data = b; check = C.selfCheck(b); customers = b.customers; touch();
    $('lockMsg').textContent = '';
    $('lockView').hidden = true; $('appView').hidden = false; $('lockBtn').hidden = false;
    const age = $('bundleAge'); age.textContent = 'Bundle from ' + dateText(b.createdAt); age.className = C.ageClass(b.createdAt, new Date());
    const bn = $('banner');
    put(bn, check.ok
      ? h('div', { class: 'banner' }, 'Prices verified, ' + check.total + ' checks')
      : h('div', { class: 'banner bad' }, 'Price check failed, do not quote from this phone', h('ul', {}, check.failed.map((f) => h('li', {}, '#' + f.id + ' ' + f.text))),
        check.total ? null : h('div', {}, 'The bundle has no price checks.')));
    renderPrices(); renderCustomers(); renderFollowUps(); tab('prices');
  }
  function tab(name) {
    ['prices', 'customers', 'followups'].forEach((t) => { $('tab-' + t).hidden = t !== name; });
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
    };
    q.oninput = g.onchange = draw;
    put(box, h('p', { class: 'meta' }, data.priceListDate + ' · Bundle from ' + dateText(data.createdAt)), q, h('div', { class: 'gap' }, g), out);
    draw();
  }
  function priceCard(c) {
    const call = C.isCall(c), labels = call ? [] : C.tierLabels(c);
    return h('div', { class: 'card' }, h('h3', {}, c.name),
      call ? h('div', { class: 'call' }, 'Call for price') : h('div', { class: 'tiers' }, c.tiers.map((t, i) => [h('span', {}, labels[i]), h('b', {}, money(t[1]))])),
      (c.flags || []).map((f) => h('span', { class: 'flag' }, f)),
      c.note ? h('div', { class: 'note' }, c.note) : null);
  }

  /* ----- customers ----- */
  function renderCustomers() {
    const box = $('tab-customers');
    if (selected) return renderDetail(selected);
    const q = h('input', { type: 'search', placeholder: 'Name, contact, city, state, zip, phone, email', 'aria-label': 'Search customers', autocomplete: 'off' });
    const out = h('div');
    q.oninput = () => {
      const r = C.searchCustomers(customers, q.value);
      put(out, !q.value.trim() ? h('p', { class: 'meta' }, 'Type to search ' + customers.length + ' customers.') : [h('p', { class: 'meta' }, r.length + ' found' + (r.length > 50 ? ', showing 50' : '')),
        r.slice(0, 50).map((c) => { const b = h('button', { type: 'button', class: 'row' }, c.name, h('small', {}, [c.city, c.state].filter(Boolean).join(', ') + (c.lastOrder ? ' · last order ' + dateText(c.lastOrder) : ''))); b.onclick = () => { selected = c; renderCustomers(); }; return b; })]);
    };
    put(box, q, out); q.oninput();
  }
  function renderDetail(c) {
    const addr = [c.address, c.city, c.state, c.zip].filter(Boolean).join(', ');
    const back = h('button', { type: 'button', class: 'secondary' }, 'Back'); back.onclick = () => { selected = null; renderCustomers(); };
    put($('tab-customers'), back, h('div', { class: 'card' }, h('h3', {}, c.name), c.contact ? h('div', {}, c.contact) : null,
      (c.phones || []).map((p) => h('div', {}, p, h('br'), link('tel', C.digits(p), 'Call'), link('sms', C.digits(p), 'Text'))),
      c.email ? h('div', {}, c.email, h('br'), link('mailto', c.email, 'Email')) : null,
      addr ? h('div', {}, addr, h('br'), h('a', { class: 'act', href: 'https://maps.apple.com/?q=' + encodeURIComponent(addr), rel: 'noopener noreferrer' }, 'Maps')) : null,
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

  /* ----- wiring ----- */
  $('unlockForm').addEventListener('submit', unlock);
  $('importBtn').onclick = () => { $('file').value = ''; $('file').click(); };
  $('file').onchange = pick;
  $('lockBtn').onclick = lock;
  document.querySelectorAll('#tabs button').forEach((b) => { b.onclick = () => tab(b.dataset.tab); });
  ['click', 'keydown', 'touchstart', 'scroll', 'input'].forEach((ev) => document.addEventListener(ev, touch, { capture: true, passive: true }));
  const idleCheck = () => { if (data && Date.now() - lastActive >= IDLE_MS) lock(); };
  setInterval(idleCheck, 15000);
  document.addEventListener('visibilitychange', idleCheck);
  window.AAIApp = { lock, idleCheck, state: () => data, IDLE_MS };
  if ('serviceWorker' in navigator) navigator.serviceWorker.register('sw.js').catch(() => {});
  lock();
})();
