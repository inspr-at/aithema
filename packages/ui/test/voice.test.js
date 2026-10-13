import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Window } from 'happy-dom';
import { createSession, inputRevision } from '@inspr/aithema-core';
import { voiceEvents } from '../../core/src/live-voice.js';
import { AudioRail } from '../src/audio-rail.js';
import { en } from '../src/i18n/en.js';
import { de } from '../src/i18n/de.js';
import { manifest } from '../../../plugins/elevenlabs/src/manifest.js';
import { styles } from '../src/styles.js';
import { voiceJournal } from '../src/voice-orphan.js';
import { createVoiceControl } from '../src/voice-control.js';
import { createElevenLabsClient } from '../../../plugins/elevenlabs/src/client.js';
import { eventProbe } from '../../../test/voice-test-events.js';
const window = new Window();
for (const key of ['HTMLElement', 'customElements', 'document', 'CustomEvent']) globalThis[key] = window[key];
await import('../src/session-element.js');
const tick = () => new Promise(resolve => setImmediate(resolve));

function fixture(t, { pause, unavailable = false, journal, ready, start } = {}) {
  const root = document.createElement('div'); document.body.append(root);
  const commands = [], events = voiceEvents(), context = { understanding: 'fixture' };
  const session = { callId: 'local-call', providerSessionId: 'local-provider', events,
    async setInput(value) { commands.push(['input', value]); }, async setOutput(value) { commands.push(['output', value]); },
    async sendText(value) { commands.push(['text', value]); }, async updateContext(value) { commands.push(['context', value]); },
    async pause() { return pause ? pause() : { acknowledged: true, paused: true }; },
    async resume() { return { acknowledged: true, paused: false }; },
    async close() { commands.push(['close']); events.end(); return { closureConfirmed: true }; },
  };
  const client = { manifest, async start() { if (start) await start(); return session; } };
  const rail = new AudioRail({ root, copy: en, client, feature: () => ({ available: !unavailable, reason: 'preset denies voice' }), context: () => context, journal, ready });
  t.after(async () => { await rail.close(); rail.destroy(); root.remove(); });
  return { root, rail, commands, events, context };
}
test('AIT-138 d: newcomer must Take over, then separately Resume; takeover acquires no media', async t => {
  const { rail, root } = fixture(t); let takeovers = 0, starts = 0;
  rail.client.tabId = 'new-tab';
  rail.client.takeover = async identity => { takeovers++; return { ...identity, epoch: 2 }; };
  const start = rail.client.start; rail.client.start = async (...args) => { starts++; return start(...args); };
  rail.receiveState({ callId: 'shared', providerSessionId: 'old', controllingTabId: 'old-tab', epoch: 1, state: 'active' });
  rail.feature = () => ({ available: false, reason: en.paused }); rail.render();
  assert.equal(root.dataset.state, 'waiting'); assert.equal(rail.button('pause').title, en.voiceTakeover);
  await rail.start(); assert.equal(takeovers, 1); assert.equal(starts, 0);
  assert.equal(root.dataset.state, 'waiting'); assert.equal(rail.button('pause').title, en.resume);
  await rail.start(); assert.equal(starts, 1);
});
for (const copy of [de, en]) test(`AIT-138 d merge: ${copy.display.locale} paused old tab cannot hide a budget or consent refusal`, async t => {
  const session = createSession({ demo: true, locale: copy.display.locale }); let takeovers = 0, starts = 0;
  session.paused = true;
  session.featureMatrix = { best: { voice: { available: false, reason: 'budget denied' }, text: { available: true } } };
  session.voiceLifecycle = { callId: 'denied-takeback', providerSessionId: 'denied-provider', epoch: 2,
    controllingTabId: 'other-tab', state: 'waiting' };
  const client = { manifest, tabId: 'old-tab', async takeover() { takeovers++; }, async start() { starts++; } };
  const element = document.createElement('aithema-session'); element.configure({ copy, session, voiceClient: client });
  t.after(() => { element.configure({ copy, session: createSession() }); element.remove(); });
  const pause = element.shadowRoot.querySelector('.pause');
  assert.equal(pause.disabled, true, 'budget denied is not covered by the held-pause exception');
  pause.click(); await tick(); assert.equal(takeovers, 0); assert.equal(starts, 0);
  session.featureMatrix.best.voice = { available: true }; session.consentWithdrawn = true;
  element.configure({ copy, session, voiceClient: client });
  const consentPause = element.shadowRoot.querySelector('.pause');
  assert.equal(consentPause.disabled, true, 'withdrawn consent is not covered by the held-pause exception');
  consentPause.click(); await tick(); assert.equal(takeovers, 0); assert.equal(starts, 0);
});
test('AIT-138 d takeback: visible Resume follows a pending takeover and its receipt without another repaint', async t => {
  const session = createSession({ demo: true }), ack = Promise.withResolvers(); let starts = 0;
  session.paused = true;
  session.featureMatrix = { best: { voice: { available: true }, text: { available: true } } };
  session.voiceLifecycle = { callId: 'visible-takeover', providerSessionId: 'visible-provider', epoch: 1,
    controllingTabId: 'other-tab', state: 'waiting' };
  const client = { manifest, tabId: 'here', async takeover() { return ack.promise; }, async start() { starts++; } };
  const element = document.createElement('aithema-session'); element.configure({ copy: en, session, voiceClient: client });
  t.after(() => { ack.resolve(); element.configure({ copy: en, session: createSession() }); element.remove(); });
  const root = element.shadowRoot, pause = root.querySelector('.pause');
  pause.click(); await tick();
  // A durable echo repaints during the pending command. Its disabled snapshot
  // must not survive the receipt just because the rail remains in Waiting.
  element.receive({ seq: 1, type: 'session.paused', data: { paused: true } });
  assert.equal(pause.disabled, true);
  ack.resolve({ ...session.voiceLifecycle, epoch: 2, controllingTabId: client.tabId }); await tick(); await tick();
  assert.equal(root.querySelector('.audio-rail').dataset.state, 'waiting'); assert.equal(starts, 0);
  assert.equal(pause.textContent.trim(), en.resume); assert.equal(pause.disabled, false);
});
for (const [locale, copy] of [['de', de], ['en', en]]) test(`AIT-138 d takeback: ${locale} visible Resume preserves an ownership-lost click before voice.state`, async t => {
  const session = createSession({ demo: true, locale }), events = voiceEvents(), callId = 'response-first-call';
  session.featureMatrix = { best: { voice: { available: true }, text: { available: true } } };
  let starts = 0, takeovers = 0, retiredResumes = 0;
  const client = { manifest, tabId: 'old-tab', async takeover(identity) {
    takeovers++; assert.equal(identity.epoch, 2); return { ...identity, epoch: 3, controllingTabId: 'old-tab' };
  }, async start(request) {
    starts++; if (starts > 1) assert.equal(request.epoch, 3, 'startup belongs to the taken-back epoch');
    const stream = starts === 1 ? events : voiceEvents();
    return { callId, providerSessionId: 'response-first-provider', epoch: request.epoch ?? 1, events: stream,
      async setInput() {}, async setOutput() {}, async updateContext() {},
      async resume() { retiredResumes++; throw new Error('Retired session'); },
      async close() { stream.end(); return { closureConfirmed: true }; } };
  } };
  const element = document.createElement('aithema-session'); element.configure({ copy, session, voiceClient: client });
  t.after(async () => { element.configure({ copy, session: createSession() }); element.remove(); await tick(); });
  const root = element.shadowRoot, pause = root.querySelector('.pause');
  root.querySelector('.voice-start').click(); await tick();
  events.push({ type: 'waiting', callId, reason: 'ownership-lost' }); await tick();
  element.receive({ seq: 1, type: 'session.paused', data: { paused: true } });
  assert.equal(pause.disabled, false); assert.equal(pause.title, copy.voiceTakeover);
  pause.click(); pause.click(); await tick();
  assert.equal(retiredResumes, 0, 'the visible button never calls the retired Resume');
  assert.equal(takeovers, 0); assert.equal(starts, 1);
  element.receive({ type: 'voice.state', data: { callId, providerSessionId: 'response-first-provider', epoch: 2,
    controllingTabId: 'other-tab', state: 'active', reason: 'tab-takeover' } });
  await tick(); await tick();
  assert.equal(takeovers, 1); assert.equal(starts, 2, 'the original click takes over and resumes after the delayed notification');
  assert.equal(root.querySelector('.audio-rail').dataset.state, 'listening');
  assert.equal(root.querySelector('.audio-rail').hasAttribute('data-moved'), false);
});
for (const [locale, copy] of [['de', de], ['en', en]]) test(`AIT-138 UI: ${locale} composer invites speech only while listening, including a waiting reload`, async t => {
  const session = createSession({ demo: true, locale });
  session.featureMatrix = { best: { voice: { available: true }, text: { available: true } } };
  const events = voiceEvents(); let starts = 0, callId;
  const client = { manifest, async start(request) {
    starts++; callId = request.callId;
    return { callId, providerSessionId: 'ui-provider', events,
      async setInput() {}, async setOutput() {}, async updateContext() {},
      async pause() { return { acknowledged: true, paused: true }; },
      async resume() { return { acknowledged: true, paused: false }; },
      async close() { events.end(); return { closureConfirmed: true }; } };
  } };
  const element = document.createElement('aithema-session'); element.configure({ copy, session, voiceClient: client });
  let reloaded;
  t.after(async () => { for (const c of [element, reloaded].filter(Boolean)) { c.configure({ copy, session: createSession() }); c.remove(); } await tick(); });
  const root = element.shadowRoot, input = root.querySelector('textarea');
  root.querySelector('.voice-start').click(); await tick();
  assert.equal(root.querySelector('.audio-rail').dataset.state, 'listening'); assert.equal(input.placeholder, copy.placeholderVoice);
  root.querySelector('.pause').click(); await tick();
  assert.equal(root.querySelector('.audio-rail').dataset.state, 'paused'); assert.equal(input.placeholder, copy.placeholder);
  root.querySelector('.pause').click(); await tick();
  assert.equal(input.placeholder, copy.placeholderVoice, 'acknowledged Resume restores the speech invitation');
  events.push({ type: 'waiting', callId, reason: 'recovery-failed' }); await tick();
  assert.equal(root.querySelector('.audio-rail').dataset.state, 'waiting'); assert.equal(input.placeholder, copy.placeholder);
  for (const selector of ['.voice-input', '.voice-output']) {
    assert.equal(root.querySelector(selector).disabled, true); assert.ok(root.querySelector(selector).title);
  }
  const snapshot = structuredClone(session);
  snapshot.voiceLifecycle = { callId, providerSessionId: 'ui-provider', state: 'waiting', attempts: 3, needsRecovery: true };
  element.configure({ copy, session: createSession() });
  reloaded = document.createElement('aithema-session'); reloaded.configure({ copy, session: snapshot, voiceClient: client }); await tick();
  assert.equal(reloaded.shadowRoot.querySelector('.audio-rail').dataset.state, 'waiting');
  assert.equal(reloaded.shadowRoot.querySelector('textarea').placeholder, copy.placeholder);
  assert.equal(starts, 1, 'restoring waiting never starts listening');
  for (const selector of ['.voice-input', '.voice-output']) {
    assert.equal(reloaded.shadowRoot.querySelector(selector).disabled, true); assert.ok(reloaded.shadowRoot.querySelector(selector).title);
  }
});
for (const [locale, copy] of [['de', de], ['en', en]]) test(`AIT-138 Tick UI: ${locale} retired tab shows ownership copy without an error popup`, async t => {
  const session = createSession({ demo: true, locale });
  session.featureMatrix = { best: { voice: { available: true }, text: { available: true } } };
  const events = voiceEvents(), callId = 'tick-ui-call'; let starts = 0, takeovers = 0;
  const client = { manifest, tabId: 'old-tab', async takeover(identity) {
    takeovers++; assert.equal(identity.epoch, 2); return { ...identity, epoch: 3 };
  }, async start(request) {
    starts++; const stream = starts === 1 ? events : voiceEvents();
    return { callId, providerSessionId: 'tick-ui-provider', epoch: request.epoch ?? 1, events: stream,
      async setInput() {}, async setOutput() {}, async updateContext() {},
      async pause() { return { acknowledged: true, paused: true }; },
      async close() { stream.end(); return { closureConfirmed: true }; } };
  } };
  const element = document.createElement('aithema-session'); element.configure({ copy, session, voiceClient: client });
  t.after(async () => { element.configure({ copy, session: createSession() }); element.remove(); await tick(); });
  const root = element.shadowRoot, rail = root.querySelector('.audio-rail');
  root.querySelector('.voice-start').click(); await tick();
  events.push({ type: 'waiting', callId, reason: 'ownership-lost' }); await tick();
  element.receive({ type: 'voice.state', data: { callId, providerSessionId: 'tick-ui-provider', epoch: 2,
    controllingTabId: 'other-tab', state: 'waiting', reason: 'tab-takeover' } });
  element.receive({ seq: 1, type: 'session.paused', data: { paused: true } }); await tick();
  assert.equal(rail.dataset.state, 'waiting'); assert.equal(rail.hasAttribute('data-message'), false);
  assert.equal(rail.hasAttribute('data-moved'), true); assert.equal(root.querySelector('.voice-state').textContent, copy.voiceMoved);
  assert.equal(root.querySelector('.pause').title, copy.voiceTakeover);
  assert.equal(root.querySelector('.pause .voice-label').textContent, copy.voiceTakeover);
  assert.equal(root.querySelector('.pause').disabled, false, 'the old tab offers explicit takeover and Resume');
  assert.equal(root.querySelector('.voice-pause').disabled, false);
  for (const selector of ['.voice-input', '.voice-output']) {
    assert.equal(root.querySelector(selector).disabled, true);
    assert.equal(root.querySelector(selector).title, copy.voiceResumeHereFirst);
    assert.equal(root.querySelector(`${selector} .voice-label`).textContent, copy.voiceResumeHereFirst);
  }
  for (const selector of ['.composer-reason', '.notice', '.status__label']) assert.equal(root.querySelector(selector).textContent, copy.voiceInAnotherTab);
  assert.equal(root.querySelector('.status').hasAttribute('data-message'), false);
  assert.ok([...root.querySelectorAll('.status__sizer > span')].some(span => span.textContent === copy.voiceInAnotherTab));
  root.querySelector('.pause').click(); await tick(); await tick();
  assert.equal(takeovers, 1); assert.equal(starts, 2, 'one old-tab click takes over and resumes');
  assert.equal(rail.dataset.state, 'listening'); assert.equal(rail.hasAttribute('data-moved'), false);
  assert.notEqual(root.querySelector('.composer-reason').textContent, copy.voiceInAnotherTab);
  assert.notEqual(root.querySelector('.notice').textContent, copy.voiceInAnotherTab);
});
test('AIT-138 UI: waiting resets an assistant waveform to the calm baseline even with motion off', async t => {
  const { rail, events, root } = fixture(t); await rail.start();
  rail.waveform.push(.6, 'assistant', 80); assert.equal(rail.waveform.direction, 'assistant');
  rail.motion = false;
  events.push({ type: 'waiting', callId: rail.session.callId, reason: 'recovery-failed' }); await tick();
  assert.equal(root.dataset.state, 'waiting'); assert.equal(rail.waveform.direction, 'user');
  assert.equal(rail.button('input').disabled, true); assert.equal(rail.button('output').disabled, true);
});
test('AIT-145: hangup renders ended immediately while cost confirmation is pending', async t => {
  const { rail, root } = fixture(t); await rail.start();
  const terminal = Promise.withResolvers();
  rail.session.close = () => terminal.promise;
  const closing = rail.close();
  try {
    assert.equal(root.dataset.state, 'idle');
    assert.equal(root.dataset.call, 'none');
    assert.equal(root.querySelector('.voice-state').textContent, en.voiceClosureUncertain);
    assert.equal(rail.button('start').disabled, false);
    terminal.resolve({ closureConfirmed: false }); await closing;
    assert.equal(root.dataset.state, 'idle', 'accounting uncertainty is not a failed call');
  } finally { terminal.resolve({ closureConfirmed: false }); await closing; }
});
test('AIT-145: a failed closure request keeps the locally ended call ready for another call', async t => {
  const { rail, root } = fixture(t); await rail.start();
  rail.session.close = async () => { throw new Error('fixture network unavailable'); };
  await rail.close();
  assert.equal(root.dataset.state, 'idle');
  assert.equal(rail.button('start').disabled, false);
  assert.equal(root.querySelector('.voice-state').textContent, en.voiceClosureUncertain);
});
for (const command of ['pause', 'resume', 'input', 'output', 'playback']) for (const outcome of ['success', 'failure'])
test(`AIT-145: retired ${command} ${outcome} preserves ended status through close failure`, async t => {
  const { rail, root, events } = fixture(t); await rail.start();
  if (command === 'resume') await rail.pause(true);
  const response = Promise.withResolvers(), terminal = Promise.withResolvers(), session = rail.session;
  session.close = () => terminal.promise;
  let pending;
  if (command === 'playback') { rail.playback = () => response.promise; pending = rail.retryPlayback(); }
  else if (['pause', 'resume'].includes(command)) {
    session[command] = () => response.promise; pending = rail.pause(command === 'pause');
  } else {
    session[command === 'input' ? 'setInput' : 'setOutput'] = () => response.promise; rail.button(command).click();
  }
  const closing = rail.close(), render = t.mock.method(rail, 'render'), settle = t.mock.method(rail, 'settle');
  try {
    if (outcome === 'failure') response.reject(new Error('retired command cancelled'));
    else response.resolve({ acknowledged: true, paused: command === 'pause' });
    await pending; await tick();
    const repaints = render.mock.callCount(), visibilitySettlements = settle.mock.callCount();
    terminal.reject(new Error('close request failed')); await closing;
    assert.equal(root.dataset.state, 'idle'); assert.equal(root.dataset.call, 'none');
    assert.equal(root.querySelector('.voice-state').textContent, en.voiceClosureUncertain);
    assert.equal(root.hasAttribute('data-message'), false, 'no floating failure panel over following controls');
    assert.equal(rail.input, true); assert.equal(rail.output, true); assert.equal(rail.paused, false);
    assert.equal(rail.button('start').disabled, false);
    assert.equal(repaints, 0, 'a retired command must not repaint the rail');
    assert.equal(visibilitySettlements, 0, 'a retired command must not settle visibility work');
    rail.settlement({ callId: session.callId, providerSessionId: session.providerSessionId,
      terminal: { closureConfirmed: true, usage: { upstreamMicro: 1_520_000, costEstimated: false } } });
    assert.equal(root.querySelector('.voice-state').textContent, en.voiceEnded);
    assert.equal(root.hasAttribute('data-message'), false);
  } finally { response.resolve(); terminal.resolve({ closureConfirmed: false }); await pending; await closing; events.end(); }
});
for (const outcome of ['success', 'failure'])
test(`AIT-145: retired channel ${outcome} cannot change a new generation or release its pending command`, async t => {
  const { rail, root, events } = fixture(t); await rail.start();
  const old = Promise.withResolvers(), next = Promise.withResolvers(), session = rail.session;
  session.setInput = () => old.promise; rail.button('input').click();
  session.close = async () => { throw new Error('close request failed'); };
  await rail.close();
  // Reusing the session object exercises the generation guard independently of object identity.
  events.end(); session.events = voiceEvents(); t.after(() => session.events.end());
  session.setInput = enabled => enabled ? Promise.resolve() : next.promise;
  await rail.start();
  try {
    assert.equal(rail.button('input').disabled, false, 'hangup releases the retired command');
    rail.button('input').click(); assert.equal(rail.busy, true);
    if (outcome === 'failure') old.reject(new Error('retired command cancelled')); else old.resolve();
    await tick();
    assert.equal(rail.busy, true, 'the new command still owns the busy state');
    assert.equal(rail.input, true, 'the retired command cannot change the channel preference');
    assert.equal(root.dataset.state, 'listening'); assert.equal(root.dataset.call, 'active');
    assert.equal(rail.errorKey, null); assert.equal(root.hasAttribute('data-message'), false);
    next.resolve(); await tick(); assert.equal(rail.busy, false); assert.equal(rail.input, false);
  } finally { old.resolve(); next.resolve(); await tick(); events.end(); }
});
for (const outcome of ['success', 'failure'])
test(`AIT-145: provider-ended session ignores pending pause ${outcome} without a generation change`, async t => {
  const { rail, root, events } = fixture(t); await rail.start();
  const response = Promise.withResolvers(), generation = rail.generation;
  rail.session.pause = () => response.promise;
  const pending = rail.pause(true);
  events.push({ callId: 'local-call', type: 'ended', reason: 'closed' }); events.end(); await tick();
  const status = root.querySelector('.voice-state').textContent, render = t.mock.method(rail, 'render');
  try {
    assert.equal(rail.generation, generation, 'session identity must also guard completions');
    if (outcome === 'failure') response.reject(new Error('retired command cancelled'));
    else response.resolve({ acknowledged: true, paused: true });
    await pending;
    assert.equal(render.mock.callCount(), 0);
    assert.equal(root.querySelector('.voice-state').textContent, status);
    assert.equal(root.hasAttribute('data-message'), false);
  } finally { response.resolve(); await pending; }
});
for (const command of ['setInput', 'setOutput', 'updateContext'])
test(`AIT-145: retired startup ${command} completion cannot restart monitoring or issue more commands`, async t => {
  const { rail, root, events, commands } = fixture(t), response = Promise.withResolvers();
  const session = await rail.client.start(); session[command] = () => response.promise;
  const starting = rail.start(); await tick(); await rail.close();
  const count = commands.length, render = t.mock.method(rail, 'render'), interval = t.mock.method(globalThis, 'setInterval');
  try {
    response.resolve(); await starting;
    assert.equal(render.mock.callCount(), 0);
    assert.equal(interval.mock.callCount(), 0, 'hangup must not recreate heartbeat or waveform timers');
    assert.equal(commands.length, count, 'no further startup commands after hangup');
    assert.equal(root.querySelector('.voice-state').textContent, en.voiceEnded);
  } finally { response.resolve(); await starting; events.end(); }
});
for (const outcome of ['success', 'failure'])
test(`AIT-145: retired heartbeat ${outcome} cannot overwrite ended status after close failure`, async t => {
  const response = Promise.withResolvers(), nativeInterval = globalThis.setInterval; let heartbeat;
  t.mock.method(globalThis, 'setInterval', (callback, ms, ...args) => {
    if (ms === 10_000) heartbeat = callback;
    return nativeInterval(callback, ms, ...args);
  });
  const { rail, root, events } = fixture(t); await rail.start();
  rail.session.heartbeat = () => response.promise; heartbeat();
  rail.session.close = async () => { throw new Error('close request failed'); }; await rail.close();
  const render = t.mock.method(rail, 'render'), close = t.mock.method(rail, 'close');
  try {
    if (outcome === 'failure') response.reject(new Error('retired heartbeat cancelled')); else response.resolve();
    await tick();
    assert.equal(close.mock.callCount(), 0, 'an old heartbeat cannot close a subsequent generation');
    assert.equal(render.mock.callCount(), 0);
    assert.equal(root.querySelector('.voice-state').textContent, en.voiceClosureUncertain);
    assert.equal(root.hasAttribute('data-message'), false);
  } finally { response.resolve(); await tick(); events.end(); }
});
test('AIT-145: retired autoplay failure cannot restore the floating playback panel', async t => {
  const { rail, root } = fixture(t); await rail.start();
  const response = Promise.withResolvers(), playing = Promise.withResolvers(), audio = document.createElement('audio');
  audio.autoplay = true; audio.play = () => { playing.resolve(); return response.promise; };
  document.body.append(audio); t.after(() => audio.remove()); await playing.promise;
  rail.session.close = async () => { throw new Error('close request failed'); }; await rail.close();
  response.reject(new window.DOMException('policy', 'NotAllowedError')); await tick();
  assert.equal(root.querySelector('.voice-state').textContent, en.voiceClosureUncertain);
  assert.equal(root.hasAttribute('data-message'), false);
  assert.equal(rail.playbackBlocked, false);
});
test('AIT-145: a late settlement cannot overwrite a newly started call', async t => {
  const { rail, root } = fixture(t); await rail.start();
  const terminal = Promise.withResolvers(), old = rail.session;
  old.close = () => terminal.promise;
  const next = { ...old, callId: 'next-call', events: voiceEvents(), async close() { this.events.end(); return { closureConfirmed: true }; } };
  rail.client.start = async () => next;
  const closing = rail.close();
  try {
    await rail.start();
    terminal.resolve({ closureConfirmed: false }); await closing;
    assert.equal(root.dataset.state, 'listening');
    assert.equal(root.dataset.call, 'active');
  } finally { terminal.resolve({ closureConfirmed: false }); old.events.end(); await closing; }
});
test('AIT-145: localized pending cost copy does not call the reserved ceiling a charge', () => {
  assert.equal(de.voiceClosureUncertain, 'Anruf beendet. Kosten werden noch abgeglichen.');
  assert.equal(en.voiceClosureUncertain, 'Call ended. Costs are still being reconciled.');
});
test('AIT-145: browser control asks for background closure confirmation', async t => {
  let body;
  t.mock.method(globalThis, 'fetch', async (url, options) => {
    body = JSON.parse(options.body); return Response.json({ reconciliationPending: true, closureConfirmed: false }, { status: 202 });
  });
  const { control } = createVoiceControl({ sessionId: 'local-session' });
  await control.close({ callId: 'ended-call', providerSessionId: 'ended-provider', reason: 'closed' });
  assert.equal(body.background, true);
});
test('AIT-145: confirmed cost updates clear the pending call message only for the ended provider generation', async t => {
  const session = createSession({ demo: true }), events = voiceEvents();
  session.featureMatrix = { best: { voice: { available: true }, text: { available: true }, analysis: { available: true } } };
  const c = document.createElement('aithema-session'); let callId;
  c.configure({ copy: en, session, voiceClient: { manifest, async start(request) {
    callId = request.callId;
    return { callId, providerSessionId: 'ended-provider', events, async setInput() {}, async setOutput() {}, async updateContext() {},
      async close() { events.end(); return { closureConfirmed: false, reconciliationPending: true }; } };
  } } });
  t.after(() => { c.remove(); c.configure({ copy: en, session }); });
  const root = c.shadowRoot;
  root.querySelector('.voice-start').click(); await tick();
  root.querySelector('.voice-close').click(); await tick();
  const receipt = providerSessionId => ({ type: 'voice.state', data: { callId, providerSessionId, state: 'ended',
    terminal: { closureConfirmed: true, outcome: 'completed', usage: { upstreamMicro: 1_520_000, costEstimated: false } } } });
  c.receive(receipt('foreign-provider'));
  assert.equal(root.querySelector('.voice-state').textContent, en.voiceClosureUncertain);
  c.receive(receipt('ended-provider'));
  assert.equal(root.querySelector('.voice-state').textContent, 'Call ended.');
  assert.equal(root.querySelector('.audio-rail').dataset.state, 'idle');
});
test('audio rail shows listening, speaking, paused, recovering and ended states with fixed controls and independent toggles', async t => {
  const { root, rail, events, commands } = fixture(t);
  const buttons = [...root.querySelectorAll('button')]; await rail.start();
  assert.equal(root.dataset.state, 'listening');
  events.push({ callId: 'local-call', type: 'speaking' }); await tick(); assert.equal(root.dataset.state, 'speaking');
  rail.button('input').click(); await tick(); assert.equal(rail.input, false); assert.equal(rail.output, true);
  rail.button('output').click(); await tick(); assert.equal(rail.output, false);
  await rail.pause(true); assert.equal(root.dataset.state, 'paused');
  await rail.pause(false); assert.equal(rail.input, false); assert.equal(rail.output, false);
  events.push({ callId: 'local-call', type: 'recovering' }); await tick(); assert.equal(root.dataset.state, 'recovering');
  events.push({ callId: 'local-call', type: 'recovered' }); await tick(); assert.equal(root.dataset.state, 'listening');
  assert.deepEqual([...root.querySelectorAll('button')], buttons);
  assert.ok(commands.some(c => c[0] === 'input' && c[1] === false));
  assert.ok(!root.querySelector('[class*=interrupt]'), 'native voice barge-in has no force button');
});
test('AIT-136 pause state changes immediately in the same controls and focus never resumes it', async t => {
  let acknowledge; const { rail, root } = fixture(t, { pause: () => new Promise(resolve => { acknowledge = resolve; }) });
  await rail.start(); const pending = rail.pause(true);
  const buttons = [...root.querySelectorAll('button')];
  assert.equal(root.dataset.state, 'paused');
  assert.equal(rail.button('pause').disabled, false, 'a newer visitor intent may supersede a pending Pause');
  assert.equal(rail.button('pause').title, en.resume);
  acknowledge({ acknowledged: true, paused: true }); await pending; assert.equal(root.dataset.state, 'paused');
  assert.deepEqual([...root.querySelectorAll('button')], buttons);
  window.dispatchEvent(new window.Event('focus')); await tick(); assert.equal(root.dataset.state, 'paused');
});
test('window blur keeps the call; a hidden page pauses it as START does; unacknowledged pause has distinct failure copy', async t => {
  const records = new Map(), storage = { getItem: k => records.get(k) ?? null, setItem: (k, v) => records.set(k, v), removeItem: k => records.delete(k) };
  const journal = voiceJournal(storage, 's1');
  const { rail, root } = fixture(t, { journal }); await rail.start(); window.dispatchEvent(new window.Event('blur')); await tick();
  assert.equal(root.dataset.state, 'listening', 'switching windows never pauses (AIT-116 D7)');
  assert.deepEqual(journal.read(), { callId: 'local-call', providerSessionId: 'local-provider' }, 'the journal holds call identity only');
  t.mock.method(document, 'hidden', () => true, { getter: true });
  document.dispatchEvent(new window.Event('visibilitychange')); await tick();
  assert.equal(root.dataset.state, 'paused');
  t.mock.restoreAll();
  await rail.pause(false); assert.equal(root.dataset.state, 'listening');
  rail.session.pause = async () => ({ acknowledged: false, paused: true }); await rail.pause(true);
  assert.equal(root.querySelector('.voice-state').textContent, en.voicePauseFailed); assert.equal(rail.paused, true);
});
test('voice unavailable in preset disables Start with a reason and retains layout', async t => {
  const { rail, root } = fixture(t, { unavailable: true });
  assert.equal(rail.button('start').disabled, true); assert.equal(rail.button('start').title, 'preset denies voice');
  await rail.start(); assert.equal(root.dataset.state, 'idle'); assert.equal(root.querySelectorAll('.voice-cell button').length, 7);
});
test('AIT-131: label ResizeObserver measures the mask, hides short flanks and follows disconnect/reconnect', async t => {
  const observers = [];
  const view = document.defaultView, previous = view.ResizeObserver;
  view.ResizeObserver = class {
    constructor(callback) { this.callback = callback; this.targets = new Set(); observers.push(this); }
    observe(target) { this.targets.add(target); }
    disconnect() { this.targets.clear(); }
  };
  t.after(() => { view.ResizeObserver = previous; });
  const { rail, root } = fixture(t), label = root.querySelector('.voice-state'), wave = root.querySelector('.voice-wave'), caption = root.querySelector('.voice-caption');
  const observer = observers.find(o => o.targets.has(label));
  assert.ok(observer); assert.ok(observer.targets.has(caption)); assert.ok(observer.targets.has(wave));
  let lineWidths = [280], waveWidth = 500;
  t.mock.method(label, 'getBoundingClientRect', () => ({ width: 440 }));
  t.mock.method(wave, 'getBoundingClientRect', () => ({ width: waveWidth }));
  t.mock.method(caption, 'getBoundingClientRect', () => ({ width: 96 }));
  t.mock.method(document, 'createRange', () => {
    let selected;
    return { selectNodeContents(node) { selected = node; },
      getClientRects: () => (selected === caption ? [80] : lineWidths).map(width => ({ width })) };
  });
  const buttons = [...root.querySelectorAll('button')];
  observer.callback(); assert.equal(wave.style.getPropertyValue('--voice-label-half'), '140px'); assert.equal(wave.hasAttribute('data-short-flanks'), false);
  lineWidths = [184, 280]; observer.callback(); assert.equal(wave.style.getPropertyValue('--voice-label-half'), '140px', 'a wrapped label follows its widest text line, not the capped box');
  lineWidths = [440, 180]; observer.callback(); assert.equal(wave.hasAttribute('data-short-flanks'), true);
  waveWidth = 600; observer.callback(); assert.equal(wave.hasAttribute('data-short-flanks'), false);
  lineWidths = [140, 200]; rail.render(); assert.equal(wave.style.getPropertyValue('--voice-label-half'), '100px', 'a text repaint also updates the hole when the capped box stays the same size');
  caption.textContent = 'Live words'; observer.callback(); assert.equal(wave.style.getPropertyValue('--voice-label-half'), '40px');
  assert.deepEqual([...root.querySelectorAll('button')], buttons, 'mask updates preserve the controls');
  rail.disconnect(); assert.equal(observer.targets.size, 0);
  rail.connect(); assert.ok(observer.targets.has(label)); assert.ok(observer.targets.has(wave));
});
test('three failed reconnects expose recovery and typing controls, with distinct terminal and permission messages', async t => {
  const { rail, root, events } = fixture(t); await rail.start();
  events.push({ type: 'ended', callId: 'local-call', reason: 'recovery-failed' }); events.end(); await tick();
  assert.equal(rail.button('retry').disabled, false); assert.equal(root.querySelector('.voice-state').textContent, en.voiceRecoveryFailed);
  rail.failure({ name: 'NotAllowedError' }); assert.equal(rail.error, en.voiceMicDenied);
  rail.failure({ name: 'NotFoundError' }); assert.equal(rail.error, en.voiceMicMissing);
  rail.failure({ code: 'deadline' }); assert.equal(rail.error, en.voiceDeadline);
});
test('voice admission cap races carry the reason through control and render plain English or formal German', async t => {
  const { rail, root } = fixture(t);
  const reasons = ['Voice minute cap reached for this deployment', 'Voice minute cap reached for this UTC day'];
  for (const reason of reasons) {
    t.mock.method(globalThis, 'fetch', async () => Response.json({ error: 'not-admitted', reason }, { status: 403 }));
    const { control } = createVoiceControl({ sessionId: 'session' });
    let error;
    try { await control.start({ callId: 'call' }); } catch (failure) { error = failure; }
    assert.equal(error.code, 'not-admitted'); assert.equal(error.reason, reason);
    for (const copy of [en, de]) {
      rail.copy = copy; rail.failure(error);
      assert.equal(root.querySelector('.voice-state').textContent, copy.reasons[reason]);
      assert.doesNotMatch(de.reasons[reason], /\b(?:du|dein|deine|dich|dir)\b/iu);
    }
  }
});

