import { en } from '../packages/ui/src/i18n/en.js';
import { de } from '../packages/ui/src/i18n/de.js';
import { postJson } from '../packages/ui/src/post-json.js';
import { localeKey, sessionKey, preferredLocale, remember, mountTheme, paintUtilities } from './page-preferences.js';

// START consentReturnPath: normalize first, then check again. Backslashes and
// dot segments must not turn an apparently relative path into an external URL.
export function consentReturnPath(value, origin) {
  if (typeof value !== 'string' || !value.startsWith('/') || value.startsWith('//') || /[\\\u0000-\u0020]/u.test(value)) return '/';
  try {
    const url = new URL(value, origin);
    if (url.origin !== origin || url.pathname.startsWith('//')) return '/';
    return url.pathname + url.search + url.hash;
  } catch { return '/'; }
}
export function translatedItem(item, copy) {
  const translated = Object.hasOwn(copy.processingConsent.items, item.id) ? copy.processingConsent.items[item.id] : null;
  return translated?.version === item.version ? { ...item, ...translated } : item;
}

// The consent page has no component, voice client or microphone import.
export async function mountConsentPage({ document = globalThis.document, location = globalThis.location,
  storage, fetchImpl = globalThis.fetch, submit = postJson, navigate = path => location.assign(path) } = {}) {
  const query = new URLSearchParams(location.search), id = query.get('session');
  const returnTo = consentReturnPath(query.get('return'), location.origin);
  const fieldset = document.querySelector('#processing-items'), status = document.querySelector('#consent-status');
  const text = (selector, value) => { document.querySelector(selector).textContent = value; };
  let copy = { de, en }[preferredLocale(storage)], binding, session, rendered, selected = [], busy = true, usable = false, retryAction;
  mountTheme(document, storage);
  for (const back of document.querySelectorAll('[data-back]')) back.href = returnTo;
  function paint() {
    const h = copy.host, c = h.consentPage;
    document.documentElement.lang = session?.locale ?? preferredLocale(storage);
    document.title = `${h.processingTitle} — Aithema`;
    paintUtilities(copy, document);
    document.querySelector('#locale').value = preferredLocale(storage);
    text('#language-note', session && preferredLocale(storage) !== session.locale ? h.languageNext.replace('{language}', h.languages[preferredLocale(storage)]) : '');
    text('#consent-title', binding?.voiceMode === 'elevenlabs' && !binding.processingConsent ? copy.voiceHostConsentTitle : binding?.processingConsent ? h.processingTitle : h.consentTitle);
    text('#consent-legend', c.legend); text('#retry', c.retry);
    for (const back of document.querySelectorAll('[data-back]')) back.textContent = c.back;
    updateActions();
  }
  function updateActions() {
    const c = copy.host.consentPage, boxes = [...fieldset.querySelectorAll('input')], count = boxes.filter(box => box.checked).length;
    const label = count === 0 ? selected.length ? copy.host.revoke : c.none : count === boxes.length ? c.all : count === 1 ? c.one : c.count;
    for (const button of document.querySelectorAll('[data-grant]')) { button.textContent = label.replace('{count}', String(count)); button.disabled = busy || !usable; }
    for (const button of document.querySelectorAll('[data-select-all]')) { button.textContent = c.selectAll; button.disabled = busy || !usable || count === boxes.length; }
    // Keep withdrawal available even with stale terms or unavailable granting.
    for (const button of document.querySelectorAll('[data-revoke]')) { button.textContent = copy.host.revoke; button.disabled = busy || !session; }
    fieldset.disabled = busy || !usable;
  }
  function state(name, message, retry) {
    status.dataset.state = name;
    status.setAttribute('role', ['failed', 'stale'].includes(name) ? 'alert' : 'status');
    text('#status-text', message); retryAction = retry;
    document.querySelector('#retry').hidden = !retry;
    updateActions();
  }
  function renderItems() {
    for (const row of fieldset.querySelectorAll('.consent-item')) row.remove();
    const c = copy.host.consentPage;
    const contract = binding.processingConsent;
    const kind = !session.engine?.visuals || session.engine.visuals === 'off' || session.processingPreset === 'device' ? 'off' : session.conceptVisualKind === 'html' ? 'html' : 'images';
    const items = contract ? rendered.items : [{ id: 'mock-processing', version: 1, title: copy.host.consentTitle,
      recipients: c.mockRecipients, text: `${copy.host.consentUse[kind]} ${copy.host.consentTerms} ${c.mockConsequence}` }];
    text('#consent-text', c.intro);
    text('#consent-info', contract ? copy.processingConsent.withdrawal ?? rendered.withdrawal : copy.host.consentTerms);
    for (const [index, item] of items.entries()) {
      const legal = contract ? translatedItem(item, copy) : item;
      const row = document.createElement('div'); row.className = 'consent-item';
      const label = document.createElement('label'), box = document.createElement('input'), title = document.createElement('span');
      box.type = 'checkbox'; box.value = item.id; box.checked = selected.includes(item.id); box.name = 'item';
      box.id = `consent-item-${index}`; box.setAttribute('aria-describedby', `consent-recipients-${index} consent-text-${index}`);
      title.textContent = legal.title; label.append(box, title);
      const recipients = document.createElement('p'), purpose = document.createElement('p');
      recipients.id = `consent-recipients-${index}`; recipients.textContent = legal.recipients;
      purpose.id = `consent-text-${index}`; purpose.textContent = legal.text;
      row.append(label);
      const marking = rendered.required?.includes(item.id) ? c.required : rendered.optional?.includes(item.id) ? c.optional : '';
      if (marking) { const mark = document.createElement('span'); mark.className = 'consent-item__mark'; mark.textContent = marking; row.append(mark); }
      row.append(recipients, purpose); fieldset.append(row);
    }
  }
  async function get(path) {
    const response = await fetchImpl(path, { cache: 'no-store' });
    if (!response.ok) throw Object.assign(new Error('Request failed'), { status: response.status });
    return response.json();
  }
  async function load() {
    busy = true; usable = false; paint(); state('loading', copy.host.consentPage.loading);
    if (!id || !/^[a-zA-Z0-9_-]{1,128}$/u.test(id)) { busy = false; state('missing', copy.host.consentPage.missing); return; }
    try {
      binding = await get('/demo/config');
      session = await get(`/api/sessions/${id}`);
      if (session.tombstone) throw Object.assign(new Error('No conversation'), { status: 404 });
      copy = { de, en }[session.locale] ?? copy;
      rendered = binding.processingConsent ?? {};
      // Paint the server's document before the grant request finishes. If the
      // verdict cannot be read the controls remain closed and no boxes are ticked.
      selected = []; renderItems(); paint();
      if (binding.voiceMode === 'elevenlabs' && !binding.processingConsent) {
        text('#consent-text', copy.voiceHostConsent); text('#consent-info', copy.voiceHostConsent);
        fieldset.querySelectorAll('.consent-item').forEach(row => row.remove());
        busy = false; state('unavailable', copy.voiceHostConsent); return;
      }
      const current = await get(`/api/sessions/${id}/consent`);
      // The per-session contract is the authoritative current document.
      if (binding.processingConsent && current.contract) rendered = current;
      selected = current.selected ?? [];
      usable = true; busy = false; renderItems(); paint();
      state('ready', session.consentWithdrawn ? copy.host.consentWithdrawn : selected.length ? binding.processingConsent ? copy.host.processingSaved : copy.host.consentAllowed : binding.processingConsent ? copy.host.processingWaiting : copy.host.consentRequired);
    } catch (error) {
      busy = false;
      if ([403, 404, 410].includes(error.status)) { session = null; state('missing', copy.host.consentPage.missing); }
      else state('failed', copy.host.consentFailed, load);
    }
  }
  async function save(withdraw = false) {
    if (busy || !session || !withdraw && !usable) return;
    const items = withdraw ? [] : [...fieldset.querySelectorAll('input:checked')].map(box => box.value);
    const granted = !withdraw && items.length > 0;
    busy = true; state('saving', copy.host.consentPage.saving);
    try {
      const response = await submit(`/api/sessions/${id}/consent`, { granted,
        ...(binding.processingConsent ? { processing: { contract: rendered.contract, items } } : {}) });
      if (!response.ok) {
        if (response.status === 409 && binding.processingConsent) {
          const current = await get(`/api/sessions/${id}/consent`);
          if (current.contract !== rendered.contract) { busy = false; usable = false; state('stale', copy.host.consentPage.stale, load); return; }
        }
        throw Object.assign(new Error('Save failed'), { status: response.status });
      }
      const ack = await response.json();
      // A successful HTTP response alone is not a grant verdict.
      if (ack.granted !== granted) throw new Error('Missing acknowledgement');
      const current = binding.voiceMode === 'elevenlabs' && !binding.processingConsent
        ? { selected: (await get(`/api/sessions/${id}`)).consentWithdrawn ? [] : ['unconfirmed'] }
        : await get(`/api/sessions/${id}/consent`);
      if (!Array.isArray(current.selected) || current.selected.length !== items.length || !items.every(item => current.selected.includes(item))) throw new Error('Unconfirmed consent');
      if (granted && binding.processingConsent && current.contract !== rendered.contract) throw new Error('Consent contract changed');
      remember(sessionKey, id, storage);
      navigate(returnTo);
    } catch (error) {
      busy = false;
      if ([403, 404, 410].includes(error.status)) { session = null; usable = false; state('missing', copy.host.consentPage.missing); }
      else state('failed', copy.host.consentFailed, () => save(withdraw));
    }
  }
  fieldset.addEventListener('change', updateActions);
  for (const button of document.querySelectorAll('[data-select-all]')) button.addEventListener('click', () => {
    fieldset.querySelectorAll('input').forEach(box => { box.checked = true; }); updateActions();
  });
  for (const button of document.querySelectorAll('[data-grant]')) button.addEventListener('click', () => void save());
  for (const button of document.querySelectorAll('[data-revoke]')) button.addEventListener('click', () => void save(true));
  document.querySelector('#retry').addEventListener('click', () => void retryAction?.());
  document.querySelector('#locale').addEventListener('change', event => { remember(localeKey, event.target.value, storage); paint(); });
  document.querySelector('#new').addEventListener('click', () => {
    try { (storage ?? globalThis.localStorage)?.removeItem(sessionKey); } catch { /* A fresh opening still works. */ }
    navigate('/');
  });
  document.defaultView?.addEventListener('pageshow', event => { if (event.persisted) void load(); });
  await load();
  return { load, save };
}
