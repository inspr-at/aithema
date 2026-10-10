// AIT-128: START's look and journey in the component — entrance with promise and orb, readiness with an
// explicit start, the conversation rail, understanding that appears with the first input, theme and motion.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Window } from 'happy-dom';
import { createSession, applyEvent } from '@inspr/aithema-core';
import { voiceEvents } from '../../core/src/live-voice.js';
import { manifest } from '../../../plugins/elevenlabs/src/manifest.js';
import { en } from '../src/i18n/en.js';
import { de } from '../src/i18n/de.js';
import { styles, palette, themeStyles } from '../src/styles.js';
import { entranceStyles } from '../src/entrance-styles.js';
import { orbStyles } from '../src/orb.js';
import { AudioRail } from '../src/audio-rail.js';
const window = new Window();
for (const key of ['HTMLElement', 'customElements', 'document', 'CustomEvent']) globalThis[key] = window[key];
await import('../src/session-element.js');
test.after(async () => window.happyDOM.close());
const tick = async (n = 3) => { for (let i = 0; i < n; i++) await new Promise(resolve => setImmediate(resolve)); };
const available = { available: true, reason: null }, refused = reason => ({ available: false, reason });

// A conversation whose server acknowledges choices; `voice` counts every start of the voice client.
function journey(t, { copy = en, origin = 'default', matrix = {}, voice = true, consentRequired = false } = {}) {
  const session = createSession({ demo: true, locale: copy === de ? 'de' : 'en' });
  session.settings = { revision: 0, model: 'mock', effort: 'none', voice: 'fake-voice', visuals: 'off', origin, at: null };
  session.engine = { preset: 'best', origin, effort: 'none', model: { id: 'mock', label: 'Mock reasoning', offered: true }, voice: { id: 'fake-voice', label: 'Fake voice', offered: true }, visuals: 'off' };
  session.featureMatrix = { best: { text: available, analysis: available, voice: available }, ...matrix };
  const starts = [], events = voiceEvents(), media = [];
  const client = { manifest, async start({ callId }) {
    starts.push(callId);
    return { callId, providerSessionId: 'provider', events, async setInput() {}, async setOutput() {}, async updateContext() {}, async sendText() {},
      async close() { events.end(); return { closureConfirmed: true }; } };
  } };
  // Nothing may ask for the microphone except the voice client's own start.
  const nativeMedia = Object.getOwnPropertyDescriptor(globalThis.navigator, 'mediaDevices');
  Object.defineProperty(globalThis.navigator, 'mediaDevices', { configurable: true, value: { getUserMedia: async constraints => { media.push(constraints); throw new Error('denied'); } } });
  const original = globalThis.fetch, posts = [];
  globalThis.fetch = async (url, init = {}) => {
    if (String(url).endsWith('/settings') && init.method === 'POST') {
      const body = JSON.parse(init.body); posts.push(body);
      const settings = { ...session.settings, revision: 1, origin: 'chosen', at: new Date().toISOString() };
      return Response.json({ processingPreset: body.processingPreset, settings, engine: session.engine, unchanged: false, featureMatrix: session.featureMatrix,
        event: { sessionId: session.id, seq: c.session.seq + 1, type: 'settings.changed', data: { processingPreset: body.processingPreset, settings } },
        consent: { required: consentRequired, features: consentRequired ? ['text', 'voice'] : [] } });
    }
    if (String(url).endsWith('/events')) return new Response(new ReadableStream({ start(controller) { init.signal?.addEventListener('abort', () => controller.close(), { once: true }); } }));
    return Response.json(c.session);
  };
  const c = document.createElement('aithema-session');
  c.configure({ copy: structuredClone(copy), session, voiceClient: voice ? client : undefined });
  document.body.append(c);
  t.after(async () => {
    c.remove(); await tick(); globalThis.fetch = original;
    if (nativeMedia) Object.defineProperty(globalThis.navigator, 'mediaDevices', nativeMedia); else delete globalThis.navigator.mediaDevices;
  });
  // configure() rebuilds the shadow tree: read the workspace afresh each time.
  const root = c.shadowRoot, workspace = () => root.querySelector('.workspace');
  return { c, root, workspace, starts, media, posts, events, stage: () => workspace().dataset.stage };
}

