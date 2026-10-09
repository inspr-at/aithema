import '../packages/ui/src/session-element.js';
import { createDeviceReasoning } from '../plugins/device/src/index.js';
import { createVoiceControl } from '../packages/ui/src/voice-control.js';
import { createElevenLabsClient } from '../plugins/elevenlabs/src/client.js';
import { createFakeVoice } from './fake-voice.js';
import { en } from '../packages/ui/src/i18n/en.js';
import { postJson } from '../packages/ui/src/post-json.js';
const component = document.querySelector('aithema-session');
const key = 'aithema-reset-slice-1-session';
let fakeVoice, liveVoiceClient;
// Without an explicit request the server offers the owner's last confirmed choice.
async function open(fresh = false, request = {}) {
  try {
    const saved = fresh ? null : localStorage.getItem(key);
    let response = saved ? await fetch(`/api/sessions/${saved}`) : null;
    if (!response?.ok) response = await postJson('/api/sessions', request);
    if (!response.ok) throw new Error();
    const session = await response.json(); localStorage.setItem(key, session.id);
    if (binding.voiceMode === 'fake') {
      const ports = createVoiceControl({ sessionId: session.id, receive: event => component.receive(event) });
      fakeVoice = createFakeVoice({ ...ports, copy: en });
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
    component.configure({ voiceClient: liveVoiceClient ?? fakeVoice?.client, copy: en, session,
      deviceConnector: createDeviceReasoning, deviceEndpoint: 'http://127.0.0.1:8000' });
    if (binding.processingConsent) {
      const current = await fetch(`/api/sessions/${session.id}/consent`).then(r => r.json());
      for (const checkbox of document.querySelectorAll('#processing-items input')) checkbox.checked = current.selected.includes(checkbox.value);
    }
    document.querySelector('#consent-status').textContent = binding.processingConsent ? 'Processing waits for the selected permissions.' : binding.voiceMode === 'elevenlabs' ? en.voiceHostConsent : session.consentWithdrawn ? 'Consent withdrawn.' : 'Grant consent before mock processing.';
    document.querySelector('#error').textContent = '';
  } catch { document.querySelector('#error').textContent = 'Could not restore the demo. Reload to retry.'; }
}
const binding = await fetch('/demo/config').then(r => r.json());
if (binding.processingConsent) {
  const copy = binding.processingConsent;
  document.querySelector('#consent-title').textContent = 'Consent for data processing';
  document.querySelector('section[aria-labelledby="consent-title"] > p').textContent = `${copy.intro} ${copy.withdrawal}`;
  const container = document.createElement('div'); container.id = 'processing-items';
  for (const item of copy.items) {
    const label = document.createElement('label'), checkbox = document.createElement('input'), text = document.createElement('p');
    checkbox.type = 'checkbox'; checkbox.value = item.id;
    label.append(checkbox, document.createTextNode(item.title));
    text.textContent = `${item.recipients} ${item.text}`;
    container.append(label, text);
  }
  document.querySelector('#grant').before(container);
  document.querySelector('#grant').textContent = 'Grant consent';
}
if (binding.voiceMode === 'elevenlabs') {
  if (!binding.processingConsent) {
    document.querySelector('#consent-title').textContent = en.voiceHostConsentTitle;
    document.querySelector('section[aria-labelledby="consent-title"] > p').textContent = en.voiceHostConsent;
    document.querySelector('#grant').disabled = true; document.querySelector('#grant').title = en.voiceHostConsent;
  }
  await new Promise((resolve, reject) => { const script = document.createElement('script'); script.src = '/vendor/elevenlabs/lib.iife.js'; script.onload = resolve; script.onerror = reject; document.head.append(script); });
}
document.querySelector('#provider').textContent = `${binding.label} · ${binding.imageLabel}${binding.voiceDisabledReason ? ` · Voice unavailable: ${binding.voiceDisabledReason}` : ''}`;
const fakeControls = document.querySelector('#fake-voice'); fakeControls.hidden = binding.voiceMode !== 'fake';
for (const [selector, key, action] of [['#fake-say', 'fakeVoiceSay', () => fakeVoice?.speak()],
  ['#fake-interrupt', 'fakeVoiceInterrupt', () => fakeVoice?.bargeIn()], ['#fake-disconnect', 'fakeVoiceDisconnect', () => fakeVoice?.disconnect()]]) {
  const button = document.querySelector(selector); button.textContent = en[key]; button.addEventListener('click', action);
}
document.querySelector('#fake-label').textContent = en.fakeVoice;
// A device conversation lives in its tab, so crossing that boundary starts a new session.
component.addEventListener('aithema-new-conversation', event => {
  const { processingPreset, settings } = event.detail;
  void open(true, { processingPreset, settings });
});
// The settings dialog defers consent to this host interface.
component.addEventListener('aithema-consent', () => {
  document.querySelector('#consent-status').textContent = 'Your selection needs consent. Allow processing to continue.';
  document.querySelector('section[aria-labelledby="consent-title"]').scrollIntoView?.({ block: 'nearest' });
  (document.querySelector('#processing-items input:not(:checked)') ?? document.querySelector('#grant')).focus();
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
      document.querySelector('#consent-status').textContent = granted ? binding.processingConsent ? 'Your consent has been saved.' : 'Mock processing allowed.' : 'Consent withdrawn. Running work stopped.';
      if (!granted) for (const checkbox of document.querySelectorAll('#processing-items input')) checkbox.checked = false;
    } catch { document.querySelector('#consent-status').textContent = 'Could not save consent. Try again.'; }
    finally { button.disabled = false; }
  });
}
await open();
