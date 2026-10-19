import { en } from '../packages/ui/src/i18n/en.js';
import { de } from '../packages/ui/src/i18n/de.js';
import { withDemoConsentCopy } from './consent-copy.js';
import { postJson } from './post-json.js';
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
export function translatedItem(item, copy, presentation, locale) {
  const supplied = presentation?.translations?.find(entry => entry.locale === (locale ?? copy.display?.locale))?.consentItem;
  const translated = supplied?.id === item.id ? supplied : Object.hasOwn(copy.processingConsent.items, item.id) ? copy.processingConsent.items[item.id] : null;
  return translated?.version === item.version ? { ...item, ...translated } : item;
}

// The consent page has no component, voice client or microphone import.
export async function mountConsentPage({ document = globalThis.document, location = globalThis.location,
  storage, fetchImpl = globalThis.fetch, submit = postJson, clock = globalThis, navigate = path => location.assign(path) } = {}) {
  const query = new URLSearchParams(location.search), id = query.get('session');
  const returnTo = consentReturnPath(query.get('return'), location.origin);
  const fieldset = document.querySelector('#processing-items'), status = document.querySelector('#consent-status');
  const text = (selector, value) => { document.querySelector(selector).textContent = value; };
  const bundles = { de: withDemoConsentCopy(de), en: withDemoConsentCopy(en) };
  let copy = bundles[preferredLocale(storage)], binding, session, rendered, selected = [], hasGrant = false, busy = true, usable = false, retryAction;
  let active, pendingChoice, consentRevision;
  // Scope the reserved slots to this page. The shared host stylesheet is also
  // used by the conversation surface, outside this change's write set.
  const style = document.createElement('style');
  style.textContent = `
    .consent-actions [data-revoke] { width:224px; min-height:60px; flex:none; }
    .consent-actions [data-revoke][hidden], #consent-status #retry[hidden] { display:inline-flex!important; visibility:hidden; }
    #consent-status { display:grid; grid-template-columns:minmax(0,1fr) 224px; gap:16px; align-items:center; min-height:44px; }
    #status-text { display:block; min-height:21px; }
    #consent-status #retry { width:224px; min-height:44px; scroll-margin-block:8px; display:inline-flex; align-items:center; justify-content:flex-start; }
    @media(max-width:600px) {
      .consent-actions [data-revoke] { width:100%; }
      #consent-status { grid-template-columns:minmax(0,1fr); grid-template-rows:minmax(42px,auto) 44px; gap:4px; }
      #status-text { min-height:42px; font-size:13px; line-height:21px; }
    }`;
  document.head.append(style);
  // Every await (including JSON bodies and the confirmation GET) shares the
  // operation's one deadline. Aborting also settles fixtures/transports that
  // ignore AbortSignal; a superseded operation cannot repaint or navigate.
  function begin(kind, milliseconds) {
    active?.cancel(new Error('Superseded consent request'));
    const controller = new AbortController();
    let reject;
    const cancelled = new Promise((resolve, fail) => { reject = fail; });
    const operation = { kind, controller, cancelled, cancel(error) {
      if (controller.signal.aborted) return;
      operation.reason = error; controller.abort(); reject(error); clock.clearTimeout(operation.timer);
    } };
    operation.timer = clock.setTimeout(() => operation.cancel(Object.assign(new Error('Consent deadline exceeded'), { deadline: true })), milliseconds);
    active = operation;
    return operation;
  }
  async function checked(operation, promise) {
    try {
      const value = await Promise.race([promise, operation.cancelled]);
      if (active !== operation || operation.controller.signal.aborted) throw operation.reason ?? new Error('Superseded consent request');
      return value;
    } catch (error) { throw operation.controller.signal.aborted ? operation.reason : error; }
  }
  function finish(operation) {
    clock.clearTimeout(operation.timer);
    if (active === operation) active = null;
  }
  // Until a pending choice is reconciled, it may already exist on the server.
  const withdrawalAvailable = () => !!session && !!(hasGrant || pendingChoice);
  const matchesChoice = (current, choice) => Array.isArray(current.selected) && current.selected.length === choice.items.length
    && choice.items.every(item => current.selected.includes(item)) && (!choice.granted || !binding.processingConsent || current.contract === choice.contract);
  function saved() { remember(sessionKey, id, storage); navigate(returnTo); }
  mountTheme(document, storage);
  for (const back of document.querySelectorAll('[data-back]')) back.href = returnTo;
  function paint() {
    const h = copy.host, c = h.consentPage;
    document.documentElement.lang = session?.locale ?? preferredLocale(storage);
    document.title = `${h.processingTitle} — Aithema`;
    paintUtilities(copy, document);
    text('#language-note', session && preferredLocale(storage) !== session.locale ? h.languageNext.replace('{language}', h.languages[preferredLocale(storage)]) : '');
    text('#consent-title', binding?.voiceMode === 'elevenlabs' && !binding.processingConsent ? copy.voiceHostConsentTitle : binding?.processingConsent ? h.processingTitle : h.consentTitle);
    text('#consent-legend', c.legend);
    for (const back of document.querySelectorAll('[data-back]')) back.textContent = c.back;
    updateActions();
  }
  function updateActions() {
    const c = copy.host.consentPage, boxes = [...fieldset.querySelectorAll('input')], count = boxes.filter(box => box.checked).length;
    const label = count === 0 ? hasGrant && usable ? copy.host.revoke : c.none : count === boxes.length ? c.all : count === 1 ? c.one : c.count;
    for (const button of document.querySelectorAll('[data-grant]')) { button.textContent = label.replace('{count}', String(count)); button.disabled = busy || !usable; }
    for (const button of document.querySelectorAll('[data-select-all]')) { button.textContent = c.selectAll; button.disabled = busy || !usable || count === boxes.length; }
    // Keep withdrawal available even with stale terms or unavailable granting.
    for (const button of document.querySelectorAll('[data-revoke]')) { button.textContent = copy.host.revoke; button.hidden = !withdrawalAvailable(); button.disabled = !withdrawalAvailable() || ['loading', 'load-timeout'].includes(status.dataset.state); }
    for (const control of document.querySelectorAll('#locale, #theme, #new')) control.disabled = ['loading', 'load-timeout'].includes(status.dataset.state);
    fieldset.disabled = busy || !usable;
  }
  function state(name, message, retry, focus = false) {
    status.dataset.state = name;
    const alert = ['failed', 'stale'].includes(name);
    status.setAttribute('role', alert ? 'alert' : 'status');
    status.setAttribute('aria-live', alert ? 'assertive' : 'polite');
    status.setAttribute('aria-atomic', 'false');
    // Updating only the text node once avoids repeated announcements on paint.
    if (document.querySelector('#status-text').textContent !== message) text('#status-text', message);
    retryAction = retry;
    const action = document.querySelector('#retry');
    action.setAttribute('aria-live', 'off');
    action.textContent = name === 'save-unconfirmed' ? copy.host.consentPage.loadCurrent : copy.host.consentPage.retry;
    action.hidden = !retry; action.disabled = !retry;
    if (focus && retry) {
      action.focus({ preventScroll: true });
      action.scrollIntoView({ block: 'nearest', inline: 'nearest', behavior: 'instant' });
    }
    updateActions();
  }
  function renderItems() {
    for (const row of fieldset.querySelectorAll('.consent-item')) row.remove();
    const c = copy.host.consentPage;
    const contract = binding.processingConsent;
    const kind = !session.engine?.visuals || session.engine.visuals === 'off' || session.processingPreset === 'device' ? 'off' : session.conceptVisualKind === 'html' ? 'html' : 'images';
    const items = contract ? rendered.items : [{ id: 'mock-processing', version: 1, title: copy.host.consentTitle,
      recipients: c.mockRecipients, text: `${copy.host.consentUse[kind]} ${c.mockConsequence}` }];
    text('#consent-text', contract ? copy.processingConsent.intro ?? rendered.intro : c.intro);
    text('#consent-info', contract ? copy.processingConsent.withdrawal ?? rendered.withdrawal : c.mockTerms);
    for (const [index, item] of items.entries()) {
      const legal = contract ? translatedItem(item, copy, binding.voicePresentation, session.locale) : item;
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
  async function get(path, operation) {
    const response = await checked(operation, fetchImpl(path, { cache: 'no-store', signal: operation.controller.signal }));
    if (!response.ok) throw Object.assign(new Error('Request failed'), { status: response.status });
    return checked(operation, response.json());
  }
  async function load(choice, notSaved = false) {
    busy = true; usable = false;
    selected = []; fieldset.querySelectorAll('input').forEach(box => { box.checked = false; });
    paint(); state('loading', copy.host.consentPage.loading);
    if (!id || !/^[a-zA-Z0-9_-]{1,128}$/u.test(id)) { busy = false; state('missing', copy.host.consentPage.missing); return; }
    const operation = begin('load', 8000);
    try {
      binding = await get('/demo/config', operation);
      session = await get(`/api/sessions/${id}`, operation);
      if (session.tombstone) throw Object.assign(new Error('No conversation'), { status: 404 });
      copy = bundles[session.locale] ?? copy;
      rendered = binding.processingConsent ?? {};
      // Show the document before its verdict, with all boxes unchecked.
      hasGrant = session.consentRevision > 0 && !session.consentWithdrawn; renderItems(); paint();
      if (binding.voiceMode === 'elevenlabs' && !binding.processingConsent) {
        text('#consent-text', copy.voiceHostConsent); text('#consent-info', '');
        fieldset.querySelectorAll('.consent-item').forEach(row => row.remove());
        busy = false; state('unavailable', ''); return;
      }
      const current = await get(`/api/sessions/${id}/consent`, operation);
      consentRevision = current.consentRevision ?? session.consentRevision ?? 0;
      if (choice && matchesChoice(current, choice)) { pendingChoice = null; saved(); return; }
      // The per-session contract is the authoritative current document.
      if (binding.processingConsent && current.contract) rendered = current;
      selected = current.selected ?? [];
      hasGrant = selected.length > 0; pendingChoice = null;
      usable = true; busy = false; renderItems(); paint();
      state('ready', choice || notSaved ? copy.host.consentPage.notSavedYet : session.consentWithdrawn ? copy.host.consentWithdrawn : selected.length ? binding.processingConsent ? copy.host.processingSaved : copy.host.consentAllowed : binding.processingConsent ? copy.host.processingWaiting : copy.host.consentRequired);
    } catch (error) {
      if (active !== operation) return;
      busy = false;
      if (error.deadline) state('load-timeout', copy.host.consentPage.loadTimeout, () => load(choice, notSaved), true);
      else if ([403, 404, 410].includes(error.status)) { session = null; state('missing', copy.host.consentPage.missing); }
      else state('failed', copy.host.consentFailed, () => load(choice, notSaved));
    } finally { finish(operation); }
  }
  async function save(withdraw = false) {
    if (!session || !withdraw && (busy || !usable) || withdraw && (!withdrawalAvailable() || ['loading', 'load-timeout'].includes(status.dataset.state))) return;
    const items = withdraw ? [] : [...fieldset.querySelectorAll('input:checked')].map(box => box.value);
    // An empty first choice is a return, not withdrawal of a grant that never existed.
    if (!hasGrant && items.length === 0 && !withdrawalAvailable()) {
      if (withdraw) return;
      saved(); return;
    }
    const granted = !withdraw && items.length > 0;
    const choice = { items, granted, contract: rendered.contract };
    pendingChoice = choice;
    const operation = begin(withdraw ? 'withdraw' : 'save', 10000);
    busy = true; state('saving', copy.host.consentPage.saving);
    try {
      const response = await checked(operation, submit(`/api/sessions/${id}/consent`, { granted,
        ...(!withdraw || binding.processingConsent ? { processing: {
          ...(!withdraw ? { revision: consentRevision } : {}),
          ...(binding.processingConsent ? { contract: rendered.contract, items } : {}) } } : {}) }, { signal: operation.controller.signal }));
      if (!response.ok) {
        if (response.status === 409) {
          const conflict = await checked(operation, response.json());
          // The rejected write cannot be retried against an unseen revision.
          // Re-read into an editable, explicitly unsaved state, even if equal.
          if (conflict.error === 'consent-stale') { await load(undefined, true); return; }
        }
        if (response.status === 409 && binding.processingConsent) {
          const current = await get(`/api/sessions/${id}/consent`, operation);
          if (current.contract !== rendered.contract) { busy = false; usable = false; state('stale', copy.host.consentPage.stale, () => load()); return; }
        }
        throw Object.assign(new Error('Save failed'), { status: response.status });
      }
      const ack = await checked(operation, response.json());
      // A successful HTTP response alone is not a grant verdict.
      if (ack.granted !== granted) throw new Error('Missing acknowledgement');
      const current = binding.voiceMode === 'elevenlabs' && !binding.processingConsent
        ? { selected: (await get(`/api/sessions/${id}`, operation)).consentWithdrawn ? [] : ['unconfirmed'] }
        : await get(`/api/sessions/${id}/consent`, operation);
      if (!matchesChoice(current, choice)) throw new Error('Unconfirmed consent');
      pendingChoice = null; saved();
    } catch (error) {
      if (active !== operation) return;
      busy = false;
      if (error.deadline) {
        usable = false;
        state(withdraw ? 'withdraw-unconfirmed' : 'save-unconfirmed', copy.host.consentPage[withdraw ? 'withdrawUnconfirmed' : 'saveUnconfirmed'],
          withdraw ? () => save(true) : () => load(choice), true);
      } else if ([403, 404, 410].includes(error.status)) { session = null; usable = false; state('missing', copy.host.consentPage.missing); }
      else state('failed', copy.host.consentFailed, () => save(withdraw));
    } finally { finish(operation); }
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