test('host playback notifications and retry clear the message only after success', async t => {
  const { rail, root } = fixture(t); let tries = 0, notify;
  const start = rail.client.start;
  rail.client.start = (request, options) => { notify = options.onPlaybackBlocked; return start(request, options); };
  await rail.start();
  rail.session.retryPlayback = async () => { if (++tries === 1) throw new Error('blocked'); };
  notify();
  assert.equal(rail.playbackBlocked, true); assert.equal(root.querySelector('.voice-state').textContent, en.voicePlaybackBlocked);
  await rail.retryPlayback(); assert.equal(rail.playbackBlocked, true);
  await rail.retryPlayback(); assert.equal(tries, 2); assert.equal(rail.playbackBlocked, false);
});
test('component sends typed text through active voice, updates context and accepts a durable plain fallback', async t => {
  const session = createSession({ demo: true });
  session.featureMatrix = { best: { voice: { available: true }, text: { available: true }, analysis: { available: true } } };
  const commands = [], events = voiceEvents(), originalFetch = globalThis.fetch;
  let settle, plainReply = false; const terminal = new Promise(resolve => { settle = resolve; });
  globalThis.fetch = async (url, options) => {
    assert.ok(String(url).endsWith('/turns'));
    const body = JSON.parse(options.body); commands.push(['persist', body]);
    return Response.json({ seq: c.session.seq + 1, type: 'turn.final', data: { id: body.clientEventId, role: 'user', content: body.content,
      ...(plainReply ? {} : { voiceCallId: body.voiceCallId }) } });
  };
  t.after(() => { globalThis.fetch = originalFetch; });
  const c = document.createElement('aithema-session');
  let activeCall;
  c.configure({ copy: en, session, voiceClient: { manifest, async start({ callId }) {
    activeCall = callId;
    return { callId, providerSessionId: 'slow-provider', events, async close() { events.end(); return terminal; },
      async setInput() {}, async setOutput() {}, async sendText(value) { commands.push(['text', value]); },
      async updateContext(value) { commands.push(['context', value]); } };
  } } });
  t.after(() => { settle({ closureConfirmed: true }); c.configure({ copy: en, session }); c.remove(); }); const root = c.shadowRoot;
  root.querySelector('.voice-start').click(); await tick();
  root.querySelector('textarea').value = 'typed during voice'; root.querySelector('form').dispatchEvent(new window.Event('submit', { cancelable: true })); await tick();
  assert.ok(commands.some(([name, value]) => name === 'text' && value === 'typed during voice'));
  assert.equal(c.session.transcript.length, 1, 'typed text persists even when the provider never echoes');
  assert.ok(commands.findIndex(([name]) => name === 'persist') < commands.findIndex(([name]) => name === 'text'));
  assert.equal(root.querySelector('.status__label').textContent, en.voiceTextSent);
  events.push({ callId: activeCall, type: 'speaking' }); await tick();
  assert.notEqual(root.querySelector('.status__label').textContent, en.voiceTextSent, 'the status line follows the call state (D11)');
  c.receive({ seq: c.session.seq + 1, type: 'question.focused', data: { question: 'Which systems?' } }); await tick();
  assert.equal(commands.at(-1)[1].focusedQuestion, 'Which systems?');
  c.receive({ seq: c.session.seq + 1, type: 'understanding.updated', data: { ...c.session.understanding, summary: 'New context', inputRevision: inputRevision(c.session) } }); await tick();
  assert.equal(commands.at(-1)[1].understanding.summary, 'New context');
  plainReply = true;
  root.querySelector('textarea').value = 'plain while closing';
  root.querySelector('form').dispatchEvent(new window.Event('submit', { cancelable: true })); await tick();
  assert.equal(c.session.transcript.at(-1).content, 'plain while closing');
  assert.equal(commands.filter(([name]) => name === 'text').length, 1, 'a plain acknowledgement is not forwarded to the closing SDK');
  assert.equal(root.querySelector('textarea').value, ''); assert.equal(root.querySelector('.status__label').textContent, en.saved);
  root.querySelector('.voice-close').click(); await tick();
  settle({ closureConfirmed: true }); await tick();
});

