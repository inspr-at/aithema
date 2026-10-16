import '../packages/ui/src/session-element.js';
import { createDeviceReasoning } from '../plugins/device/src/index.js';
import { createVoiceControl } from '../packages/ui/src/voice-control.js';
import { createElevenLabsClient } from '../plugins/elevenlabs/src/client.js';
import { createFakeVoice } from './fake-voice.js';
import { en } from '../packages/ui/src/i18n/en.js';
import { de } from '../packages/ui/src/i18n/de.js';
import { withDemoConsentCopy } from './consent-copy.js';
import { postJson } from './post-json.js';
import { reasonText } from './reason-text.js';
import { aiNotice } from '../packages/core/src/ai-notice.js';
import { sessionKey as key, localeKey, preferredLocale, readPreference, remember, mountTheme, paintUtilities } from './page-preferences.js';
// Startup owns its failures, including rejection values without a stack or message.
function signalStartupFailure() {
  document.dispatchEvent(new document.defaultView.Event('aithema-host-failed'));
}
async function startup() {
  document.documentElement.dataset.hostStarted = '';
  try {
const component = document.querySelector('aithema-session'), bundles = { en: withDemoConsentCopy(en), de: withDemoConsentCopy(de) };
mountTheme();
let fakeVoice, liveVoiceClient, localeChoice = preferredLocale(), copy = bundles[localeChoice];
function paintPrivacyLink(link, legal, locale) {
  link.textContent = locale === 'de' ? 'Datenschutzerklärung' : 'Privacy policy';
  link.href = `${binding.privacy.url}?locale=${locale}`;
  legal.setAttribute('aria-label', locale === 'de' ? 'Rechtliche Hinweise' : 'Legal information');
}
// The page always speaks the current conversation's language.
function paintPage() {
  const h = copy.host, text = (selector, value) => { const node = document.querySelector(selector); if (node) node.textContent = value; };
  document.documentElement.lang = component.session?.locale ?? localeChoice; document.title = 'Aithema';
  paintUtilities(copy);
  const privacyLink = document.querySelector('[data-aithema-privacy]');
  if (privacyLink) paintPrivacyLink(privacyLink, privacyLink.closest('nav'), document.documentElement.lang);
  for (const [selector, value] of [['#title', h.title], ['#new', h.newConversation], ['#resume-hint', h.resumeHint], ['#source', h.slots.source],
    ['#language-label', h.language], ['#mock-hint', h.mockHint], ['#settings-hint', h.settingsHint],
    ['#fake-label', copy.fakeVoice],
    ['#fake-say', copy.fakeVoiceSay], ['#fake-interrupt', copy.fakeVoiceInterrupt], ['#fake-disconnect', copy.fakeVoiceDisconnect]]) text(selector, value);
  // The component's host slots (AIT-104 B2), filled with labelled demo content only while the demo host runs.
  if (binding.demoHost === true) {
    for (const [selector, value] of [['#demo-handover-offer', h.slots.handoverOffer], ['#demo-credits-limit', h.slots.creditsLimit], ['#demo-license', h.slots.license],
      ['#demo-legal-source', h.slots.legalSource], ['#demo-footer', h.slots.footer], ['#outbox-open', h.outbox.open], ['#outbox-title', h.outbox.title],
      ['#outbox-note', h.outbox.note], ['#ai-notice', aiNotice(component.session?.locale).text], ['#outbox-close', h.outbox.close]]) text(selector, value);
    if (!privacyLink) document.querySelector('#demo-legal').setAttribute('aria-label', h.slots.legal);
  }
  paintVisuals();
  text('#language-note', localeChoice === component.session?.locale ? '' : h.languageNext.replace('{language}', h.languages[localeChoice]));
  // A startup failure may have exposed native controls while this paint awaited.
  const actions = document.querySelector('.host-actions');
  if (actions && actions.parentElement !== component) component.append(actions);
  delete document.documentElement.dataset.hostUnavailable;
  document.documentElement.dataset.hostReady = '';
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
    if (!response?.ok) response = await postJson('/api/sessions', { ...request, locale: localeChoice });
    if (!response.ok) throw new Error();
    await adopt(await response.json());
  } catch { signalStartupFailure(); document.querySelector('#error').textContent = binding.demoHost === true ? copy.host.restoreFailed : copy.host.conversationFailed; }
}
// The demo handover reaches a local fake recipient, so its success line says nobody calls back.
const componentCopy = (bundle = copy) => binding.demoHost !== true ? bundle
  : { ...bundle, hostSurface: { ...bundle.hostSurface, handover: { ...bundle.hostSurface.handover, ...bundle.host.handover } } };
// Shows a conversation: one from storage or a new one, or one the library opened, created or reset.
async function adopt(session) {
  try {
    remember(key, session.id);
    copy = bundles[session.locale] ?? en;
    if (binding.voiceMode === 'fake') {
      const ports = createVoiceControl({ sessionId: session.id, receive: event => component.receive(event) });
      fakeVoice = createFakeVoice({ ...ports, copy: () => copy });
    }
    if (binding.voiceMode === 'elevenlabs') {
      const ports = createVoiceControl({ sessionId: session.id, receive: event => component.receive(event) });
      liveVoiceClient = createElevenLabsClient({ sdk: globalThis.ElevenLabsClient.Conversation, control: ports.control,
        workletPaths: { rawAudioProcessor: '/vendor/elevenlabs/worklets/raw-audio.js', audioConcatProcessor: '/vendor/elevenlabs/worklets/audio-concat.js' },
        persistEvent: (event, options) => ports.persistEvent(event, { providerSessionId: event.providerSessionId }, options) });
    }
    // The settings Advanced tab connects a local model through this browser-only factory.
    component.configure({ voiceClient: liveVoiceClient ?? fakeVoice?.client, voicePresentation: binding.voicePresentation, copy: componentCopy(), session,
      paimosImportUrl: binding.paimosImportUrl, paimosImportVersion: binding.paimosImportVersion,
      copyForLocale: locale => bundles[locale] && componentCopy(bundles[locale]),
      deviceConnector: createDeviceReasoning, deviceEndpoint: 'http://127.0.0.1:8000',
      // The host surface (AIT-104 B2): library, handover and credits from the demo ports; verification
      // only where the fake mail outbox can confirm it (the mock demo).
      host: { ...(binding.operatorLogin ? { operator: { ...binding.operatorLogin, name: binding.operator?.name, adminUrl: '/admin',
          error: new URL(location.href).searchParams.get('operator') === 'denied' } } : {}), library: true, verification: { delivery: binding.demoHost === true, privacyDocumentConfigured: Boolean(binding.privacy) },
        handover: binding.demoHost === true, credits: true, locale: () => localeChoice, version: binding.build } });
    // A stored choice may have changed while the initial conversation was being restored.
    await component.changeLocale(localeChoice);
    paintPage();
    document.querySelector('#error').textContent = '';
  } catch { signalStartupFailure(); document.querySelector('#error').textContent = binding.demoHost === true ? copy.host.restoreFailed : copy.host.conversationFailed; }
}
const binding = await fetch('/demo/config').then(r => r.json());
// Demo slot fills and the fake outbox speak for the local demo host only: a live provider host shows none of them.
for (const demoOnly of document.querySelectorAll('[data-demo-only]')) {
  if (binding.demoHost !== true) demoOnly.remove(); else demoOnly.hidden = false;
}
if (binding.privacy?.url === '/privacy') {
  const legal = document.querySelector('#demo-legal') ?? document.createElement('nav');
  legal.slot = 'legal';
  const link = document.createElement('a');
  link.setAttribute('data-aithema-privacy', ''); link.rel = 'privacy-policy';
  paintPrivacyLink(link, legal, component.session?.locale ?? localeChoice);
  legal.append(link);
  if (!legal.isConnected) component.append(legal);
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
  const { processingPreset, settings, confirm } = event.detail;
  void open(true, { processingPreset, settings, confirm });
});
// The settings dialog defers consent to this host interface.
// The library opened, created or reset a conversation: this host owns its voice clients, so it switches.
component.addEventListener('aithema-open-conversation', event => { event.preventDefault(); void adopt(event.detail.session); });
component.addEventListener('aithema-consent', () => {
  if (component.session?.id) globalThis.location.assign(`/consent/?session=${encodeURIComponent(component.session.id)}&return=/`);
});
component.addEventListener('aithema-features', paintVisuals);
component.addEventListener('aithema-locale', () => { copy = bundles[component.session.locale] ?? en; paintPage(); });
// Remember the next-conversation choice even when a call or an existing turn prevents changing this one.
document.querySelector('#locale').addEventListener('change', async event => {
  if (document.documentElement.hasAttribute('data-host-unavailable')) return;
  const locale = event.target.value; localeChoice = locale; remember(localeKey, locale);
  await component.changeLocale(locale); paintPage();
});
await open();
if (binding.operatorLogin && location.hash === '#settings-general') {
  component.openSettings(undefined, { tab: 'general', anchor: '.operator-section' });
  const cleaned = new URL(location.href); cleaned.searchParams.delete('operator'); cleaned.hash = '';
  history.replaceState(null, '', cleaned.pathname + cleaned.search);
}
  } catch {
    signalStartupFailure();
  }
}
await startup().catch(signalStartupFailure);
