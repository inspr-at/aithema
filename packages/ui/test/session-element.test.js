import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Window } from 'happy-dom';
import { createSession, inputRevision, reduceUnderstanding } from '@inspr/aithema-core';
import { en } from '../src/i18n/en.js';
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

test('the engine panel keeps its fixed size, defers snapshot feature updates under the pointer and offers settings', async () => {
  const c = setup();
  const session = c.session;
  session.featureMatrix.best.analysis = { available: false, reason: 'binding evidence expired' };
  c.configure({ copy: en, session });
  const root = c.shadowRoot;
  assert.equal(root.querySelector('.engine__value').textContent, 'Best models');
  assert.equal(root.querySelector('.engine__label').textContent, en.processing);
  assert.equal(root.querySelector('.settings-open').getAttribute('aria-haspopup'), 'dialog');
  assert.equal(root.querySelector('.preset-choice'), null, 'presets change through acknowledged settings, never a raw select');
  assert.match(root.querySelector('.features').textContent, /binding evidence expired/);
  assert.ok(!root.querySelector('.features li').classList.contains('unavailable'));
  root.querySelector('.preset-panel').dispatchEvent(new window.Event('pointerenter'));
  const originalFetch = globalThis.fetch;
  const next = c.session; next.featureMatrix.best = {};
  globalThis.fetch = async () => Response.json(next);
  try {
    c.receive({ seq: c.session.seq + 2, type: 'turn.final', data: {} });
    await new Promise(r => setImmediate(r));
    assert.match(root.querySelector('.features').textContent, /binding evidence expired/);
    root.querySelector('.preset-panel').dispatchEvent(new window.Event('pointerleave'));
    assert.ok(!root.querySelector('.features').textContent.includes('binding evidence expired'));
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
  assert.match(root.querySelector('.composer').textContent, /not configured/);
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
    assert.equal(root.querySelector('.composer-reason').textContent, 'session paused');
    assert.equal(root.querySelector('.composer-reason').title, 'session paused');
    assert.equal(root.querySelector('.retry').hidden, false);
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
    assert.match(c.shadowRoot.querySelector('.features').textContent, /unavailable on device/);
    c.remove(); assert.equal(signal.aborted, true);
  } finally { c.remove(); globalThis.fetch = originalFetch; }
});

test('pause and consent gate sends immediately while preset updates defer and cached understanding stays visible', async () => {
  const c = setup(), root = c.shadowRoot;
  turn(c, 'input', 'systems: SAP');
  c.receive({ seq: c.session.seq + 1, type: 'understanding.updated', data: understanding(c) });
  const send = root.querySelector('.send'), pause = root.querySelector('.pause'), preset = root.querySelector('.preset-panel');
  preset.dispatchEvent(new window.Event('pointerenter'));
  const features = root.querySelector('.features').textContent;
  c.receive({ seq: c.session.seq + 1, type: 'session.paused', data: { paused: true } });
  assert.equal(send.disabled, true); assert.equal(pause.textContent, en.resume);
  assert.equal(root.querySelector('.features').textContent, features);
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
    assert.equal(list.querySelector('.user'), row); assert.equal(row.querySelector('.withdraw'), button);
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