for (const change of [
  { name: 'draft grant', draftsBefore: false, draftsAfter: true, preserved: true },
  { name: 'draft withdrawal', draftsBefore: true, draftsAfter: false, preserved: true },
  { name: 'reasoning withdrawal', draftsBefore: true, draftsAfter: true, preserved: false },
  { name: 'voice withdrawal', draftsBefore: true, draftsAfter: true, preserved: false },
]) test(`consent.revised during a call: ${change.name} ${change.preserved ? 'keeps the SDK, rail and partial reply' : 'closes the SDK and clears the partial reply'}`, async t => {
  const session = createSession({ demo: true });
  session.featureMatrix = { best: { voice: { available: true }, text: { available: true }, analysis: { available: true },
    html: { available: change.draftsBefore, reason: change.draftsBefore ? null : 'current processing consent required' } } };
  const c = document.createElement('aithema-session'), closed = [], ended = [];
  let callId, callbacks, drafts = change.draftsBefore, refreshes = 0;
  t.mock.method(globalThis, 'fetch', async (url, options = {}) => {
    if (url.endsWith('/events')) return new Response(new ReadableStream({ start(controller) {
      options.signal.addEventListener('abort', () => controller.close(), { once: true });
    } }));
    assert.equal(url, `/api/sessions/${session.id}`);
    refreshes++;
    const snapshot = c.session;
    snapshot.featureMatrix.best.html = { available: drafts, reason: drafts ? null : 'current processing consent required' };
    return Response.json(snapshot);
  });
  const control = {
    async start(request) { callId = request.callId; return { callId, providerSessionId: 'consent-provider',
      credential: { providerSessionId: 'consent-provider', connectionType: 'webrtc', conversationToken: 'fixture-token', ttlMs: 60_000 },
      spendDeadlineAt: Date.now() + 60_000, browserLivenessDeadlineAt: Date.now() + 30_000 }; },
    async close(identity) { closed.push(identity); return { closureConfirmed: true }; },
    async pause() {}, async resume() {}, async heartbeat() {},
  };
  const client = createElevenLabsClient({ control, persistEvent: async () => {}, sdk: {
    async startSession(options) { callbacks = options; return {
      getId: () => 'consent-provider', input: { async setMuted() {} }, setVolume() {}, sendContextualUpdate() {},
      async endSession() { ended.push(callId); },
    }; },
  } });
  c.configure({ copy: en, session, voiceClient: client }); document.body.append(c);
  t.after(async () => { c.remove(); await tick(); });
  const root = c.shadowRoot, rail = root.querySelector('.audio-rail');
  root.querySelector('.voice-start').click(); await tick();
  assert.equal(rail.dataset.state, 'listening'); assert.equal(rail.dataset.call, 'active');
  c.receive({ seq: c.session.seq + 1, type: 'turn.final', data: { id: 'source', role: 'user', content: 'Repairs' } });
  const revision = inputRevision(c.session);
  c.receive({ type: 'turn.partial', data: { id: 'reply', delta: 'Unfinished', inputRevision: revision } });
  const partial = root.querySelector('.partial'); assert.equal(partial.querySelector('span').textContent, 'Unfinished');

  drafts = change.draftsAfter;
  // The server keeps the session-wide grant on selective saves. Only a draft-only
  // change carries its explicit conversation preservation flag.
  c.receive({ seq: c.session.seq + 1, type: 'consent.revised', data: { granted: true,
    ...(change.preserved ? { conversationUnchanged: true } : {}) } }); await tick();
  assert.equal(refreshes, 1, 'every consent save refreshes the authoritative feature verdicts');
  assert.equal(c.session.featureMatrix.best.html.available, drafts);
  if (change.preserved) {
    assert.deepEqual(ended, [], 'the browser SDK remains connected');
    assert.deepEqual(closed, [], 'the live call is never closed');
    assert.equal(root.querySelector('.audio-rail'), rail); assert.equal(rail.dataset.call, 'active');
    assert.equal(rail.dataset.state, 'listening'); assert.equal(root.querySelector('.voice-close').disabled, false);
    assert.equal(root.querySelector('.partial'), partial); assert.equal(partial.querySelector('span').textContent, 'Unfinished');
    assert.equal(inputRevision(c.session), revision);
    callbacks.onModeChange({ mode: 'speaking' }); await tick();
    assert.equal(rail.dataset.state, 'speaking', 'the same SDK still drives the rail');
    c.receive({ type: 'turn.partial', data: { id: 'reply', delta: ' answer', inputRevision: revision } });
    assert.equal(root.querySelector('.partial'), partial); assert.equal(partial.querySelector('span').textContent, 'Unfinished answer');
  } else {
    assert.deepEqual(ended, [callId], 'required consent withdrawal disconnects the browser SDK');
    assert.deepEqual(closed.map(({ callId: id }) => id), [callId], 'required consent withdrawal closes the live call');
    assert.equal(rail.dataset.call, 'none'); assert.equal(rail.dataset.state, 'idle');
    assert.equal(root.querySelector('.partial'), null);
    c.receive({ type: 'turn.partial', data: { id: 'reply', delta: ' late', inputRevision: revision } });
    assert.equal(root.querySelector('.partial'), null, 'invalidated fragments cannot restore a withdrawn reply');
  }
});

