import '../packages/ui/src/session-element.js';
import { createDeviceReasoning } from '../plugins/device/src/index.js';
import { createVoiceControl } from '../packages/ui/src/voice-control.js';
import { createElevenLabsClient } from '../plugins/elevenlabs/src/client.js';
import { createFakeVoice } from './fake-voice.js';
import { en } from '../packages/ui/src/i18n/en.js';
import { de } from '../packages/ui/src/i18n/de.js';
import { postJson } from '../packages/ui/src/post-json.js';
import { reasonText } from '../packages/ui/src/settings-dialog.js';
import { aiNotice } from '../packages/core/src/ai-notice.js';
const component = document.querySelector('aithema-session');
const key = 'aithema-reset-slice-1-session', localeKey = 'aithema-demo-locale', bundles = { en, de };
let fakeVoice, liveVoiceClient, copy = en, consentState = null;
// An explicit choice wins; otherwise the browser's first English or German preference (de* → de).
function preferredLocale() {
  const chosen = localStorage.getItem(localeKey);
  if (Object.hasOwn(bundles, chosen ?? '')) return chosen;
  const languages = navigator.languages?.length ? navigator.languages : [navigator.language ?? 'en'];
  return languages.map(l => l.toLowerCase()).find(l => /^(?:de|en)(?:-|$)/u.test(l))?.startsWith('de') ? 'de' : 'en';
}
// The page speaks the conversation's language; a new choice applies to the next conversation.
function paintPage() {
  const h = copy.host, text = (selector, value) => { document.querySelector(selector).textContent = value; };
  document.documentElement.lang = component.session?.locale ?? 'en'; document.title = h.title;
  for (const [selector, value] of [['#title', h.title], ['#new', h.newConversation], ['#resume-hint', h.resumeHint], ['#source', h.source],
    ['#language-label', h.language], ['#mock-hint', h.mockHint], ['#settings-hint', h.settingsHint],
    ['#grant', binding.processingConsent ? h.processingGrant : h.grant], ['#revoke', h.revoke], ['#fake-label', copy.fakeVoice],
    ['#fake-say', copy.fakeVoiceSay], ['#fake-interrupt', copy.fakeVoiceInterrupt], ['#fake-disconnect', copy.fakeVoiceDisconnect]]) text(selector, value);
  // The component's host slots (AIT-104 B2), filled with labelled demo content only while the demo host runs.
  if (binding.demoHost === true) {
    for (const [selector, value] of [['#demo-account-label', h.slots.account], ['#demo-account-note', h.slots.accountNote], ['#demo-account-source', h.slots.source],
      ['#demo-handover-offer', h.slots.handoverOffer], ['#demo-credits-limit', h.slots.creditsLimit], ['#demo-license', h.slots.license],
      ['#demo-legal-source', h.slots.legalSource], ['#demo-footer', h.slots.footer], ['#outbox-open', h.outbox.open], ['#outbox-title', h.outbox.title],
      ['#outbox-note', h.outbox.note], ['#ai-notice', aiNotice(component.session?.locale).text], ['#outbox-close', h.outbox.close]]) text(selector, value);
    document.querySelector('#demo-legal').setAttribute('aria-label', h.slots.legal);
  }
  if (binding.processingConsent) {
    text('#consent-title', h.processingTitle);
    const consent = copy.processingConsent ?? {}, fallback = binding.processingConsent;
    text('#consent-text', `${consent.intro ?? fallback.intro} ${consent.withdrawal ?? fallback.withdrawal}`);
    const checkboxes = document.querySelectorAll('#processing-items input');
    for (const [index, item] of fallback.items.entries()) {
      // Only the matching legal version can be translated; all others keep the server text.
      const translated = Object.hasOwn(consent.items ?? {}, item.id) && consent.items[item.id].version === item.version ? consent.items[item.id] : {};
      const checkbox = checkboxes[index];
      checkbox.parentElement.querySelector('span').textContent = translated.title ?? item.title;
      checkbox.parentElement.nextElementSibling.textContent = `${translated.recipients ?? item.recipients} ${translated.text ?? item.text}`;
    }
  }
  else if (binding.voiceMode === 'elevenlabs') { text('#consent-title', copy.voiceHostConsentTitle); text('#consent-text', copy.voiceHostConsent); document.querySelector('#grant').title = copy.voiceHostConsent; }
  else text('#consent-title', h.consentTitle);
  paintVisuals();
  const choice = document.querySelector('#locale');
  for (const option of choice.options) option.textContent = h.languages[option.value];
  choice.value = preferredLocale();
  text('#language-note', choice.value === component.session?.locale ? '' : h.languageNext.replace('{language}', h.languages[choice.value]));
}
// The header and the mock consent name the visual kind this conversation uses (AIT-118): the
// server's selected visuals and kind pick the HTML or image binding; visuals off name none.
function visualKind() {
  const session = component.session, visuals = session?.engine?.visuals;
  if (!visuals || visuals === 'off' || session.processingPreset === 'device') return 'off';
  return session.conceptVisualKind === 'html' ? 'html' : 'images';
}
function paintVisuals() {
  const h = copy.host, kind = visualKind(), raw = { html: binding.htmlLabel, images: binding.imageLabel }[kind];
  const visuals = kind === 'off' ? h.visualsOff : h.labels[raw] ?? raw;
  document.querySelector('#provider').textContent = [h.labels[binding.label] ?? binding.label, visuals].join(' · ')
    + (binding.voiceDisabledReason ? ` · ${h.voiceUnavailable.replace('{reason}', reasonText(copy, binding.voiceDisabledReason))}` : '');
  if (!binding.processingConsent && binding.voiceMode !== 'elevenlabs') document.querySelector('#consent-text').textContent = `${h.consentUse[kind]} ${h.consentTerms}`;
}
// The consent line follows the server's feature verdicts, never a remembered click (D8, D6).
function paintConsent(force = false) {
  const status = document.querySelector('#consent-status'), session = component.session;
  if (binding.voiceMode === 'elevenlabs' && !binding.processingConsent) { status.textContent = copy.voiceHostConsent; return; }
  const preset = session.processingPreset === 'device' ? 'best' : session.processingPreset ?? 'best', text = session.featureMatrix?.[preset]?.text;
  const state = session.consentWithdrawn ? 'withdrawn' : text?.available ? 'allowed'
    : text?.reason === 'current processing consent required' ? 'required' : null;
  if (!force && (state === null || state === consentState)) return;
  consentState = state;
  const allowed = binding.processingConsent ? copy.host.processingSaved : copy.host.consentAllowed;
  const required = binding.processingConsent ? copy.host.processingWaiting : copy.host.consentRequired;
  status.textContent = { withdrawn: copy.host.consentWithdrawn, allowed, required }[state] ?? '';
}
// Without an explicit request the server offers the owner's last confirmed choice.
async function open(fresh = false, request = {}) {
  try {
    const saved = fresh ? null : localStorage.getItem(key);
    let response = saved ? await fetch(`/api/sessions/${saved}`) : null;
    if (!response?.ok) response = await postJson('/api/sessions', { ...request, locale: preferredLocale() });
    if (!response.ok) throw new Error();
    await adopt(await response.json());
  } catch { document.querySelector('#error').textContent = copy.host.restoreFailed; }
}
// The demo handover reaches a local fake recipient, so its success line says nobody calls back.
const componentCopy = () => binding.demoHost !== true ? copy
  : { ...copy, hostSurface: { ...copy.hostSurface, handover: { ...copy.hostSurface.handover, ...copy.host.handover } } };
