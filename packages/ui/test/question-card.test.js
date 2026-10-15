import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Window } from 'happy-dom';
import { createSession, inputRevision } from '@inspr/aithema-core';
import { voiceEvents } from '../../core/src/live-voice.js';
import { manifest } from '../../../plugins/elevenlabs/src/manifest.js';
import { en } from '../src/i18n/en.js';
import { de } from '../src/i18n/de.js';
import { QuestionCard, questionCardMarkup } from '../src/question-card.js';

const window = new Window();
for (const key of ['HTMLElement', 'customElements', 'document', 'CustomEvent']) globalThis[key] = window[key];
await import('../src/session-element.js');
const tick = () => new Promise(resolve => setImmediate(resolve));
const options = [{ text: 'Only finished cushions' }, { text: 'Choose my own design', likely: true }, { text: 'Both' }];
function setup(copy = en, extra = {}) {
  const c = document.createElement('aithema-session'), session = createSession({ demo: true, locale: copy === de ? 'de' : 'en' });
  session.featureMatrix = { best: { text: { available: true }, analysis: { available: true }, voice: { available: true } } };
  c.configure({ copy, session, ...extra });
  c.receive({ seq: c.session.seq + 1, type: 'turn.final', data: { id: 'u', role: 'user', content: 'I sell cushions.' } });
  return c;
}
function question(c, patch = {}) {
  c.receive({ seq: c.session.seq + 1, type: 'turn.final', data: { id: `a${c.session.seq}`, role: 'assistant',
    content: 'Choose a design or a finished cushion?', question_short: 'Choose a design?', options,
    inputRevision: inputRevision(c.session), ...patch } });
}
const shown = c => Boolean(c.shadowRoot.querySelector('.qcard:not([hidden])'));

for (const [copy, heading, suggestion, hint] of [
  [de, 'Offene Frage', 'Vorschlag', 'Ein Klick sendet die Antwort. Oder sprechen oder tippen Sie einfach.'],
  [en, 'Open question', 'Suggestion', 'One click sends the answer. Or just speak or type.'],
]) test(`AIT-132: ${copy.display.locale} approved card copy, likely first and accessible answer rows`, () => {
  const c = setup(copy); question(c); const root = c.shadowRoot, card = root.querySelector('.qcard');
  assert.ok(shown(c)); assert.equal(card.getAttribute('role'), 'group');
  assert.equal(root.querySelector(`#${card.getAttribute('aria-labelledby')}`).textContent, heading);
  assert.equal(root.querySelector('.qtext').textContent, 'Choose a design?');
  assert.equal(root.querySelector('.qhint').textContent, hint);
  const rows = [...card.querySelectorAll('.qopt')];
  assert.deepEqual(rows.map(row => row.querySelector('.t').textContent), [options[1].text, options[0].text, options[2].text]);
  assert.equal(rows[0].querySelector('.tag').textContent, suggestion);
  assert.equal(rows.filter(row => row.classList.contains('likely')).length, 1);
  for (const row of rows) {
    assert.equal(row.tagName, 'BUTTON'); assert.equal(row.type, 'button'); assert.equal(row.tabIndex, 0);
    assert.equal(row.querySelector('.go').getAttribute('aria-hidden'), 'true');
    assert.ok(row.getAttribute('aria-describedby').includes('qhint'));
  }
});

test('AIT-132: questions without valid options and partial questions get no card', () => {
  const c = setup();
  c.receive({ type: 'turn.partial', data: { id: 'partial', delta: 'Choose?', inputRevision: inputRevision(c.session), question_short: 'Choose?', options } });
  assert.equal(shown(c), false);
  for (const patch of [{ options: [] }, { options: undefined }, { options: [{ text: '' }] }, { question_short: undefined }]) {
    question(c, patch); assert.equal(shown(c), false);
  }
});