test('closing notification ends the browser SDK and local UI before slow provider settlement', async t => {
  const session = createSession({ demo: true });
  session.featureMatrix = { best: { voice: { available: true }, text: { available: true }, analysis: { available: true } } };
  let ended = false, settle, callId, providerClosed = false;
  const terminal = new Promise(resolve => { settle = resolve; });
  const control = {
    async start(request) { callId = request.callId; return { callId, providerSessionId: 'slow-provider',
      credential: { providerSessionId: 'slow-provider', connectionType: 'webrtc', conversationToken: 'fixture-token', ttlMs: 60_000 },
      spendDeadlineAt: Date.now() + 60_000, browserLivenessDeadlineAt: Date.now() + 30_000 }; },
    async close() { assert.equal(ended, true); providerClosed = true; return terminal; },
    async pause() {}, async resume() {}, async heartbeat() {},
  };
  const client = createElevenLabsClient({ control, persistEvent: async () => {}, sdk: {
    async startSession() { return { getId: () => 'slow-provider', input: { async setMuted() {} }, setVolume() {}, sendContextualUpdate() {},
      async endSession() { ended = true; } }; },
  } });
  const c = document.createElement('aithema-session'); c.configure({ copy: en, session, voiceClient: client });
  t.after(async () => { settle({ closureConfirmed: true }); c.configure({ copy: en, session }); c.remove(); await tick(); });
  c.shadowRoot.querySelector('.voice-start').click(); await tick();
  assert.equal(c.shadowRoot.querySelector('.audio-rail').dataset.state, 'listening');
  c.receive({ type: 'voice.state', data: { callId, providerSessionId: 'previous-provider', state: 'closing', reason: 'consent-revised' } }); await tick();
  assert.equal(ended, false, 'an old provider cannot close the current SDK');
  c.receive({ type: 'voice.state', data: { callId, providerSessionId: 'slow-provider', state: 'closing', reason: 'consent-revised' } }); await tick();
  assert.equal(ended, true, 'closing stops capture without waiting for a terminal'); assert.equal(providerClosed, true);
  assert.equal(c.shadowRoot.querySelector('.audio-rail').dataset.state, 'idle');
  assert.equal(c.shadowRoot.querySelector('.voice-state').textContent, en.voiceClosureUncertain);
  settle({ closureConfirmed: true }); await tick();
});

