import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Window } from 'happy-dom';
import { applyEvent, createSession, inputRevision, reduceUnderstanding } from '@inspr/aithema-core';
import { en } from '../src/i18n/en.js';
import { de } from '../src/i18n/de.js';
import { AI_NOTICE } from '../../core/src/ai-notice.js';
import { styles, palette } from '../src/styles.js';
import { settingsStyles } from '../src/settings-styles.js';
import { entranceStyles } from '../src/entrance-styles.js';
import { contrast, glassCard, mix, textPairs } from '../../../test/contrast.js';
const window = new Window();
for (const key of ['HTMLElement', 'customElements', 'document', 'CustomEvent']) globalThis[key] = window[key];
await import('../src/session-element.js');
function setup(options = {}) {
  const component = document.createElement('aithema-session');
  const session = createSession({ demo: true });
  session.featureMatrix = { best: { text: { available: true, reason: null }, analysis: { available: true, reason: null } } };
  component.configure({ copy: structuredClone(en), session, ...options });
  return component;
}
function turn(component, id, content) { component.receive({ seq: component.session.seq + 1, type: 'turn.final',
  data: { id, role: 'user', content } }); }
function reply(component, id) { component.receive({ seq: component.session.seq + 1, type: 'turn.final',
  data: { id, role: 'assistant', content: 'Reply', inputRevision: inputRevision(component.session) } }); }
function assertInlineRetry(component, message) {
  const root = component.shadowRoot;
  assert.equal(root.querySelector('.retry').hidden, true, message);
  assert.equal(root.querySelector('.overview-retry').hidden, false, message);
  assert.equal(root.querySelector('.notice').textContent, `${en.understandingFailed}\u00a0· ${en.understandingRetry}`, message);
}
function understanding(component, draft = false) {
  const session = component.session;
  const raw = { summary: '<script>untrusted</script>', signals: ['Known'], openQuestions: ['Deadline?', 'Budget?'],
    constraints: { systems: { value: 'SAP', evidence: 'SAP' } }, progress: { talk: { value: .75 }, build: { value: 1 } } };
  return reduceUnderstanding(session.understanding, raw, { transcript: session.transcript, inputRevision: inputRevision(session), draft });
}
test('host copy, multiline composer, safe transcript bubbles, export and responsive theme surface', () => {
  const c = setup(), root = c.shadowRoot; turn(c, 't1', '<img src=x onerror=alert(1)>\nHello');
  assert.equal(root.querySelector('ol img'), null); assert.match(root.querySelector('ol').textContent, /<img/);
  assert.equal(root.querySelector('textarea').getAttribute('maxlength'), '8000');
  assert.equal(root.querySelector('.export').getAttribute('href'), `/api/sessions/${c.session.id}/export`);
  assert.match(root.querySelector('style').textContent, /min-width:60rem/); assert.match(root.querySelector('style').textContent, /--aithema-accent/);
});
test('readiness/aside uses draft truth, five missing rows plus overflow and preserved clarified expansion', () => {
  const c = setup(), root = c.shadowRoot; turn(c, 't1', 'SAP'); reply(c, 'a1');
  c.receive({ seq: c.session.seq + 1, type: 'understanding.updated', data: understanding(c, true) });
  assert.equal(root.querySelector('.notice').textContent, en.draft); assert.equal(root.querySelector('.scale').getAttribute('aria-valuenow'), '47');
  assert.equal(root.querySelectorAll('.missing li').length, 5); assert.match(root.querySelector('.overflow').textContent, /1 more/);
  const details = root.querySelector('details'); details.open = true;
  c.receive({ seq: c.session.seq + 1, type: 'understanding.updated', data: understanding(c) });
  assert.equal(root.querySelector('details'), details); assert.equal(details.open, true);
  assert.equal(root.querySelector('.summary-text script'), null); assert.equal(root.querySelector('.notice').textContent, en.final);
  root.querySelector('.expand').click(); assert.equal(details.open, false);
  root.querySelector('.expand').click(); assert.equal(details.open, true);
  turn(c, 't2', 'More'); reply(c, 'a2'); assert.equal(root.querySelector('.notice').textContent, en.stale);
});
test('automatic aside and transcript changes render at once under the pointer; rows update in place and append below', () => {
  const c = setup(), root = c.shadowRoot, shell = root.querySelector('.transcript-shell');
  turn(c, 't0', 'First'); const first = root.querySelector('.turn'), withdraw = first.querySelector('.withdraw');
  shell.dispatchEvent(new window.Event('pointerenter'));
  turn(c, 't1', 'SAP'); assert.equal(root.querySelectorAll('.turn').length, 2, 'no deferral while hovered (AIT-116 D2)');
  assert.equal(root.querySelector('.turn'), first, 'existing rows keep their nodes'); assert.equal(first.querySelector('.withdraw'), withdraw);
  assert.equal(root.querySelectorAll('.turn')[1].dataset.id, 't1', 'new turns append below');
  shell.dispatchEvent(new window.Event('pointerleave'));
  root.querySelector('.understanding').dispatchEvent(new window.Event('pointerenter'));
  c.receive({ seq: c.session.seq + 1, type: 'understanding.updated', data: understanding(c) });
  assert.match(root.querySelector('.summary-text').textContent, /untrusted/);
  root.querySelector('.understanding').dispatchEvent(new window.Event('pointerleave'));
  assert.match(root.querySelector('.summary-text').textContent, /untrusted/);
});
test('unsolicited live renders keep focused summaries and keyed aside items in place (AIT-116 focus, D2)', async t => {
  // Focus needs a connected element; the event stream stays open and silent.
  t.mock.method(globalThis, 'fetch', async (url, options = {}) => new Response(new ReadableStream({ start(controller) {
    options.signal?.addEventListener('abort', () => controller.close(), { once: true }); } })));
  const c = setup(), root = c.shadowRoot; document.body.append(c); t.after(() => c.remove());
  turn(c, 't1', 'systems: SAP');
  c.receive({ seq: c.session.seq + 1, type: 'understanding.updated', data: understanding(c) });
  const summary = root.querySelector('.cleared summary'), details = summary.parentNode;
  const questions = [...root.querySelectorAll('.questions li')], missing = [...root.querySelectorAll('.missing li')];
  const features = [...root.querySelectorAll('.features li')];
  summary.focus(); assert.ok(root.activeElement === summary);
  // An unchanged assessment, then one whose first question grew.
  c.receive({ seq: c.session.seq + 1, type: 'understanding.updated', data: understanding(c) });
  assert.ok(root.querySelector('.cleared summary') === summary, 'the summary keeps its node');
  assert.equal(summary.isConnected, true); assert.ok(root.activeElement === summary, 'keyboard focus survives');
  assert.ok([...root.querySelectorAll('.missing li')].every((row, i) => row === missing[i]) && missing.length > 0, 'missing rows keep their nodes');
  const grown = understanding(c); grown.openQuestions = ['Deadline, given the seasonal peak in December and the staff rota?', 'Budget?'];
  c.receive({ seq: c.session.seq + 1, type: 'understanding.updated', data: grown });
  assert.ok(root.activeElement === summary); assert.ok(summary.parentNode === details);
  assert.ok(root.querySelectorAll('.questions li')[1] === questions[1], 'an unchanged item after a grown one keeps its node');
  c.receive({ seq: c.session.seq + 1, type: 'session.paused', data: { paused: true } });
  assert.ok([...root.querySelectorAll('.features li')].every((row, i) => row === features[i]) && features.length > 0, 'feature rows keep their nodes');
  assert.match(root.querySelector('.features').textContent, /Conversation paused/);
});
test('empty aside lists say so quietly once assessed and stay hidden before', () => {
  const c = setup(), root = c.shadowRoot;
  assert.ok([...root.querySelectorAll('.analysis-content section')].every(n => n.hidden), 'nothing to show before the first assessment');
  turn(c, 't1', 'SAP');
  const data = understanding(c); data.openQuestions = []; data.signals = [];
  c.receive({ seq: c.session.seq + 1, type: 'understanding.updated', data });
  assert.ok([...root.querySelectorAll('.analysis-content section')].every(n => !n.hidden));
  assert.equal(root.querySelector('.questions').textContent, en.noneYet); assert.equal(root.querySelector('.signals').textContent, en.noneYet);
});
test('partial assistant turns are replaced by final; stale fragments and duplicate events are ignored', () => {
  const c = setup(); turn(c, 't1', 'Hello'); const revision = inputRevision(c.session);
  c.receive({ type: 'turn.partial', data: { id: 'a', delta: 'first', inputRevision: revision } });
  c.receive({ seq: c.session.seq + 1, type: 'turn.final', data: { id: 'a', role: 'assistant', content: 'final', inputRevision: revision } });
  assert.equal(c.shadowRoot.querySelectorAll('.partial').length, 0);
  const seq = c.session.seq; c.receive({ seq, type: 'turn.final', data: { id: 'a', role: 'assistant', content: 'duplicate' } });
  turn(c, 't2', 'new'); c.receive({ type: 'turn.partial', data: { id: 'stale', delta: 'stale', inputRevision: revision } });
  assert.equal(c.shadowRoot.querySelectorAll('.turn').length, 3); assert.equal(c.shadowRoot.querySelectorAll('.partial').length, 0);
});
test('a settings change that supersedes the reply clears its partial; old-revision fragments never render beside the replacement', () => {
  const c = setup(); turn(c, 't1', 'Hello'); const revision = inputRevision(c.session), partials = () => [...c.shadowRoot.querySelectorAll('.partial')].map(n => n.querySelector('span').textContent);
  const settings = (patch, at = c.session.settings.revision + 1) => c.receive({ seq: c.session.seq + 1, type: 'settings.changed',
    data: { processingPreset: 'best', settings: { ...c.session.settings, ...patch, revision: at, origin: 'chosen', at: new Date(0).toISOString() } } });
  c.receive({ type: 'turn.partial', data: { id: 'old', delta: 'Unfinished old', inputRevision: revision, settingsRevision: 0 } });
  settings({ voice: 'off' });
  c.receive({ type: 'turn.partial', data: { id: 'old', delta: ' answer', inputRevision: revision, settingsRevision: 0 } });
  assert.deepEqual(partials(), ['Unfinished old answer'], 'a change that keeps the model and effort keeps the running reply');
  settings({ model: 'mock/deep', effort: 'high' });
  assert.deepEqual(partials(), [], 'the superseded partial reply is cleared at once');
  c.receive({ type: 'turn.partial', data: { id: 'old', delta: ' late', inputRevision: revision, settingsRevision: 1 } });
  c.receive({ type: 'turn.partial', data: { id: 'new', delta: 'Replacement', inputRevision: revision, settingsRevision: 2 } });
  assert.deepEqual(partials(), ['Replacement'], 'fragments tagged with an older settings revision are ignored');
  c.receive({ seq: c.session.seq + 1, type: 'turn.final', data: { id: 'new', role: 'assistant', content: 'Replacement done', inputRevision: revision } });
  assert.deepEqual(partials(), []);
  assert.deepEqual([...c.shadowRoot.querySelectorAll('.turn')].map(n => n.querySelector('span').textContent), ['Hello', 'Replacement done']);
});
test('keyed rows: a superseded partial loses its node, a restarted reply under its id starts fresh and keeps its node to the final', () => {
  const c = setup(); turn(c, 't1', 'Hello'); const revision = inputRevision(c.session), root = c.shadowRoot;
  c.receive({ type: 'turn.partial', data: { id: 'r', delta: 'Old text', inputRevision: revision, settingsRevision: 0 } });
  const old = root.querySelector('[data-id="r"]');
  c.receive({ seq: c.session.seq + 1, type: 'settings.changed', data: { processingPreset: 'best',
    settings: { ...c.session.settings, model: 'mock/deep', effort: 'high', revision: 1, origin: 'chosen', at: new Date(0).toISOString() } } });
  assert.equal(old.isConnected, false, 'no stale node stays behind');
  assert.equal(root.querySelectorAll('.turn').length, 1);
  c.receive({ type: 'turn.partial', data: { id: 'r', delta: 'New', inputRevision: revision, settingsRevision: 1 } });
  const restarted = root.querySelector('[data-id="r"]');
  assert.notEqual(restarted, old); assert.equal(restarted.querySelector('span').textContent, 'New');
  c.receive({ seq: c.session.seq + 1, type: 'turn.final', data: { id: 'r', role: 'assistant', content: 'New answer', inputRevision: revision,
    engine: { label: 'Deep (mock)', effort: 'high' } } });
  assert.equal(root.querySelector('[data-id="r"]'), restarted, 'the final reply keeps the partial node');
  assert.equal(restarted.className.includes('partial'), false);
  assert.equal(restarted.querySelector('.engine-tag'), null, 'model information appears once in the footer');
  assert.equal(c.session.transcript.at(-1).engine.label, 'Deep (mock)', 'the producer contract stays intact');
  assert.deepEqual([...root.querySelectorAll('.turn')].map(n => n.dataset.id), ['t1', 'r']);
});
const platform = (t, value) => {
  const previous = Object.getOwnPropertyDescriptor(globalThis.navigator, 'platform');
  Object.defineProperty(globalThis.navigator, 'platform', { configurable: true, value });
  t.after(() => { if (previous) Object.defineProperty(globalThis.navigator, 'platform', previous); else delete globalThis.navigator.platform; });
};
test('Enter inserts a newline; the platform shortcut sends; failed acknowledgement retries identical id and bytes', async t => {
  platform(t, 'Linux x86_64');
  const c = setup(), root = c.shadowRoot, input = root.querySelector('textarea'); input.value = 'Hello\nworld';
  const originalFetch = globalThis.fetch, calls = []; let fail = true;
  globalThis.fetch = async (url, options) => {
    calls.push(options.body); if (fail) return new Response(null, { status: 503 });
    return Response.json({ seq: c.session.seq + 1, type: 'turn.final', data: { id: JSON.parse(options.body).clientEventId, role: 'user', content: 'Hello\nworld' } });
  };
  try {
    const enter = new window.KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true }); input.dispatchEvent(enter);
    assert.equal(enter.defaultPrevented, false); assert.equal(calls.length, 0);
    input.dispatchEvent(new window.KeyboardEvent('keydown', { key: 'Enter', ctrlKey: true, bubbles: true, cancelable: true }));
    await new Promise(r => setImmediate(r)); assert.equal(input.value, 'Hello\nworld'); assert.equal(calls.length, 1);
    fail = false; input.dispatchEvent(new window.KeyboardEvent('keydown', { key: 'Enter', ctrlKey: true, bubbles: true, cancelable: true }));
    await new Promise(r => setImmediate(r)); assert.equal(input.value, ''); assert.equal(calls[0], calls[1]);
  } finally { globalThis.fetch = originalFetch; }
});
test('late acknowledgements and events from a previous conversation cannot alter a new session', async () => {
  const c = setup(), oldId = c.session.id, input = c.shadowRoot.querySelector('textarea'); input.value = 'Previous';
  const originalFetch = globalThis.fetch; let release;
  globalThis.fetch = () => new Promise(r => { release = r; });
  try {
    c.shadowRoot.querySelector('form').dispatchEvent(new window.Event('submit', { cancelable: true }));
    const next = createSession({ demo: true }); c.configure({ copy: en, session: next });
    release(Response.json({ sessionId: oldId, seq: 2, type: 'turn.final', data: { id: 'old', role: 'user', content: 'Previous' } }));
    await new Promise(r => setImmediate(r));
    c.receive({ sessionId: oldId, seq: 2, type: 'turn.final', data: { role: 'user', content: 'Other tab' } });
    assert.equal(c.session.id, next.id); assert.equal(c.session.transcript.length, 0);
  } finally { globalThis.fetch = originalFetch; }
});
test('fresh configure after lane failure exposes inline Retry for unfinished understanding or a stuck missing reply', () => {
  const c = setup(); turn(c, 'first', 'First');
  c.receive({ type: 'lane.failed', data: { lane: 'understanding', error: 'reasoning-unavailable' } });
  c.configure({ copy: en, session: c.session });
  assertInlineRetry(c);
  c.receive({ seq: c.session.seq + 1, type: 'understanding.updated', data: understanding(c) });
  c.configure({ copy: en, session: c.session });
  assertInlineRetry(c, 'the latest person turn still has no reply, so Tick requires the inline stuck-state action');
  const session = c.session;
  session.operations = { inputRevision: inputRevision(session), running: ['reaction'], lastFailure: null };
  c.configure({ copy: en, session });
  assert.equal(c.shadowRoot.querySelector('.retry').hidden, true, 'known running work hides Retry');
});
test('fresh configure restores operational failure and draft retry state', () => {
  const c = setup(); turn(c, 'first', 'First');
  c.receive({ seq: c.session.seq + 1, type: 'understanding.updated', data: understanding(c, true) });
  const session = c.session;
  session.operations = { inputRevision: inputRevision(session), running: [], lastFailure: {
    inputRevision: inputRevision(session), lane: 'reaction', error: 'reasoning-unavailable', retryable: true,
  } };
  c.configure({ copy: en, session });
  assert.equal(c.shadowRoot.querySelector('.notice').textContent, en.draft);
  assert.equal(c.shadowRoot.querySelector('.reaction-failure').textContent, en.reasoningFailed);
  assert.equal(c.shadowRoot.textContent.split(en.reasoningFailed).length - 1, 1);
  assert.equal(c.shadowRoot.querySelector('.retry').hidden, false);
});
test('an SSE cursor rejected with 400 restores the snapshot and reconnects with its cursor', async () => {
  const c = setup(), originalFetch = globalThis.fetch, calls = [], restored = createSession({ demo: true });
  restored.id = c.session.id; restored.seq = 1;
  const outdated = c.session; outdated.seq = 99; c.configure({ copy: en, session: outdated });
  globalThis.fetch = async (url, options) => {
    calls.push({ url, cursor: options?.headers?.['Last-Event-ID'] });
    if (!url.endsWith('/events')) return Response.json(restored);
    if (calls.length === 1) return Response.json({ error: 'invalid-cursor' }, { status: 400 });
    return new Response(new ReadableStream({ start(controller) {
      options.signal.addEventListener('abort', () => controller.close(), { once: true });
    } }), { headers: { 'content-type': 'text/event-stream' } });
  };
  try {
    document.body.append(c); await new Promise(r => setImmediate(r));
    assert.deepEqual(calls.map(r => r.cursor), ['99', undefined, '1']);
    assert.equal(c.session.seq, 1);
  } finally { c.remove(); await new Promise(r => setImmediate(r)); globalThis.fetch = originalFetch; }
});
test('AIT-109 N2: Retry stays hidden while anonymous understanding is deferred', () => {
  const c = setup(), session = c.session;
  session.demo = false; c.configure({ copy: en, session });
  for (let i = 1; i <= 2; i++) {
    turn(c, `person-${i}`, `Message ${i}`);
    c.receive({ seq: c.session.seq + 1, type: 'turn.final', data: { id: `reply-${i}`, role: 'assistant', content: 'Reply',
      inputRevision: inputRevision(c.session) } });
    assert.equal(c.shadowRoot.querySelector('.retry').hidden, true, 'waiting for the turn threshold is not a failure');
  }
  turn(c, 'person-3', 'Third message');
  c.receive({ type: 'lane.status', data: { inputRevision: inputRevision(c.session), running: [], lastFailure: null } });
  assertInlineRetry(c, 'missing reply is a stuck state with inline retry');
  const identified = setup(), identifiedSession = identified.session;
  identifiedSession.demo = false; identifiedSession.identified = true;
  identified.configure({ copy: en, session: identifiedSession }); turn(identified, 'identified', 'First');
  identified.receive({ type: 'lane.status', data: { inputRevision: inputRevision(identified.session), running: [], lastFailure: null } });
  assertInlineRetry(identified, 'identified people bypass the threshold; missing reply uses inline retry');
});

