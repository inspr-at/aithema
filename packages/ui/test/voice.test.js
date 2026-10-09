import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Window } from 'happy-dom';
import { createSession, inputRevision } from '@inspr/aithema-core';
import { voiceEvents } from '../../core/src/live-voice.js';
import { AudioRail } from '../src/audio-rail.js';
import { en } from '../src/i18n/en.js';
import { manifest } from '../../../plugins/elevenlabs/src/manifest.js';
import { styles } from '../src/styles.js';
const window = new Window();
for (const key of ['HTMLElement', 'customElements', 'document', 'CustomEvent']) globalThis[key] = window[key];
await import('../src/session-element.js');
const tick = () => new Promise(resolve => setImmediate(resolve));

function fixture(t, { pause, unavailable = false } = {}) {
  const root = document.createElement('div'); document.body.append(root);
  const commands = [], events = voiceEvents(), context = { understanding: 'fixture' };
  const session = { callId: 'local-call', providerSessionId: 'local-provider', events,
    async setInput(value) { commands.push(['input', value]); }, async setOutput(value) { commands.push(['output', value]); },
    async sendText(value) { commands.push(['text', value]); }, async updateContext(value) { commands.push(['context', value]); },
    async pause() { return pause ? pause() : { acknowledged: true, paused: true }; },
    async resume() { return { acknowledged: true, paused: false }; },
    async close() { commands.push(['close']); events.end(); return { closureConfirmed: true }; },
  };
  const client = { manifest, async start() { return session; } };
  const rail = new AudioRail({ root, copy: en, client, feature: () => ({ available: !unavailable, reason: 'preset denies voice' }), context: () => context });
  t.after(async () => { await rail.close(); rail.destroy(); root.remove(); });
  return { root, rail, commands, events, context };
}
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
test('pause state changes only after server acknowledgement and focus never resumes it', async t => {
  let acknowledge; const { rail, root } = fixture(t, { pause: () => new Promise(resolve => { acknowledge = resolve; }) });
  await rail.start(); const pending = rail.pause(true);
  assert.equal(root.dataset.state, 'listening'); assert.equal(rail.button('pause').disabled, true);
  acknowledge({ acknowledged: true, paused: true }); await pending; assert.equal(root.dataset.state, 'paused');
  window.dispatchEvent(new window.Event('focus')); await tick(); assert.equal(root.dataset.state, 'paused');
});
test('tab blur pauses an active call; unacknowledged pause has distinct failure copy', async t => {
  const { rail, root } = fixture(t); await rail.start(); window.dispatchEvent(new window.Event('blur')); await tick();
  assert.equal(root.dataset.state, 'paused'); await rail.pause(false);
  rail.session.pause = async () => ({ acknowledged: false, paused: true }); await rail.pause(true);
  assert.equal(root.querySelector('.voice-state').textContent, en.voicePauseFailed); assert.equal(rail.paused, false);
});
test('voice unavailable in preset disables Start with a reason and retains layout', async t => {
  const { rail, root } = fixture(t, { unavailable: true });
  assert.equal(rail.button('start').disabled, true); assert.equal(rail.button('start').title, 'preset denies voice');
  await rail.start(); assert.equal(root.dataset.state, 'idle'); assert.equal(root.querySelectorAll('button').length, 7);
});
test('three failed reconnects expose recovery and typing controls, with distinct terminal and permission messages', async t => {
  const { rail, root, events } = fixture(t); await rail.start();
  events.push({ type: 'ended', callId: 'local-call', reason: 'recovery-failed' }); events.end(); await tick();
  assert.equal(rail.button('retry').disabled, false); assert.equal(root.querySelector('.voice-state').textContent, en.voiceRecoveryFailed);
  rail.failure({ name: 'NotAllowedError' }); assert.equal(rail.error, en.voiceMicDenied);
  rail.failure({ name: 'NotFoundError' }); assert.equal(rail.error, en.voiceMicMissing);
  rail.failure({ code: 'deadline' }); assert.equal(rail.error, en.voiceDeadline);
});
test('blocked SDK playback retries on a real user gesture and clears the message only after success', async t => {
  const { rail, root } = fixture(t); await rail.start(); let tries = 0;
  const audio = document.createElement('audio'); audio.autoplay = true;
  audio.play = async () => { if (++tries === 1) throw new window.DOMException('policy', 'NotAllowedError'); };
  document.body.append(audio); await new Promise(resolve => setTimeout(resolve, 15));
  assert.equal(rail.playbackBlocked, true); assert.equal(root.querySelector('.voice-state').textContent, en.voicePlaybackBlocked);
  rail.button('playback').click(); await tick(); assert.equal(tries, 2); assert.equal(rail.playbackBlocked, false); audio.remove();
});
test('component sends typed text through active voice and updates context when understanding or focus changes', async t => {
  const session = createSession({ demo: true });
  session.featureMatrix = { best: { voice: { available: true }, text: { available: true }, analysis: { available: true } } };
  const commands = [], events = voiceEvents();
  const c = document.createElement('aithema-session');
  c.configure({ copy: en, session, voiceClient: { manifest, async start({ callId }) {
    return { callId, events, async close() { events.end(); return { closureConfirmed: true }; },
      async setInput() {}, async setOutput() {}, async sendText(value) { commands.push(['text', value]); },
      async updateContext(value) { commands.push(['context', value]); } };
  } } });
  t.after(() => c.remove()); const root = c.shadowRoot;
  root.querySelector('.voice-start').click(); await tick();
  root.querySelector('textarea').value = 'typed during voice'; root.querySelector('form').dispatchEvent(new window.Event('submit', { cancelable: true })); await tick();
  assert.ok(commands.some(([name, value]) => name === 'text' && value === 'typed during voice'));
  assert.equal(c.session.transcript.length, 0, 'only provider finals persist the typed echo');
  c.receive({ seq: c.session.seq + 1, type: 'question.focused', data: { question: 'Which systems?' } }); await tick();
  assert.equal(commands.at(-1)[1].focusedQuestion, 'Which systems?');
  c.receive({ seq: c.session.seq + 1, type: 'understanding.updated', data: { ...c.session.understanding, summary: 'New context', inputRevision: inputRevision(c.session) } }); await tick();
  assert.equal(commands.at(-1)[1].understanding.summary, 'New context');
  root.querySelector('.voice-close').click(); await tick();
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
  assert.match(styles, /height:8rem/); assert.match(styles, /grid-template-columns:repeat\(7,minmax\(0,1fr\)\)/);
  assert.ok(!/\.voice-controls[^}]*:hover[^}]*\b(?:width|height|padding|margin|transform):/u.test(styles));
});