test('AIT-132: one click sends only the exact option text once, waits for persistence and closes the card', async t => {
  const c = setup(); question(c, { options: [{ text: '  Both\ncolours  ', likely: true }] });
  const root = c.shadowRoot, input = root.querySelector('textarea'); input.value = 'A separate draft';
  const calls = [], held = Promise.withResolvers();
  t.mock.method(globalThis, 'fetch', async (url, request) => { calls.push({ url, body: JSON.parse(request.body) }); return held.promise; });
  const button = root.querySelector('.qopt'); button.click(); button.click();
  assert.equal(button.disabled, false); assert.equal(button.getAttribute('aria-disabled'), 'true');
  assert.equal(calls.length, 1); assert.equal(calls[0].body.content, '  Both\ncolours  ');
  assert.match(calls[0].url, /\/turns$/u); assert.equal(shown(c), true, 'the question stays until its answer is persisted');
  held.resolve(Response.json({ seq: c.session.seq + 1, type: 'turn.final', data: { id: 'answer', role: 'user', content: calls[0].body.content } }));
  await tick();
  assert.equal(c.session.transcript.at(-1).role, 'user'); assert.equal(c.session.transcript.at(-1).content, '  Both\ncolours  ');
  assert.equal(shown(c), false); assert.equal(input.value, 'A separate draft');
});

test('AIT-132: a failed answer retains the card and retries the same visitor-turn identity and bytes', async t => {
  const c = setup(); question(c); const bodies = []; let fail = true;
  t.mock.method(globalThis, 'fetch', async (url, request) => {
    bodies.push(request.body); if (fail) return new Response(null, { status: 503 });
    const body = JSON.parse(request.body);
    return Response.json({ seq: c.session.seq + 1, type: 'turn.final', data: { id: body.clientEventId, role: 'user', content: body.content } });
  });
  c.shadowRoot.querySelector('.qopt').click(); await tick(); assert.equal(shown(c), true);
  fail = false; c.shadowRoot.querySelector('.qopt').click(); await tick();
  assert.equal(bodies.length, 2); assert.equal(bodies[0], bodies[1]); assert.equal(shown(c), false);
});

test('AIT-132: device streams use the same card contract while retaining canonical local turns and the draft', async t => {
  const requests = [], c = document.createElement('aithema-session');
  t.mock.method(globalThis, 'fetch', async () => assert.fail('Device answers stay in this tab'));
  c.configure({ copy: en, session: createSession({ processingPreset: 'device' }), deviceReasoning: {
    model: 'local-fixture', id: 'device', async connect() {}, async *stream(request) {
      requests.push(request); assert.match(request.system, /question_short/u);
      const answer = requests.length === 1 ? { content: 'Choose a design?', question_short: 'Choose a design?', options }
        : { content: 'That answers the question.', question_short: null, options: [] };
      const wire = JSON.stringify(answer);
      for (let i = 0; i < wire.length; i += 12) yield wire.slice(i, i + 12);
    },
  } });
  const root = c.shadowRoot, input = root.querySelector('textarea'); input.value = 'I sell cushions.';
  root.querySelector('form').dispatchEvent(new window.Event('submit', { cancelable: true })); await tick();
  assert.equal(shown(c), true); assert.deepEqual(requests[0].messages, [{ role: 'user', content: 'I sell cushions.' }]);
  assert.equal(root.querySelectorAll('.partial').length, 0);
  input.value = 'A separate draft'; root.querySelector('.qopt').click(); await tick();
  assert.equal(c.session.transcript.filter(turn => turn.role === 'user').at(-1).content, options[1].text);
  assert.equal(requests[1].messages.at(-1).content, options[1].text); assert.equal(input.value, 'A separate draft');
  assert.equal(shown(c), false);
});

