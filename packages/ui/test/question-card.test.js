import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Window } from 'happy-dom';
import { createSession, inputRevision } from '@inspr/aithema-core';
import { voiceEvents } from '../../core/src/live-voice.js';
import { manifest } from '../../../plugins/elevenlabs/src/manifest.js';
import { en } from '../src/i18n/en.js';
import { de } from '../src/i18n/de.js';

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
  events.push({ type: 'partial', callId, providerSessionId: 'qcard-voice', role: 'user', text: 'Both' }); await tick();
  assert.equal(shown(c), true, 'captions alone do not persist an answer');
  c.receive({ seq: c.session.seq + 1, type: 'turn.final', data: { id: 'spoken', role: 'user', content: 'Both', callId, providerSessionId: 'qcard-voice' } });
  assert.equal(shown(c), false); assert.equal(c.shadowRoot.querySelector('.audio-rail').dataset.call, 'active');
});