test('failed recovered SDK connections complete all three attempts and expose Resume despite closing broadcasts', { timeout: 60_000 }, async t => {
  const session = createSession({ demo: true });
  session.featureMatrix = { best: { voice: { available: true }, text: { available: true } } };
  const c = document.createElement('aithema-session'), notices = eventProbe();
  let callbacks, attempts = 0, connections = 0, callId;
  const receipt = providerSessionId => ({ callId, providerSessionId,
    credential: { providerSessionId, connectionType: 'webrtc', conversationToken: 'fixture-token', ttlMs: 60_000 },
    spendDeadlineAt: Date.now() + 60_000, browserLivenessDeadlineAt: Date.now() + 30_000 });
  const control = {
    async start(request) { callId = request.callId; return receipt('initial-provider'); },
    async recover() { return receipt(`recovered-provider-${++attempts}`); },
    async close(identity) {
      c.receive({ type: 'voice.state', data: { ...identity, state: identity.reason === 'transport-lost' ? 'recovering' : 'closing' } });
      c.receive({ type: 'voice.state', data: { ...identity, state: identity.reason === 'transport-lost' ? 'recovering' : 'ended' } });
      return { closureConfirmed: true };
    },
    async pause() {}, async resume() {}, async heartbeat() {},
  };
  const client = createElevenLabsClient({ control, persistEvent: async () => {}, sdk: {
    async startSession(options) {
      if (++connections > 1) throw new Error('fixture SDK connect failed');
      callbacks = options;
      return { getId: () => 'initial-provider', input: { async setMuted() {} }, setVolume() {}, sendContextualUpdate() {}, async endSession() {} };
    },
  } });
  const render = AudioRail.prototype.render;
  t.mock.method(AudioRail.prototype, 'render', function () {
    render.call(this); notices.record(this.state);
  });
  c.configure({ copy: en, session, voiceClient: client });
  t.after(async () => { c.configure({ copy: en, session }); c.remove(); await tick(); });
  const root = c.shadowRoot;
  const started = notices.waitFor(state => state === 'listening'); root.querySelector('.voice-start').click(); await started;
  const after = notices.events.length;
  const finished = notices.waitFor(state => state === 'waiting', after);
  callbacks.onDisconnect(); await finished;
  assert.equal(attempts, 3); assert.equal(connections, 4, 'recovery admission succeeds but each SDK connect fails');
  assert.equal(root.querySelector('.audio-rail').dataset.state, 'waiting');
  assert.equal(root.querySelector('.voice-state').textContent, en.voiceStates.waiting);
  assert.equal(root.querySelector('.pause').title, en.resume);
  assert.equal(root.querySelector('.voice-retry').disabled, true);
  assert.equal(root.querySelector('.send').disabled, false);
});