test('AIT-109 N3: failed snapshot recovery waits one second before reconnecting', async t => {
  const c = setup(), calls = [];
  t.mock.timers.enable({ apis: ['setTimeout'] });
  t.mock.method(globalThis, 'fetch', async (url, options = {}) => {
    calls.push(url);
    if (!url.endsWith('/events')) return new Response(null, { status: 503 });
    if (calls.length === 1) return new Response(null, { status: 400 });
    return new Response(new ReadableStream({ start(controller) {
      options.signal.addEventListener('abort', () => controller.close(), { once: true });
    } }));
  });
  try {
    document.body.append(c); await new Promise(resolve => setImmediate(resolve));
    assert.equal(calls.length, 2, 'a failed restore must not reconnect immediately');
    t.mock.timers.tick(999); await new Promise(resolve => setImmediate(resolve)); assert.equal(calls.length, 2);
    t.mock.timers.tick(1); await new Promise(resolve => setImmediate(resolve)); assert.equal(calls.length, 3);
    assert.equal(c.shadowRoot.querySelector('.status__label').textContent, en.connected);
  } finally { c.remove(); await new Promise(resolve => setImmediate(resolve)); }
});

test('AIT-109 N3: removing the page cancels the failed-restore reconnect delay', async t => {
  const c = setup(), calls = [];
  t.mock.timers.enable({ apis: ['setTimeout'] });
  t.mock.method(globalThis, 'fetch', async (url, options = {}) => {
    calls.push(url);
    if (!url.endsWith('/events')) return new Response(null, { status: 503 });
    if (calls.length === 1) return new Response(null, { status: 400 });
    return new Response(new ReadableStream({ start(controller) {
      options.signal.addEventListener('abort', () => controller.close(), { once: true });
    } }));
  });
  try {
    document.body.append(c); await new Promise(resolve => setImmediate(resolve));
    c.remove(); await new Promise(resolve => setImmediate(resolve));
    t.mock.timers.tick(1000); await new Promise(resolve => setImmediate(resolve));
    assert.equal(calls.length, 2, 'no reconnect after disconnection');
  } finally { c.remove(); }
});

test('AIT-109 L5: dropped SSE resumes its cursor, ignores replay, and restores a sequence gap', async t => {
  const c = setup(), cursors = [], encoder = new TextEncoder();
  const first = { sessionId: c.session.id, seq: 1, type: 'turn.final', data: { id: 'first', role: 'user', content: 'über' } };
  const second = { ...first, seq: 2, data: { id: 'second', role: 'user', content: 'second' } };
  const missing = { ...first, seq: 3, data: { id: 'missing', role: 'user', content: 'restored' } };
  const gap = { ...first, seq: 4, data: { id: 'reply', role: 'assistant', content: 'restored reply' } };
  const restored = [first, second, missing, gap].reduce(applyEvent, c.session);
  let snapshots = 0;
  const frame = event => encoder.encode(`id: ${event.seq}\nevent: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`);
  t.mock.timers.enable({ apis: ['setTimeout'] });
  t.mock.method(globalThis, 'fetch', async (url, options = {}) => {
    if (!url.endsWith('/events')) { snapshots++; return Response.json(restored); }
    cursors.push(options.headers['Last-Event-ID']);
    return new Response(new ReadableStream({ start(controller) {
      if (cursors.length === 1) {
        const bytes = frame(first), split = bytes.indexOf(0xc3) + 1;
        controller.enqueue(bytes.slice(0, split)); controller.enqueue(bytes.slice(split)); controller.close();
      } else {
        options.signal.addEventListener('abort', () => controller.close(), { once: true });
        if (cursors.length === 2) {
          for (const event of [first, second, gap]) controller.enqueue(frame(event));
        }
      }
    } }));
  });
  try {
    document.body.append(c); await new Promise(resolve => setImmediate(resolve));
    assert.deepEqual(cursors, ['0']); assert.equal(c.session.transcript[0].content, 'über');
    t.mock.timers.tick(999); await new Promise(resolve => setImmediate(resolve)); assert.deepEqual(cursors, ['0']);
    t.mock.timers.tick(1); await new Promise(resolve => setImmediate(resolve));
    assert.deepEqual(cursors, ['0', '1', '4']); assert.ok(snapshots >= 1);
    assert.equal(c.session.seq, 4);
    assert.deepEqual(c.session.transcript.map(turn => turn.id), ['first', 'second', 'missing', 'reply']);
    assert.match(c.shadowRoot.querySelector('ol').textContent, /restored reply/u);
  } finally { c.remove(); await new Promise(resolve => setImmediate(resolve)); }
});
test('pause state changes only after server acknowledgement; a failed resume preserves pause', async () => {
  const c = setup({ voiceClient: {} }), original = globalThis.fetch; let release;
  globalThis.fetch = () => new Promise(r => { release = r; });
  try {
    const button = c.shadowRoot.querySelector('.pause'); assert.ok(button);
    button.click(); assert.equal(c.session.paused, false); assert.equal(button.disabled, true);
    release(Response.json({ paused: true, event: { seq: 1, type: 'session.paused', data: { paused: true } } }));
    await new Promise(r => setImmediate(r));
    assert.equal(c.session.paused, true); assert.equal(button.textContent, en.resume);
    button.click(); release(new Response(null, { status: 500 })); await new Promise(r => setImmediate(r));
    assert.equal(c.session.paused, true);
  } finally { globalThis.fetch = original; }
});
test('withdraw a stable statement id and clear visible projections even while hovered', async () => {
  const c = setup(), root = c.shadowRoot, original = globalThis.fetch; let body;
  turn(c, 'stable-turn', 'SAP');
  c.receive({ seq: c.session.seq + 1, type: 'understanding.updated', data: understanding(c) });
  root.querySelector('.understanding').dispatchEvent(new window.Event('pointerenter'));
  globalThis.fetch = async (url, init) => {
    assert.ok(url.endsWith('/withdraw')); body = JSON.parse(init.body);
    return Response.json({ event: { seq: c.session.seq + 1, type: 'turn.withdrawn', data: { turnId: 'stable-turn' } } });
  };
  try {
    const button = root.querySelector('.withdraw'); assert.ok(button); button.click();
    await new Promise(r => setImmediate(r)); assert.deepEqual(body, { turnId: 'stable-turn' });
    assert.equal(root.querySelector('ol').textContent.includes('SAP'), false);
    assert.equal(root.querySelector('.summary-text').textContent, '');
    assert.equal(c.session.transcript[0].erased, true);
  } finally { globalThis.fetch = original; }
});
test('a withdrawal acknowledgement with an SSE gap clears visible content before snapshot recovery', async () => {
  const c = setup(), root = c.shadowRoot, original = globalThis.fetch; let release;
  turn(c, 't', 'SAP'); c.receive({ seq: c.session.seq + 1, type: 'understanding.updated', data: understanding(c) });
  root.querySelector('.transcript-shell').dispatchEvent(new window.Event('pointerenter'));
  root.querySelector('.understanding').dispatchEvent(new window.Event('pointerenter'));
  globalThis.fetch = () => new Promise(r => { release = r; });
  try {
    c.receive({ seq: c.session.seq + 2, type: 'turn.withdrawn', data: { turnId: 't' } });
    assert.equal(root.querySelector('ol').textContent.includes('SAP'), false);
    assert.equal(root.querySelector('.summary-text').textContent, '');
  } finally { release(Response.json(c.session)); await new Promise(r => setImmediate(r)); globalThis.fetch = original; }
});
test.after(async () => window.happyDOM.close());