test('the entrance shows START\'s promise by default in English and German, and the promise slot replaces it', async t => {
  for (const copy of [en, de]) {
    const { root, stage } = journey(t, { copy });
    assert.equal(stage(), 'entrance');
    const slot = root.querySelector('.intro__promise slot[name="promise"]');
    assert.ok(slot, 'a named promise slot');
    assert.deepEqual([...slot.querySelectorAll('.promise span')].map(line => line.textContent), copy.entrance.promise);
    assert.equal(slot.querySelector('.promise__lead').textContent, copy.entrance.lead);
    assert.ok(root.querySelector('.intro__orb .orb'), 'the orb stands with the promise');
    assert.equal(root.querySelectorAll('.chooser-option').length, 4);
  }
  assert.deepEqual(en.entrance.promise, ['Your project.', 'Your process.', 'Optimised with AI.']);
  assert.deepEqual(de.entrance.promise, ['Ihr Projekt.', 'Ihr Prozess.', 'Mit KI optimiert.']);
  const { c, root } = journey(t);
  const headline = document.createElement('h1'); headline.slot = 'promise'; headline.textContent = 'Host promise'; c.append(headline);
  assert.deepEqual(root.querySelector('slot[name="promise"]').assignedElements(), [headline], 'slotted host content is the headline');
});