// Shows a conversation: one from storage or a new one, or one the library opened, created or reset.
async function adopt(session) {
  try {
    localStorage.setItem(key, session.id);
    copy = bundles[session.locale] ?? en;
    if (binding.voiceMode === 'fake') {
      const ports = createVoiceControl({ sessionId: session.id, receive: event => component.receive(event) });
      fakeVoice = createFakeVoice({ ...ports, copy });
    }
    if (binding.voiceMode === 'elevenlabs') {
      const ports = createVoiceControl({ sessionId: session.id, receive: event => component.receive(event) });
      let providerSessionId;
      const control = { ...ports.control };
      for (const name of ['start', 'recover']) control[name] = async (...args) => { const grant = await ports.control[name](...args); providerSessionId = grant.providerSessionId; return grant; };
      liveVoiceClient = createElevenLabsClient({ sdk: globalThis.ElevenLabsClient.Conversation, control,
        workletPaths: { rawAudioProcessor: '/vendor/elevenlabs/worklets/raw-audio.js', audioConcatProcessor: '/vendor/elevenlabs/worklets/audio-concat.js' },
        persistEvent: event => ports.persistEvent(event, { providerSessionId }) });
    }
    // The settings Advanced tab connects a local model through this browser-only factory.
    component.configure({ voiceClient: liveVoiceClient ?? fakeVoice?.client, copy: componentCopy(), session,
      deviceConnector: createDeviceReasoning, deviceEndpoint: 'http://127.0.0.1:8000',
      // The host surface (AIT-104 B2): library, handover and credits from the demo ports; verification
      // only where the fake mail outbox can confirm it (the mock demo).
      host: { library: true, verification: binding.demoHost === true, handover: true, credits: true, locale: preferredLocale } });
    if (binding.processingConsent) {
      const current = await fetch(`/api/sessions/${session.id}/consent`).then(r => r.json());
      for (const checkbox of document.querySelectorAll('#processing-items input')) checkbox.checked = current.selected.includes(checkbox.value);
    }
    paintPage(); paintConsent(true);
    document.querySelector('#error').textContent = '';
  } catch { document.querySelector('#error').textContent = copy.host.restoreFailed; }
}
const binding = await fetch('/demo/config').then(r => r.json());
// Demo slot fills and the fake outbox speak for the local demo host only: a live provider host shows none of them.
if (binding.demoHost !== true) for (const demoOnly of document.querySelectorAll('[data-demo-only]')) demoOnly.remove();
// Demo only: the fake mail outbox stands in for the visitor's inbox (GET S/demo/outbox).
const outbox = document.querySelector('#outbox');
async function paintOutbox(status = '') {
  const o = copy.host.outbox, list = document.querySelector('#outbox-list'), id = component.session.id;
  document.querySelector('#outbox-status').textContent = status;
  try {
    const response = await fetch(`/api/sessions/${id}/demo/outbox`);
    if (!response.ok) throw new Error();
    const { messages } = await response.json();
    if (component.session.id !== id) return;
    list.replaceChildren(...messages.toReversed().map(message => {
      const item = document.createElement('li'), to = document.createElement('span');
      to.textContent = o.to.replace('{address}', message.address);
      if (!message.token) { const used = document.createElement('span'); used.textContent = o.used; item.append(to, used); return item; }
      const confirm = document.createElement('button'); confirm.type = 'button'; confirm.textContent = o.confirm;
      // Confirming unlocks the AI assessment, so the outbox's own notice line describes it (AIT-119).
      confirm.setAttribute('aria-describedby', 'ai-notice');
      confirm.addEventListener('click', async () => {
        confirm.disabled = true;
        const result = await postJson(`/api/sessions/${id}/identity/confirm`, { token: message.token }).catch(() => null);
        const body = await result?.json().catch(() => null);
        await paintOutbox(result?.ok && body?.identity?.status === 'verified' ? o.confirmed : o.failed);
      });
      item.append(to, confirm); return item;
    }));
    if (!messages.length) document.querySelector('#outbox-status').textContent = status || o.empty;
  } catch { document.querySelector('#outbox-status').textContent = o.failed; }
}
if (binding.demoHost === true) {
  document.querySelector('#outbox-open').hidden = false;
  document.querySelector('#outbox-open').addEventListener('click', () => { outbox.showModal(); void paintOutbox(); });
  document.querySelector('#outbox-close').addEventListener('click', () => outbox.close());
  // The demo account menu closes on Escape or a click elsewhere.
  const account = document.querySelector('#demo-account');
  document.addEventListener('click', event => { if (account.open && !event.composedPath().includes(account)) account.open = false; });
  account.addEventListener('keydown', event => { if (event.key === 'Escape' && account.open) { account.open = false; account.querySelector('summary').focus(); } });
}
if (binding.processingConsent) {
  const container = document.createElement('div'); container.id = 'processing-items';
  for (const item of binding.processingConsent.items) {
    const label = document.createElement('label'), checkbox = document.createElement('input'), title = document.createElement('span'), text = document.createElement('p');
    checkbox.type = 'checkbox'; checkbox.value = item.id;
    // Keep the server copy visible while opening; paintPage replaces matching versions later.
    title.textContent = item.title; text.textContent = `${item.recipients} ${item.text}`;
    label.append(checkbox, title);
    container.append(label, text);
  }
  document.querySelector('#grant').before(container);
}
if (binding.voiceMode === 'elevenlabs') {
  if (!binding.processingConsent) document.querySelector('#grant').disabled = true;
  await new Promise((resolve, reject) => { const script = document.createElement('script'); script.src = '/vendor/elevenlabs/lib.iife.js'; script.onload = resolve; script.onerror = reject; document.head.append(script); });
}
const fakeControls = document.querySelector('#fake-voice'); fakeControls.hidden = binding.voiceMode !== 'fake';
for (const [selector, action] of [['#fake-say', () => fakeVoice?.speak()],
  ['#fake-interrupt', () => fakeVoice?.bargeIn()], ['#fake-disconnect', () => fakeVoice?.disconnect()]]) {
  document.querySelector(selector).addEventListener('click', action);
}
// A device conversation lives in its tab, so crossing that boundary starts a new session.
component.addEventListener('aithema-new-conversation', event => {
  const { processingPreset, settings } = event.detail;
  void open(true, { processingPreset, settings });
});
// The settings dialog defers consent to this host interface.
// The library opened, created or reset a conversation: this host owns its voice clients, so it switches.
component.addEventListener('aithema-open-conversation', event => { event.preventDefault(); void adopt(event.detail.session); });
component.addEventListener('aithema-consent', () => {
  document.querySelector('#consent-status').textContent = copy.consentForSelection;
  document.querySelector('section[aria-labelledby="consent-title"]').scrollIntoView?.({ block: 'nearest' });
  (document.querySelector('#processing-items input:not(:checked)') ?? document.querySelector('#grant')).focus();
});
component.addEventListener('aithema-features', () => { paintVisuals(); paintConsent(); });
document.querySelector('#locale').addEventListener('change', event => {
  localStorage.setItem(localeKey, event.target.value);
  // A conversation with no turn yet restarts in the chosen language at once (AIT-126: the first live test kept
  // speaking English after a switch to German, because the choice only applied to the next conversation).
  const session = component.session;
  if (session && session.locale !== event.target.value && !(session.transcript ?? []).length) void open(true);
  else paintPage();
});
document.querySelector('#new').addEventListener('click', () => void open(true));
for (const [selector, granted] of [['#grant', true], ['#revoke', false]]) {
  document.querySelector(selector).addEventListener('click', async () => {
    const button = document.querySelector(selector), id = component.session.id; button.disabled = true;
    try {
      const processing = binding.processingConsent ? { contract: binding.processingConsent.contract,
        items: [...document.querySelectorAll('#processing-items input:checked')].map(input => input.value) } : undefined;
      const response = await postJson(`/api/sessions/${id}/consent`, { granted, ...(processing ? { processing } : {}) });
      if (!response.ok) throw new Error();
      const ack = await response.json();
      if (component.session.id !== id) return;
      component.receive(ack.event);
      consentState = granted ? 'allowed' : 'withdrawn';
      document.querySelector('#consent-status').textContent = granted ? binding.processingConsent ? copy.host.processingSaved : copy.host.consentAllowed : copy.host.consentStopped;
      if (!granted) for (const checkbox of document.querySelectorAll('#processing-items input')) checkbox.checked = false;
    } catch { consentState = null; document.querySelector('#consent-status').textContent = copy.host.consentFailed; }
    finally { button.disabled = false; }
  });
}
await open();