test('the engine panel keeps its fixed size, renders snapshot feature updates at once under the pointer and offers settings', async () => {
  const c = setup();
  const session = c.session;
  session.featureMatrix.best.analysis = { available: false, reason: 'binding evidence expired' };
  c.configure({ copy: en, session });
  const root = c.shadowRoot;
  assert.equal(root.querySelector('.engine__value').textContent, 'Best models');
  assert.equal(root.querySelector('.toolbar .preset-panel'), null);
  assert.ok(root.querySelector('.display-foot .engine__value'));
  assert.equal(root.querySelector('.settings-open').getAttribute('aria-haspopup'), 'dialog');
  assert.equal(root.querySelector('.preset-choice'), null, 'presets change through acknowledged settings, never a raw select');
  const expired = en.reasons['binding evidence expired'];
  assert.ok(root.querySelector('.features').textContent.includes(expired), 'machine reasons show in the page language');
  assert.ok(!root.querySelector('.features li').classList.contains('unavailable'));
  root.querySelector('.preset-panel').dispatchEvent(new window.Event('pointerenter'));
  const originalFetch = globalThis.fetch;
  const next = c.session; next.featureMatrix.best = {};
  globalThis.fetch = async () => Response.json(next);
  try {
    c.receive({ seq: c.session.seq + 2, type: 'turn.final', data: {} });
    await new Promise(r => setImmediate(r));
    assert.ok(!root.querySelector('.features').textContent.includes(expired), 'snapshot features render at once under the pointer');
    root.querySelector('.preset-panel').dispatchEvent(new window.Event('pointerleave'));
  } finally { globalThis.fetch = originalFetch; }
  // START has no processing band: the processing line sits quietly in the top row, the features stay readable to assistive technology.
  assert.ok(root.querySelector('.display-foot').contains(root.querySelector('.preset-panel')));
});

test('an acknowledged switch to EU gates the composer and analysis with their exact reasons and prevents posts', async () => {
  const c = setup(); turn(c, 'first', 'Hello');
  assert.equal(c.shadowRoot.querySelector('textarea').disabled, false);
  c.receive({ type: 'lane.status', data: { inputRevision: inputRevision(c.session), running: [], lastFailure: null } });
  assertInlineRetry(c);
  const session = c.session;
  session.featureMatrix.eu = { text: { available: false, reason: 'not configured' }, analysis: { available: false, reason: 'consent required' } };
  c.configure({ copy: en, session });
  c.receive({ seq: c.session.seq + 1, type: 'settings.changed', data: { processingPreset: 'eu',
    settings: { ...session.settings, revision: 1, origin: 'chosen', at: new Date().toISOString() } } });
  const root = c.shadowRoot;
  assert.equal(c.session.processingPreset, 'eu'); assert.equal(root.querySelector('.engine__value').textContent, 'In the EU');
  assert.equal(root.querySelector('textarea').disabled, true);
  assert.equal(root.querySelector('.send').disabled, true);
  assert.match(root.querySelector('.composer').textContent, /Not configured/);
  assert.equal(root.querySelector('.understanding').getAttribute('aria-disabled'), 'true');
  assert.equal(root.querySelector('.notice').textContent, 'consent required');
  assert.equal(root.querySelector('.readiness').style.visibility, 'hidden');
  assert.ok([...root.querySelectorAll('.analysis-content section')].every(n => n.hidden));
  assert.equal(root.querySelector('.retry').hidden, true);
  const originalFetch = globalThis.fetch; let posts = 0;
  globalThis.fetch = async () => { posts++; return new Response(null, { status: 503 }); };
  try {
    root.querySelector('textarea').value = 'Blocked';
    root.querySelector('form').dispatchEvent(new window.Event('submit', { cancelable: true }));
    root.querySelector('.retry').dispatchEvent(new window.Event('click'));
    await new Promise(r => setImmediate(r)); assert.equal(posts, 0);
  } finally { globalThis.fetch = originalFetch; }
});

test('composer gates update immediately while hovered and the aside stays in place across a restored snapshot', async () => {
  const c = setup(); turn(c, 'first', 'Hello');
  const root = c.shadowRoot, composer = root.querySelector('.composer'), send = root.querySelector('.send'), aside = root.querySelector('.understanding');
  composer.dispatchEvent(new window.Event('pointerenter')); aside.dispatchEvent(new window.Event('pointerenter'));
  const next = c.session;
  next.featureMatrix.best = { text: { available: false, reason: 'session paused' }, analysis: { available: false, reason: 'session paused' } };
  const originalFetch = globalThis.fetch; globalThis.fetch = async () => Response.json(next);
  try {
    c.receive({ seq: c.session.seq + 2, type: 'turn.final', data: {} });
    await new Promise(r => setImmediate(r));
    assert.equal(root.querySelector('.send'), send); assert.equal(root.querySelector('.understanding'), aside);
    assert.equal(send.disabled, true, 'fixed composer controls update while hovered');
    assert.equal(root.querySelector('textarea').disabled, true);
    assert.equal(root.querySelector('.composer-reason').textContent, en.reasons['session paused']);
    assert.equal(root.querySelector('.composer-reason').title, en.reasons['session paused']);
    assert.equal(root.querySelector('.retry').hidden, true, 'the aside renders at once under the pointer');
    composer.dispatchEvent(new window.Event('pointerleave')); aside.dispatchEvent(new window.Event('pointerleave'));
    assert.equal(send.disabled, true); assert.equal(root.querySelector('.retry').hidden, true);
    assert.equal(aside.hidden, false, 'fixed aside remains in the layout');
  } finally { globalThis.fetch = originalFetch; }
});

for (const preset of ['best', 'device']) for (const trigger of ['click', 'ctrlKey', 'metaKey']) {
  test(`hovered ${preset} composer permits consecutive sends using ${trigger} and blocks overlapping sends`, async t => {
    platform(t, trigger === 'metaKey' ? 'MacIntel' : 'Linux x86_64');
    const c = setup(), originalFetch = globalThis.fetch; let calls = 0, release;
    const held = () => new Promise(resolve => { release = resolve; });
    const device = { async connect() { calls++; await held(); }, async *stream() { yield 'Local answer'; } };
    if (preset === 'device') c.configure({ copy: en, session: createSession({ processingPreset: 'device' }), deviceReasoning: device });
    const root = c.shadowRoot, input = root.querySelector('textarea'), send = root.querySelector('.send');
    globalThis.fetch = async (url, options) => {
      if (url.endsWith('/events')) return new Response(new ReadableStream({ start(controller) {
        options.signal.addEventListener('abort', () => controller.close(), { once: true });
      } }), { headers: { 'content-type': 'text/event-stream' } });
      calls++; await held();
      const body = JSON.parse(options.body);
      return Response.json({ seq: c.session.seq + 1, type: 'turn.final', data: { id: body.clientEventId, role: 'user', content: body.content } });
    };
    const submit = () => trigger === 'click' ? send.click()
      : input.dispatchEvent(new window.KeyboardEvent('keydown', { key: 'Enter', [trigger]: true, bubbles: true, cancelable: true }));
    root.querySelector('.composer').dispatchEvent(new window.Event('pointerenter'));
    try {
      document.body.append(c);
      for (const content of ['First', 'Second']) {
        input.value = content; submit();
        assert.equal(calls, content === 'First' ? 1 : 2);
        assert.equal(send.disabled, true, 'pending send disables the button immediately');
        send.click();
        input.dispatchEvent(new window.KeyboardEvent('keydown', { key: 'Enter', ctrlKey: true }));
        input.dispatchEvent(new window.KeyboardEvent('keydown', { key: 'Enter', metaKey: true }));
        assert.equal(calls, content === 'First' ? 1 : 2, 'sending guard prevents overlapping dispatch');
        release(); await new Promise(resolve => setImmediate(resolve));
        assert.equal(send.disabled, false, 'completion re-enables Send without leaving the composer');
        assert.equal(input.value, '');
      }
      assert.deepEqual(c.session.transcript.filter(t => t.role === 'user').map(t => t.content), ['First', 'Second']);
    } finally { release?.(); c.remove(); await new Promise(resolve => setImmediate(resolve)); globalThis.fetch = originalFetch; }
  });
}

test('shortcut send uses sending and feature state even when the button has a stale disabled value', async t => {
  platform(t, 'MacIntel');
  const c = setup(), root = c.shadowRoot, originalFetch = globalThis.fetch; let calls = 0;
  globalThis.fetch = async (_, options) => {
    calls++; const body = JSON.parse(options.body);
    return Response.json({ seq: c.session.seq + 1, type: 'turn.final', data: { id: body.clientEventId, role: 'user', content: body.content } });
  };
  try {
    root.querySelector('.send').disabled = true;
    root.querySelector('textarea').value = 'Allowed';
    root.querySelector('textarea').dispatchEvent(new window.KeyboardEvent('keydown', { key: 'Enter', metaKey: true }));
    await new Promise(resolve => setImmediate(resolve)); assert.equal(calls, 1);
  } finally { globalThis.fetch = originalFetch; }
});

test('unsupported features.updated events cannot mutate snapshot feature verdicts', () => {
  const c = setup(), matrix = c.session.featureMatrix;
  c.receive({ type: 'features.updated', data: { best: {} } });
  assert.deepEqual(c.session.featureMatrix, matrix);
});