test('AIT-132: card text is inert and keyed answer focus survives unrelated updates', async t => {
  t.mock.method(globalThis, 'fetch', async (url, request = {}) => new Response(new ReadableStream({ start(controller) {
    request.signal?.addEventListener('abort', () => controller.close(), { once: true });
  } })));
  const c = setup(); document.body.append(c); t.after(() => c.remove());
  question(c, { question_short: '<img src=x onerror=alert(1)>?', options: [{ text: '<script>answer</script>', likely: true }] });
  const root = c.shadowRoot, button = root.querySelector('.qopt'); button.focus();
  assert.equal(root.querySelector('.qcard img, .qcard script'), null);
  c.receive({ type: 'lane.status', data: { inputRevision: inputRevision(c.session), running: ['understanding'] } });
  assert.equal(root.querySelector('.qopt'), button); assert.equal(root.activeElement, button);
});

test('AIT-132: fold strip follows an unanswered question in both languages, including questions without options', () => {
  for (const copy of [de, en]) {
    const c = setup(copy), root = c.shadowRoot; question(c); root.querySelector('.fold').click();
    assert.equal(root.querySelector('.fold-question').hidden, false);
    assert.equal(root.querySelector('.fold-question').textContent, copy.layout.openQuestion);
    c.receive({ seq: c.session.seq + 1, type: 'turn.final', data: { id: 'spoken', role: 'user', content: 'Both', provenance: { source: 'voice' } } });
    assert.equal(root.querySelector('.fold-question').hidden, true);
    question(c, { options: [] });
    assert.equal(shown(c), false); assert.equal(root.querySelector('.fold-question').hidden, false);
  }
});

test('AIT-132: card answers use active voice forwarding once, and speaking closes only on a durable visitor event', async t => {
  const events = voiceEvents(), commands = []; let callId;
  const c = setup(en, { voiceClient: { manifest, async start(request) {
    callId = request.callId;
    return { callId, providerSessionId: 'qcard-voice', events,
      async setInput(value) { commands.push(['input', value]); }, async setOutput() {},
      async sendText(value) { commands.push(['text', value]); }, async updateContext(value) { commands.push(['context', value]); },
      async close() { events.end(); return { closureConfirmed: true }; } };
  } } });
  t.after(() => c.configure({ copy: en, session: createSession() }));
  t.mock.method(globalThis, 'fetch', async (url, request) => {
    const body = JSON.parse(request.body); commands.push(['persist', body]);
    return Response.json({ seq: c.session.seq + 1, type: 'turn.final', data: { id: body.clientEventId, role: 'user', content: body.content, voiceCallId: body.voiceCallId } });
  });
  c.shadowRoot.querySelector('.voice-start').click(); await tick(); question(c);
  assert.equal(c.shadowRoot.querySelector('.audio-rail').dataset.call, 'active');
  c.shadowRoot.querySelector('.voice-input').click(); await tick(); c.shadowRoot.querySelector('.voice-input').click(); await tick();
  assert.equal(shown(c), true); assert.ok(commands.some(([name]) => name === 'input'));
  c.shadowRoot.querySelector('.qopt').click(); await tick();
  assert.equal(shown(c), false); assert.equal(commands.filter(([name]) => name === 'text').length, 1);
  assert.equal(commands.find(([name]) => name === 'text')[1], options[1].text);
  assert.ok(commands.findIndex(([name]) => name === 'persist') < commands.findIndex(([name]) => name === 'text'));
  question(c);
  events.push({ type: 'partial', turnId: 'spoken', callId, providerSessionId: 'qcard-voice', role: 'user', text: 'Both' }); await tick();
  assert.equal(shown(c), true, 'captions alone do not persist an answer');
  c.receive({ seq: c.session.seq + 1, type: 'turn.final', data: { id: 'spoken', role: 'user', content: 'Both', callId, providerSessionId: 'qcard-voice' } });
  assert.equal(shown(c), false); assert.equal(c.shadowRoot.querySelector('.audio-rail').dataset.call, 'active');
});

