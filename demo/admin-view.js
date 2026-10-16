import { adminCopy } from './admin-copy.js';
import { wholeCredits } from '../packages/ui/src/display.js';
export const TIERS = ['anonymous', 'emailGiven', 'emailConfirmed'];
export const esc = s => String(s).replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;').replaceAll('"', '&quot;');
export const fill = (s, v) => s.replace(/\{(\w+)\}/g, (m, k) => v[k] ?? m);
const svg = (d, cls = 'i', box = '0 0 24 24') => `<svg class="${cls}" viewBox="${box}" aria-hidden="true">${d}</svg>`
const I = {
  back: svg('<path d="m14.5 6-6 6 6 6"/>'), check: svg('<path d="m5 12.5 4.5 4.5L19 7.5"/>'), arrow: svg('<path d="M5 12h14m-5-5 5 5-5 5"/>'),
  lock: svg('<rect x="5" y="10.5" width="14" height="9.5" rx="2"/><path d="M8.5 10.5V8a3.5 3.5 0 0 1 7 0v2.5"/>'),
  info: svg('<circle cx="12" cy="12" r="8.5"/><path d="M12 11v5.5"/><path d="M12 7.6v.2" stroke-width="2.2"/>'),
  login: svg('<path d="M14 4h6v16h-6M3 12h12m-4-4 4 4-4 4"/>'),

}