test('preset, feature and device copy comes from the host', async () => {
  const c = setup(), copy = { ...en, processing: 'Verarbeitung',
    presets: { best: 'Optimal', eu: 'Europa', device: 'Lokal', custom: 'Eigene' },
    features: { text: 'Text lokal', analysis: 'Analyse', voice: 'Stimme', transcription: 'Transkript', images: 'Bilder' },
    deviceExportUnavailable: 'Kein lokaler Export', deviceConnectFirst: 'Modell verbinden',
    deviceConversation: 'Bleibt im Tab', deviceUnavailable: 'Modell fehlt', settings: { ...en.settings, open: 'Einstellungen' } };
  c.configure({ copy, session: createSession({ processingPreset: 'device' }) });
  let root = c.shadowRoot;
  assert.equal(root.querySelector('.engine__label'), null);
  assert.equal(root.querySelector('.engine__value').textContent, 'Lokal');
  assert.equal(root.querySelector('.settings-open').textContent, 'Einstellungen');
  assert.deepEqual([...root.querySelectorAll('.chooser-option strong')].map(n => n.textContent), ['Optimal', 'Europa', 'Lokal', 'Eigene']);
  const originalFetch = globalThis.fetch; globalThis.fetch = async () => new Response(null, { status: 503 });
  try {
    c.openSettings(); await new Promise(r => setImmediate(r));
    assert.deepEqual([...root.querySelectorAll('.preset-option .preset-name')].map(n => n.textContent), ['Optimal', 'Europa', 'Lokal', 'Eigene']);
    root.querySelector('dialog.settings .done').click(); await new Promise(r => setImmediate(r));
  } finally { globalThis.fetch = originalFetch; }
  assert.match(root.querySelector('.features').textContent, /Text lokal/);
  assert.equal(root.querySelector('.export').title, copy.deviceExportUnavailable);
  root.querySelector('textarea').value = 'Hello'; root.querySelector('form').dispatchEvent(new window.Event('submit'));
  await new Promise(r => setImmediate(r)); assert.equal(root.querySelector('.status__label').textContent, copy.deviceConnectFirst);
  const device = { async connect() {}, async *stream() { yield 'Hi'; } };
  c.configure({ copy, session: createSession({ processingPreset: 'device' }), deviceReasoning: device });
  root = c.shadowRoot; root.querySelector('textarea').value = 'Hello'; root.querySelector('form').dispatchEvent(new window.Event('submit'));
  await new Promise(r => setImmediate(r)); assert.equal(root.querySelector('.status__label').textContent, copy.deviceConversation);
  c.configure({ copy, session: createSession({ processingPreset: 'device' }), deviceReasoning: { async connect() { throw new Error(); } } });
  root = c.shadowRoot; root.querySelector('textarea').value = 'Hello'; root.querySelector('form').dispatchEvent(new window.Event('submit'));
  await new Promise(r => setImmediate(r)); assert.equal(root.querySelector('.status__label').textContent, copy.deviceUnavailable);
});
test('device sends text in this tab only; browser configure/disconnect aborts local work', async () => {
  const c = setup(), originalFetch = globalThis.fetch; let calls = 0, signal;
  const device = { async connect(options) { signal = options.signal; }, async *stream() { yield 'Local answer'; } };
  globalThis.fetch = async () => { calls++; throw new Error('No server call permitted'); };
  try {
    c.configure({ copy: en, session: createSession({ processingPreset: 'device' }), deviceReasoning: device });
    document.body.append(c);
    const input = c.shadowRoot.querySelector('textarea'); input.value = 'Local question';
    c.shadowRoot.querySelector('form').dispatchEvent(new window.Event('submit', { cancelable: true }));
    await new Promise(r => setImmediate(r));
    assert.equal(calls, 0); assert.deepEqual(c.session.transcript.map(t => t.content), ['Local question', 'Local answer']);
    assert.ok(c.session.transcript.every(t => !Object.hasOwn(t, 'at')), 'device turns keep their original fields');
    assert.equal(c.shadowRoot.querySelector('.retry').hidden, true);
    assert.equal(c.shadowRoot.querySelector('.export').getAttribute('aria-disabled'), 'true');
    assert.equal(c.shadowRoot.querySelector('.export').hasAttribute('href'), false);
    assert.ok(c.shadowRoot.querySelector('.features').textContent.includes(en.reasons['unavailable on device']));
    c.remove(); assert.equal(signal.aborted, true);
  } finally { c.remove(); globalThis.fetch = originalFetch; }
});

test('pause and consent gate sends and preset rows immediately while cached understanding stays visible', async () => {
  const c = setup({ voiceClient: {} }), root = c.shadowRoot;
  turn(c, 'input', 'systems: SAP');
  c.receive({ seq: c.session.seq + 1, type: 'understanding.updated', data: understanding(c) });
  const send = root.querySelector('.send'), pause = root.querySelector('.pause'), preset = root.querySelector('.preset-panel');
  preset.dispatchEvent(new window.Event('pointerenter'));
  c.receive({ seq: c.session.seq + 1, type: 'session.paused', data: { paused: true } });
  assert.equal(send.disabled, true); assert.equal(pause.textContent, en.resume);
  assert.match(root.querySelector('.features').textContent, /Conversation paused/);
  assert.equal(root.querySelector('.status__label').textContent, en.connectionLabels.connecting, 'the status line keeps its connection state during pause');
  assert.equal(root.querySelector('.summary-text').textContent.includes('untrusted'), true);
  assert.equal(root.querySelector('.readiness').style.visibility, '');
  assert.ok([...root.querySelectorAll('.analysis-content section')].every(node => !node.hidden));
  preset.dispatchEvent(new window.Event('pointerleave'));
  assert.match(root.querySelector('.features').textContent, /Conversation paused/);
  root.querySelector('.transcript-shell').dispatchEvent(new window.Event('pointerenter'));
  root.querySelector('.understanding').dispatchEvent(new window.Event('pointerenter'));
  c.receive({ seq: c.session.seq + 1, type: 'consent.revised', data: { granted: false } });
  assert.equal(send.disabled, true); assert.equal(root.querySelector('.summary-text').textContent, '');
  assert.equal(root.querySelector('.send'), send); assert.equal(root.querySelector('.pause'), pause);
  // The one pause lives in the rail's fixed 44 px cell (START's single capsule), so its label can change without moving it.
  assert.ok(root.querySelector('.audio-rail .voice-cell--pause').contains(pause));
  assert.match(root.querySelector('style').textContent, /\.audio-rail button \{[^}]*width:44px; height:44px;/u);
});

test('an old snapshot cannot undo acknowledged pause during recovery', async () => {
  const c = setup(), beforePause = c.session, original = globalThis.fetch;
  let release;
  globalThis.fetch = () => new Promise(resolve => { release = resolve; });
  try {
    c.receive({ seq: c.session.seq + 2, type: 'turn.final', data: {} });
    c.receive({ seq: c.session.seq + 1, type: 'session.paused', data: { paused: true } });
    release(Response.json(beforePause)); await new Promise(resolve => setImmediate(resolve));
    assert.equal(c.session.paused, true);
    assert.equal(c.shadowRoot.querySelector('textarea').disabled, true);
    assert.equal(c.shadowRoot.querySelector('.send').disabled, false);
    assert.equal(c.shadowRoot.querySelector('.send').getAttribute('aria-label'), en.resume);
    assert.equal(c.shadowRoot.querySelector('.composer-paused').hidden, false);
  } finally { globalThis.fetch = original; }
});

test('device withdrawal aborts the local stream, redacts without moving hovered targets and excludes input on the next send', async () => {
  const c = setup(), originalFetch = globalThis.fetch, inputs = [];
  let calls = 0, signal, release;
  const held = new Promise(resolve => { release = resolve; });
  const device = { async connect() {}, async *stream(input, options) {
    inputs.push(input); signal = options.signal;
    if (inputs.length === 1) { yield 'Local private answer'; await held; yield 'Late private answer'; }
    else yield 'New local answer';
  } };
  globalThis.fetch = async () => { calls++; return new Response(null, { status: 404 }); };
  try {
    c.configure({ copy: en, session: createSession({ processingPreset: 'device' }), deviceReasoning: device });
    document.body.append(c);
    const root = c.shadowRoot, input = root.querySelector('textarea'), send = root.querySelector('.send');
    input.value = 'Withdraw this local statement';
    root.querySelector('form').dispatchEvent(new window.Event('submit', { cancelable: true }));
    await new Promise(resolve => setImmediate(resolve));
    const shell = root.querySelector('.transcript-shell'), list = root.querySelector('ol');
    const row = list.querySelector('.user'), button = row.querySelector('.withdraw'), partial = list.querySelector('.partial');
    row.getBoundingClientRect = () => ({ height: 96 }); partial.getBoundingClientRect = () => ({ height: 48 });
    shell.scrollTop = 17; shell.dispatchEvent(new window.Event('pointerenter'));
    root.querySelector('.understanding').dispatchEvent(new window.Event('pointerenter'));
    button.click(); await new Promise(resolve => setImmediate(resolve));
    assert.equal(signal.aborted, true);
    assert.equal(c.session.transcript[0].erased, true);
    assert.equal(list.textContent.includes('Withdraw this local statement'), false);
    assert.equal(list.textContent.includes('Local private answer'), false);
    assert.ok(list.querySelector('.user') === row, 'the hovered row keeps its node'); assert.ok(button.isConnected === false, 'a withdrawn statement has no withdraw action');
    assert.equal(row.style.minHeight, '96px'); assert.equal(partial.style.minHeight, '48px');
    assert.equal(shell.scrollTop, 17); assert.equal(root.querySelector('.send'), send);
    release(); await new Promise(resolve => setImmediate(resolve));
    assert.equal(list.textContent.includes('Late private answer'), false);
    shell.dispatchEvent(new window.Event('pointerleave'));
    assert.equal(root.querySelectorAll('.withdraw').length, 0);
    assert.equal(root.querySelectorAll('.partial').length, 0);
    input.value = 'Keep this new statement';
    root.querySelector('form').dispatchEvent(new window.Event('submit', { cancelable: true }));
    await new Promise(resolve => setImmediate(resolve));
    assert.deepEqual(inputs[1].messages, [{ role: 'user', content: 'Keep this new statement' }]);
    assert.equal(calls, 0, 'device withdrawal stays in this tab, including feature refresh');
  } finally { release(); c.remove(); await new Promise(resolve => setImmediate(resolve)); globalThis.fetch = originalFetch; }
});

test('configure sends session ownership on SSE, recovery, feature refresh and every control POST', async () => {
  const c = setup({ voiceClient: {} }), originalFetch = globalThis.fetch, calls = [];
  const session = c.session, sessionToken = 'header-owner-fixture';
  globalThis.fetch = async (url, options = {}) => {
    calls.push({ url, headers: new Headers(options.headers) });
    if (url.endsWith('/events')) return new Response(new ReadableStream({ start(controller) {
      options.signal.addEventListener('abort', () => controller.close(), { once: true });
    } }));
    const body = options.body ? JSON.parse(options.body) : {};
    const event = (type, data) => ({ seq: c.session.seq + 1, type, data });
    if (url.endsWith('/turns')) return Response.json(event('turn.final', { id: body.clientEventId, role: 'user', content: body.content }));
    if (url.endsWith('/pause')) return Response.json({ event: event('session.paused', { paused: body.paused }) });
    if (url.endsWith('/withdraw')) return Response.json({ event: event('turn.withdrawn', { turnId: body.turnId }) });
    if (url.endsWith('/retry')) return Response.json({ accepted: true });
    return Response.json(c.session);
  };
  const tick = () => new Promise(resolve => setImmediate(resolve));
  try {
    c.configure({ copy: en, voiceClient: {}, session, sessionToken }); document.body.append(c); await tick();
    const root = c.shadowRoot;
    root.querySelector('textarea').value = 'Header owned statement';
    root.querySelector('form').dispatchEvent(new window.Event('submit', { cancelable: true })); await tick();
    root.querySelector('.retry').click(); await tick();
    root.querySelector('.pause').click(); await tick();
    root.querySelector('.pause').click(); await tick();
    root.querySelector('.withdraw').click(); await tick();
    c.receive({ seq: c.session.seq + 2, type: 'turn.final', data: {} }); await tick();
    for (const action of ['events', 'turns', 'retry', 'pause', 'withdraw']) {
      assert.ok(calls.some(call => call.url.endsWith('/' + action)), action);
    }
    assert.ok(calls.filter(call => call.url.endsWith(session.id)).length >= 4, 'feature refreshes and gap recovery fetch snapshots');
    assert.ok(calls.every(call => call.headers.get('x-aithema-session-token') === sessionToken));
    assert.equal(c.shadowRoot.innerHTML.includes(sessionToken), false);
  } finally { c.remove(); await tick(); globalThis.fetch = originalFetch; }
});

test('header-owned export fetches the ZIP with ownership and releases the download URL', async t => {
  const c = setup(), originalFetch = globalThis.fetch, calls = [], downloaded = [], revoked = [];
  t.mock.method(URL, 'createObjectURL', () => 'blob:header-owned-fixture');
  t.mock.method(URL, 'revokeObjectURL', value => revoked.push(value));
  const nativeClick = window.HTMLAnchorElement.prototype.click;
  t.mock.method(window.HTMLAnchorElement.prototype, 'click', function () {
    if (this.download) downloaded.push({ href: this.href, download: this.download });
    else nativeClick.call(this);
  });
  globalThis.fetch = async (url, options) => {
    calls.push({ url, headers: new Headers(options?.headers) });
    return new Response('fixture-zip', { headers: { 'content-type': 'application/zip' } });
  };
  try {
    c.configure({ copy: en, session: c.session, sessionToken: 'export-owner-fixture' });
    const click = new window.MouseEvent('click', { bubbles: true, cancelable: true });
    c.shadowRoot.querySelector('.export').dispatchEvent(click);
    await new Promise(resolve => setImmediate(resolve));
    assert.equal(click.defaultPrevented, true);
    assert.equal(calls.length, 1); assert.ok(calls[0].url.endsWith('/export'));
    assert.equal(calls[0].headers.get('x-aithema-session-token'), 'export-owner-fixture');
    assert.deepEqual(downloaded, [{ href: 'blob:header-owned-fixture', download: 'aithema-session.zip' }]);
    assert.deepEqual(revoked, ['blob:header-owned-fixture']);
  } finally { globalThis.fetch = originalFetch; }
});

