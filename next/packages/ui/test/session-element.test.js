import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Window } from 'happy-dom';
import { createSession, inputRevision, reduceUnderstanding } from '@inspr/aithema-next-core';
import { en } from '../src/i18n/en.js';
const window = new Window();
for (const key of ['HTMLElement', 'customElements', 'document', 'CustomEvent']) globalThis[key] = window[key];
await import('../src/session-element.js');
function setup() {
  const component = document.createElement('aithema-session');
  component.configure({ copy: structuredClone(en), session: createSession({ demo: true }) });
  return component;
}
function turn(component, id, content) { component.receive({ seq: component.session.seq + 1, type: 'turn.final',
  data: { id, role: 'user', content } }); }
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
  const c = setup(), root = c.shadowRoot; turn(c, 't1', 'SAP');
  c.receive({ seq: c.session.seq + 1, type: 'understanding.updated', data: understanding(c, true) });
  assert.equal(root.querySelector('.notice').textContent, en.draft); assert.equal(root.querySelector('.scale').getAttribute('aria-valuenow'), '47');
  assert.equal(root.querySelectorAll('.missing li').length, 5); assert.match(root.querySelector('.overflow').textContent, /1 more/);
  const details = root.querySelector('details'); details.open = true;
  c.receive({ seq: c.session.seq + 1, type: 'understanding.updated', data: understanding(c) });
  assert.equal(root.querySelector('details'), details); assert.equal(details.open, true);
  assert.equal(root.querySelector('.summary-text script'), null); assert.equal(root.querySelector('.notice').textContent, en.final);
  root.querySelector('.expand').click(); assert.equal(details.open, false);
  root.querySelector('.expand').click(); assert.equal(details.open, true);
  turn(c, 't2', 'More'); assert.equal(root.querySelector('.notice').textContent, en.stale);
});
test('automatic aside and transcript changes wait while the pointer is over their region', () => {
  const c = setup(), root = c.shadowRoot;
  root.querySelector('.transcript-shell').dispatchEvent(new window.Event('pointerenter'));
  turn(c, 't1', 'SAP'); assert.equal(root.querySelectorAll('.turn').length, 0);
  root.querySelector('.transcript-shell').dispatchEvent(new window.Event('pointerleave'));
  assert.equal(root.querySelectorAll('.turn').length, 1);
  root.querySelector('.understanding').dispatchEvent(new window.Event('pointerenter'));
  c.receive({ seq: c.session.seq + 1, type: 'understanding.updated', data: understanding(c) });
  assert.equal(root.querySelector('.summary-text').textContent, '');
  root.querySelector('.understanding').dispatchEvent(new window.Event('pointerleave'));
  assert.match(root.querySelector('.summary-text').textContent, /untrusted/);
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
test('Enter inserts a newline; Ctrl/Cmd+Enter sends; failed acknowledgement retries identical id and bytes', async () => {
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
    fail = false; input.dispatchEvent(new window.KeyboardEvent('keydown', { key: 'Enter', metaKey: true, bubbles: true, cancelable: true }));
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
test('fresh configure after lane failure exposes Retry for unfinished understanding or a missing reply', () => {
  const c = setup(); turn(c, 'first', 'First');
  c.receive({ type: 'lane.failed', data: { lane: 'understanding', error: 'reasoning-unavailable' } });
  c.configure({ copy: en, session: c.session });
  assert.equal(c.shadowRoot.querySelector('.retry').hidden, false);
  c.receive({ seq: c.session.seq + 1, type: 'understanding.updated', data: understanding(c) });
  c.configure({ copy: en, session: c.session });
  assert.equal(c.shadowRoot.querySelector('.retry').hidden, false, 'the latest person turn still has no reply');
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
  assert.equal(c.shadowRoot.querySelector('.notice').textContent, en.reasoningFailed);
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
test.after(async () => window.happyDOM.close());
