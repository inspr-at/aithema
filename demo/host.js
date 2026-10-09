import '../packages/ui/src/session-element.js';
import { createDeviceReasoning } from '../plugins/device/src/index.js';
import { createVoiceControl } from '../packages/ui/src/voice-control.js';
import { createElevenLabsClient } from '../plugins/elevenlabs/src/client.js';
import { createFakeVoice } from './fake-voice.js';
import { en } from '../packages/ui/src/i18n/en.js';
import { postJson } from '../packages/ui/src/post-json.js';
const component = document.querySelector('aithema-session');
const key = 'aithema-reset-slice-1-session';
let processingPreset = 'best', fakeVoice, liveVoiceClient;
async function open(fresh = false) {
  try {
    const saved = fresh ? null : localStorage.getItem(key);
    let response = saved ? await fetch(`/api/sessions/${saved}`) : null;
    if (!response?.ok) response = await postJson('/api/sessions', { processingPreset });
    if (!response.ok) throw new Error();
    const session = await response.json(); localStorage.setItem(key, session.id);
    processingPreset = session.processingPreset ?? 'best';
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
    component.configure({ voiceClient: liveVoiceClient ?? fakeVoice?.client, copy: en, session, deviceReasoning: processingPreset === 'device'
      ? createDeviceReasoning({ endpoint: document.querySelector('#device-endpoint').value }) : undefined });
    document.querySelector('#consent-status').textContent = binding.voiceMode === 'elevenlabs' ? en.voiceHostConsent : session.consentWithdrawn ? 'Consent withdrawn.' : 'Grant consent before mock processing.';
    document.querySelector('#error').textContent = '';
  } catch { document.querySelector('#error').textContent = 'Could not restore the demo. Reload to retry.'; }
}
const binding = await fetch('/demo/config').then(r => r.json());
if (binding.voiceMode === 'elevenlabs') {
  document.querySelector('#consent-title').textContent = en.voiceHostConsentTitle;
  document.querySelector('section[aria-labelledby="consent-title"] > p').textContent = en.voiceHostConsent;
  document.querySelector('#grant').disabled = true; document.querySelector('#grant').title = en.voiceHostConsent;
  await new Promise((resolve, reject) => { const script = document.createElement('script'); script.src = '/vendor/elevenlabs/lib.iife.js'; script.onload = resolve; script.onerror = reject; document.head.append(script); });
}
document.querySelector('#provider').textContent = binding.label;
const fakeControls = document.querySelector('#fake-voice'); fakeControls.hidden = binding.voiceMode !== 'fake';
for (const [selector, key, action] of [['#fake-say', 'fakeVoiceSay', () => fakeVoice?.speak()],
  ['#fake-interrupt', 'fakeVoiceInterrupt', () => fakeVoice?.bargeIn()], ['#fake-disconnect', 'fakeVoiceDisconnect', () => fakeVoice?.disconnect()]]) {
  const button = document.querySelector(selector); button.textContent = en[key]; button.addEventListener('click', action);
}
document.querySelector('#fake-label').textContent = en.fakeVoice;
component.addEventListener('aithema-preset', event => { processingPreset = event.detail.processingPreset; void open(true); });
document.querySelector('#new').addEventListener('click', () => void open(true));
for (const [selector, granted] of [['#grant', true], ['#revoke', false]]) {
  document.querySelector(selector).addEventListener('click', async () => {
    const button = document.querySelector(selector), id = component.session.id; button.disabled = true;
    try {
      const response = await postJson(`/api/sessions/${id}/consent`, { granted });
      if (!response.ok) throw new Error();
      const ack = await response.json();
      if (component.session.id !== id) return;
      component.receive(ack.event);
      document.querySelector('#consent-status').textContent = granted ? 'Mock processing allowed.' : 'Consent withdrawn. Running work stopped.';
    } catch { document.querySelector('#consent-status').textContent = 'Could not save consent. Try again.'; }
    finally { button.disabled = false; }
  });
}
await open();