const paimosOptions = { paimosImportUrl: 'https://paimos.example.test/import/project-draft', paimosImportVersion: 1 };

for (const state of ['two failures', 'overview-only failure', 'stale', 'pending', 'generating', 'draft', 'empty', 'reply-only failure', 'current voice', 'current', 'recovered']) {
  test(`AIT-221 project action requires a current overview: ${state}`, t => {
    const c = setup(), session = c.session;
    session.transcript = [{ id: 'person', role: 'user', content: 'A bakery app.' }];
    const revision = inputRevision(session);
    session.transcript.push({ id: 'reply', role: 'assistant', content: 'Payments?', inputRevision: revision });
    Object.assign(session.understanding, { inputRevision: revision, readinessAssessed: true, summary: 'A bakery app.' });
    const failures = (state === 'two failures' ? ['reaction', 'understanding'] : state === 'overview-only failure' || state === 'recovered' ? ['understanding'] : state === 'reply-only failure' ? ['reaction'] : [])
      .map(lane => ({ lane, error: 'reasoning-unavailable', retryable: true }));
    session.operations = { inputRevision: revision, running: state === 'generating' ? ['understanding'] : [], failures, lastFailure: failures.at(-1) ?? null };
    if (state === 'stale' || state === 'pending') session.understanding.inputRevision = 'older';
    if (state === 'pending' || state === 'empty') session.understanding.readinessAssessed = false;
    if (state === 'pending') session.operations.running = ['reaction'];
    if (state === 'draft') session.understanding.draft = true;
    if (state === 'current voice') session.voiceLifecycle = { callId: 'call', providerSessionId: 'provider', epoch: 1, state: 'active' };
    c.configure({ copy: en, session, ...paimosOptions });
    if (state === 'recovered') {
      c.receive({ type: 'lane.status', data: { inputRevision: revision, running: [], failures: [], lastFailure: null } });
      c.receive({ seq: c.session.seq + 1, type: 'understanding.updated', data: understanding(c) });
    }
    const current = ['reply-only failure', 'current voice', 'current', 'recovered'].includes(state), root = c.shadowRoot, create = root.querySelector('.create-project');
    assert.equal(root.querySelector('.understanding').dataset.overview, current ? 'current' : 'unavailable');
    assert.equal(create.inert, !current, 'unavailable overview cannot be reached with the keyboard');
    assert.equal(create.hidden, false, 'keep the measured footer slot');
    assert.notEqual(create.style.display, 'none');
    const submitted = [];
    t.mock.method(window.HTMLFormElement.prototype, 'submit', function () { submitted.push(this); });
    // Even an invocation that bypasses visibility and inert must use a current overview.
    create.dispatchEvent(new window.MouseEvent('click', { bubbles: true }));
    assert.equal(submitted.length, Number(current));
    assert.match(styles, /\.understanding:not\(\[data-overview="current"\]\) > \.foot > \.create-project\s*\{ visibility:hidden; \}/);
  });
}

test('AIT-242 device mode hides the project action and the handler refuses a forced invocation', t => {
  const c = setup(), submitted = [], createdForms = [];
  assert.equal(c.shadowRoot.querySelector('.create-project'), null, 'the host must configure the handoff');
  c.configure({ copy: en, session: createSession({ processingPreset: 'device' }), ...paimosOptions });
  const create = c.shadowRoot.querySelector('.create-project');
  assert.ok(create);
  assert.equal(create.style.visibility, 'hidden');
  assert.equal(create.inert, true);
  const nativeCreate = document.createElement.bind(document);
  t.mock.method(document, 'createElement', function (name, ...args) {
    const element = nativeCreate(name, ...args);
    if (name === 'form') createdForms.push(element);
    return element;
  });
  t.mock.method(window.HTMLFormElement.prototype, 'submit', function () { submitted.push(this); });
  t.mock.method(globalThis, 'fetch', () => { assert.fail('device project handoff must never fetch'); });
  // Simulate an invocation that bypasses presentation and interaction restrictions.
  create.style.visibility = ''; create.inert = false;
  create.dispatchEvent(new window.MouseEvent('click', { bubbles: true }));
  assert.deepEqual(createdForms, [], 'refuse before constructing any handoff form');
  assert.deepEqual(submitted, [], 'never POST device content');
});

test('AIT-242 switching device to server and back updates the same project action without removing its layout slot', () => {
  const c = setup();
  const session = createSession({ processingPreset: 'device' });
  Object.assign(session.understanding, { inputRevision: inputRevision(session), readinessAssessed: true });
  c.configure({ copy: en, session, ...paimosOptions });
  const root = c.shadowRoot, create = root.querySelector('.create-project'), footer = create.parentElement;
  const children = [...footer.children];
  for (const processingPreset of ['best', 'device']) {
    c.receive({ seq: c.session.seq + 1, type: 'settings.changed', data: { processingPreset,
      settings: { ...c.session.settings, revision: c.session.settings.revision + 1 } } });
    const device = processingPreset === 'device';
    assert.equal(root.querySelector('.create-project'), create, 'the control survives in-place changes');
    assert.equal(create.style.visibility, device ? 'hidden' : '');
    assert.equal(create.inert, device);
    assert.equal(create.hidden, false, 'the action keeps its layout slot');
    assert.notEqual(create.style.display, 'none', 'visibility preserves the footer space');
    assert.deepEqual([...footer.children], children);
  }
});

for (const processingPreset of ['best', 'eu', 'custom']) test(`AIT-242 ${processingPreset} project handoff keeps the v1 download fields unchanged`, t => {
  const c = setup(), session = createSession({ locale: 'en', processingPreset });
  const at = '2026-10-16T10:00:00.000Z';
  Object.assign(session.understanding, { summary: 'A bakery project\nPreorders for neighbors.', signals: ['Phone orders'], openQuestions: ['Payments?'] });
  session.transcript = [
    { id: 'person', role: 'user', content: 'Preorders 🥐', at },
    { id: 'reply', role: 'assistant', content: 'Payments?', at, origin: 'ai-generated', model: 'fixture/model' },
    { id: 'erased', role: 'user', content: 'Erased private content', at, erased: true },
    { id: 'withdrawn', role: 'assistant', content: 'Withdrawn reply', at, withdrawn: true },
  ];
  session.transcript[1].inputRevision = inputRevision(session);
  Object.assign(session.understanding, { inputRevision: inputRevision(session), readinessAssessed: true });
  c.configure({ copy: en, session, sessionToken: 'must-not-be-posted', ...paimosOptions });
  const create = c.shadowRoot.querySelector('.create-project'), submitted = [];
  assert.equal(create.style.visibility, '');
  assert.equal(create.inert, false);
  t.mock.method(window.HTMLFormElement.prototype, 'submit', function () {
    assert.equal(this.isConnected, true);
    assert.equal(this.method, 'post'); assert.equal(this.action, paimosOptions.paimosImportUrl);
    assert.equal(this.target, '_blank'); assert.equal(this.rel, 'noopener');
    assert.equal(this.acceptCharset, 'UTF-8'); assert.equal(this.hidden, true);
    assert.equal(this.elements.length, 1);
    const field = this.elements[0]; assert.equal(field.type, 'hidden'); assert.equal(field.name, 'payload');
    submitted.push({ form: this, payload: JSON.parse(field.value) });
  });
  t.mock.method(globalThis, 'fetch', () => { assert.fail('project handoff uses only the native form POST'); });
  create.click();
  assert.equal(submitted.length, 1);
  assert.deepEqual(submitted[0].payload, {
    version: 1, source: { product: 'aithema', host: document.location.host, session_id: session.id }, language: 'en',
    title: 'A bakery project', summary: session.understanding.summary, facts: ['Phone orders'], open_points: ['Payments?'],
    transcript: [{ role: 'user', text: 'Preorders 🥐', at }, { role: 'assistant', text: 'Payments?', at }],
  });
  assert.equal(submitted[0].form.isConnected, false, 'temporary handoff form is removed');
  assert.deepEqual(c.session, session, 'handoff leaves the server session unchanged');
});

