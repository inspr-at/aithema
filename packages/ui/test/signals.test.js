import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Window } from 'happy-dom';
import './fixtures/page-origin.js';
import { createSession, inputRevision, reduceUnderstanding } from '@inspr/aithema-core';
import { en } from '../src/i18n/en.js';
import { de } from '../src/i18n/de.js';
import { styles } from '../src/styles.js';
import { reasonSeparator } from '../src/consent-line.js';
const window = new Window({ url: 'http://localhost/' });
for (const key of ['HTMLElement', 'customElements', 'document', 'CustomEvent']) globalThis[key] = window[key];
await import('../src/session-element.js');
function setup(copy = en) {
  const c = document.createElement('aithema-session'), session = createSession({ demo: true });
  session.featureMatrix = { best: { text: { available: true }, analysis: { available: true } } };
  c.configure({ session, copy }); return c;
}
function final(c, signals) {
  const s = c.session;
  c.receive({ seq: s.seq + 1, type: 'understanding.updated', data: reduceUnderstanding(s.understanding,
    { signals, constraints: {}, progress: {}, summary: 'You use orders.', openQuestions: [] }, { transcript: s.transcript, inputRevision: inputRevision(s) }) });
}
function connectForFocus(c, t) {
  const original = globalThis.fetch;
  globalThis.fetch = async (url, init = {}) => String(url).endsWith('/events')
    ? new Response(new ReadableStream({ start(controller) {
      init.signal?.addEventListener('abort', () => { try { controller.close(); } catch {} }, { once: true });
    } })) : Response.json(c.session);
  c.receive({ seq: c.session.seq + 1, type: 'turn.final', data: { id: 'visitor', role: 'user', content: 'We use orders.' } });
  document.body.append(c);
  t.after(() => { c.remove(); globalThis.fetch = original; });
}
const texts = c => [...c.shadowRoot.querySelectorAll('.signal-text')].map(n => n.textContent);
const seven = ['One', 'Two', 'Three', 'Four', 'Five', 'Six', 'Seven'];

test('AIT-515 newest five and accessible Show all count; expand/collapse keeps focus and conversation state', t => {
  const c = setup(); connectForFocus(c, t); final(c, seven); const root = c.shadowRoot, button = root.querySelector('.signals-toggle');
  assert.deepEqual(texts(c), seven.slice(0, 5));
  assert.equal(button.textContent, 'Show all (7)'); assert.equal(button.getAttribute('aria-expanded'), 'false');
  assert.equal(button.getAttribute('aria-controls'), root.querySelector('.signals').id);
  button.focus(); button.click(); assert.deepEqual(texts(c), seven); assert.equal(button.textContent, 'Show less');
  final(c, seven); assert.equal(root.activeElement === button, true);
  button.blur(); final(c, [...seven, 'Newest']); button.focus(); assert.equal(root.activeElement === button, true); assert.equal(texts(c).length, 8);
  assert.equal(texts(c)[0], 'Newest'); button.click(); assert.equal(texts(c).length, 5); assert.equal(root.activeElement === button, true);
});

test('AIT-515 five or fewer has no toggle; only assistant basis has an unconfirmed tag; hostile text stays text', () => {
  const c = setup(); final(c, [{ text: '<img src=x onerror=alert(1)>', basis: 'assistant' }, { text: 'Document fact', basis: 'document' }, 'Legacy']);
  const root = c.shadowRoot;
  assert.equal(root.querySelector('.signals-toggle').hidden, true);
  assert.equal(root.querySelectorAll('.signal-basis').length, 1); assert.equal(root.querySelector('.signal-basis').textContent, 'unconfirmed');
  assert.equal(root.querySelector('.signals img'), null);
  assert.equal(texts(c)[0], '<img src=x onerror=alert(1)>');
});