test('AIT-138 fix 2: a recoverable segment confirmation keeps waiting and Resume in the browser', async t => {
  const session = createSession({ demo: true });
  session.featureMatrix = { best: { voice: { available: true }, text: { available: true } } };
  let callId, sdkEnds = 0, serverCloses = 0;
  const receipt = providerSessionId => ({ callId, providerSessionId,
    credential: { providerSessionId, connectionType: 'webrtc', conversationToken: 'fixture-token', ttlMs: 60_000 },
    spendDeadlineAt: Date.now() + 60_000, browserLivenessDeadlineAt: Date.now() + 30_000 });
  const control = {
    async start(request) { callId = request.callId; return receipt('waiting-provider'); },
    async recover() { return receipt('resumed-provider'); },
    async close() { serverCloses++; return { closureConfirmed: true }; },
    async pause() { return { acknowledged: true, paused: true }; }, async resume() { return { acknowledged: true, paused: false }; }, async heartbeat() {},
  };
  const client = createElevenLabsClient({ control, persistEvent: async () => {}, sdk: {
    async startSession(options) { const id = options.conversationToken && sdkEnds ? 'resumed-provider' : 'waiting-provider';
      return { getId: () => id, input: { async setMuted() {} }, setVolume() {}, sendContextualUpdate() {}, async endSession() { sdkEnds++; } };
    },
  } });
  const c = document.createElement('aithema-session'); c.configure({ copy: en, session, voiceClient: client });
  t.after(async () => { c.configure({ copy: en, session }); c.remove(); await tick(); });
  const root = c.shadowRoot; root.querySelector('.voice-start').click(); await tick();
  c.receive({ type: 'voice.state', data: { callId, providerSessionId: 'waiting-provider', state: 'waiting', reason: 'browser-liveness-deadline' } }); await tick();
  c.receive({ type: 'voice.state', data: { callId, providerSessionId: 'waiting-provider', state: 'ended', reason: 'browser-liveness-deadline',
    terminal: { closureConfirmed: true } } }); await tick();
  assert.equal(serverCloses, 0, 'provider settlement must not send a logical hang-up command');
  assert.equal(sdkEnds, 0); assert.equal(root.querySelector('.audio-rail').dataset.state, 'waiting');
  assert.equal(root.querySelector('.pause').title, en.resume); assert.equal(root.querySelector('.pause').disabled, false);
  root.querySelector('.pause').click(); await tick(); await tick();
  assert.equal(root.querySelector('.audio-rail').dataset.state, 'listening');
});

test('AIT-138 fix 3: a waiting snapshot restores Resume without connecting until an explicit click', async t => {
  const session = createSession({ demo: true });
  session.featureMatrix = { best: { voice: { available: true }, text: { available: true } } };
  session.voiceLifecycle = { callId: 'durable-waiting-call', providerSessionId: 'retired-provider', state: 'waiting', attempts: 3,
    needsRecovery: true, spendDeadlineAt: Date.now() + 60_000, browserLivenessDeadlineAt: Date.now() - 1000 };
  const nativeStorage = globalThis.sessionStorage, storage = memoryStorage();
  globalThis.sessionStorage = storage; t.after(() => { globalThis.sessionStorage = nativeStorage; });
  voiceJournal(storage, session.id).save({ callId: 'durable-waiting-call', providerSessionId: 'retired-provider' });
  const requests = []; let connections = 0;
  const control = {
    async start() { assert.fail('Resume must continue the persisted logical call'); },
    async recover(identity) { requests.push(identity); return { callId: identity.callId, providerSessionId: 'resumed-provider', presentation: 'continuation',
      credential: { providerSessionId: 'resumed-provider', connectionType: 'webrtc', conversationToken: 'fixture-token', ttlMs: 60_000 },
      overrides: { agent: { language: 'en', firstMessage: '' } }, spendDeadlineAt: session.voiceLifecycle.spendDeadlineAt,
      browserLivenessDeadlineAt: Date.now() + 30_000 }; },
    async close() { return { closureConfirmed: true }; },
    async pause() { return { acknowledged: true, paused: true }; },
    async resume() { return { acknowledged: true, paused: false }; }, async heartbeat() {},
  };
  const client = createElevenLabsClient({ control, persistEvent: async () => {}, sdk: {
    async startSession(options) { connections++; assert.equal(options.overrides.agent.firstMessage, '');
      return { getId: () => 'resumed-provider', input: { async setMuted() {} }, setVolume() {}, sendContextualUpdate() {}, async endSession() {} };
    },
  } });
  const c = document.createElement('aithema-session'); c.configure({ copy: en, session, voiceClient: client });
  t.after(async () => { c.configure({ copy: en, session: createSession() }); c.remove(); await tick(); });
  const root = c.shadowRoot; await tick();
  assert.equal(root.querySelector('.audio-rail').dataset.state, 'waiting'); assert.equal(root.querySelector('.pause').title, en.resume);
  assert.equal(root.querySelector('.pause').disabled, false); assert.equal(connections, 0); assert.deepEqual(requests, []);
  root.querySelector('.pause').click(); await tick(); await tick();
  assert.equal(root.querySelector('.audio-rail').dataset.state, 'listening'); assert.equal(connections, 1);
  assert.deepEqual(requests, [{ callId: 'durable-waiting-call', providerSessionId: 'retired-provider', explicit: true }]);
});

test('resending failed typed input after voice ends drops its stale call identity', async t => {
  const session = createSession({ demo: true });
  session.featureMatrix = { best: { voice: { available: true }, text: { available: true } } };
  const c = document.createElement('aithema-session'), events = voiceEvents(), requests = [], originalFetch = globalThis.fetch;
  globalThis.fetch = async (url, options) => {
    const body = JSON.parse(options.body); requests.push(body);
    if (requests.length === 1) return Response.json({ error: 'fixture-failure' }, { status: 503 });
    return Response.json({ seq: 1, type: 'turn.final', data: { id: body.clientEventId, role: 'user', content: body.content } });
  };
  c.configure({ copy: en, session, voiceClient: { manifest, async start({ callId }) {
    return { callId, providerSessionId: 'provider', events, async setInput() {}, async setOutput() {}, async updateContext() {},
      async close() { events.end(); return { closureConfirmed: true }; } };
  } } });
  t.after(() => { globalThis.fetch = originalFetch; c.configure({ copy: en, session }); c.remove(); });
  const root = c.shadowRoot;
  root.querySelector('.voice-start').click(); await tick();
  root.querySelector('textarea').value = 'yes';
  root.querySelector('form').dispatchEvent(new window.Event('submit', { cancelable: true })); await tick();
  assert.ok(requests[0].voiceCallId); assert.equal(root.querySelector('.status__label').textContent, en.failed);
  events.push({ type: 'ended', callId: requests[0].voiceCallId, reason: 'closed' }); events.end(); await tick();
  root.querySelector('form').dispatchEvent(new window.Event('submit', { cancelable: true })); await tick();
  assert.equal(requests[1].voiceCallId, undefined); assert.equal(requests[1].providerSessionId, undefined);
  assert.equal(requests[1].clientEventId, requests[0].clientEventId, 'resend preserves the pending turn identity');
  assert.equal(c.session.transcript.length, 1); assert.equal(root.querySelector('textarea').value, '');
});
test('heard correction truncates the bubble immediately under hover while preserving its occupied height', () => {
  const c = document.createElement('aithema-session'), session = createSession({ demo: true });
  c.configure({ copy: en, session });
  c.receive({ seq: 1, type: 'turn.final', data: { id: 'a', role: 'assistant', content: 'Heard. Unspoken remainder.' } });
  const shell = c.shadowRoot.querySelector('.transcript-shell'), row = shell.querySelector('.turn');
  row.getBoundingClientRect = () => ({ height: 80 }); shell.dispatchEvent(new window.Event('pointerenter'));
  c.receive({ seq: 2, type: 'turn.corrected', data: { id: 'a', role: 'assistant', content: 'Heard.' } });
  assert.equal(row.querySelector('span').textContent, 'Heard.'); assert.equal(row.style.minHeight, '80px');
  assert.equal(shell.querySelector('.turn'), row);
  shell.dispatchEvent(new window.Event('pointerleave')); assert.equal(c.session.transcript[0].content, 'Heard.');
  // START's conversation rail: orb dock, then 44 px controls in fixed cells around the waveform.
  assert.match(styles, /\.audio-rail \{[^}]*grid-template-columns:48px 44px minmax\(0,1fr\) 44px 44px 44px;/u);
  assert.ok(!/\.audio-rail[^{}]*:hover[^{}]*\{[^}]*\b(?:width|height|padding|margin|transform):/u.test(styles));
});
test('Start waits for the orphan cleanup and a 409 conflict gets a precise message', async t => {
  let release; const ready = new Promise(resolve => { release = resolve; }); let started = 0;
  const { rail, root } = fixture(t, { ready: () => ready, start: () => { started++; } });
  const starting = rail.start(); await tick();
  assert.equal(started, 0, 'no start request while the previous page call is being ended');
  assert.equal(root.dataset.state, 'connecting'); release(); await starting;
  assert.equal(started, 1); assert.equal(root.dataset.state, 'listening'); await rail.close();
  rail.client.start = async () => { throw Object.assign(new Error('Voice control failed'), { code: 'voice-conflict' }); };
  await rail.start();
  assert.equal(root.querySelector('.voice-state').textContent, en.voiceConflict);
  assert.notEqual(en.voiceConflict, en.voiceConnectionFailed); assert.equal(rail.button('retry').disabled, false);
});
const memoryStorage = () => { const records = new Map();
  return { getItem: k => records.get(k) ?? null, setItem: (k, v) => records.set(k, v), removeItem: k => records.delete(k) }; };