test('a reconnect re-reads feature verdicts, so a host restart that dropped consent shows it (D6)', async () => {
  const c = setup(), originalFetch = globalThis.fetch; let streams = 0, refreshed = 0;
  turn(c, 'reconnect-project', 'We need a website.');
  const session = c.session;
  globalThis.fetch = async (url, options = {}) => {
    if (url.endsWith('/events')) {
      streams++;
      // The first stream ends as if the host stopped; the next one stays open.
      return new Response(new ReadableStream({ start(controller) {
        if (streams === 1) controller.close();
        else options.signal.addEventListener('abort', () => controller.close(), { once: true });
      } }));
    }
    const next = structuredClone(session);
    next.featureMatrix.best = { text: { available: false, reason: 'current processing consent required' },
      analysis: { available: false, reason: 'current processing consent required' } };
    return Response.json(next);
  };
  c.addEventListener('aithema-features', () => { refreshed++; });
  try {
    document.body.append(c);
    for (let i = 0; i < 300 && !refreshed; i++) await new Promise(resolve => setTimeout(resolve, 10));
    const root = c.shadowRoot;
    assert.equal(refreshed, 1); assert.equal(root.querySelector('.send').disabled, true);
    assert.equal(root.querySelector('.composer-reason').textContent, `${en.featureConsent.text}\u00a0· ${en.featureConsent.action}`);
    assert.equal(root.querySelector('.notice').textContent, 'The overview needs your consent\u00a0· Give consent…');
    assert.equal(root.querySelector('.status__label').textContent, en.connected);
  } finally { c.remove(); await new Promise(resolve => setImmediate(resolve)); globalThis.fetch = originalFetch; }
});
test('the German bundle covers every English key and renders the component in German', async () => {
  const { de } = await import('../src/i18n/de.js');
  const keys = (value, prefix = '') => Object.entries(value).flatMap(([key, item]) =>
    item && typeof item === 'object' && !Array.isArray(item) ? keys(item, `${prefix}${key}.`) : [`${prefix}${key}`]);
  const german = new Set(keys(de));
  assert.deepEqual(keys(en).filter(key => !german.has(key)), []);
  assert.equal(de.conceptGuidance.length, en.conceptGuidance.length);
  const c = document.createElement('aithema-session'), session = createSession({ locale: 'de' });
  session.featureMatrix = { best: { text: { available: false, reason: 'current processing consent required' } } };
  c.configure({ copy: de, session });
  const root = c.shadowRoot;
  assert.equal(root.querySelector('.send').textContent, 'Senden');
  assert.equal(root.querySelector('.composer-reason').textContent, `${de.featureConsent.text}\u00a0· ${de.featureConsent.action}`);
  assert.match(root.querySelector('.features').textContent, /Auswertung/);
});
test('every text pair reaches WCAG AA in light and dark, placeholder, bubbles, cards and tints included (AIT-116 D9, AIT-118)', () => {
  const { light, dark } = palette;
  const names = ['accent', 'accent-bright', 'accent-soft', 'amber', 'apricot', 'coral', 'error', 'ink', 'muted', 'on-accent', 'on-ink', 'paper', 'paper-deep', 'surface', 'warning'];
  assert.deepEqual(Object.keys(light).sort(), names); assert.deepEqual(Object.keys(dark).sort(), names);
  // START's palettes (src/styles/app.css): paper, surface, navy ink, muted, teal; navy paper in dark.
  assert.deepEqual([light.paper, light['paper-deep'], light.surface, light.ink, light.muted, light.accent, light['accent-bright'], light['accent-soft']],
    ['#fbf7ef', '#f4eee4', '#fffcf8', '#102b42', '#496477', '#0e6f6c', '#12908c', '#ddedea']);
  assert.deepEqual([dark.paper, dark.surface, dark.ink, dark.muted], ['#0b1a26', '#102433', '#eaf1f6', '#9db4c4']);
  // The placeholder uses the muted token, not the browser default (#757575 measured 3.51:1 on the dark surface).
  assert.match(styles, /textarea::placeholder \{ color:var\(--aithema-muted\); opacity:1; \}/u);
  // The composited layers textPairs models are the ones the styles draw (AIT-118 gate).
  assert.match(styles, /button:where\(:hover:not\(:disabled\)\) \{ background:color-mix\(in srgb,var\(--aithema-accent\) 8%,transparent\); \}/u);
  assert.match(styles, /\.turn \{[^}]*background:color-mix\(in srgb,var\(--aithema-ink\) 7%,var\(--aithema-paper\)\);/u);
  assert.match(styles, /\.turn\.user \{[^}]*background:color-mix\(in srgb,var\(--aithema-accent\) 12%,var\(--aithema-paper\)\);/u);
  assert.match(settingsStyles, /\.notice-area\[data-kind\]:not\(\[data-kind=""\]\) \{ background:color-mix\(in srgb,var\(--aithema-amber\) 9%,transparent\); \}/u);
  assert.match(settingsStyles, /\.recovery \{[^}]*background:color-mix\(in srgb,var\(--aithema-amber\) 9%,transparent\); \}/u);
  assert.match(settingsStyles, /\.settings-field legend \{[^}]*color:color-mix\(in oklab,var\(--aithema-ink\) 85%,transparent\); \}/u);
  assert.match(settingsStyles, /\.gauge__value \{[^}]*opacity:\.85; \}/u);
  assert.match(settingsStyles, /\.select__option:hover, \.select__option:focus-visible \{ background:color-mix\(in srgb,var\(--aithema-accent\) 10%,transparent\); \}/u);
  assert.match(settingsStyles, /\.local pre \{[^}]*background:color-mix\(in srgb,var\(--aithema-ink\) 7%,transparent\);/u);
  assert.match(settingsStyles, /\.gauge-panel \{[^}]*background:var\(--aithema-gauge-panel\); \}/u);
  // The light gauge panel's stops are fixed in its token; dark follows the surface and paper.
  const lightPanel = ['#fffefd', '#faf8f3', '#f7f9f6', '#e6f0ef'];
  assert.match(styles, /--aithema-gauge-panel:radial-gradient\(ellipse at 25% 0%,#fffefd,transparent 65%\),linear-gradient\(155deg,#faf8f3,#f7f9f6 55%,#e6f0ef\);/u);
  const themes = { light: textPairs(light, { primaryText: light['on-ink'], gaugePanel: lightPanel }), dark: textPairs(dark, { primaryText: dark['on-ink'] }) };
  for (const [theme, pairs] of Object.entries(themes)) {
    const tokens = palette[theme];
    for (const pair of ['accent on hover tint over notice tint on surface', 'ink on hover tint over notice tint on paper', 'legend (ink 85 %) on ' + tokens.surface,
      `gauge value (ink at 0.85 opacity) on ${theme === 'light' ? '#e6f0ef' : tokens.paper}`]) assert.ok(pairs[pair], `${theme}: ${pair} is checked`);
    assert.ok(Object.keys(pairs).length >= 88, `${theme}: ${Object.keys(pairs).length} pairs`);
    for (const [pair, [text, background]] of Object.entries(pairs)) {
      assert.ok(contrast(text, background) >= 4.5, `${theme} ${pair}: ${contrast(text, background).toFixed(2)}:1`);
    }
  }
  // START's glass cards as the styles draw them (Codex gate, AIT-128): every point of the content box over paper and
  // under each of the page's three lights at its peak (the peaks lie apart), plain and selected, with the glass, both
  // corner glows and the inner highlight. The layers are read from the styles; the geometry glassCard models is pinned here.
  assert.match(entranceStyles, /\.chooser-option \{[^}]*background:radial-gradient\(ellipse at 100% 110%,light-dark\([^)]+\),transparent 55%\),radial-gradient\(ellipse at 0 105%,light-dark\([^)]+\),transparent 45%\),\s*linear-gradient\(125deg,light-dark\([^)]+\),light-dark\([^)]+\) 50%,light-dark\([^)]+\)\);/u);
  assert.match(entranceStyles, /\.chooser-option::before \{[^}]*inset:5px;[^}]*background:linear-gradient\(135deg,light-dark\([^)]+\),transparent 12%,transparent 75%,light-dark\([^)]+\)\);/u);
  // The card's text is ink or the card's muted; the icon colour is a graphic, not text.
  const cardColours = [...entranceStyles.matchAll(/(?<=^|\}\s*)\.chooser-option[^{]*\{([^}]*)\}/gmu)].flatMap(([, body]) => [...body.matchAll(/(?<![-\w])color:([^;]+);/gu)].map(m => m[1]));
  assert.deepEqual([...new Set(cardColours)].sort(), ['light-dark(#173c53,#bddfdf)', 'var(--aithema-ink)', 'var(--chooser-muted)']);
  assert.match(entranceStyles, /--chooser-muted:light-dark\(var\(--aithema-muted\),color-mix\(in srgb,var\(--aithema-muted\) 60%,var\(--aithema-ink\)\)\);/u);
  const lights = [...styles.match(/--aithema-lighting:([^;]+);/u)[1].matchAll(/rgba\((\d+),(\d+),(\d+),([\d.]+)\)/gu)]
    .map(([, ...rgba]) => [`#${rgba.slice(0, 3).map(v => Number(v).toString(16).padStart(2, '0')).join('')}`, Number(rgba[3])]);
  assert.equal(lights.length, 3);
  const declared = (selector, theme) => {
    const start = entranceStyles.indexOf(`${selector} {`), value = entranceStyles.slice(start, entranceStyles.indexOf('}', start)).match(/background(?:-color)?:([^;]+);/u)[1];
    return [...value.matchAll(/light-dark\((#[0-9a-f]{8}),(#[0-9a-f]{8})\)/gu)].map(m => m[theme === 'light' ? 1 : 2]).map(hex => [hex.slice(0, 7), parseInt(hex.slice(7), 16) / 255]);
  };
  const worstOnCards = (theme, muted) => {
    const t = palette[theme], [teal, apricot, ...glass] = declared('.chooser-option', theme), [first, last] = declared('.chooser-option::before', theme);
    const card = { teal, apricot, glass: glass.map((stop, i) => [i / 2, ...stop]), highlight: [[0, ...first], [.12, first[0], 0], [.75, last[0], 0], [1, ...last]],
      selected: declared('.chooser-option[aria-pressed="true"], .chooser-option[aria-pressed="true"]:hover', theme)[0] };
    const worst = { ink: [Infinity], muted: [Infinity] };
    for (const page of [t.paper, ...lights.map(([hex, alpha]) => mix(hex, t.paper, alpha))]) for (const selected of [false, true]) {
      for (const background of glassCard(card, page, { selected })) for (const [name, text] of [['ink', t.ink], ['muted', muted]]) {
        const ratio = contrast(text, background); if (ratio < worst[name][0]) worst[name] = [ratio, background, page, selected];
      }
    }
    return worst;
  };
  for (const [theme, muted] of [['light', light.muted], ['dark', mix(dark.muted, dark.ink, .6)]]) {
    for (const [name, [ratio, background, page, selected]] of Object.entries(worstOnCards(theme, muted))) {
      assert.ok(ratio >= 4.5, `${theme} ${name} on a ${selected ? 'selected ' : ''}card at ${background} over ${page}: ${ratio.toFixed(2)}:1`);
    }
  }
  // START's own dark muted on these cards fails the same check: the model detects it.
  assert.ok(worstOnCards('dark', dark.muted).muted[0] < 4.5);
  // The values AIT-109 reported fail the same check: the test detects them.
  assert.ok(contrast('#67777a', mix(light.accent, light.paper, .12)) < 4.5 && contrast('#67777a', light.paper) < 4.5);
  assert.ok(contrast('#757575', dark.surface) < 4.5, 'the fixture detects the reported default placeholder');
  // No settings colour is fixed to the light theme where dark text or a light fill would invert: the tokens carry both themes.
  assert.doesNotMatch(settingsStyles, /prefers-color-scheme/u);
  assert.match(settingsStyles, /\.done \{[^}]*color:var\(--aithema-on-ink\);/u);
  assert.doesNotMatch(settingsStyles, /#89613b|#9a4030|#925125|color:#fff; border-color:var\(--aithema-accent\)/u);
});

// AIT-119, EU AI Act Art. 50(1): the notice stands before the first interaction, in the page language.
test('the AI notice is painted with the first render, ahead of the composer, in English and German (AIT-119)', () => {
  for (const [locale, copy] of [['en', en], ['de', de]]) {
    const c = document.createElement('aithema-session'), session = createSession({ locale, demo: true });
    session.featureMatrix = { best: { text: { available: false, reason: 'current processing consent required' }, analysis: { available: true, reason: null } } };
    c.configure({ copy: structuredClone(copy), session });
    const root = c.shadowRoot, notice = root.querySelector('#ai-notice');
    // The complete sentence stays as the accessible description; the footer has a standing short notice.
    assert.equal(notice.textContent, AI_NOTICE[locale].text);
    assert.equal(root.querySelector('.ai-notice__label').textContent, copy.assistant);
    assert.equal(root.querySelector('.ai-notice__short').textContent, copy.layout.aiShort);
    assert.equal(root.querySelector('.ai-notice__voice'), null);
    assert.equal(root.querySelector('textarea').disabled, true, 'the composer is still closed while the notice already stands');
    // It is the conversation's first line, outside the start card, so neither the chooser nor the
    // ready card covers it, and it comes before every control of the pane.
    const line = notice.parentElement;
    assert.ok(root.querySelector('.display-foot').contains(line));
    assert.equal(root.querySelector('.ai-notice').getAttribute('aria-describedby'), 'ai-notice build-info');
    assert.equal(root.querySelector('.intro').contains(line), false);
    session.featureMatrix.best.text = { available: true, reason: null };
    c.configure({ copy: structuredClone(copy), session });
    assert.equal(c.shadowRoot.querySelector('textarea').disabled, false);
    assert.equal(c.shadowRoot.querySelector('#ai-notice').textContent, AI_NOTICE[locale].text);
  }
  assert.equal(AI_NOTICE.en.text, 'You are talking to an AI assistant.');
  assert.equal(AI_NOTICE.de.text, 'Sie sprechen mit einer KI-Assistenz.');
  assert.equal(AI_NOTICE.de.voice, 'Gesprochene Antworten nutzen eine synthetische Stimme.');
});
test('with voice offered both sentences show; consent still pending counts as offered (AIT-119)', () => {
  const c = document.createElement('aithema-session'), session = createSession({ demo: true });
  const client = { manifest: { liveVoice: { capabilities: {} } }, async start() { throw new Error('unused'); } };
  session.featureMatrix = { best: { voice: { available: false, reason: 'current processing consent required' }, text: { available: true }, analysis: { available: true } } };
  c.configure({ copy: en, session, voiceClient: client });
  const full = `${AI_NOTICE.en.text} ${AI_NOTICE.en.voice}`;
  assert.equal(c.shadowRoot.querySelector('#ai-notice').textContent, full);
  session.featureMatrix.best.voice = { available: false, reason: 'voice off' };
  c.configure({ copy: en, session, voiceClient: client });
  assert.equal(c.shadowRoot.querySelector('#ai-notice').textContent, AI_NOTICE.en.text);
  assert.equal(c.shadowRoot.querySelector('.ai-notice__voice').textContent, en.layout.syntheticVoice);
});
test('a host rewords the AI notice through the bundle or configure, but an empty override keeps the default (AIT-119)', () => {
  const c = document.createElement('aithema-session'), session = createSession({ demo: true });
  const text = () => c.shadowRoot.querySelector('#ai-notice').textContent;
  for (const blank of ['', '   ', null, 42]) {
    c.configure({ copy: { ...en, aiNotice: { text: blank, voice: blank } }, session });
    assert.equal(text(), AI_NOTICE.en.text, `bundle ${JSON.stringify(blank)}`);
    c.configure({ copy: en, session, aiNotice: { text: blank } });
    assert.equal(text(), AI_NOTICE.en.text, `configure ${JSON.stringify(blank)}`);
  }
  c.configure({ copy: { ...en, aiNotice: undefined }, session }); assert.equal(text(), AI_NOTICE.en.text);
  c.configure({ copy: { ...en, aiNotice: { text: 'Host bundle: an AI answers.' } }, session });
  assert.equal(text(), 'Host bundle: an AI answers.');
  c.configure({ copy: { ...en, aiNotice: { text: 'Host bundle: an AI answers.' } }, session, aiNotice: { text: 'Host config: an AI answers.' } });
  assert.equal(text(), 'Host config: an AI answers.');
  // An empty configured part defers to the bundle, then to the default; it never empties the line.
  c.configure({ copy: { ...en, aiNotice: { text: 'Host bundle: an AI answers.' } }, session, aiNotice: { text: ' ' } });
  assert.equal(text(), 'Host bundle: an AI answers.');
});
test('screen readers get the AI notice once, as the last description of every control that begins an interaction (AIT-119)', () => {
  const c = setup(); c.configure({ copy: en, session: c.session, voiceClient: {} }); const root = c.shadowRoot, notice = root.querySelector('#ai-notice');
  const described = node => (node.getAttribute('aria-describedby') ?? '').split(' ').filter(Boolean);
  const entries = () => [...root.querySelectorAll('.chooser-option, .chooser__continue, .ready__actions button, .ready__start, .voice-start, .voice-retry, textarea, .attach, .send')];
  // Chooser state: the four options keep their own detail first, Continue and the composer theirs.
  assert.equal(root.querySelector('.intro').dataset.mode, 'chooser');
  assert.deepEqual([...root.querySelectorAll('.chooser-option')].map(described),
    ['best', 'eu', 'device', 'custom'].map(preset => [`chooser-${preset}-detail`, 'ai-notice']));
  assert.deepEqual(described(root.querySelector('.chooser__continue')), ['ai-notice']);
  assert.deepEqual(described(root.querySelector('textarea')), ['composer-reason', 'ai-notice']);
  assert.deepEqual(described(root.querySelector('.attach')), ['attach-limits', 'ai-notice']);
  for (const selector of ['.send', '.voice-start', '.voice-retry']) assert.deepEqual(described(root.querySelector(selector)), ['ai-notice'], selector);
  assert.equal(entries().length, 10, 'four options, Continue, Start and Retry call, composer, Attach and Send');
  // Every referenced description exists in this shadow root, so nothing is silently dropped.
  for (const node of entries()) for (const id of described(node)) assert.ok(root.getElementById(id), `${id} exists`);
  // Ready state, with consent still missing: Change and Review consent are described too.
  const session = c.session;
  session.featureMatrix.best.text = { available: false, reason: 'current processing consent required' };
  c.configure({ copy: en, session });
  c.receive({ seq: c.session.seq + 1, type: 'settings.changed', data: { processingPreset: 'best',
    settings: { ...session.settings, revision: 1, origin: 'chosen', at: new Date().toISOString() } } });
  assert.equal(root.querySelector('.intro').dataset.mode, 'ready');
  const actions = [...root.querySelectorAll('.ready__actions button')];
  assert.deepEqual(actions.map(button => button.className), ['ready__change', 'ready__consent']);
  for (const button of actions) assert.deepEqual(described(button), ['ai-notice'], button.className);
  assert.deepEqual(described(root.querySelector('.ready__start')), ['ready-route', 'ai-notice'], 'Start names the processing route, then the notice');
  for (const node of entries()) assert.equal(described(node).at(-1), 'ai-notice', node.className || node.tagName);
  // Not a live region: it is read with those controls, not re-announced on every render.
  for (let node = notice; node && node !== root; node = node.parentNode) {
    assert.equal(node.getAttribute('aria-live'), null); assert.ok([null, 'tooltip'].includes(node.getAttribute('role'))); assert.equal(node.getAttribute('aria-hidden'), null);
  }
  assert.equal(root.querySelectorAll('#ai-notice').length, 1);
  const css = root.querySelector('style').textContent;
  const foot = css.match(/\.display-foot\s*\{[^}]*position:fixed;[^}]*\}/u)?.[0] ?? '';
  assert.match(foot, /position:fixed;/u); assert.match(foot, /bottom:0;/u);
  const rule = [...css.matchAll(/\.ai-notice \{([^}]+)\}/gu)].map(match => match[1]).find(rule => rule.includes('min-height:44px;'));
  assert.ok(rule, 'the standing notice keeps its full-size target; responsive font rules do not replace it');
  assert.match(rule, /min-height:44px;/u); assert.match(rule, /background:none;/u);
  for (const banned of ['border:', 'box-shadow:', 'font-style:italic']) assert.ok(!rule.includes(banned), banned);
  assert.match(css, /--aithema-backdrop:var\(--aithema-lighting\) var\(--aithema-paper\);/u);

});

