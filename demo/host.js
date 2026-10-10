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
import { sessionKey as key, localeKey, preferredLocale, readPreference, remember, mountTheme, paintUtilities } from './page-preferences.js';
const component = document.querySelector('aithema-session'), bundles = { en, de };
mountTheme();
let fakeVoice, liveVoiceClient, copy = bundles[preferredLocale()];
// The page speaks the conversation's language; a new choice applies to the next conversation.
function paintPage() {
  const h = copy.host, text = (selector, value) => { const node = document.querySelector(selector); if (node) node.textContent = value; };
  document.documentElement.lang = component.session?.locale ?? preferredLocale(); document.title = 'Aithema';
  paintUtilities(copy);
  for (const [selector, value] of [['#title', h.title], ['#new', h.newConversation], ['#resume-hint', h.resumeHint], ['#source', h.slots.source],
    ['#language-label', h.language], ['#mock-hint', h.mockHint], ['#settings-hint', h.settingsHint],
    ['#fake-label', copy.fakeVoice],
    ['#fake-say', copy.fakeVoiceSay], ['#fake-interrupt', copy.fakeVoiceInterrupt], ['#fake-disconnect', copy.fakeVoiceDisconnect]]) text(selector, value);
  // The component's host slots (AIT-104 B2), filled with labelled demo content only while the demo host runs.
  if (binding.demoHost === true) {
    for (const [selector, value] of [['#demo-account-label', h.slots.account], ['#demo-account-note', h.slots.accountNote], ['#demo-account-source', h.slots.source],
      ['#demo-handover-offer', h.slots.handoverOffer], ['#demo-credits-limit', h.slots.creditsLimit], ['#demo-license', h.slots.license],
      ['#demo-legal-source', h.slots.legalSource], ['#demo-footer', h.slots.footer], ['#outbox-open', h.outbox.open], ['#outbox-title', h.outbox.title],
      ['#outbox-note', h.outbox.note], ['#ai-notice', aiNotice(component.session?.locale).text], ['#outbox-close', h.outbox.close]]) text(selector, value);
    document.querySelector('#demo-legal').setAttribute('aria-label', h.slots.legal);
  }
  paintVisuals();
  const choice = document.querySelector('#locale');
  // DE/EN stay compact; the language label follows the running conversation.
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
  const provider = document.querySelector('#provider'); if (!provider) return;
  provider.textContent = [h.labels[binding.label] ?? binding.label, visuals].join(' · ')
    + (binding.voiceDisabledReason ? ` · ${h.voiceUnavailable.replace('{reason}', reasonText(copy, binding.voiceDisabledReason))}` : '');
}
// Without an explicit request the server offers the owner's last confirmed choice.
async function open(fresh = false, request = {}) {
  try {
    const saved = fresh ? null : readPreference(key);
    let response = saved ? await fetch(`/api/sessions/${saved}`) : null;
    if (!response?.ok) response = await postJson('/api/sessions', { ...request, locale: preferredLocale() });
    if (!response.ok) throw new Error();
    await adopt(await response.json());
  } catch { document.querySelector('#error').textContent = binding.demoHost === true ? copy.host.restoreFailed : copy.host.conversationFailed; }
}
// The demo handover reaches a local fake recipient, so its success line says nobody calls back.
const componentCopy = () => binding.demoHost !== true ? copy
  : { ...copy, hostSurface: { ...copy.hostSurface, handover: { ...copy.hostSurface.handover, ...copy.host.handover } } };
// Shows a conversation: one from storage or a new one, or one the library opened, created or reset.
async function adopt(session) {
  try {
    remember(key, session.id);
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
    paintPage();
    document.querySelector('#error').textContent = '';
  } catch { document.querySelector('#error').textContent = binding.demoHost === true ? copy.host.restoreFailed : copy.host.conversationFailed; }
}
const binding = await fetch('/demo/config').then(r => r.json());
// Demo slot fills and the fake outbox speak for the local demo host only: a live provider host shows none of them.
for (const demoOnly of document.querySelectorAll('[data-demo-only]')) {
  if (binding.demoHost !== true) demoOnly.remove(); else demoOnly.hidden = false;
}
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
if (binding.voiceMode === 'elevenlabs') {
  await new Promise((resolve, reject) => { const script = document.createElement('script'); script.src = '/vendor/elevenlabs/lib.iife.js'; script.onload = resolve; script.onerror = reject; document.head.append(script); });
}
const fakeControls = document.querySelector('#fake-voice'); if (fakeControls) fakeControls.hidden = binding.voiceMode !== 'fake';
for (const [selector, action] of [['#fake-say', () => fakeVoice?.speak()],
  ['#fake-interrupt', () => fakeVoice?.bargeIn()], ['#fake-disconnect', () => fakeVoice?.disconnect()]]) {
  document.querySelector(selector)?.addEventListener('click', action);
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
  if (component.session?.id) globalThis.location.assign(`/consent/?session=${encodeURIComponent(component.session.id)}&return=/`);
});
component.addEventListener('aithema-features', paintVisuals);
document.querySelector('#locale').addEventListener('change', event => { remember(localeKey, event.target.value); paintPage(); });
document.querySelector('#new').addEventListener('click', () => void open(true));
await open();