test('AIT-515 impersonal German and host overrides win', () => {
  const c = setup(de); final(c, [...seven, { text: 'Suggestion', basis: 'assistant' }]);
  assert.equal(c.shadowRoot.querySelector('.signals-toggle').textContent, 'Alle anzeigen (8)');
  c.shadowRoot.querySelector('.signals-toggle').click();
  assert.equal(c.shadowRoot.querySelector('.signals-toggle').textContent, 'Weniger anzeigen');
  assert.equal(c.shadowRoot.querySelector('.signal-basis').textContent, 'unbestätigt');
  const custom = setup({ ...en, signalsAll: 'All {n}', showLess: 'Close list', signalUnconfirmed: 'Needs confirmation' });
  final(custom, seven); assert.equal(custom.shadowRoot.querySelector('.signals-toggle').textContent, 'All 7');
  custom.shadowRoot.querySelector('.signals-toggle').click(); assert.equal(custom.shadowRoot.querySelector('.signals-toggle').textContent, 'Close list');
});

test('AIT-515 first/whole list never highlights; only one to three new keys highlight once for two seconds', t => {
  t.mock.timers.enable({ apis: ['setTimeout', 'Date'], now: 1_800_000_000_000 });
  const c = setup(); final(c, seven); const root = c.shadowRoot;
  assert.equal(root.querySelectorAll('[data-signal-new]').length, 0);
  final(c, [...seven, 'New']); assert.equal(root.querySelectorAll('[data-signal-new]').length, 1);
  final(c, [...seven, 'New']); assert.equal(root.querySelectorAll('[data-signal-new]').length, 1);
  t.mock.timers.tick(2000); assert.equal(root.querySelectorAll('[data-signal-new]').length, 0);
  final(c, [...seven, 'New']); assert.equal(root.querySelectorAll('[data-signal-new]').length, 0);
  final(c, [...seven, 'New', 'A', 'B', 'C', 'D']); assert.equal(root.querySelectorAll('[data-signal-new]').length, 0);
});

test('AIT-515 pointer and focus defer model list changes until both leave', t => {
  const c = setup(); connectForFocus(c, t); final(c, seven); const root = c.shadowRoot, list = root.querySelector('.signals');
  list.dispatchEvent(new window.Event('pointerenter'));
  final(c, [...seven, 'Newest']); assert.deepEqual(texts(c), seven.slice(0, 5));
  list.dispatchEvent(new window.Event('pointerleave')); assert.deepEqual(texts(c), ['Newest', ...seven.slice(0, 4)]);
  root.querySelector('.signals-toggle').focus();
  final(c, [...seven, 'Newest', 'Latest']); assert.equal(texts(c)[0], 'Newest');
  root.querySelector('.signals-toggle').blur();
  root.querySelector('.signals-section').dispatchEvent(new window.FocusEvent('focusout'));
  assert.equal(texts(c)[0], 'Latest');
  root.querySelector('.signals-section').dispatchEvent(new window.Event('pointerenter'));
  final(c, [...seven, 'Newest', 'Latest', 'Current']); assert.equal(texts(c)[0], 'Latest', 'hovering the toggle also defers changes');
  root.querySelector('.signals-section').dispatchEvent(new window.Event('pointerleave'));
  assert.equal(texts(c)[0], 'Current');
});

test('AIT-515 reset preserves identities without a highlight storm; erasure and a different conversation clear expansion', () => {
  const c = setup(); final(c, seven); c.shadowRoot.querySelector('.signals-toggle').click();
  c.receive({ seq: c.session.seq + 1, type: 'upload.state', data: { id: 'doc', state: 'accepted' } });
  final(c, seven); assert.equal(texts(c).length, 7); assert.equal(c.shadowRoot.querySelectorAll('[data-signal-new]').length, 0);
  c.receive({ seq: c.session.seq + 1, type: 'session.erased', data: { at: 'erased' } });
  assert.equal(c.shadowRoot.querySelector('.signals-toggle').hidden, true); assert.deepEqual(texts(c), []);
  const fresh = setup().session; c.configure({ session: fresh, copy: en }); final(c, seven);
  assert.equal(texts(c).length, 5);
});