test('theme: light by default, dark by attribute or system preference unless light is set; START palettes and type, no web fonts', () => {
  assert.match(themeStyles, /^:host \{ color-scheme:light; --aithema-paper:#fbf7ef;/u);
  assert.match(themeStyles, /:host\(\[theme="dark"\]\) \{ color-scheme:dark; --aithema-paper:#0b1a26;/u);
  assert.match(themeStyles, /@media\(prefers-color-scheme:dark\) \{ :host\(:not\(\[theme="light"\]\)\) \{ color-scheme:dark; --aithema-paper:#0b1a26;/u);
  for (const theme of ['light', 'dark']) for (const [name, value] of Object.entries(palette[theme])) assert.ok(themeStyles.includes(`--aithema-${name}:${value};`), `${theme} ${name}`);
  assert.match(styles, /--aithema-display:Georgia,"Iowan Old Style","Palatino Linotype",serif;/u);
  assert.match(styles, /--aithema-radius-sm:10px; --aithema-radius-md:18px; --aithema-radius-lg:28px;/u);
  assert.match(styles, /--aithema-shell-max:1520px;/u);
  for (const css of [styles, entranceStyles, orbStyles]) assert.doesNotMatch(css, /@font-face|@import|url\(https?:/u);
  assert.doesNotMatch(styles + entranceStyles, /font-style:italic/u, 'no italics');
});

test('reduced motion stops every animation and the understanding reveal; the reveal is START\'s 560 ms otherwise', () => {
  assert.match(styles, /transition:grid-template-columns 560ms var\(--aithema-ease\)/u);
  assert.match(styles, /@media\(prefers-reduced-motion:reduce\) \{ \* \{ scroll-behavior:auto; animation:none !important; \} \.workspace, \.understanding, \.fill, \.icon-slash \{ transition:none !important; \} \}/u);
  assert.match(orbStyles, /@media\(prefers-reduced-motion:reduce\) \{ \.orb__layer, \.orb__ring \{ animation:none !important;/u);
  assert.match(entranceStyles, /@media\(prefers-reduced-motion:reduce\) \{ \.chooser-option, [^}]*transition:none; \}/u);
});

test('Continue fires aithema-consent for an uncovered choice; readiness follows and nothing asks for the microphone until the explicit voice start', async t => {
  const j = journey(t, { consentRequired: true }), asked = [];
  j.c.addEventListener('aithema-consent', event => asked.push(event.detail.reason));
  j.root.querySelector('.chooser__continue').click(); await tick(6);
  assert.deepEqual(asked, ['chooser']); assert.equal(j.stage(), 'ready');
  // The host's consent page returns to this conversation: readiness again, still no audio.
  j.c.configure({ copy: structuredClone(en), session: j.c.session, voiceClient: { manifest, async start() { j.starts.push('reconfigured'); throw new Error('unused'); } } });
  await tick(6);
  assert.equal(j.stage(), 'ready');
  const ready = j.root.querySelector('.ready');
  assert.deepEqual([...ready.querySelectorAll('.ready__row')].map(row => row.dataset.ready), ['model', 'consent', 'microphone', 'speaker', 'visuals']);
  // The choice to speak or to type is reversible and starts nothing.
  const mode = name => ready.querySelector(`.ready__mode[data-mode="${name}"]`);
  assert.equal(mode('voice').getAttribute('aria-pressed'), 'true');
  mode('type').click(); await tick();
  assert.equal(mode('type').getAttribute('aria-pressed'), 'true'); assert.equal(ready.querySelector('[data-ready="microphone"]').dataset.state, 'off');
  mode('voice').click(); await tick();
  assert.equal(ready.querySelector('[data-ready="microphone"] dd').textContent, en.ready.checkOnStart);
  assert.deepEqual(j.starts, []); assert.deepEqual(j.media, [], 'no microphone request before the explicit start');
  assert.equal(j.root.querySelector('.audio-rail').inert, true, 'the rail waits');
  j.root.querySelector('.ready__start').click(); await tick(6);
  assert.deepEqual(j.starts, ['reconfigured'], 'the explicit voice start is the only start');
  assert.equal(j.stage(), 'live');
});

test('typing starts the live conversation with focus in the composer; typing during a call still works', async t => {
  const j = journey(t, { origin: 'chosen' });
  assert.equal(j.stage(), 'ready');
  j.root.querySelector('.ready__mode[data-mode="type"]').click(); await tick();
  j.root.querySelector('.ready__start').click(); await tick();
  assert.equal(j.stage(), 'live'); assert.equal(j.root.querySelector('.intro').hidden, true);
  assert.ok(j.root.activeElement === j.root.querySelector('textarea'), 'focus is in the composer');
  assert.deepEqual(j.starts, []); assert.equal(j.root.querySelector('textarea').placeholder, en.placeholder);
  j.root.querySelector('.voice-start').click(); await tick(6);
  assert.equal(j.starts.length, 1); assert.equal(j.root.querySelector('.audio-rail').dataset.call, 'active');
  assert.equal(j.root.querySelector('textarea').placeholder, en.placeholderVoice, 'START: speak, or type');
  assert.equal(j.root.querySelector('textarea').disabled, false, 'the composer stays open during the call');
});

test('voice that this selection cannot offer leaves typing as the only start, with the reason on the voice choice', async t => {
  const j = journey(t, { origin: 'chosen', matrix: { best: { text: available, analysis: available, voice: refused('voice off') } } });
  const voice = j.root.querySelector('.ready__mode[data-mode="voice"]');
  assert.equal(voice.getAttribute('aria-disabled'), 'true'); assert.equal(voice.title, en.reasons['voice off']);
  assert.equal(j.root.querySelector('.ready__mode[data-mode="type"]').getAttribute('aria-pressed'), 'true');
  voice.click(); await tick();
  assert.equal(j.root.querySelector('.ready__mode[data-mode="type"]').getAttribute('aria-pressed'), 'true', 'an unavailable choice cannot be selected');
});

test('understanding is absent before the first input and opens with it', async t => {
  const j = journey(t, { origin: 'chosen' }), aside = j.root.querySelector('.understanding');
  assert.equal(j.workspace().dataset.understanding, 'absent'); assert.equal(aside.inert, true, 'nothing in it can take focus');
  j.c.receive({ seq: j.c.session.seq + 1, type: 'turn.final', data: { id: 'first', role: 'user', content: 'Hello' } });
  assert.equal(j.workspace().dataset.understanding, 'present'); assert.equal(aside.inert, false); assert.equal(j.stage(), 'live');
  assert.equal(aside.hidden, false);
  assert.equal(j.workspace().hasAttribute('data-reveal'), true, 'the opening runs START\'s reveal');
  assert.match(styles, /\.workspace\[data-reveal\] \{ transition:grid-template-columns 560ms/u, 'only the reveal animates the columns');
  await new Promise(resolve => setTimeout(resolve, 750));
  assert.equal(j.workspace().hasAttribute('data-reveal'), false, 'then a resize or theme change moves nothing on its own');
});

test('a reload of a conversation with input opens live with the orb docked in the rail', async t => {
  let session = createSession({ demo: true });
  session = applyEvent(session, { seq: 1, type: 'turn.final', data: { id: 't', role: 'user', content: 'Earlier' } });
  session.featureMatrix = { best: { text: available, analysis: available } };
  const c = document.createElement('aithema-session'); c.configure({ copy: en, session }); t.after(() => c.remove());
  const root = c.shadowRoot;
  assert.equal(root.querySelector('.workspace').dataset.stage, 'live');
  assert.equal(root.querySelector('.workspace').hasAttribute('data-reveal'), false, 'a reload opens the understanding without animating it');
  assert.ok(root.querySelector('.audio-rail .voice-orb .orb'), 'the entrance orb is the voice avatar');
  assert.equal(root.querySelector('.intro__orb .orb'), null);
});

test('rail controls keep accessible names and their states in fixed shared cells', async t => {
  const root = document.createElement('div'); document.body.append(root);
  const events = voiceEvents(), commands = [];
  const session = { callId: 'call', providerSessionId: 'provider', events, async setInput(v) { commands.push(['input', v]); }, async setOutput(v) { commands.push(['output', v]); },
    async updateContext() {}, async pause() { return { acknowledged: true, paused: true }; }, async resume() { return { acknowledged: true, paused: false }; },
    async close() { events.end(); return { closureConfirmed: true }; }, audioLevels: () => ({ input: .3, output: .6 }) };
  const levels = [];
  const rail = new AudioRail({ root, copy: en, client: { manifest, async start() { return session; } }, feature: () => available, context: () => ({}), onLevel: level => levels.push(level) });
  t.after(async () => { await rail.close(); rail.destroy(); root.remove(); });
  const name = button => button.textContent.trim();
  const cell = button => button.closest('.voice-cell');
  assert.equal(cell(rail.button('start')), cell(rail.button('input')), 'Start and the microphone share a cell');
  assert.equal(cell(rail.button('close')), cell(rail.button('retry')), 'End and Retry call share a cell');
  assert.equal(cell(rail.button('output')), cell(rail.button('playback')), 'Sound and Enable sound share a cell');
  assert.equal(root.dataset.call, 'none'); assert.equal(name(rail.button('start')), en.voiceStart);
  for (const button of root.querySelectorAll('button')) {
    assert.ok(name(button), `${button.className} has a name`); assert.equal(button.title, name(button)); assert.ok(button.querySelector('svg[aria-hidden="true"]'));
  }
  await rail.start();
  assert.equal(root.dataset.call, 'active'); assert.equal(root.getAttribute('role'), 'group'); assert.equal(root.getAttribute('aria-label'), en.voiceRail);
  assert.equal(name(rail.button('input')), en.voiceMicOn); assert.equal(rail.button('input').getAttribute('aria-pressed'), 'true');
  rail.button('input').click(); await tick();
  assert.equal(name(rail.button('input')), en.voiceMicOff); assert.equal(rail.button('input').getAttribute('aria-pressed'), 'false');
  rail.button('output').click(); await tick();
  assert.equal(rail.button('output').getAttribute('aria-pressed'), 'false'); assert.deepEqual(commands.slice(-2), [['input', false], ['output', false]]);
  await rail.pause(true); assert.equal(name(rail.button('pause')), en.resume); assert.equal(rail.button('pause').getAttribute('aria-pressed'), 'true');
  rail.reportPlaybackBlocked(); assert.ok(root.hasAttribute('data-playback-blocked')); assert.equal(rail.button('playback').disabled, false);
  assert.equal(root.querySelector('.voice-state').textContent, en.voicePlaybackBlocked);
  await rail.pause(false);
  events.push({ callId: 'call', type: 'speaking' }); await new Promise(resolve => setTimeout(resolve, 200));
  assert.ok(levels.some(level => level === .6), 'the orb follows the audible reply');
  await rail.close(); assert.equal(root.dataset.call, 'none'); assert.equal(levels.at(-1), 0, 'the orb rests after the call');
});

test('under reduced motion the waveform keeps its still baseline', async t => {
  const root = document.createElement('div'); document.body.append(root);
  const events = voiceEvents(), native = window.matchMedia;
  window.matchMedia = query => ({ matches: query.includes('reduce'), addEventListener() {}, removeEventListener() {} });
  const session = { callId: 'call', providerSessionId: 'provider', events, async setInput() {}, async setOutput() {}, async updateContext() {},
    async close() { events.end(); return { closureConfirmed: true }; }, audioLevels: () => ({ input: .5, output: .5 }) };
  const rail = new AudioRail({ root, copy: en, client: { manifest, async start() { return session; } }, feature: () => available, context: () => ({}) });
  t.after(async () => { window.matchMedia = native; await rail.close(); rail.destroy(); root.remove(); });
  let pushed = 0; const push = rail.waveform.push.bind(rail.waveform); rail.waveform.push = (...args) => { pushed++; return push(...args); };
  await rail.start(); await new Promise(resolve => setTimeout(resolve, 200));
  assert.equal(pushed, 0);
});
