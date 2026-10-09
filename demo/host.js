import '../packages/ui/src/session-element.js';
import { createDeviceReasoning } from '../plugins/device/src/index.js';
import { createVoiceControl } from '../packages/ui/src/voice-control.js';
import { createElevenLabsClient } from '../plugins/elevenlabs/src/client.js';
import { createFakeVoice } from './fake-voice.js';
import { en } from '../packages/ui/src/i18n/en.js';
import { de } from '../packages/ui/src/i18n/de.js';
import { postJson } from '../packages/ui/src/post-json.js';
import { reasonText } from '../packages/ui/src/settings-dialog.js';
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
  if (binding.processingConsent) {
    text('#consent-title', h.processingTitle);
    const consent = copy.processingConsent ?? {}, fallback = binding.processingConsent;
    text('#consent-text', `${consent.intro ?? fallback.intro} ${consent.withdrawal ?? fallback.withdrawal}`);
    for (const item of fallback.items) {
      // Unknown host items retain their supplied legal text; never infer a translation.
      const translated = Object.hasOwn(consent.items ?? {}, item.id) ? consent.items[item.id] : {};
      const checkbox = [...document.querySelectorAll('#processing-items input')].find(input => input.value === item.id);
      checkbox.parentElement.querySelector('span').textContent = translated.title ?? item.title;
      checkbox.parentElement.nextElementSibling.textContent = `${translated.recipients ?? item.recipients} ${translated.text ?? item.text}`;
    }
  }
  else if (binding.voiceMode === 'elevenlabs') { text('#consent-title', copy.voiceHostConsentTitle); text('#consent-text', copy.voiceHostConsent); document.querySelector('#grant').title = copy.voiceHostConsent; }
  else { text('#consent-title', h.consentTitle); text('#consent-text', h.consentText); }
  text('#provider', [binding.label, binding.imageLabel].map(label => h.labels[label] ?? label).join(' · ')
    + (binding.voiceDisabledReason ? ` · ${h.voiceUnavailable.replace('{reason}', reasonText(copy, binding.voiceDisabledReason))}` : ''));
  const choice = document.querySelector('#locale');
  for (const option of choice.options) option.textContent = h.languages[option.value];
  choice.value = preferredLocale();
  text('#language-note', choice.value === component.session?.locale ? '' : h.languageNext.replace('{language}', h.languages[choice.value]));
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
    const session = await response.json(); localStorage.setItem(key, session.id);
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
    component.configure({ voiceClient: liveVoiceClient ?? fakeVoice?.client, copy, session,
      deviceConnector: createDeviceReasoning, deviceEndpoint: 'http://127.0.0.1:8000' });
    if (binding.processingConsent) {
      const current = await fetch(`/api/sessions/${session.id}/consent`).then(r => r.json());
      for (const checkbox of document.querySelectorAll('#processing-items input')) checkbox.checked = current.selected.includes(checkbox.value);
    }
    paintPage(); paintConsent(true);
    document.querySelector('#error').textContent = '';
  } catch { document.querySelector('#error').textContent = copy.host.restoreFailed; }
}
const binding = await fetch('/demo/config').then(r => r.json());
if (binding.processingConsent) {
  const container = document.createElement('div'); container.id = 'processing-items';
  for (const item of binding.processingConsent.items) {
    const label = document.createElement('label'), checkbox = document.createElement('input'), text = document.createElement('p');
    checkbox.type = 'checkbox'; checkbox.value = item.id;
    // Paint after the conversation chooses its bundle, including after a language change.
    label.append(checkbox, document.createElement('span'));
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
component.addEventListener('aithema-consent', () => {
  document.querySelector('#consent-status').textContent = copy.consentForSelection;
  document.querySelector('section[aria-labelledby="consent-title"]').scrollIntoView?.({ block: 'nearest' });
  (document.querySelector('#processing-items input:not(:checked)') ?? document.querySelector('#grant')).focus();
});
component.addEventListener('aithema-features', () => paintConsent());
document.querySelector('#locale').addEventListener('change', event => { localStorage.setItem(localeKey, event.target.value); paintPage(); });
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