const until = async (predicate, message) => {
  for (let i = 0; i < 300; i++) { if (predicate()) return; await new Promise(resolve => setTimeout(resolve, 10)); }
  assert.fail(message);
};
const sse = events => new Response(new ReadableStream({ start(controller) {
  for (const event of events) controller.enqueue(new TextEncoder().encode(`${event.seq ? `id: ${event.seq}\n` : ''}data: ${JSON.stringify(event)}\n\n`));
} }), { headers: { 'content-type': 'text/event-stream' } });
// Reload a page that had a call. `history` is what the server streams after the page's
// cursor; `record` is the journal the previous page left (older builds also stored pause
// ownership in it).
async function reloadOrphan(t, { record, seq = 5, history = [], channel = true }) {
  const storage = memoryStorage(), nativeFetch = globalThis.fetch, nativeChannel = globalThis.BroadcastChannel, calls = [];
  const session = createSession({ demo: true }); session.paused = true; session.seq = seq;
  session.featureMatrix = { best: { voice: { available: true }, text: { available: true }, analysis: { available: true } } };
  voiceJournal(storage, session.id).save(record);
  const nativeStorage = globalThis.sessionStorage; globalThis.sessionStorage = storage;
  if (!channel) delete globalThis.BroadcastChannel;
  globalThis.fetch = async (url, options = {}) => {
    const after = new Headers(options.headers).get('last-event-id');
    calls.push({ url, body: options.body && JSON.parse(options.body), keepalive: options.keepalive, after });
    if (url.endsWith('/events')) return sse(history.filter(event => !event.seq || event.seq > Number(after)));
    if (url.endsWith('/pause')) return Response.json({ event: { sessionId: session.id, seq: c.session.seq + 1, type: 'session.paused', data: { paused: false } } });
    if (url.endsWith('/close')) return Response.json({ closureConfirmed: true });
    return Response.json(session);
  };
  const c = document.createElement('aithema-session');
  t.after(() => {
    c.remove(); globalThis.fetch = nativeFetch; globalThis.sessionStorage = nativeStorage;
    if (!channel) globalThis.BroadcastChannel = nativeChannel;
  });
  document.body.append(c); c.configure({ copy: en, session });
  await until(() => voiceJournal(storage, session.id).read() === null, 'the journal was not settled');
  for (let i = 0; i < 20; i++) await tick();
  return { c, calls, session, storage };
}
const pauseEvent = (seq, paused) => ({ seq, type: 'session.paused', data: { paused } });
const resumes = calls => calls.filter(call => call.url.endsWith('/pause'));
test('a reload never sends paused:false by itself: it stays paused behind one focused Resume (AIT-116 D4)', async t => {
  const legacy = { callId: 'old-call', providerSessionId: 'old-provider', autoPaused: true, pausedAfter: 4 };
  const probes = {
    'own automatic pause, complete history': { record: legacy, history: [pauseEvent(5, true)] },
    'truncated replay': { record: legacy, seq: 4, history: [pauseEvent(5, true)] },
    'a gap in the event numbers': { record: legacy, seq: 4, history: [pauseEvent(5, true), pauseEvent(7, true)] },
    'missing event numbers': { record: legacy, history: [{ type: 'session.paused', data: { paused: false } }, { type: 'lane.status', data: {} }] },
    // Another tab resumes and pauses by hand meanwhile: its pause is the person's, not a reload prompt.
    'concurrent foreign pause': { record: legacy, seq: 4, history: [pauseEvent(5, true), pauseEvent(6, false), pauseEvent(7, true)], status: en.paused },
    'failed automatic pause, then a foreign manual pause': { record: { ...legacy, pausedAfter: 3 }, history: [pauseEvent(5, true)] },
    'no pause ownership recorded': { record: { callId: 'old-call', providerSessionId: 'old-provider' }, history: [] },
  };
  for (const [name, probe] of Object.entries(probes)) {
    const { c, calls, session } = await reloadOrphan(t, probe);
    const closes = calls.filter(call => call.url.endsWith('/close'));
    assert.deepEqual(closes, [{ url: `/api/sessions/${session.id}/voice/old-call/close`,
      body: { providerSessionId: 'old-provider', reason: 'page-reloaded' }, keepalive: true, after: null }], `${name}: the abandoned call is ended`);
    assert.deepEqual(resumes(calls), [], `${name}: no pause change without the person`);
    assert.equal(c.session.paused, true, `${name}: still paused`);
    const root = c.shadowRoot, resume = root.querySelector('.pause');
    assert.equal(root.querySelector('.status__label').textContent, probe.status ?? en.pausedResume, `${name}: a clear Resume prompt`);
    assert.equal(resume.textContent, en.resume); assert.equal(root.activeElement, resume, `${name}: Resume has focus`);
    c.remove();
  }
  const { c, calls } = await reloadOrphan(t, probes['own automatic pause, complete history']);
  c.shadowRoot.querySelector('.pause').click(); await until(() => !c.session.paused, 'one click resumes');
  assert.deepEqual(resumes(calls).map(call => call.body), [{ paused: false }]);
  c.receive({ seq: c.session.seq + 1, type: 'session.paused', data: { paused: true } });
  assert.equal(c.shadowRoot.querySelector('.status__label').textContent, en.paused, 'the prompt ends with that pause');
});
test('without BroadcastChannel a reload never closes the journaled call; the lease ends it (AIT-116 D4)', async t => {
  const { c, calls, storage, session } = await reloadOrphan(t, { record: { callId: 'old-call', providerSessionId: 'old-provider' }, channel: false });
  assert.deepEqual(calls.filter(call => call.url.endsWith('/close')), [], 'no /close without proof of abandonment');
  assert.equal(voiceJournal(storage, session.id).read(), null);
  assert.equal(c.session.paused, true); assert.deepEqual(resumes(calls), []);
});
test('a sessionStorage that throws on access still mounts device and server conversations; the journal keeps nothing (AIT-116 D4)', async t => {
  // A sandboxed or opaque-origin frame raises SecurityError on the mere property read.
  const descriptor = Object.getOwnPropertyDescriptor(globalThis, 'sessionStorage'), nativeFetch = globalThis.fetch, calls = [];
  Object.defineProperty(globalThis, 'sessionStorage', { configurable: true, get() { throw new window.DOMException('denied', 'SecurityError'); } });
  t.after(() => { Object.defineProperty(globalThis, 'sessionStorage', descriptor); globalThis.fetch = nativeFetch; });
  assert.throws(() => globalThis.sessionStorage, { name: 'SecurityError' });
  const client = { manifest, async start() { return { callId: 'call', providerSessionId: 'provider', events: voiceEvents(),
    async setInput() {}, async setOutput() {}, async sendText() {}, async updateContext() {}, async close() { return { closureConfirmed: true }; } }; } };
  for (const preset of ['device', 'best']) {
    // A confirmed choice: the ready card leaves the call rail usable.
    const session = createSession({ demo: true }); session.processingPreset = preset; session.settings = { ...session.settings, origin: 'chosen' };
    session.featureMatrix = { best: { voice: { available: true }, text: { available: true }, analysis: { available: true } } };
    globalThis.fetch = async (url, options = {}) => {
      calls.push(url);
      if (url.endsWith('/events')) return new Response(new ReadableStream({ start(controller) { options.signal?.addEventListener('abort', () => controller.close(), { once: true }); } }));
      return Response.json(session);
    };
    const c = document.createElement('aithema-session'); document.body.append(c);
    c.configure({ copy: en, session, voiceClient: client });
    const root = c.shadowRoot;
    assert.ok(root.querySelector('.composer textarea') && root.querySelector('.intro').dataset.mode === 'ready', `${preset}: the conversation mounts`);
    if (preset === 'best') {
      // A call starts and ends without storage; a page hide then has no record to close.
      await c.shadowRoot.querySelector('.voice-start').click(); await until(() => root.querySelector('.audio-rail').dataset.state === 'listening', 'the call starts');
      window.dispatchEvent(new window.Event('pagehide')); await tick();
      await root.querySelector('.voice-close').click(); await until(() => root.querySelector('.audio-rail').dataset.state === 'idle', 'the call ends');
    }
    c.remove(); await tick();
  }
  assert.deepEqual(calls.filter(url => url.endsWith('/close')), [], 'without storage the orphan close is skipped');
});
test('Retry after a 409 waits out the remaining lease the server reports, otherwise retries at once', async t => {
  let attempts = 0; const { rail, root } = fixture(t, { start: () => { attempts++; } });
  const conflict = retryAfterMs => Object.assign(new Error('Voice control failed'), { code: 'voice-conflict', retryAfterMs });
  const start = rail.client.start; rail.client.start = async () => { throw conflict(120); };
  await rail.start(); assert.equal(root.querySelector('.voice-state').textContent, en.voiceConflict);
  rail.client.start = start; const clicked = Date.now();
  rail.button('retry').click(); await tick(); assert.equal(root.dataset.state, 'connecting'); assert.equal(attempts, 0, 'Retry waits for the lease');
  await until(() => root.dataset.state === 'listening', 'Retry starts after the lease');
  assert.ok(Date.now() - clicked >= 100); assert.equal(attempts, 1); await rail.close();
  rail.client.start = async () => { throw conflict(undefined); };
  await rail.start(); rail.client.start = start;
  rail.button('retry').click(); await tick(); await tick(); assert.equal(attempts, 2, 'a plain Retry without a reported lease');
});
test('a 409 carries the remaining lease only when the server reports Retry-After', async t => {
  const nativeFetch = globalThis.fetch; t.after(() => { globalThis.fetch = nativeFetch; });
  const { control } = createVoiceControl({ sessionId: 's1' });
  for (const [headers, expected] of [[{ 'retry-after': '7' }, 7000], [{}, undefined]]) {
    globalThis.fetch = async () => Response.json({ error: 'voice-conflict' }, { status: 409, headers });
    await assert.rejects(control.start({ callId: 'c1' }), error => error.code === 'voice-conflict' && error.retryAfterMs === expected);
  }
});
test('a copied journal never ends a call another live tab still drives (AIT-116 D4 cross-tab)', async t => {
  const storage = memoryStorage(), original = globalThis.sessionStorage, nativeFetch = globalThis.fetch, closes = [];
  const session = createSession({ demo: true });
  session.featureMatrix = { best: { voice: { available: true }, text: { available: true }, analysis: { available: true } } };
  globalThis.sessionStorage = storage;
  globalThis.fetch = async url => { closes.push(url); return Response.json({ closureConfirmed: true }); };
  const events = voiceEvents(), driver = document.createElement('aithema-session');
  // configure() tears the rail down, heartbeat included, even when an assertion fails first.
  t.after(() => { events.end(); driver.configure({ copy: en, session: createSession({ demo: true }) }); globalThis.sessionStorage = original; globalThis.fetch = nativeFetch; });
  driver.configure({ copy: en, session, voiceClient: { manifest, async start({ callId }) {
    return { callId, providerSessionId: 'driver-provider', events, async close() { events.end(); return { closureConfirmed: true }; },
      async setInput() {}, async setOutput() {}, async updateContext() {} };
  } } });
  driver.shadowRoot.querySelector('.voice-start').click();
  await until(() => voiceJournal(storage, session.id).read(), 'the driving tab journals its call');
  const copied = memoryStorage(); voiceJournal(copied, session.id).save(voiceJournal(storage, session.id).read());
  // An auxiliary window inherits the opener's sessionStorage, journal included.
  globalThis.sessionStorage = copied;
  const auxiliary = document.createElement('aithema-session'); auxiliary.configure({ copy: en, session });
  t.after(() => auxiliary.remove());
  await until(() => voiceJournal(copied, session.id).read() === null, 'the copy is dropped once the owner answers');
  assert.deepEqual(closes, [], 'no close request for a call another tab drives');
  assert.equal(driver.shadowRoot.querySelector('.audio-rail').dataset.state, 'listening');
  // Once nothing answers for the call, a reload ends it as before.
  globalThis.sessionStorage = storage; await driver.shadowRoot.querySelector('.voice-close').click();
  voiceJournal(storage, session.id).save({ callId: 'gone-call', providerSessionId: 'gone-provider' });
  const reloaded = document.createElement('aithema-session'); reloaded.configure({ copy: en, session });
  await until(() => closes.length === 1, 'an unanswered journal is closed');
  assert.match(closes[0], /voice\/gone-call\/close$/u);
});
test('a hidden page during a pending microphone toggle pauses once the toggle settles (AIT-116 D7)', async t => {
  let release; const journal = voiceJournal(memoryStorage(), 's1');
  const { rail, root } = fixture(t, { journal }); await rail.start();
  rail.session.setInput = () => new Promise(resolve => { release = resolve; });
  rail.button('input').click(); await tick(); assert.equal(rail.busy, true);
  t.mock.method(document, 'hidden', () => true, { getter: true });
  document.dispatchEvent(new window.Event('visibilitychange')); await tick();
  assert.equal(root.dataset.state, 'paused', 'visibility stops media before the pending command completes');
  release(); for (let i = 0; i < 5; i++) await tick();
  assert.equal(root.dataset.state, 'paused', 'the queued visibility pause applies afterwards');
  assert.equal(rail.input, false); assert.ok(journal.read());
  t.mock.restoreAll();
});
test('a hidden page during a pending resume pauses again once the resume is acknowledged (AIT-116 D7)', async t => {
  const { rail, root } = fixture(t); await rail.start(); await rail.pause(true);
  let acknowledge; rail.session.resume = () => new Promise(resolve => { acknowledge = resolve; });
  const resuming = rail.pause(false); await tick(); assert.equal(rail.busy, true); assert.equal(rail.paused, true);
  t.mock.method(document, 'hidden', () => true, { getter: true });
  document.dispatchEvent(new window.Event('visibilitychange')); await tick();
  acknowledge({ acknowledged: true, paused: false }); await resuming; for (let i = 0; i < 5; i++) await tick();
  assert.equal(rail.paused, true, 'a hidden rail never stays listening after the acknowledgement');
  assert.equal(root.dataset.state, 'paused');
  t.mock.restoreAll();
});


