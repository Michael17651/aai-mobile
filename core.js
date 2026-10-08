/* Pure logic: bundle crypto, price rules, self-check, search. No DOM, no network.
   Format: see "Phone bundle export" in the AAI Console CLAUDE.md (summarized in README). */
(function (root) {
  'use strict';
  const ITER = 600000;
  const cents = (n) => Math.round(n * 100) / 100;
  const fromB64 = (s) => { const b = atob(s), u = new Uint8Array(b.length); for (let i = 0; i < b.length; i++) u[i] = b.charCodeAt(i); return u; };

  /* ---------- crypto: one file layout {v:1,salt,iv,ct} for .aaib bundles and .aaio outboxes ---------- */
  const toB64 = (u8) => { let s = ''; u8.forEach((b) => { s += String.fromCharCode(b); }); return btoa(s); };
  const aesKey = async (pass, salt, use, subtle) => {
    const base = await subtle.importKey('raw', new TextEncoder().encode(pass), 'PBKDF2', false, ['deriveKey']);
    return subtle.deriveKey({ name: 'PBKDF2', salt, iterations: ITER, hash: 'SHA-256' }, base, { name: 'AES-GCM', length: 256 }, false, [use]);
  };
  async function seal(obj, pass, subtle) {
    subtle = subtle || root.crypto.subtle;
    const salt = root.crypto.getRandomValues(new Uint8Array(16)), iv = root.crypto.getRandomValues(new Uint8Array(12));
    const key = await aesKey(pass, salt, 'encrypt', subtle);
    const ct = new Uint8Array(await subtle.encrypt({ name: 'AES-GCM', iv }, key, new TextEncoder().encode(JSON.stringify(obj))));
    return JSON.stringify({ v: 1, salt: toB64(salt), iv: toB64(iv), ct: toB64(ct) });
  }
  async function decrypt(text, pass, subtle, what) {
    subtle = subtle || (root.crypto && root.crypto.subtle);
    let f;
    try { f = JSON.parse(text); } catch (e) { throw new Error('This is not a ' + what + '.'); }
    if (!f || f.v !== 1 || !f.salt || !f.iv || !f.ct) throw new Error('This is not a ' + what + ' (or a newer version).');
    try {
      const key = await aesKey(pass, fromB64(f.salt), 'decrypt', subtle);
      return JSON.parse(new TextDecoder().decode(await subtle.decrypt({ name: 'AES-GCM', iv: fromB64(f.iv) }, key, fromB64(f.ct))));
    } catch (e) { throw new Error('Wrong passphrase, or the file is damaged.'); }
  }
  async function open(text, pass, subtle) {
    const bundle = await decrypt(text, pass, subtle, 'phone bundle');
    if (!bundle || bundle.version !== 1 || !['customers', 'catalog', 'followUps', 'checks'].every((k) => Array.isArray(bundle[k]))) throw new Error('The bundle is not a version 1 bundle.');
    return bundle;
  }
  async function openOutbox(text, pass, subtle) {
    const o = await decrypt(text, pass, subtle, 'outbox file');
    if (!o || o.version !== 1 || !Array.isArray(o.records)) throw new Error('The file is not a version 1 outbox.');
    return o;
  }

  /* ---------- pricing ---------- */
  const find = (catalog, name) => {
    const k = String(name).toLowerCase();
    return catalog.find((c) => c.name.toLowerCase() === k) || catalog.find((c) => (c.aliases || []).some((a) => a.toLowerCase() === k)) || null;
  };
  // No tiers, or a tier price that is not a positive number = call for price, never $0.
  const isCall = (c) => !c.tiers || !c.tiers.length || !c.tiers.every((t) => Number(t[1]) > 0);
  // Unit price: the tier with the largest minimum at or below qty (qty under 1 counts as 1).
  function tierPrice(c, qty) {
    const n = Math.max(1, Number(qty) || 0);
    let p = c.tiers[0][1];
    for (const t of c.tiers) if (t[0] <= n) p = t[1];
    return p;
  }
  function tierLabels(c) {
    const t = c.tiers;
    return t.map((x, i) => (t.length === 1 ? 'Each' : i + 1 < t.length ? (t[i + 1][0] - 1 > x[0] ? x[0] + '–' + (t[i + 1][0] - 1) : String(x[0])) : x[0] + '+'));
  }
  // Master Panda boards pool their quantities for the tier; every Nth board is free at the average billed price.
  function priceQuote(rows, catalog, rules) {
    const items = rows.map((r) => ({ r, c: find(catalog, r.item) }));
    if (items.some((x) => !x.c || isCall(x.c))) throw new Error('unknown or call-for-price item in a quote');
    const mpQty = items.filter((x) => x.c.mp).reduce((a, x) => a + (Number(x.r.qty) || 0), 0);
    const units = items.map((x) => tierPrice(x.c, x.c.mp ? mpQty : x.r.qty));
    const line = (i) => units[i] * (Number(rows[i].qty) || 0);
    const promo = [];
    const mp = items.map((x, i) => (x.c.mp && (Number(x.r.qty) || 0) > 0 ? i : -1)).filter((i) => i >= 0);
    const n = mp.reduce((a, i) => a + Number(rows[i].qty), 0), free = Math.floor(n / rules.freeBoard.every);
    if (free) promo.push(-Math.round(free * mp.reduce((a, i) => a + line(i), 0) / n * 100) / 100);
    const titled = rows.reduce((a, r) => a + (rules.titleAdd.titles.indexOf(r.title) > -1 ? Number(r.qty) || 0 : 0), 0);
    const extra = titled ? [titled * rules.titleAdd.amount] : [];
    const total = cents(rows.reduce((a, r, i) => a + line(i), 0) + promo.concat(extra).reduce((a, x) => a + x, 0));
    return { units, promo, extra, total };
  }
  // Quote lines for the capture screen: same engine as the Price check, but call-for-price items are listed, never priced, never $0.
  // rows: [{item, qty, title?}] -> {lines:[{name, qty, call, unit, total, title}], promo, extra, total, incomplete}
  function priceLines(rows, catalog, rules) {
    const items = rows.map((r) => ({ r, c: find(catalog, r.item) }));
    const ok = (x) => x.c && !isCall(x.c);
    const q = items.some(ok) ? priceQuote(items.filter(ok).map((x) => x.r), catalog, rules) : { units: [], promo: [], extra: [], total: 0 };
    let k = 0;
    const lines = items.map((x) => {
      const qty = Number(x.r.qty) || 0, title = x.r.title || null;
      if (!ok(x)) return { name: x.c ? x.c.name : String(x.r.item), qty, call: true, unit: null, total: null, title };
      const unit = q.units[k++];
      return { name: x.c.name, qty, call: false, unit, total: cents(unit * qty), title };
    });
    return { lines, promo: q.promo, extra: q.extra, total: q.total, incomplete: lines.some((l) => l.call) };
  }
  const same = (a, b) => Array.isArray(a) && Array.isArray(b) && a.length === b.length && a.every((x, i) => Math.abs(x - b[i]) < 0.005);
  // Returns the failing checks ([] = all pass). Anything malformed counts as failing.
  function selfCheck(b) {
    const bad = [], rules = b.rules;
    const okRules = rules && rules.titleAdd && Array.isArray(rules.titleAdd.titles) && Number(rules.titleAdd.amount) > 0 && rules.freeBoard && Number(rules.freeBoard.every) > 0;
    b.checks.forEach((k) => {
      let ok = false;
      try {
        if (k.kind === 'tier') {
          const c = find(b.catalog, k.item);
          if (c && !isCall(c)) { const u = tierPrice(c, k.qty); ok = Math.abs(u - k.expect.unit) < 0.005 && Math.abs(cents(u * k.qty) - k.expect.total) < 0.005; }
        } else if (k.kind === 'quote' && okRules) {
          const got = priceQuote(k.rows, b.catalog, rules), e = k.expect;
          ok = same(got.units, e.units) && same(got.promo, e.promo) && same(got.extra, e.extra) && Math.abs(got.total - e.total) < 0.005;
        }
      } catch (e) { ok = false; }
      if (!ok) bad.push({ id: k.id, text: k.kind === 'tier' ? k.item + ' at ' + k.qty : (k.desc || 'quote check') });
    });
    return { total: b.checks.length, failed: bad, ok: b.checks.length > 0 && !bad.length };
  }

  /* ---------- search ---------- */
  const digits = (s) => String(s || '').replace(/\D/g, '');
  const PHONEISH = /^[\d\s().+-]+$/;
  // 4+ digits, leading 1 ignored, matched anywhere in either phone.
  function phoneHit(q, c) {
    let d = digits(q);
    if (d.length < 4) return false;
    if (d[0] === '1') d = d.slice(1);
    return !!d && (c.phones || []).some((p) => digits(p).indexOf(d) > -1);
  }
  function searchCustomers(list, q) {
    q = String(q || '').trim().toLowerCase();
    if (!q) return [];
    const phoneOnly = PHONEISH.test(q);
    return list.filter((c) => {
      const hay = [c.name, c.contact, c.city, c.state, c.zip, c.email].join(' ').toLowerCase();
      if (phoneOnly && phoneHit(q, c)) return true;
      return q.split(/\s+/).every((t) => hay.indexOf(t) > -1 || phoneHit(t, c));
    });
  }
  function searchCatalog(list, q, group) {
    q = String(q || '').trim().toLowerCase();
    return list.filter((c) => (!group || c.group === group) &&
      (!q || q.split(/\s+/).every((t) => [c.name, c.note].concat(c.aliases || []).join(' ').toLowerCase().indexOf(t) > -1)));
  }

  /* ---------- misc ---------- */
  const dayStr = (d) => d.getFullYear() + '-' + String(d.getMonth() + 1).padStart(2, '0') + '-' + String(d.getDate()).padStart(2, '0');
  // 'overdue' | 'soon' (today..+3 days) | ''
  function dueClass(due, now) {
    if (!due) return '';
    const t = dayStr(now), s = new Date(now); s.setDate(s.getDate() + 3);
    return due < t ? 'overdue' : due <= dayStr(s) ? 'soon' : '';
  }
  const ageClass = (iso, now) => { const d = (now - new Date(iso)) / 864e5; return d > 30 ? 'red' : d > 7 ? 'amber' : ''; };

  const stamp = (d) => dayStr(d) + '-' + String(d.getHours()).padStart(2, '0') + String(d.getMinutes()).padStart(2, '0');

  const api = { open, seal, openOutbox, priceLines, stamp, find, isCall, tierPrice, tierLabels, priceQuote, selfCheck, searchCustomers, searchCatalog, dueClass, ageClass, dayStr, digits };
  if (typeof module !== 'undefined' && module.exports) module.exports = api; else root.AAICore = api;
})(typeof globalThis !== 'undefined' ? globalThis : this);