for (const copy of [de, en]) test(`AIT-174 round3 ${copy.display.locale}: purpose pause only presents in composer and preserves overview`, () => {
  const c = setup(), session = c.session; session.locale = copy.display.locale;
  c.configure({ copy, session, voiceClient: {} });
  turn(c, 'purpose-project', 'systems: SAP'); reply(c, 'purpose-reply');
  c.receive({ seq: c.session.seq + 1, type: 'understanding.updated', data: understanding(c) });
  const root = c.shadowRoot, notice = root.querySelector('.notice').textContent, summary = root.querySelector('.summary-text').textContent;
  const startCell = root.querySelector('.voice-start').parentNode;
  c.receive({ seq: c.session.seq + 1, type: 'session.paused', data: { paused: true, reason: 'purpose' } });
  assert.equal(root.querySelector('.purpose-pause-copy').hidden, false);
  assert.equal(root.querySelector('.purpose-pause-copy').textContent, copy.purposePaused);
  assert.equal(root.querySelector('.voice-start').disabled, true);
  assert.equal(root.querySelector('.voice-start').parentNode, startCell, 'Start stays in the normal idle mic cell');
  assert.equal(root.querySelector('.voice-start').title, copy.display.locale === 'de' ? 'Dieses Gespräch ist pausiert.' : 'This conversation is paused.');
  assert.equal(root.querySelector('.voice-start').getAttribute('aria-description'), root.querySelector('.voice-start').title);
  assert.equal(root.querySelector('.voice-output').disabled, true);
  assert.equal(root.querySelector('.voice-input').disabled, true);
  assert.doesNotMatch(root.querySelector('.voice-state').textContent, /pausiert|paused/iu);
  assert.doesNotMatch(root.querySelector('.status__label').textContent, /pausiert|paused/iu);
  assert.equal(root.querySelector('.notice').textContent, notice);
  assert.equal(root.querySelector('.summary-text').textContent, summary);
});

for (const copy of [de, en]) for (const draft of [false, true]) test(`AIT-197 R4 ${copy.display.locale}: running analysis preserves ${draft ? 'draft' : 'stale'} assessment`, () => {
  const c = setup(); turn(c, 'first', 'We need a website.');
  c.receive({ seq: c.session.seq + 1, type: 'understanding.updated', data: understanding(c) });
  turn(c, 'second', 'For our customers.');
  if (draft) c.receive({ seq: c.session.seq + 1, type: 'understanding.updated', data: understanding(c, true) });
  const session = c.session;
  session.operations = { inputRevision: inputRevision(session), running: ['understanding'], lastFailure: null };
  c.configure({ session, copy });
  const root = c.shadowRoot;
  assert.equal(root.querySelector('.notice').textContent, draft ? copy.draft : copy.stale);
  assert.notEqual(root.querySelector('.notice').textContent, copy.preparingOverview);
  assert.equal(root.querySelector('.summary-text').textContent, '<script>untrusted</script>');
  assert.ok([...root.querySelectorAll('.analysis-content section')].every(n => !n.hidden));
});
for (const copy of [de, en]) for (const reason of ['not configured', 'budget denied', 'verification required', 'current processing consent required']) test(`AIT-197 R4 ${copy.display.locale}: no assessment preserves reason ${reason}`, () => {
  const c = setup(); turn(c, 'first', 'We need a website.');
  const session = c.session;
  session.featureMatrix.best.analysis = { available: false, reason };
  c.configure({ session, copy });
  const root = c.shadowRoot;
  assert.equal(root.querySelector('.notice').textContent, reason === 'current processing consent required'
    ? `${copy.featureConsent.analysis}\u00a0· ${copy.featureConsent.action}` : copy.reasons[reason]);
  assert.equal(root.querySelector('.notice button') !== null, reason === 'current processing consent required');
  assert.equal(root.querySelector('.understanding').hasAttribute('aria-disabled'), reason !== 'current processing consent required', 'the consent action stays interactive');
  assert.equal(root.querySelector('.readiness').style.visibility, 'hidden');
  assert.ok([...root.querySelectorAll('.analysis-content section')].every(n => n.hidden));
  assert.equal(root.querySelector('.retry').hidden, true);
});

test('AIT-198 inline overview Retry keeps its node and keyboard focus across live renders', async t => {
  t.mock.method(globalThis, 'fetch', async (url, options = {}) => new Response(new ReadableStream({ start(controller) {
    options.signal?.addEventListener('abort', () => controller.close(), { once: true }); } })));
  const c = setup(), root = c.shadowRoot; document.body.append(c); t.after(() => c.remove());
  turn(c, 'focus-person', 'First project detail');
  c.receive({ type: 'lane.failed', data: { lane: 'understanding', error: 'reasoning-unavailable' } });
  const retry = root.querySelector('.overview-retry'); retry.focus();
  assert.equal(root.activeElement, retry);
  c.receive({ type: 'lane.failed', data: { lane: 'understanding', error: 'reasoning-unavailable' } });
  assert.ok(root.querySelector('.overview-retry') === retry, 'live render keeps the inline button');
  assert.ok(root.activeElement === retry, 'keyboard focus survives');
  assert.equal(root.querySelector('.retry').hidden, true);
});

for (const copy of [de, en]) test(`AIT-198 ${copy === de ? 'DE' : 'EN'} missing reply with idle operations and no failure is a stuck overview`, () => {
  const c = setup(); turn(c, 'stuck-person', 'First project detail');
  const session = c.session;
  session.operations = { inputRevision: inputRevision(session), running: [], lastFailure: null };
  c.configure({ copy, session });
  const root = c.shadowRoot;
  assert.equal(root.querySelector('.notice').textContent, `${copy.understandingFailed}\u00a0· ${copy.understandingRetry}`);
  assert.equal(root.querySelectorAll('.notice .overview-retry').length, 1);
  assert.equal(root.querySelector('.overview-retry').disabled, false);
  assert.equal(root.querySelector('.retry').hidden, true, 'never a bare footer retry next to the placeholder');
});