test('AIT-515 same-conversation configure and five-item interval retain expansion; reconnect never replays highlights', () => {
  const c = setup(); final(c, seven); c.shadowRoot.querySelector('.signals-toggle').click();
  c.shadowRoot.querySelector('.signals-toggle').blur();
  final(c, seven.slice(0, 3)); assert.equal(c.shadowRoot.querySelector('.signals-toggle').hidden, true);
  final(c, seven); assert.equal(texts(c).length, 7, 'temporary short lists retain the expanded preference');
  c.configure({ session: c.session, copy: en });
  assert.equal(texts(c).length, 7, 'same-conversation configure retains expansion');
  assert.equal(c.shadowRoot.querySelectorAll('[data-signal-new]').length, 0, 'snapshot mount is quiet');
  const fresh = setup().session;
  c.configure({ session: fresh, copy: en }); final(c, seven);
  assert.equal(texts(c).length, 5, 'different conversation resets expansion');
});

test('AIT-515 SSE backlog and reconnect are quiet, then live signals highlight after lane status', async t => {
  t.mock.timers.enable({ apis: ['setTimeout', 'Date'], now: 1_800_000_000_000 });
  const c = setup(), controllers = [], original = globalThis.fetch, encoder = new TextEncoder();
  // AIT-495 may yield after a render consumes its work slice. Drain its
  // zero-delay task on the same paused clock without spending highlight time.
  const settle = async () => {
    for (let i = 0; i < 4; i++) { t.mock.timers.tick(0); await new Promise(resolve => setImmediate(resolve)); }
  };
  final(c, seven);
  globalThis.fetch = async (url, init = {}) => String(url).endsWith('/events')
    ? new Response(new ReadableStream({ start(controller) {
      controllers.push(controller);
      init.signal?.addEventListener('abort', () => { try { controller.close(); } catch {} }, { once: true });
    } })) : Response.json(c.session);
  t.after(() => { c.remove(); globalThis.fetch = original; });
  document.body.append(c); await settle();
  assert.equal(controllers.length, 1);
  const send = (controller, event) => controller.enqueue(encoder.encode(`data: ${JSON.stringify(event)}\n\n`));
  const assessment = (controller, signals) => {
    const s = c.session;
    send(controller, { seq: s.seq + 1, type: 'understanding.updated', data: reduceUnderstanding(s.understanding,
      { signals, constraints: {}, progress: {}, summary: 'You use orders.', openQuestions: [] },
      { transcript: s.transcript, inputRevision: inputRevision(s) }) });
  };
  const ready = controller => send(controller, { type: 'lane.status', data: { inputRevision: inputRevision(c.session), running: [], failures: [], lastFailure: null } });
  assessment(controllers[0], [...seven, 'Replayed']); await settle();
  assert.equal(texts(c)[0], 'Replayed');
  assert.equal(c.shadowRoot.querySelectorAll('[data-signal-new]').length, 0, 'initial SSE backlog is not a live arrival');
  ready(controllers[0]); await settle();
  assessment(controllers[0], [...seven, 'Replayed', 'Live']); await settle();
  assert.equal(c.shadowRoot.querySelectorAll('[data-signal-new]').length, 1, 'post-barrier live arrival highlights');
  controllers[0].close(); await settle(); t.mock.timers.tick(1000); await settle();
  assert.equal(controllers.length, 2);
  assessment(controllers[1], [...seven, 'Replayed', 'Live', 'Reconnect']); await settle();
  assert.equal(texts(c)[0], 'Reconnect');
  assert.equal(c.shadowRoot.querySelectorAll('[data-signal-new]').length, 0, 'reconnect clears old marks and never replays them');
  ready(controllers[1]); await settle();
  assessment(controllers[1], [...seven, 'Replayed', 'Live', 'Reconnect', 'Live again']); await settle();
  assert.equal(c.shadowRoot.querySelectorAll('[data-signal-new]').length, 1);
});

