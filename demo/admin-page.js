import { adminCopy } from './admin-copy.js';
import { adminModel, renderAdmin, TIERS, esc, fill } from './admin-view.js';
import { preferredLocale } from './page-preferences.js';

const locale = new URL(location.href).searchParams.get('lang') ?? preferredLocale();
const C = adminCopy[locale === 'en' ? 'en' : 'de'];
const nf = n => new Intl.NumberFormat(C.locale).format(n);
const usd = credits => new Intl.NumberFormat(C.locale, { style: 'currency', currency: 'USD', currencyDisplay: 'code' }).format(credits / 100);
const parseWhole = s => { const t = s.replace(/[\s.,'  ]/gu, ''); return /^\d{1,7}$/u.test(t) ? Number(t) : null; };
const exactUsd = micro => `${Math.floor(micro / 1_000_000)}.${String(micro % 1_000_000).padStart(6, '0')}`;
const time = at => {
  const d = new Date(at), today = new Date();
  const sameDay = d.toDateString() === today.toDateString();
  return new Intl.DateTimeFormat(C.locale, { ...(sameDay ? {} : { day: 'numeric', month: 'short' }), hour: '2-digit', minute: '2-digit' }).format(d);
};
let state, audit, busy = false;
const statusIcon = '<svg class="i" viewBox="0 0 24 24" aria-hidden="true"><circle cx="12" cy="12" r="8.5"/><path d="M12 11v5.5M12 7.6v.2"/></svg>';
function section(id) {
  const el = document.querySelector(`.ad-sec[data-sec="${id}"]`); if (!el) return null;
  const inputs = [...el.querySelectorAll('input[data-sec]')];
  const vals = inputs.map(i => i.type === 'checkbox' ? i.checked : parseWhole(i.value));
  const base = inputs.map(i => i.type === 'checkbox' ? i.dataset.base === 'true' : Number(i.dataset.base));
  let message, bad;
  if (id !== 'confirm') {
    const invalid = vals.findIndex(v => v === null);
    if (invalid >= 0) { message = C.credits.whole; bad = invalid; }
    else if (id === 'credits') {
      const max = vals.findIndex(v => v > 100000);
      if (max >= 0) { message = C.credits.max; bad = max; }
      else {
        const micro = vals.map((v, k) => v === base[k] ? state.settings.allowancesMicro[TIERS[k]] : v * 10000);
        for (let k = 1; k < 3; k++) if (micro[k] < micro[k - 1]) { message = fill(C.credits.order, { tier: C.credits.tiers[TIERS[k]][0], prev: C.credits.tiers[TIERS[k - 1]][0] }); bad = k; break; }
      }
    } else {
      bad = vals.findIndex((v, k) => v > (k % 2 ? 10000 : 1000));
      if (bad >= 0) message = C.mail.max;
      else if (vals[0] > vals[1] || vals[2] > vals[3]) { message = C.mail.order; bad = vals[0] > vals[1] ? 0 : 2; }
    }
  }
  return { el, inputs, vals, base, message, bad, dirty: vals.some((v, k) => v !== base[k]) };
}
function paint(id, mode, at) {
  const s = section(id); if (!s) return;
  s.el.dataset.mode = mode;
  if (at !== undefined) s.el.dataset.messageAt = String(at);
  at ??= s.el.dataset.messageAt ?? state.settings.updatedAt;
  s.inputs.forEach((i, k) => {
    const box = i.type === 'checkbox' ? i.closest('.ad-check') : i.closest('.ad-fld');
    box.classList.toggle('dirty', s.vals[k] !== s.base[k]); box.classList.toggle('bad', mode === 'invalid' && s.bad === k);
    if (i.type !== 'checkbox') i.setAttribute('aria-invalid', String(mode === 'invalid' && s.bad === k));
  });
  const button = s.el.querySelector('.ad-btn'), discard = s.el.querySelector('.ad-discard');
  for (const [selector, hidden] of [['.l-save', mode === 'conflict'], ['.l-reload', mode !== 'conflict']]) {
    const label = button.querySelector(selector); label.classList.toggle('off', hidden); label.setAttribute('aria-hidden', String(hidden));
  }
  button.disabled = busy || !['dirty', 'conflict', 'failed'].includes(mode);
  const showDiscard = ['dirty', 'invalid', 'failed'].includes(mode);
  discard.classList.toggle('off', !showDiscard); discard.tabIndex = showDiscard ? 0 : -1; discard.setAttribute('aria-hidden', String(!showDiscard)); discard.disabled = busy;
  s.inputs.forEach(i => { i.disabled = busy || id === 'confirm' && !state.deliveryEnabled; });
  const msg = mode === 'dirty' ? C.dirty : mode === 'saving' ? C.saving : mode === 'saved' ? fill(C.saved, { time: time(at) }) : mode === 'invalid' ? s.message : mode === 'failed' ? C.failed : mode === 'conflict' ? fill(C.conflict, { time: time(at) }) : '';
  const cur = s.el.querySelector('.ad-status .cur');
  cur.innerHTML = ['invalid', 'failed', 'conflict'].includes(mode) ? `${statusIcon}<span class="ink">${esc(msg)}</span>` : mode === 'saved'
    ? `<span class="ok"><svg class="i" viewBox="0 0 24 24" aria-hidden="true"><path d="m5 12.5 4.5 4.5L19 7.5"/></svg></span><span>${esc(msg)}</span>` : esc(msg);
  if (id === 'credits') TIERS.forEach((t, k) => { if (s.vals[k] !== null) s.el.querySelector(`[data-usd="${t}"]`).textContent = usd(s.vals[k]); });
}
function edited(id) {
  const s = section(id); if (!s || s.el.dataset.mode === 'conflict') return;
  paint(id, s.message ? 'invalid' : s.dirty ? 'dirty' : 'clean');
}
function signedOut() {
  busy = false; state = undefined;
  document.body.innerHTML = renderAdmin({ signed: 'expired' }, locale);
}
async function read(path, options) {
  const r = await fetch('/api/operator/admin/' + path, { cache: 'no-store', ...options });
  if (r.status === 401) { signedOut(); throw Object.assign(new Error('expired'), { expired: true }); }
  const data = await r.json(); if (!r.ok) throw Object.assign(new Error('admin-request'), { status: r.status, data });
  return data;
}
async function reload() {
  // Serialize the two reads so a 401 cannot trigger a later stale render.
  const fresh = await read('state'), log = await read('audit');
  state = fresh; audit = log; document.body.innerHTML = renderAdmin(adminModel(state, audit), locale); wire();
}
function updateDependencies() {
  const m = adminModel(state, audit), d = document.createElement('div'); d.innerHTML = renderAdmin(m, locale);
  for (const selector of ['.ad-sub-stack', '.ad-use', '[data-sec=log] .ad-body']) {
    const nodes = [...document.querySelectorAll(selector)], fresh = [...d.querySelectorAll(selector)];
    nodes.forEach((node, i) => { node.innerHTML = fresh[i].innerHTML; });
  }
  wireMore();
}
function applySettings(saved, savedSection) {
  const previous = Object.fromEntries(['credits', 'confirm', 'mail'].map(id => [id, section(id)]));
  state.settings = saved;
  const m = adminModel(state, audit);
  const bases = { credits: TIERS.map(t => m.allow[t]), confirm: [m.conf], mail: [m.mail.hour, m.mail.day, m.ip.hour, m.ip.day] };
  for (const id of ['credits', 'confirm', 'mail']) {
    const s = previous[id];
    s.inputs.forEach((input, k) => {
      input.dataset.base = String(bases[id][k]);
      if (id === savedSection || s.vals[k] === s.base[k]) {
        if (input.type === 'checkbox') input.checked = bases[id][k]; else input.value = nf(bases[id][k]);
      }
    });
    if (id !== savedSection) edited(id);
  }
}
async function save(id) {
  if (busy) return;
  const s = section(id); if (!s) return;
  const conflict = s.el.dataset.mode === 'conflict';
  if (!conflict && (!s.dirty || s.message)) return;
  busy = true; for (const sec of ['credits', 'confirm', 'mail']) paint(sec, sec === id ? 'saving' : section(sec).el.dataset.mode);
  try {
    if (conflict) { await reload(); return; }
    const input = { baseRevision: state.settings.revision };
    if (id === 'credits') input.allowancesUsd = Object.fromEntries(TIERS.map((t, k) => [t, s.vals[k] === s.base[k] ? exactUsd(state.settings.allowancesMicro[t]) : exactUsd(s.vals[k] * 10000)]));
    if (id === 'confirm') input.confirmationEnabled = s.vals[0];
    if (id === 'mail') { input.mailCap = { hour: s.vals[0], day: s.vals[1] }; input.mailIpCap = { hour: s.vals[2], day: s.vals[3] }; }
    const saved = await read('settings', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(input) });
    applySettings(saved, id); busy = false; paint(id, 'saved', saved.updatedAt);
    // Saving is complete even if a subsequent audit read is temporarily unavailable.
    try { audit = await read('audit'); updateDependencies(); } catch (error) { if (error.expired) return; }
  } catch (error) {
    if (error.expired) return;
    busy = false; paint(id, error.status === 409 ? 'conflict' : 'failed', error.data?.current?.updatedAt);
  } finally {
    busy = false;
    if (state) for (const sec of ['credits', 'confirm', 'mail']) {
      const s = section(sec); s.inputs.forEach(i => { i.disabled = sec === 'confirm' && !state.deliveryEnabled; });
      s.el.querySelector('.ad-btn').disabled = !['dirty', 'conflict', 'failed'].includes(s.el.dataset.mode);
      s.el.querySelector('.ad-discard').disabled = false;
    }
  }
}
function wireMore() {
  document.querySelector('.ad-more')?.addEventListener('click', async event => {
    event.target.disabled = true;
    try { const page = await read('audit?before=' + audit.nextBefore); audit = { items: [...audit.items, ...page.items], nextBefore: page.nextBefore }; updateDependencies(); }
    catch (error) { if (!error.expired) event.target.disabled = false; }
  });
}
function wire() {
  for (const input of document.querySelectorAll('input[data-sec]')) {
    input.addEventListener(input.type === 'checkbox' ? 'change' : 'input', () => edited(input.dataset.sec));
    if (input.type !== 'checkbox') input.addEventListener('blur', () => { const n = parseWhole(input.value); if (n !== null) input.value = nf(n); });
  }
  for (const b of document.querySelectorAll('[data-save]')) b.addEventListener('click', () => void save(b.dataset.save));
  for (const b of document.querySelectorAll('[data-discard]')) b.addEventListener('click', () => {
    const s = section(b.dataset.discard); s.inputs.forEach((i, k) => { if (i.type === 'checkbox') i.checked = s.base[k]; else i.value = nf(s.base[k]); }); paint(b.dataset.discard, 'clean');
  });
  for (const id of ['credits', 'confirm', 'mail']) paint(id, 'clean'); wireMore();
}
addEventListener('beforeunload', event => {
  if (state && ['credits', 'confirm', 'mail'].some(id => section(id)?.dirty)) { event.preventDefault(); event.returnValue = ''; }
});
document.documentElement.lang = locale === 'en' ? 'en' : 'de'; document.title = C.title + ' · Aithema';
if (document.querySelector('.ad-page')?.dataset.signed === 'in') {
  try { await reload(); } catch (error) {
    if (!error.expired) {
      // The authenticated server-rendered state stays readable; reload retries initialization.
      const status = document.querySelector('.ad-status .cur'); if (status) status.textContent = C.failed;
    }
  }
} else {
  document.body.innerHTML = renderAdmin({ signed: document.querySelector('.ad-page')?.dataset.signed ?? 'out' }, locale);
}