function assertNoFailedOverview(c, message) {
  const root = c.shadowRoot;
  assert.equal(root.querySelector('.overview-retry').hidden, true, message);
  assert.doesNotMatch(root.querySelector('.notice').textContent, /couldn't be built|konnte gerade nicht erstellt/iu, message);
  assert.equal(root.querySelector('.retry').hidden, true, message);
}

test('AIT-198 typed turn waits for current lane.status without flashing a stuck overview', () => {
  const c = setup();
  turn(c, 'typed-person', 'First detail');
  const revision = inputRevision(c.session);
  assertNoFailedOverview(c, 'turn.final precedes lane.status');
  c.receive({ type: 'lane.status', data: { inputRevision: 'obsolete', running: [], lastFailure: null } });
  assertNoFailedOverview(c, 'obsolete status cannot settle this revision');
  c.receive({ type: 'lane.status', data: { inputRevision: revision, running: ['reaction'], lastFailure: null } });
  assertNoFailedOverview(c, 'reaction now owns the reply');
  c.receive({ type: 'lane.status', data: { inputRevision: revision, running: [], lastFailure: null } });
  assertInlineRetry(c, 'confirmed idle still exposes a genuinely stuck reply');
});

for (const source of ['live call', 'facade pending', 'spoken facade pending']) test(`AIT-198 ${source}: no failed overview from person final through assistant final`, () => {
  const c = setup(), session = c.session;
  if (source === 'live call') session.voiceLifecycle = { callId: 'voice-call', providerSessionId: 'voice-provider', epoch: 1, state: 'active' };
  c.configure({ copy: en, session, voiceClient: {} });
  c.receive({ seq: c.session.seq + 1, type: 'turn.final', data: { id: 'voice-person', role: 'user', content: 'Voice detail',
    ...(source === 'facade pending' ? { voiceCallId: 'voice-call', voiceProviderId: 'voice-provider' } :
      source === 'spoken facade pending' ? { callId: 'voice-call', providerSessionId: 'voice-provider' } : {}) } });
  const revision = inputRevision(c.session);
  assertNoFailedOverview(c, 'person final');
  c.receive({ type: 'lane.status', data: { inputRevision: revision, running: [], lastFailure: null } });
  assertNoFailedOverview(c, 'the facade needs no reaction lane');
  c.receive({ type: 'turn.partial', data: { id: 'voice-reply', inputRevision: revision, delta: 'Reply' } });
  assertNoFailedOverview(c, 'assistant partial');
  c.receive({ seq: c.session.seq + 1, type: 'understanding.updated', data: understanding(c) });
  reply(c, 'voice-reply');
  assertNoFailedOverview(c, 'assistant final');
});

for (const recovering of [false, true]) test(`AIT-198 ${recovering ? 'recovering' : 'deferred'} analysis never shows a stuck overview`, async t => {
  const c = setup(), retryStarted = Promise.withResolvers(), retryDone = Promise.withResolvers();
  t.mock.method(globalThis, 'fetch', async (url, options = {}) => {
    if (url.endsWith('/events')) return new Response(new ReadableStream({ start(controller) {
      options.signal?.addEventListener('abort', () => controller.close(), { once: true });
    } }));
    if (url.endsWith('/retry')) { retryStarted.resolve(); await retryDone.promise; return Response.json({ accepted: true }); }
    return Response.json(c.session);
  });
  document.body.append(c); t.after(() => { retryDone.resolve(); c.remove(); });
  turn(c, 'deferred-person', 'First detail');
  const revision = inputRevision(c.session);
  c.receive({ type: 'lane.failed', data: { inputRevision: revision, lane: 'understanding', reason: 'budget reconciling' } });
  c.receive({ type: 'lane.status', data: { inputRevision: revision, running: [], lastFailure: null } });
  if (recovering) {
    c.receive({ seq: c.session.seq + 1, type: 'identity.unlocked', data: {} });
    await retryStarted.promise;
    c.receive({ type: 'lane.status', data: { inputRevision: revision, running: [], lastFailure: null } });
  }
  assertNoFailedOverview(c, recovering ? 'retry request is in flight' : 'analysis is deferred');
  retryDone.resolve();
});


test('AIT-198 an ended facade call can expose a genuinely stuck missing reply', () => {
  const c = setup({ voiceClient: {} });
  c.receive({ seq: 1, type: 'turn.final', data: { id: 'voice-person', role: 'user', content: 'Detail', voiceCallId: 'call' } });
  c.receive({ type: 'lane.status', data: { inputRevision: inputRevision(c.session), running: [], lastFailure: null } });
  assertNoFailedOverview(c, 'accepted facade input is still pending');
  c.receive({ type: 'voice.state', data: { callId: 'call', providerSessionId: 'provider', epoch: 1, state: 'ended' } });
  assertInlineRetry(c, 'authoritative call end releases the pending facade reply');
});

// The merged consent and failure vocabulary must stay available in both locales.
test('AIT-197 R5 DE/EN copy has identical recursive key sets', () => {
  const keys = (value, prefix = '') => Object.entries(value).flatMap(([key, entry]) => {
    const path = `${prefix}${key}`;
    return entry && typeof entry === 'object' ? keys(entry, `${path}.`) : [path];
  });
  assert.deepEqual(keys(de).sort(), keys(en).sort());
  for (const copy of [de, en]) for (const key of ['noProjectDetails', 'overviewPendingReply', 'preparingOverview', 'understandingFailed', 'understandingRetry']) {
    assert.equal(typeof copy[key], 'string');
    assert.ok(copy[key].length > 0);
  }
});

for (const state of ['shown', 'running', 'unavailable']) test(`AIT-221 two failures: ${state} Retry separator and footer return order`, () => {
  const c = setup(); turn(c, 'person', 'A project detail');
  const session = c.session;
  const failures = ['reaction', 'understanding'].map(lane => ({ lane, error: 'reasoning-unavailable', retryable: true }));
  session.operations = { inputRevision: inputRevision(session), running: state === 'running' ? ['reaction'] : [], failures, lastFailure: failures[1] };
  if (state === 'unavailable') session.featureMatrix.best.analysis = { available: false, reason: 'not configured' };
  c.configure({ session, copy: en, paimosImportUrl: 'https://paimos.example.test/import/project-draft', paimosImportVersion: 1 });
  const root = c.shadowRoot, retry = root.querySelector('.retry');
  assert.equal(retry.hidden, state !== 'shown');
  assert.equal(root.querySelector('.reaction-failure-text').textContent, `${en.reasoningFailed}${state === 'shown' ? '\u00a0· ' : ''}`);
  c.receive({ type: 'lane.status', data: { ...session.operations, running: [], failures: [failures[0]], lastFailure: failures[0] } });
  const footer = root.querySelector('.understanding > .foot');
  assert.equal(footer.children[1], retry, 'same Retry returns immediately after export');
  assert.equal(retry.nextElementSibling, footer.querySelector('.export-reason'));
  assert.deepEqual([...footer.querySelectorAll('a, button')].map(n => n.className), ['export', 'retry', 'create-project'], 'original keyboard order');
});

// Definition can finish while the host is still fetching its session.
test('AIT-210: loading shell readiness follows configuration, not element definition', () => {
  const empty = document.createElement('aithema-session');
  assert.ok(customElements.get('aithema-session'));
  assert.equal(empty.hasAttribute('data-aithema-mounted'), false);
  const mounted = setup();
  assert.equal(mounted.hasAttribute('data-aithema-mounted'), true);
  assert.equal(mounted.shadowRoot.querySelector('.band .audio-rail'), null);
});

test('AIT-263: public focus command carries the revision and propagates typed stale refusals', async t => {
  const component = setup();
  turn(component, 'person-focus', 'We need a website.');
  component.receive({ seq: component.session.seq + 1, type: 'understanding.updated', data: {
    ...component.session.understanding, inputRevision: inputRevision(component.session), draft: false,
    openQuestions: ['Audience?', 'Launch date?'],
  } });
  const item = component.openQuestionItems[1], requests = [];
  const original = globalThis.fetch; t.after(() => { globalThis.fetch = original; });
  globalThis.fetch = async (url, options) => {
    requests.push({ url, options });
    return Response.json({ error: 'focus-refused', reason: 'stale-question' }, { status: 409 });
  };
  await assert.rejects(component.focusQuestion(item.id), { reason: 'stale-question', status: 409 });
  assert.match(requests[0].url, /\/focus-question$/u);
  assert.deepEqual(JSON.parse(requests[0].options.body), { questionId: item.id, inputRevision: inputRevision(component.session) });
  assert.equal(component.session.transcript.length, 1);
});

for (const copy of [de, en]) test(`AIT-266 ${copy.display.locale}: saved acknowledgment stays inline for 1600ms and resets on configure`, async t => {
  const c = setup({ copy }), root = c.shadowRoot;
  t.after(() => c.configure({ copy, session: c.session }));
  t.mock.method(globalThis, 'fetch', async (_url, options) => Response.json({ seq: c.session.seq + 1, type: 'turn.final',
    data: { id: JSON.parse(options.body).clientEventId, role: 'user', content: 'Hello' } }));
  t.mock.timers.enable({ apis: ['setTimeout'] });
  root.querySelector('textarea').value = 'Hello';
  root.querySelector('form').dispatchEvent(new window.Event('submit', { cancelable: true }));
  await new Promise(resolve => setImmediate(resolve));
  const feedback = root.querySelector('.composer-feedback');
  assert.equal(feedback.hasAttribute('data-saved'), true);
  assert.equal(root.querySelector('.composer-saved span').textContent, copy.saved);
  assert.equal(root.querySelector('.status__label').textContent.includes(copy.saved), false);
  assert.equal(root.querySelector('.composer-dock > .status__label'), null);
  t.mock.timers.tick(1599); assert.equal(feedback.hasAttribute('data-saved'), true);
  t.mock.timers.tick(1); assert.equal(feedback.hasAttribute('data-saved'), false);
  assert.equal(root.querySelector('.composer-saved span').textContent, '');
  assert.equal(root.querySelector('.composer-saved-announcement').textContent, '');
  assert.equal(root.querySelector('.composer-saved').getAttribute('aria-hidden'), 'true');
  c.configure({ copy, session: c.session });
  t.mock.timers.tick(1600); assert.equal(c.shadowRoot.querySelector('.composer-feedback').hasAttribute('data-saved'), false);
});

for (const copy of [de, en]) test(`AIT-266 ${copy.display.locale}: platform shortcut has localized modifier and Enter keycaps`, t => {
  for (const [value, key] of [['MacIntel', copy.shortcutKeys.mac], ['Win32', copy.shortcutKeys.other]]) {
    platform(t, value);
    const c = setup({ copy }), reason = c.shadowRoot.querySelector('.composer-reason');
    assert.deepEqual([...reason.querySelectorAll('kbd')].map(n => n.textContent), [key, 'Enter']);
    assert.equal(reason.textContent, copy.shortcut.replace('{key}', key));
  }
});

for (const copy of [de, en]) test(`AIT-266 ${copy.display.locale}: no bound visuals hides the rail; configured/off visuals retain their UI`, () => {
  const c = setup({ copy });
  assert.equal(c.shadowRoot.querySelector('.concept-rail').hidden, true);
  const noDrafts = c.session;
  noDrafts.featureMatrix.eu = { html: { available: false, reason: 'preset not configured' } };
  noDrafts.featureMatrix.custom = { images: { available: false, reason: 'preset not configured' } };
  c.configure({ copy, session: noDrafts });
  assert.equal(c.shadowRoot.querySelector('.concept-rail').hidden, true);
  for (const verdict of [{ available: true }, { available: false, reason: 'visuals off' }, { available: false, reason: 'current processing consent required' }]) {
    const session = c.session; session.featureMatrix.best.html = verdict;
    c.configure({ copy, session });
    assert.equal(c.shadowRoot.querySelector('.concept-rail').hidden, false);
  }
});

for (const visualsBound of [false, true]) test(`AIT-266: explicit host visuals capability ${visualsBound} wins over a preset refusal`, () => {
  const c = setup(), session = c.session;
  session.visualsBound = visualsBound;
  session.featureMatrix.best.html = { available: false, reason: 'preset not configured' };
  c.configure({ copy: en, session });
  assert.equal(c.shadowRoot.querySelector('.concept-rail').hidden, !visualsBound);
  session.paused = true;
  c.configure({ copy: en, session });
  assert.equal(c.shadowRoot.querySelector('.concept-rail').hidden, !visualsBound, 'a paused reload retains host capability presentation');
});


for (const copy of [de, en]) test(`AIT-280 ${copy.display.locale}: successful turns announce once per ten seconds, never while typing`, async t => {
  const c = setup({ copy }), root = c.shadowRoot, live = root.querySelector('.composer-saved-announcement');
  t.after(() => c.configure({ copy, session: c.session }));
  t.mock.timers.enable({ apis: ['setTimeout', 'Date'], now: 100_000 });
  t.mock.method(globalThis, 'fetch', async (_url, options) => Response.json({ seq: c.session.seq + 1, type: 'turn.final',
    data: { id: JSON.parse(options.body).clientEventId, role: 'user', content: JSON.parse(options.body).content } }));
  assert.equal(live.getAttribute('role'), 'status'); assert.equal(live.getAttribute('aria-live'), 'polite');
  assert.equal(live.getAttribute('aria-atomic'), 'true'); assert.equal(live.hasAttribute('aria-hidden'), false);
  assert.equal(live.textContent, '');
  const send = async () => {
    root.querySelector('textarea').value = 'Hello';
    root.querySelector('form').dispatchEvent(new window.Event('submit', { cancelable: true }));
    await new Promise(resolve => setImmediate(resolve));
  };
  const type = () => { root.querySelector('textarea').value += 'x'; root.querySelector('textarea').dispatchEvent(new window.Event('input')); };
  let announcements = 0;
  for (const [advance, announced] of [[0, true], [1600, false], [2000, false], [6399, false], [1, true]]) {
    t.mock.timers.tick(advance); await send();
    assert.equal(live.textContent, announced ? copy.saved : '');
    if (live.textContent) announcements++;
    for (let i = 0; i < 5; i++) type();
    assert.equal(live.textContent, announced ? copy.saved : '', 'keystrokes do not change the live text');
  }
  assert.equal(announcements, 2, 'several saves inside 10s are one burst');
  t.mock.timers.tick(1600); assert.equal(live.textContent, '');
  for (let i = 0; i < 5; i++) type();
  assert.equal(live.textContent, '', 'typing after expiry never announces');
  c.configure({ copy, session: c.session });
  await send(); assert.equal(root.querySelector('.composer-saved-announcement').textContent, copy.saved, 'new configuration resets the burst');
});

test('AIT-286: shared failure sentence uses warning ink; composer consent keeps the action style and a coarse 44px target', () => {
  assert.match(styles, /:is\(\.composer-reason,\.concept-activity-text\) \.warning[^}]*color:var\(--aithema-warning\)/u);
  assert.ok(styles.includes('@media(hover:none), (pointer:coarse) {\n  .composer-reason[data-consent-feature] > .consent-action::after, .upload-retry-copy[data-consent-feature] > .consent-action::after { height:max(100%,44px); }'));
  const c = setup(), root = c.shadowRoot;
  c.session.featureMatrix.best.text = { available: false, reason: 'current processing consent required' };
  c.receive({ type: 'lane.status', data: { running: [], failures: [] } });
  const action = root.querySelector('.composer-reason .consent-action');
  assert.equal(action.tagName, 'BUTTON'); assert.equal(action.type, 'button');
  assert.equal(window.getComputedStyle(action).textDecorationLine || window.getComputedStyle(action).textDecoration, 'underline');
  for (const [theme, tokens] of Object.entries(palette)) for (const background of [tokens.paper, tokens.surface])
    assert.ok(contrast(tokens.warning, background) >= 4.5, `${theme}: warning ink AA on ${background}`);
});