test('AIT-136 hiding during recovery keeps pause intent after a failed acknowledgement and reconnect', async t => {
  const { rail, root, events } = fixture(t, { pause: async () => { throw new Error('recovering'); } });
  await rail.start(); events.push({ type: 'recovering', callId: 'local-call' }); await tick();
  t.mock.method(document, 'hidden', () => true, { getter: true });
  const buttons = [...root.querySelectorAll('button')];
  document.dispatchEvent(new window.Event('visibilitychange'));
  assert.equal(root.dataset.state, 'paused');
  await tick(); assert.equal(rail.paused, true);
  events.push({ type: 'recovered', callId: 'local-call' }); await tick();
  assert.equal(root.dataset.state, 'paused'); assert.deepEqual([...root.querySelectorAll('button')], buttons);
  t.mock.restoreAll();
});

test('AIT-136 the rail forwards withdrawal to the adapter instead of draining revoked content', async t => {
  const { rail } = fixture(t); await rail.start();
  let options; rail.session.close = async value => { options = value; return { closureConfirmed: true }; };
  await rail.close('turn-withdrawn'); assert.equal(options.reason, 'turn-withdrawn');
});

test('AIT-136 the persistence port carries generation, HTTP refusal status and cancellation', async t => {
  const delivered = [], requests = [];
  const ports = createVoiceControl({ sessionId: 's1', receive: event => delivered.push(event) });
  const event = { type: 'final', callId: 'c1', providerSessionId: 'generation-a', turnId: 'generation-a:user:1', role: 'user', text: 'hello' };
  t.mock.method(globalThis, 'fetch', async (url, options) => {
    requests.push({ url, options }); return Response.json({ error: 'not-admitted' }, { status: 403 });
  });
  await assert.rejects(ports.persistEvent(event, event), error => error.status === 403 && error.code === 'not-admitted');
  assert.equal(JSON.parse(requests[0].options.body).providerSessionId, 'generation-a');
  const held = Promise.withResolvers(), controller = new AbortController();
  t.mock.method(globalThis, 'fetch', (url, options) => { requests.push({ url, options }); return held.promise; });
  const pending = ports.persistEvent(event, event, { signal: controller.signal });
  const rejected = assert.rejects(pending, { name: 'AbortError' });
  controller.abort(); held.resolve(Response.json({ seq: 1, type: 'turn.final' })); await rejected;
  assert.equal(requests.at(-1).options.signal, controller.signal); assert.deepEqual(delivered, []);
});


test('AIT-136 withdrawal arriving during normal end reaches the already closing adapter', async t => {
  const { rail } = fixture(t); await rail.start();
  const held = Promise.withResolvers(), calls = [];
  rail.session.close = options => { calls.push(options); return held.promise; };
  const closing = rail.close();
  try {
    assert.equal(rail.close('turn-withdrawn'), closing);
    assert.deepEqual(calls.map(options => options.reason), ['closed', 'turn-withdrawn']);
  } finally { held.resolve({ closureConfirmed: true }); await closing; }
});