export function adminModel(state, audit) {
  const s = state.settings, p = state.providerCap;
  const auditRow = r => {
    const old = r.oldValues, next = r.newValues;
    const who = r.actor.startsWith('operator:') ? ['op', r.actor.slice(9, r.actor.lastIndexOf('#'))] : r.actor.startsWith('ops-cli:') ? ['cli', r.actor.slice(8)] : ['sys'];
    if (next.event === 'session.erase') return { at: r.at, who, ev: ['erase', next.sessionId, next.visitor, next.result] };
    if (next.event === 'mail-cap') return { at: r.at, who, ev: [next.window === 'hour' ? 'capHour' : 'capDay', next.count] };
    const ch = [];
    for (const t of TIERS) if (old?.allowancesMicro && old.allowancesMicro[t] !== next.allowancesMicro?.[t]) ch.push([t, wholeCredits(old.allowancesMicro[t]), wholeCredits(next.allowancesMicro[t])]);
    if (old && old.confirmationEnabled !== next.confirmationEnabled) ch.push(['confirmation', old.confirmationEnabled, next.confirmationEnabled]);
    for (const [key, prefix] of [['mailCap', 'mail'], ['mailIpCap', 'ip']]) for (const win of ['hour', 'day']) if (old?.[key] && old[key][win] !== next[key]?.[win]) ch.push([prefix + (win === 'hour' ? 'Hour' : 'Day'), old[key][win], next[key][win]]);
    if (ch.length) return { at: r.at, who, ch };
    if (!old) return { at: r.at, who, ev: ['initAll', ...TIERS.map(t => wholeCredits(next.allowancesMicro[t]))] };
    if (!old.mailCap || !old.mailIpCap) return { at: r.at, who, ev: [!old.mailCap ? 'initMail' : 'initIp', ...Object.values(!old.mailCap ? next.mailCap : next.mailIpCap)] };
    return { at: r.at, who, ch: [] };
  };
  return { signed: 'in', name: state.operator.name, allow: Object.fromEntries(TIERS.map(t => [t, wholeCredits(s.allowancesMicro[t])])),
    conf: s.confirmationEnabled, delivery: state.deliveryEnabled, mail: s.mailCap, ip: s.mailIpCap,
    use: { hour: state.mailUsage.hour.count, day: state.mailUsage.day.count }, ipUse: state.busiestConnection,
    prov: { available: p.available, cap: p.capMicro / 10_000, confirmed: p.confirmedMicro / 10_000,
      reserved: p.reservedMicro / 10_000, uncertain: p.uncertainMicro / 10_000, breach: p.breach ? { reason: p.breach.reason === 'over-cap' ? 'overCap' : p.breach.reason } : null },
    audit: audit.items.map(auditRow), more: audit.nextBefore !== null, end: audit.items.length > 0 && audit.nextBefore === null,
    updatedAt: s.updatedAt, sec: { credits: { mode: 'clean' }, confirm: { mode: 'clean' }, mail: { mode: 'clean' } } };
}
export function renderAdmin(m, locale = 'de') {
  const C = adminCopy[locale === 'en' ? 'en' : 'de'];
  const nf = n => new Intl.NumberFormat(C.locale).format(n);
  const usd = credits => new Intl.NumberFormat(C.locale, { style: 'currency', currency: 'USD', currencyDisplay: 'code' }).format(credits / 100);
  const hm = iso => new Intl.DateTimeFormat(C.locale, { hour: '2-digit', minute: '2-digit' }).format(new Date(iso));
  const when = iso => new Intl.DateTimeFormat(C.locale, { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' }).format(new Date(iso));
const band = () => `<header class="ad-band"><span class="ad-wordmark"><span class="ad-mark" aria-hidden="true"></span>Aithema</span></header>`
const head = (m) => `<a class="ad-back" href="/">${I.back}<span>${esc(C.back)}</span></a>
  <h1 class="ad-title">${esc(C.title)}</h1>
  ${m.signed === 'in' ? `<form class="ad-who" method="post" action="/api/operator/logout/"><span class="nm">${esc(fill(C.operator, { name: m.name }))}</span><span class="sep" aria-hidden="true"> · </span><button type="submit">${esc(C.logout)}</button></form>` : ''}`

// The status cell stacks every message this section can show (visible one + hidden measures): no shift, ever.
function statusCell(id, msgs) {
  return `<div class="ad-status" data-status="${id}"><p class="cur" role="status" aria-live="polite"></p>${msgs.map(t => `<p class="msr" aria-hidden="true">${t}</p>`).join('')}</div>`
}
function saveRow(id, msgs) {
  return `<div class="ad-save"><button type="button" class="ad-btn" data-save="${id}" disabled><span class="l-save">${esc(C.save)}</span><span class="l-reload off" aria-hidden="true">${esc(C.reload)}</span></button>
    <button type="button" class="ad-discard off" data-discard="${id}" tabindex="-1" aria-hidden="true">${esc(C.discard)}</button>${statusCell(id, msgs)}</div>`
}
const msgSaved = () => `<span class="ok">${I.check}</span><span>${esc(fill(C.saved, { time: hm(m.savedAt ?? Date.now()) }))}</span>`
const msgInk = t => `${I.info}<span class="ink">${esc(t)}</span>`
const commonMsgs = () => [esc(C.dirty), esc(C.saving), msgSaved(), msgInk(C.failed), msgInk(fill(C.conflict, { time: C.locale === 'de' ? '30. Sept., 23:59' : 'Sep 30, 11:59 PM' }))]

function creditsSection(m) {
  const v = m.allow
  const sub = t => {
    const options = t === 'emailConfirmed' ? [C.credits.tiers[t][1], C.credits.off, C.credits.noDelivery] : [C.credits.tiers[t][1]];
    const active = t !== 'emailConfirmed' || m.conf && m.delivery ? 0 : m.delivery ? 1 : 2;
    return `<span class="ad-sub-stack">${options.map((text, i) => `<span class="ad-sub${i === active ? active ? ' off' : '' : ' msr'}"${i === active ? '' : ' aria-hidden="true"'}>${esc(text)}</span>`).join('')}</span>`;
  }
  const rows = TIERS.map(t => `<div class="ad-tier"><label for="f-${t}"><span class="ad-name">${esc(C.credits.tiers[t][0])}</span>${sub(t)}</label>
    <div class="ad-fld" data-fld="${t}"><input id="f-${t}" type="text" inputmode="numeric" autocomplete="off" spellcheck="false" value="${nf(v[t])}" data-base="${m.allow[t]}" data-sec="credits"><span class="unit">${esc(C.credits.unit)}</span></div>
    <span class="ad-usd" data-usd="${t}">${usd(v[t])}</span></div>`).join('')
  const longestOrder = fill(C.credits.order, { tier: C.credits.tiers.emailConfirmed[0], prev: C.credits.tiers.emailGiven[0] })
  return `<section class="ad-sec" aria-labelledby="h-credits" data-sec="credits"><h2 id="h-credits">${esc(C.credits.h)}</h2><p class="ad-intro">${esc(C.credits.intro)}</p>
    <div class="ad-body ad-tiers">${rows}</div><p class="ad-hint">${esc(C.credits.hint)}</p>
    ${saveRow('credits', [...commonMsgs(), msgInk(longestOrder), msgInk(C.credits.max), msgInk(C.credits.whole)])}</section>`
}
function confirmSection(m) {
  const on = m.conf
  return `<section class="ad-sec" aria-labelledby="h-confirm" data-sec="confirm"><h2 id="h-confirm">${esc(C.confirm.h)}</h2>
    <div class="ad-body"><label class="ad-check${m.delivery ? '' : ' disabled'}"><input type="checkbox" id="f-confirm" data-sec="confirm" data-base="${on}"${on ? ' checked' : ''}${m.delivery ? '' : ' disabled'}>
      <span class="ad-box">${I.check}</span><span><b>${esc(C.confirm.label)}</b><small>${esc(C.confirm.desc)}</small>${m.delivery ? '' : `<small>${esc(C.confirm.noDelivery)}</small>`}</span></label></div>
    ${saveRow('confirm', commonMsgs())}</section>`
}
function useLine(n, max, win, peak) {
  const base = (peak ? C.mail.peak : '') + fill(win === 'hour' ? C.mail.useHour : C.mail.useDay, { n: nf(n), max: nf(max) })
  let tail = ''
  if (max === 0) tail = ` · <span class="warn">${esc(C.mail.paused)}</span>`
  else if (n >= max) tail = ` · <span class="warn">${esc(C.mail.reached)}</span>`
  else if (n >= max * 0.8) tail = ` · <span class="warn">${esc(fill(C.mail.left, { n: nf(max - n) }))}</span>`
  return esc(base) + tail
}
function mailSection(m) {
  const row = (grp, win, val, use, peak) => `<div class="ad-lim"><label for="f-${grp}-${win}">${esc(C.mail[win])}</label>
    <div class="ad-fld" data-fld="${grp}-${win}"><input id="f-${grp}-${win}" type="text" inputmode="numeric" autocomplete="off" spellcheck="false" value="${nf(val)}" data-base="${val}" data-sec="mail"></div>
    <p class="ad-use">${useLine(use, val, win, peak)}</p></div>`
  return `<section class="ad-sec" aria-labelledby="h-mail" data-sec="mail"><h2 id="h-mail">${esc(C.mail.h)}</h2><p class="ad-intro">${esc(C.mail.intro)}</p>
    <div class="ad-body"><div class="ad-group" role="group" aria-labelledby="h-mail-g"><h3 id="h-mail-g">${esc(C.mail.global)}</h3>
      ${row('mail', 'hour', m.mail.hour, m.use.hour)}${row('mail', 'day', m.mail.day, m.use.day)}</div>
    <div class="ad-group" role="group" aria-labelledby="h-mail-ip"><h3 id="h-mail-ip">${esc(C.mail.ip)}</h3>
      ${row('ip', 'hour', m.ip.hour, m.ipUse.hour, true)}${row('ip', 'day', m.ip.day, m.ipUse.day, true)}</div></div>
    <p class="ad-hint">${esc(C.mail.hint)}</p>
    ${saveRow('mail', [...commonMsgs(), msgInk(C.mail.order), msgInk(C.mail.max), msgInk(C.credits.whole)])}</section>`
}
function provSection(m) {
  const p = m.prov, P = C.prov
  if (!p.available) return `<section class="ad-sec" aria-labelledby="h-prov"><h2 id="h-prov">${esc(P.h)}</h2><p class="ad-intro">${esc(P.none)}</p></section>`
  const locked = !!p.breach, remaining = locked ? 0 : Math.max(0, p.cap - p.confirmed - p.reserved - p.uncertain)
  const kv = (k, v, h = '', cls = '') => `<div class="ad-kv${cls}"><dt>${esc(k)}</dt><dd class="v">${usd(v)}</dd><dd class="h">${esc(h)}</dd></div>`
  const state = locked
    ? `<span class="ad-state">${I.lock}<span>${esc(fill(P.latchedNoTime, { reason: P.reasons[p.breach.reason] }))}</span></span><p class="ad-recover">${esc(P.recovery)}</p>`
    : `<span class="ad-state">${I.check}<span>${esc(P.open)}</span></span>`
  return `<section class="ad-sec" aria-labelledby="h-prov" data-sec="prov"><h2 id="h-prov">${esc(P.h)}</h2><p class="ad-intro">${esc(P.intro)}</p>
    <dl class="ad-body ad-dl">${kv(P.cap, p.cap)}${kv(P.confirmed, p.confirmed, P.confirmedHint)}${kv(P.reserved, p.reserved, P.reservedHint)}${kv(P.uncertain, p.uncertain, P.uncertainHint)}
    ${kv(P.remaining, remaining, locked ? P.lockedHint : '', ' sum')}<div class="ad-kv state"><dt>${esc(P.status)}</dt><dd>${state}</dd></div></dl></section>`
}
function changeText(c) {
  const [f, a, b] = c, LG = C.log
  const val = x => f === 'confirmation' ? (x ? LG.on : LG.off) : nf(x)
  const unit = ['anonymous', 'emailGiven', 'emailConfirmed'].includes(f) ? ' ' + C.credits.unit : ''
  return `<span>${esc(LG.f[f])}: <b>${esc(val(a))}</b>${I.arrow}<span class="sr">${esc(LG.to)} </span><b>${esc(val(b))}</b>${esc(unit)}</span>`
}
function eventText(e) {
  const LG = C.log, [k, ...x] = e
  if (k === 'erase') return `<span>${esc(fill(LG.erase, { id: x[0] ?? '—', scope: x[1] === null ? '—' : x[1] ? LG.visitor : LG.session, result: x[2] }))}</span>`
  if (k === 'capHour' || k === 'capDay') return `<span>${esc(fill(LG[k], { n: nf(x[0]) }))}</span>`
  if (k === 'initAll') return `<span>${esc(fill(LG.initAll, { a: nf(x[0]), b: nf(x[1]), c: nf(x[2]) }))}</span>`
  return `<span>${esc(fill(LG[k], { h: nf(x[0]), d: nf(x[1]) }))}</span>`
}
function logSection(m) {
  const who = w => w[0] === 'op' ? w[1] : w[0] === 'cli' ? fill(C.log.cli, { user: w[1] }) : C.log.system
  const rows = m.audit.map(r => `<li><span class="ad-t"><time datetime="${r.at}">${esc(when(r.at))}</time></span><span class="ad-a">${esc(who(r.who))}</span>
    <span class="ad-w">${r.ch ? r.ch.map(changeText).join('') : eventText(r.ev)}</span></li>`).join('')
  return `<section class="ad-sec" aria-labelledby="h-log" data-sec="log"><h2 id="h-log">${esc(C.log.h)}</h2><p class="ad-intro">${esc(C.log.intro)}</p>
    <div class="ad-body">${m.audit.length ? `<ol class="ad-log">${rows}</ol>` : `<p class="ad-empty">${esc(C.log.empty)}</p>`}
    ${m.more ? `<button type="button" class="ad-more">${esc(C.log.more)}</button>` : ''}${m.end ? `<p class="ad-end">${esc(C.log.end)}</p>` : ''}</div></section>`
}
function adminPage(m) {
  if (m.signed !== 'in') return `<div class="ad-page" data-product data-signed="${m.signed}">${band()}<main class="ad-main">${head(m)}
    <div class="ad-out"><p>${esc(m.signed === 'expired' ? C.out.expired : C.out.line)}</p>
    <a class="ad-login" href="/api/operator/login/?return=admin">${I.login}<span>${esc(fill(C.out.login, { provider: C.provider }))}</span></a></div></main></div>`
  return `<div class="ad-page" data-product data-signed="${m.signed}">${band()}<main class="ad-main">${head(m)}
    ${creditsSection(m)}${confirmSection(m)}${mailSection(m)}${provSection(m)}${logSection(m)}</main></div>`
}


return adminPage(m);
}