test('AIT-515 an empty final defers hiding under the pointer; a source reset still clears immediately', () => {
  const c = setup(); final(c, seven); const root = c.shadowRoot, list = root.querySelector('.signals');
  list.dispatchEvent(new window.Event('pointerenter'));
  final(c, []);
  assert.deepEqual(texts(c), seven.slice(0, 5), 'empty final cannot remove the row under a resting pointer');
  assert.equal(root.querySelector('.signals-section').hidden, false);
  list.dispatchEvent(new window.Event('pointerleave'));
  assert.deepEqual(texts(c), []); assert.equal(root.querySelector('.signals-section').hidden, true);
  final(c, seven); list.dispatchEvent(new window.Event('pointerenter'));
  c.receive({ seq: c.session.seq + 1, type: 'consent.revised', data: { granted: false } });
  assert.deepEqual(texts(c), [], 'privacy withdrawal never waits on pointer departure');
  assert.equal(root.querySelector('.signals-section').hidden, true);
});

test('AIT-515 four arrivals accumulated behind the pointer never flash as a whole batch', () => {
  const c = setup(); final(c, seven); const root = c.shadowRoot, list = root.querySelector('.signals');
  list.dispatchEvent(new window.Event('pointerenter'));
  const added = [];
  for (const text of ['Arrival A', 'Arrival B', 'Arrival C', 'Arrival D']) {
    added.push(text); final(c, [...seven, ...added]);
  }
  assert.deepEqual(texts(c), seven.slice(0, 5));
  list.dispatchEvent(new window.Event('pointerleave'));
  assert.equal(texts(c)[0], 'Arrival D');
  assert.equal(root.querySelectorAll('[data-signal-new]').length, 0, 'more than three newly displayed keys stay quiet');
});


test('AIT-515 r10 latest held final replaces a pending addition even when it matches the displayed rows', () => {
  const c = setup(); final(c, seven);
  const root = c.shadowRoot, list = root.querySelector('.signals');
  list.dispatchEvent(new window.Event('pointerenter'));
  final(c, [...seven, 'Withdrawn suggestion']);
  assert.deepEqual(texts(c), seven.slice(0, 5), 'pending addition stays held');
  final(c, seven);
  list.dispatchEvent(new window.Event('pointerleave'));
  assert.deepEqual(texts(c), seven.slice(0, 5), 'the latest final wins when the pointer leaves');
  assert.equal(root.querySelectorAll('[data-signal-new]').length, 0, 'a dropped pending addition never highlights');
  assert.equal(root.querySelector('.signals-toggle').textContent, 'Show all (7)');
});

test('AIT-515 r10 assistant provenance has a separator and matching impersonal headings retain host overrides', () => {
  for (const [copy, heading, label] of [[en, 'Signals', 'unconfirmed'], [de, 'Signale', 'unbestätigt']]) {
    const c = setup(copy); final(c, [{ text: 'Suggestion', basis: 'assistant' }]);
    assert.equal(c.shadowRoot.querySelector('.signal-provenance').textContent, `${reasonSeparator}${label}`);
    assert.equal(c.shadowRoot.querySelector('#signals-title').textContent, heading);
  }
  const c = setup({ ...de, signals: 'Host heading', signalUnconfirmed: 'Host basis' });
  final(c, [{ text: 'Suggestion', basis: 'assistant' }]);
  assert.equal(c.shadowRoot.querySelector('#signals-title').textContent, 'Host heading');
  assert.equal(c.shadowRoot.querySelector('.signal-provenance').textContent, `${reasonSeparator}Host basis`);
});

test('AIT-515 r10 arrival tint has no edge stripe or shadow', () => {
  const rule = styles.match(/\.signals li\[data-signal-new\] \{([^}]+)\}/u)?.[1];
  assert.ok(rule, 'arrival style exists');
  assert.doesNotMatch(rule, /box-shadow|border-(?:left|inline-start)/u, 'arrival tint leaves the bullet unobstructed');
});
