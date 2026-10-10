import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Window } from 'happy-dom';
import { createSession, inputRevision, reduceUnderstanding } from '@inspr/aithema-core';
import { en } from '../src/i18n/en.js';
import { de } from '../src/i18n/de.js';
import { AI_NOTICE } from '../../core/src/ai-notice.js';
import { styles } from '../src/styles.js';
import { settingsStyles } from '../src/settings-styles.js';
import { contrast, mix, textPairs, tokens } from '../../../test/contrast.js';
const window = new Window();
for (const key of ['HTMLElement', 'customElements', 'document', 'CustomEvent']) globalThis[key] = window[key];
await import('../src/session-element.js');
function setup() {
  const component = document.createElement('aithema-session');
  const session = createSession({ demo: true });
  session.featureMatrix = { best: { text: { available: true, reason: null }, analysis: { available: true, reason: null } } };
  component.configure({ copy: structuredClone(en), session });
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
  assert.match(root.querySelector('.features').textContent, /Session paused/);
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
  assert.equal(restarted.querySelector('.engine-tag')?.textContent, `Deep (mock) · ${en.settings.efforts.high}`);
  assert.deepEqual([...root.querySelectorAll('.turn')].map(n => n.dataset.id), ['t1', 'r']);
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
test('pause state changes only after server acknowledgement; a failed resume preserves pause', async () => {
  const c = setup(), original = globalThis.fetch; let release;
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
  assert.equal(root.querySelector('.engine__label').textContent, en.processing);
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
  assert.match(root.querySelector('style').textContent, /height:9rem/);
});

test('an acknowledged switch to EU gates the composer and analysis with their exact reasons and prevents posts', async () => {
  const c = setup(); turn(c, 'first', 'Hello');
  assert.equal(c.shadowRoot.querySelector('textarea').disabled, false);
  assert.equal(c.shadowRoot.querySelector('.retry').hidden, false);
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
  test(`hovered ${preset} composer permits consecutive sends using ${trigger} and blocks overlapping sends`, async () => {
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

test('shortcut send uses sending and feature state even when the button has a stale disabled value', async () => {
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
  assert.equal(root.querySelector('.engine__label').textContent, 'Verarbeitung');
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
  await new Promise(r => setImmediate(r)); assert.equal(root.querySelector('.status').textContent, copy.deviceConnectFirst);
  const device = { async connect() {}, async *stream() { yield 'Hi'; } };
  c.configure({ copy, session: createSession({ processingPreset: 'device' }), deviceReasoning: device });
  root = c.shadowRoot; root.querySelector('textarea').value = 'Hello'; root.querySelector('form').dispatchEvent(new window.Event('submit'));
  await new Promise(r => setImmediate(r)); assert.equal(root.querySelector('.status').textContent, copy.deviceConversation);
  c.configure({ copy, session: createSession({ processingPreset: 'device' }), deviceReasoning: { async connect() { throw new Error(); } } });
  root = c.shadowRoot; root.querySelector('textarea').value = 'Hello'; root.querySelector('form').dispatchEvent(new window.Event('submit'));
  await new Promise(r => setImmediate(r)); assert.equal(root.querySelector('.status').textContent, copy.deviceUnavailable);
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
    assert.equal(c.shadowRoot.querySelector('.retry').hidden, true);
    assert.equal(c.shadowRoot.querySelector('.export').getAttribute('aria-disabled'), 'true');
    assert.equal(c.shadowRoot.querySelector('.export').hasAttribute('href'), false);
    assert.ok(c.shadowRoot.querySelector('.features').textContent.includes(en.reasons['unavailable on device']));
    c.remove(); assert.equal(signal.aborted, true);
  } finally { c.remove(); globalThis.fetch = originalFetch; }
});

test('pause and consent gate sends and preset rows immediately while cached understanding stays visible', async () => {
  const c = setup(), root = c.shadowRoot;
  turn(c, 'input', 'systems: SAP');
  c.receive({ seq: c.session.seq + 1, type: 'understanding.updated', data: understanding(c) });
  const send = root.querySelector('.send'), pause = root.querySelector('.pause'), preset = root.querySelector('.preset-panel');
  preset.dispatchEvent(new window.Event('pointerenter'));
  c.receive({ seq: c.session.seq + 1, type: 'session.paused', data: { paused: true } });
  assert.equal(send.disabled, true); assert.equal(pause.textContent, en.resume);
  assert.match(root.querySelector('.features').textContent, /Session paused/);
  assert.equal(root.querySelector('.status').textContent, en.paused, 'the status line follows the pause');
  assert.equal(root.querySelector('.summary-text').textContent.includes('untrusted'), true);
  assert.equal(root.querySelector('.readiness').style.visibility, '');
  assert.ok([...root.querySelectorAll('.analysis-content section')].every(node => !node.hidden));
  preset.dispatchEvent(new window.Event('pointerleave'));
  assert.match(root.querySelector('.features').textContent, /Session paused/);
  root.querySelector('.transcript-shell').dispatchEvent(new window.Event('pointerenter'));
  root.querySelector('.understanding').dispatchEvent(new window.Event('pointerenter'));
  c.receive({ seq: c.session.seq + 1, type: 'consent.revised', data: { granted: false } });
  assert.equal(send.disabled, true); assert.equal(root.querySelector('.summary-text').textContent, '');
  assert.equal(root.querySelector('.send'), send); assert.equal(root.querySelector('.pause'), pause);
  assert.match(root.querySelector('style').textContent, /min-width:5.5rem/);
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
    assert.equal(c.shadowRoot.querySelector('.send').disabled, true);
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
  const c = setup(), originalFetch = globalThis.fetch, calls = [];
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
    c.configure({ copy: en, session, sessionToken }); document.body.append(c); await tick();
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

test('a reconnect re-reads feature verdicts, so a host restart that dropped consent shows it (D6)', async () => {
  const c = setup(), originalFetch = globalThis.fetch; let streams = 0, refreshed = 0;
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
    assert.equal(root.querySelector('.composer-reason').textContent, en.reasons['current processing consent required']);
    assert.equal(root.querySelector('.notice').textContent, en.reasons['current processing consent required']);
    assert.equal(root.querySelector('.status').textContent, en.connected);
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
  assert.equal(root.querySelector('.composer-reason').textContent, de.reasons['current processing consent required']);
  assert.match(root.querySelector('.features').textContent, /Auswertung/);
});
test('every text pair reaches WCAG AA in light and dark, placeholder, bubbles and tints included (AIT-116 D9, AIT-118)', () => {
  const light = tokens(styles.match(/^:host \{([^}]*)\}/mu)[1], 'aithema-');
  const dark = tokens(styles.match(/@media\(prefers-color-scheme:dark\) \{ :host \{([^}]*)\}/u)[1], 'aithema-');
  const names = ['accent', 'amber', 'error', 'ink', 'line', 'muted', 'on-accent', 'paper', 'surface', 'warning'];
  assert.deepEqual(Object.keys(light).sort(), names); assert.deepEqual(Object.keys(dark).sort(), names);
  // The placeholder uses the muted token, not the browser default (#757575 measured 3.51:1 on the dark surface).
  assert.match(styles, /textarea::placeholder \{ color:var\(--aithema-muted\); opacity:1; \}/u);
  // The light gauge panel's stops are fixed in the settings styles; dark follows the tokens.
  const lightPanel = ['#fffefd', '#faf8f3', '#f7f9f6', '#e6f0ef'];
  const themes = { light: textPairs(light, { primaryText: '#ffffff', gaugePanel: lightPanel }), dark: textPairs(dark, { primaryText: dark.paper }) };
  assert.match(settingsStyles, /\.gauge-panel \{[^}]*radial-gradient\(ellipse at 25% 0%,#fffefd,transparent 65%\),linear-gradient\(155deg,#faf8f3,#f7f9f6 55%,#e6f0ef\); \}/u);
  // The composited layers textPairs models are the ones the styles draw (AIT-118 gate).
  assert.match(styles, /button:where\(:hover:not\(:disabled\)\) \{ background:color-mix\(in srgb,var\(--aithema-accent\) 8%,transparent\); \}/u);
  assert.match(settingsStyles, /\.notice-area\[data-kind\]:not\(\[data-kind=""\]\) \{ background:color-mix\(in srgb,var\(--aithema-amber\) 9%,transparent\); \}/u);
  assert.match(settingsStyles, /\.recovery \{[^}]*background:color-mix\(in srgb,var\(--aithema-amber\) 9%,transparent\); \}/u);
  assert.match(settingsStyles, /\.settings-field legend \{[^}]*color:color-mix\(in oklab,var\(--aithema-ink\) 85%,transparent\); \}/u);
  assert.match(settingsStyles, /\.gauge__value \{[^}]*opacity:\.85; \}/u);
  assert.match(settingsStyles, /\.select__option:hover, \.select__option:focus-visible \{ background:color-mix\(in srgb,var\(--aithema-accent\) 10%,transparent\); \}/u);
  assert.match(settingsStyles, /\.local pre \{[^}]*background:color-mix\(in srgb,var\(--aithema-ink\) 7%,transparent\);/u);
  for (const [theme, pairs] of Object.entries(themes)) {
    for (const pair of ['accent on hover tint over notice tint on surface', 'ink on hover tint over notice tint on paper', 'legend (ink 85 %) on ' + (theme === 'light' ? light : dark).surface,
      `gauge value (ink at 0.85 opacity) on ${theme === 'light' ? '#e6f0ef' : dark.paper}`]) assert.ok(pairs[pair], `${theme}: ${pair} is checked`);
    assert.ok(Object.keys(pairs).length >= 88, `${theme}: ${Object.keys(pairs).length} pairs`);
    for (const [pair, [text, background]] of Object.entries(pairs)) {
      assert.ok(contrast(text, background) >= 4.5, `${theme} ${pair}: ${contrast(text, background).toFixed(2)}:1`);
    }
  }
  // The values AIT-109 reported fail the same check: the test detects them.
  assert.ok(contrast('#67777a', mix(light.accent, light.paper, .12)) < 4.5 && contrast('#67777a', light.paper) < 4.5);
  assert.ok(contrast('#757575', dark.surface) < 4.5, 'the fixture detects the reported default placeholder');
  // No settings colour is fixed to the light theme where dark text or a light fill would invert.
  const darkSettings = settingsStyles.match(/@media\(prefers-color-scheme:dark\) \{([\s\S]*?)\} \}/u)[1];
  assert.match(darkSettings, /\.done, \.chooser__continue \{ color:var\(--aithema-paper\); \}/u);
  assert.match(darkSettings, /\.gauge-panel \{ background:linear-gradient\(155deg,var\(--aithema-surface\),var\(--aithema-paper\)\); \}/u);
  assert.doesNotMatch(settingsStyles, /#89613b|#9a4030|#925125|color:#fff; border-color:var\(--aithema-accent\)/u);
});

// AIT-119, EU AI Act Art. 50(1): the notice stands before the first interaction, in the page language.
test('the AI notice is painted with the first render, ahead of the composer, in English and German (AIT-119)', () => {
  for (const [locale, copy] of [['en', en], ['de', de]]) {
    const c = document.createElement('aithema-session'), session = createSession({ locale, demo: true });
    session.featureMatrix = { best: { text: { available: false, reason: 'current processing consent required' }, analysis: { available: true, reason: null } } };
    c.configure({ copy: structuredClone(copy), session });
    const root = c.shadowRoot, notice = root.querySelector('#ai-notice');
    // Without a voice client only the first sentence shows; the hidden copy keeps the full notice's height.
    assert.equal(notice.textContent, AI_NOTICE[locale].text);
    assert.equal(root.querySelector('.ai-notice__sizer').textContent, `${AI_NOTICE[locale].text} ${AI_NOTICE[locale].voice}`);
    assert.equal(root.querySelector('textarea').disabled, true, 'the composer is still closed while the notice already stands');
    // It sits outside the start card and before the composer, so neither the chooser nor the ready card covers it.
    const line = notice.parentElement;
    assert.equal(line.nextElementSibling, root.querySelector('form.composer'));
    assert.equal(root.querySelector('.intro').contains(line), false);
    session.featureMatrix.best.text = { available: true, reason: null };
    c.configure({ copy: structuredClone(copy), session });
    assert.equal(c.shadowRoot.querySelector('textarea').disabled, false);
    assert.equal(c.shadowRoot.querySelector('#ai-notice').textContent, AI_NOTICE[locale].text);
  }
  assert.equal(AI_NOTICE.en.text, 'You are talking to an AI assistant.');
  assert.equal(AI_NOTICE.de.text, 'Sie sprechen mit einem KI-Assistenten.');
  assert.equal(AI_NOTICE.de.voice, 'Gesprochene Antworten verwenden eine synthetische Stimme.');
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
  assert.equal(c.shadowRoot.querySelector('.ai-notice__sizer').textContent, full);
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
test('screen readers get the AI notice once, as the description of the composer and of starting a call (AIT-119)', () => {
  const c = setup(), root = c.shadowRoot, notice = root.querySelector('#ai-notice');
  assert.deepEqual(root.querySelector('textarea').getAttribute('aria-describedby').split(' '), ['ai-notice', 'composer-reason']);
  for (const name of ['start', 'retry']) assert.equal(root.querySelector(`.voice-${name}`).getAttribute('aria-describedby'), 'ai-notice');
  // Not a live region: it is read with those controls, not re-announced on every render.
  for (let node = notice; node && node !== root; node = node.parentNode) {
    assert.equal(node.getAttribute('aria-live'), null); assert.equal(node.getAttribute('role'), null); assert.equal(node.getAttribute('aria-hidden'), null);
  }
  assert.equal(root.querySelector('.ai-notice__sizer').getAttribute('aria-hidden'), 'true');
  // GUI-27: a plain line, no box, pill or edge accent.
  const css = root.querySelector('style').textContent, rule = css.slice(css.indexOf('.ai-notice {'), css.indexOf('}', css.indexOf('.ai-notice {')));
  for (const banned of ['background', 'border-radius', 'border-left', 'box-shadow', 'outline']) assert.ok(!rule.includes(banned), banned);
});