test('AIT-225: the options scroll region has a translated accessible name and remains keyboard ordered across unrelated updates', () => {
  for (const copy of [en, de]) {
    const c = setup(copy); question(c);
    const root = c.shadowRoot, region = root.querySelector('.qopts'), buttons = [...region.children];
    assert.equal(region.getAttribute('role'), 'region');
    assert.equal(root.querySelector(`#${region.getAttribute('aria-labelledby')}`).textContent, copy.questionCard.heading);
    c.receive({ type: 'lane.status', data: { inputRevision: inputRevision(c.session), running: ['understanding'] } });
    assert.deepEqual([...region.children], buttons);
    assert.ok(buttons.every(button => button.tabIndex === 0));
  }
});

test('AIT-225: a held reservation releases only when the scroll position cannot clamp, without following the new end', () => {
  const host = document.createElement('div'), root = host.attachShadow({ mode: 'open' });
  root.innerHTML = `<div class="conversation"></div><div class="transcript-shell"></div>${questionCardMarkup}<textarea></textarea>`;
  const shell = root.querySelector('.transcript-shell');
  Object.defineProperties(shell, { scrollHeight: { value: 1500 }, clientHeight: { value: 300 } });
  shell.scrollTop = 1200;
  let following = true, resizes = 0;
  const card = new QuestionCard({ root, send() {}, followsTranscript: () => following, onResize: () => resizes++ });
  card.card.getBoundingClientRect = () => ({ height: 290 });
  card.update({ turnId: 'reply', question_short: 'Choose?', options }, en, false);
  const reserved = () => root.querySelector('.conversation').style.getPropertyValue('--question-card-height');
  assert.equal(reserved(), '290px');
  following = false; card.card.getBoundingClientRect = () => ({ height: 150 });
  card.reserve(); assert.equal(reserved(), '290px', 'a shorter card must not clamp a reading scroll position');
  card.update(null, en, false);
  assert.equal(reserved(), '290px', 'closing a question must not clamp a reading scroll position');
  following = true; card.reserve();
  assert.equal(reserved(), '290px', 'following at the old bottom must not release and clamp visible text');
  shell.scrollTop = 500; following = false; card.reserve();
  assert.equal(reserved(), '0px'); assert.equal(shell.scrollTop, 500, 'release preserves the reading position');
  card.reserve(); assert.equal(resizes, 1, 'release must not call the follow callback or cause another scroll');
  card.destroy();
});

test('AIT-225: scroll and visual viewport resize reservations coalesce into one animation frame and disconnect cleanly', t => {
  const host = document.createElement('div'), root = host.attachShadow({ mode: 'open' });
  root.innerHTML = `<div class="conversation"></div><div class="transcript-shell"></div>${questionCardMarkup}`;
  const descriptor = Object.getOwnPropertyDescriptor(window, 'visualViewport'), viewport = new window.EventTarget();
  Object.defineProperty(window, 'visualViewport', { configurable: true, value: viewport });
  t.after(() => { if (descriptor) Object.defineProperty(window, 'visualViewport', descriptor); else delete window.visualViewport; });
  const frames = [], cancelled = [];
  t.mock.method(window, 'requestAnimationFrame', callback => { frames.push(callback); return frames.length; });
  t.mock.method(window, 'cancelAnimationFrame', id => cancelled.push(id));
  const card = new QuestionCard({ root, send() {} });
  let calls = 0; t.mock.method(card, 'reserve', () => calls++);
  card.scheduleReserve(); card.scheduleReserve(); viewport.dispatchEvent(new window.Event('resize'));
  window.dispatchEvent(new window.Event('resize'));
  assert.equal(frames.length, 1); assert.equal(calls, 0, 'events do no synchronous layout work');
  frames[0](); assert.equal(calls, 1);
  viewport.dispatchEvent(new window.Event('resize'));
  assert.equal(frames.length, 2, 'a later visual viewport resize schedules fresh geometry');
  card.destroy(); assert.deepEqual(cancelled, [2]);
  viewport.dispatchEvent(new window.Event('resize')); window.dispatchEvent(new window.Event('resize'));
  assert.equal(frames.length, 2, 'disconnect removes both resize listeners');
});
