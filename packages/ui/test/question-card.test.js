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
    assert.equal(row.getAttribute('aria-label'), row.querySelector('.t').textContent + (row.classList.contains('likely') ? `, ${suggestion}` : ''));
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
  c.shadowRoot.querySelector('.workspace').setAttribute('data-phone-short', ''); question(c);
  assert.equal(c.shadowRoot.querySelector('textarea').placeholder, en.placeholderCompact, 'compact mode keeps one-line copy during an active call too');
  c.shadowRoot.querySelector('.workspace').removeAttribute('data-phone-short'); question(c);
  assert.equal(c.shadowRoot.querySelector('textarea').placeholder, en.placeholderVoice, 'the expanded composer restores its voice invitation');
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

test('AIT-225: shrinking or closing the card reserves only its visible height, including while reading', () => {
  const host = document.createElement('div'), root = host.attachShadow({ mode: 'open' });
  root.innerHTML = `<div class="conversation"></div><div class="transcript-shell"></div>${questionCardMarkup}<textarea></textarea>`;
  const shell = root.querySelector('.transcript-shell');
  let following = true;
  const card = new QuestionCard({ root, send() {}, followsTranscript: () => following });
  card.card.getBoundingClientRect = () => ({ height: 290 });
  card.update({ turnId: 'reply', question_short: 'Choose?', options }, en, false);
  const reserved = () => root.querySelector('.conversation').style.getPropertyValue('--question-card-height');
  assert.equal(reserved(), '290px');
  following = false; card.card.getBoundingClientRect = () => ({ height: 150 });
  card.reserve(); assert.equal(reserved(), '150px', 'no obsolete band survives a shorter card');
  card.update(null, en, false); assert.equal(reserved(), '0px', 'closing leaves no empty reservation');
  for (const event of [new window.Event('scroll'), new window.WheelEvent('wheel', { deltaY: 100 }), new window.KeyboardEvent('keydown', { key: 'End' })]) {
    shell.dispatchEvent(event); card.reserve();
    assert.equal(reserved(), '0px', 'scroll intent has no retained band to collapse');
  }
  card.destroy();
});

test('AIT-225: scroll and visual viewport resize reservations coalesce into one animation frame and disconnect cleanly', t => {
  const view = new Window(), host = view.document.createElement('div'), root = host.attachShadow({ mode: 'open' });
  root.innerHTML = `<div class="conversation"></div><div class="transcript-shell"></div>${questionCardMarkup}`;
  const descriptor = Object.getOwnPropertyDescriptor(view, 'visualViewport'), viewport = new view.EventTarget();
  Object.defineProperty(view, 'visualViewport', { configurable: true, value: viewport });
  t.after(() => { if (descriptor) Object.defineProperty(view, 'visualViewport', descriptor); else delete view.visualViewport; });
  const frames = [], cancelled = [];
  t.mock.method(view, 'requestAnimationFrame', callback => { frames.push(callback); return frames.length; });
  t.mock.method(view, 'cancelAnimationFrame', id => cancelled.push(id));
  const card = new QuestionCard({ root, send() {} });
  let calls = 0; t.mock.method(card, 'reserve', () => calls++);
  card.scheduleReserve(); card.scheduleReserve(); viewport.dispatchEvent(new view.Event('resize'));
  view.dispatchEvent(new view.Event('resize'));
  assert.equal(frames.length, 1); assert.equal(calls, 0, 'events do no synchronous layout work');
  frames[0](); assert.equal(calls, 1);
  viewport.scale = 2; viewport.dispatchEvent(new view.Event('resize'));
  assert.equal(frames.length, 1, 'pinch zoom leaves the reader and dock in place');
  viewport.scale = 1; viewport.dispatchEvent(new view.Event('resize'));
  assert.equal(frames.length, 2, 'a later visual viewport resize schedules fresh geometry');
  card.destroy(); assert.deepEqual(cancelled, [2]);
  viewport.dispatchEvent(new view.Event('resize')); view.dispatchEvent(new view.Event('resize'));
  assert.equal(frames.length, 2, 'disconnect removes both resize listeners');
  const opts = card.card.querySelector('.qopts');
  Object.defineProperties(opts, { scrollWidth: { value: 300 }, clientWidth: { value: 100 } });
  card.card.setAttribute('data-compact', ''); opts.scrollLeft = 200;
  card.connect(); opts.dispatchEvent(new view.Event('scroll'));
  assert.equal(opts.hasAttribute('data-more-start'), true, 'reconnecting restores scroll-edge updates');
  assert.equal(opts.hasAttribute('data-more-end'), false);
  card.destroy(); opts.scrollLeft = 0; opts.dispatchEvent(new view.Event('scroll'));
  assert.equal(opts.hasAttribute('data-more-start'), true, 'disconnect removes the option-scroll listener too');
});

test('AIT-225: desktop reservations do not inspect phone layout styles', t => {
  const view = new Window(), host = view.document.createElement('div'), root = host.attachShadow({ mode: 'open' });
  root.innerHTML = `<div class="workspace"><div class="conversation"></div><div class="transcript-shell"></div>${questionCardMarkup}</div>`;
  t.mock.method(view, 'getComputedStyle', () => { throw new Error('phone-only style read on desktop'); });
  const card = new QuestionCard({ root, send() {} });
  card.card.getBoundingClientRect = () => ({ height: 290 });
  card.update({ turnId: 'reply', question_short: 'Choose?', options }, en, false);
  assert.equal(root.querySelector('.conversation').style.getPropertyValue('--question-card-height'), '290px');
  card.destroy();
});

test('AIT-411: queued unchanged viewport resize cannot scroll a default conversation to the latest reply', t => {
  const view = new Window(), host = view.document.createElement('div'), root = host.attachShadow({ mode: 'open' });
  root.innerHTML = `<div class="conversation"></div><div class="transcript-shell"></div>${questionCardMarkup}`;
  const frames = [], followed = [];
  t.mock.method(view, 'requestAnimationFrame', callback => { frames.push(callback); return frames.length; });
  t.mock.method(view, 'cancelAnimationFrame', () => {});
  const card = new QuestionCard({ root, send() {}, followsTranscript: () => true, onResize: value => followed.push(value) });
  t.after(() => card.destroy());
  card.reserve(); followed.length = 0;
  // A viewport resize queued before mounting arrives after the component exists.
  // The viewport already has its final size, and the hidden card stays hidden.
  view.dispatchEvent(new view.Event('resize')); frames.shift()();
  assert.deepEqual(followed, [], 'a queued no-op resize preserves the initial reading position');
  Object.defineProperty(view, 'innerWidth', { configurable: true, value: view.innerWidth + 100 });
  view.dispatchEvent(new view.Event('resize')); frames.shift()();
  assert.deepEqual(followed, [{ following: true }], 'a real viewport resize retains the existing follow behavior');
});

test('AIT-463 BC9: an identity unlock keeps the answered reply card without Retry', async () => {
  const core = await import('../../core/src/session.js'), c = setup();
  question(c, { replyRevision: core.replyInputRevision(c.session) });
  c.receive({ seq: c.session.seq + 1, type: 'identity.state', data: { identified: true } });
  c.receive({ seq: c.session.seq + 1, type: 'understanding.updated', data: { ...c.session.understanding, inputRevision: core.inputRevision(c.session), readinessAssessed: true } });
  assert.equal(shown(c), true);
  assert.equal(c.shadowRoot.querySelector('.retry').hidden, true);
});

// Layout contracts use a clamped scroll box; real geometry is covered on the browser lane.
function navigationScene(t) {
  const c = setup(); question(c);
  const root = c.shadowRoot, shell = root.querySelector('.transcript-shell');
  let top = 0;
  Object.defineProperties(shell, {
    clientHeight: { configurable: true, get: () => 200 },
    scrollHeight: { configurable: true, get: () => 1000 + root.querySelector('ol').textContent.length },
    scrollTop: { configurable: true, get: () => top, set: value => { top = Math.max(0, Math.min(value, shell.scrollHeight - 200)); } },
  });
  shell.getBoundingClientRect = () => ({ top: 0, bottom: 200, height: 200, width: 300 });
  t.mock.method(window, 'getComputedStyle', () => ({ paddingTop: '0px' }));
  root.elementFromPoint = () => shell.querySelector('.turn');
  const move = (x, y = 20, pointerType = 'mouse') => c.dispatchEvent(new window.PointerEvent('pointermove', { clientX: x, clientY: y, pointerType }));
  move(20); shell.dispatchEvent(new window.Event('pointerenter'));
  shell.scrollTop = 100; shell.dispatchEvent(new window.Event('scroll'));
  const partial = (id, delta = 'New reply') => c.receive({ type: 'turn.partial', data: { id, delta, inputRevision: inputRevision(c.session) } });
  const acknowledge = async (_url, request) => {
    const body = JSON.parse(request.body);
    return Response.json({ seq: c.session.seq + 1, type: 'turn.final', data: { id: body.clientEventId, role: 'user', content: body.content } });
  };
  return { c, root, shell, move, partial, acknowledge, bottom: () => shell.scrollHeight - shell.clientHeight };
}

test('AIT-512: persisted user row exists before the card hides, in the same task', t => {
  const { c, root } = navigationScene(t), card = root.querySelector('.qcard');
  const descriptor = Object.getOwnPropertyDescriptor(window.HTMLElement.prototype, 'hidden');
  const observed = [];
  Object.defineProperty(card, 'hidden', { configurable: true, get() { return descriptor.get.call(this); }, set(value) {
    if (value) observed.push(Boolean(root.querySelector('[data-id="persisted-answer"]')));
    descriptor.set.call(this, value);
  } });
  c.receive({ seq: c.session.seq + 1, type: 'turn.final', data: { id: 'persisted-answer', role: 'user', content: 'Both' } });
  assert.ok(observed.length > 0);
  assert.ok(observed.every(Boolean), 'append the persisted user row before hiding/releasing the card');
  assert.equal(root.querySelector('.conversation').style.getPropertyValue('--question-card-height'), '0px');
});

test('AIT-512: keyboard option pick follows from a scrolled-up, hovered transcript', async t => {
  const { root, shell, acknowledge, bottom, partial } = navigationScene(t);
  t.mock.method(globalThis, 'fetch', acknowledge);
  root.querySelector('.qopt').click(); await tick();
  assert.equal(shell.scrollTop, bottom(), 'the persisted answer is pinned after the card releases its space');
  partial('short');
  assert.equal(shell.scrollTop, bottom(), 'a resting transcript pointer does not undo the visitor navigation');
});

test('AIT-512: mouse jitter stays in the intent; movement beyond eight pixels ends it', async t => {
  const { root, shell, c, move, partial, acknowledge, bottom } = navigationScene(t);
  t.mock.method(globalThis, 'fetch', acknowledge);
  c.dispatchEvent(new window.PointerEvent('pointerdown', { clientX: 20, clientY: 20, pointerType: 'mouse' }));
  root.querySelector('.qopt').dispatchEvent(new window.MouseEvent('click', { bubbles: true, composed: true, detail: 1 })); await tick();
  move(23, 22); partial('reply', 'First');
  assert.equal(shell.scrollTop, bottom(), '1–3 px jitter retains the pick intent');
  move(29, 20); const before = shell.scrollTop; partial('reply', ' longer');
  assert.equal(shell.scrollTop, before, 'movement beyond eight pixels restores the hover gate');
});

for (const failure of ['send', 'lane']) test(`AIT-512: ${failure} failure ends the navigation intent`, async t => {
  const { c, root, shell, partial, acknowledge } = navigationScene(t);
  t.mock.method(globalThis, 'fetch', failure === 'send' ? async () => new Response(null, { status: 503 }) : acknowledge);
  root.querySelector('.qopt').click(); await tick();
  if (failure === 'lane') c.receive({ type: 'lane.failed', data: { lane: 'understanding', inputRevision: inputRevision(c.session), reason: 'fixture', retryable: true } });
  const before = shell.scrollTop; partial('after-failure');
  assert.equal(shell.scrollTop, before, 'a failed send/lane cannot retain the hover exception');
});

test('AIT-512: jump control requires new content and includes a growing reply while scrolled up', t => {
  const { root, shell, partial } = navigationScene(t), jump = root.querySelector('.transcript-latest');
  shell.scrollTop = shell.scrollHeight; shell.dispatchEvent(new window.Event('scroll'));
  shell.scrollTop = 100; shell.dispatchEvent(new window.Event('scroll'));
  assert.equal(jump.style.visibility, 'hidden', 'scrolling alone does not invent new messages');
  partial('new');
  assert.notEqual(jump.style.visibility, 'hidden', 'new content while scrolled up exposes the jump control');
  jump.click(); assert.equal(jump.style.visibility, 'hidden');
  partial('new', ' another chunk');
  assert.notEqual(jump.style.visibility, 'hidden', 'stream growth under the parked pointer is also new content');
});

test('AIT-512: a new card ignores an immediate second pointer click; keyboard activation remains available', async t => {
  const { c, root, acknowledge } = navigationScene(t); let requests = 0;
  t.mock.method(globalThis, 'fetch', (...args) => { requests++; return acknowledge(...args); });
  c.dispatchEvent(new window.PointerEvent('pointerdown', { clientX: 20, clientY: 20, pointerType: 'mouse' }));
  root.querySelector('.qopt').dispatchEvent(new window.MouseEvent('click', { bubbles: true, composed: true, detail: 1 })); await tick();
  question(c); await tick();
  root.querySelector('.qopt').dispatchEvent(new window.MouseEvent('click', { bubbles: true, composed: true, detail: 2 })); await tick();
  assert.equal(requests, 1, 'a second click cannot activate a newly painted card under the resting pointer');
  root.querySelector('.qopt').click(); await tick();
  assert.equal(requests, 2, 'keyboard activation bypasses the pointer-only guard');
});

for (const pointerType of ['mouse', 'pen', 'touch']) test(`AIT-512 gate1: ${pointerType} two-pixel double click cannot activate a moved card`, async t => {
  const { c, root, move, acknowledge } = navigationScene(t); let requests = 0;
  t.mock.method(globalThis, 'fetch', (...args) => { requests++; return acknowledge(...args); });
  const down = x => c.dispatchEvent(new window.PointerEvent('pointerdown', { clientX: x, clientY: 20, pointerType }));
  const click = detail => root.querySelector('.qopt').dispatchEvent(new window.MouseEvent('click', { bubbles: true, composed: true, detail, cancelable: true }));
  down(20); click(1); await tick(); question(c); await tick();
  if (pointerType === 'touch') root.querySelector('.qopt').dispatchEvent(new window.Event('touchstart', { bubbles: true, composed: true }));
  else move(22, 20, pointerType);
  down(22); click(2); await tick();
  assert.equal(requests, 1, 'jitter or a second tap is not deliberate movement');
  root.querySelector('.qopt').click(); await tick();
  assert.equal(requests, 2, 'keyboard activation remains available during the guard');
});

for (const control of ['withdraw', 'link', 'read-full', 'card-link']) test(`AIT-512 gate1: moved ${control} ignores the second pointer click`, async t => {
  const { c, root, acknowledge } = navigationScene(t); let withdrawals = 0;
  t.mock.method(globalThis, 'fetch', (url, request) => {
    if (url.endsWith('/withdraw')) { withdrawals++; return Response.json({}); }
    return acknowledge(url, request);
  });
  c.dispatchEvent(new window.PointerEvent('pointerdown', { clientX: 20, clientY: 20, pointerType: 'mouse' }));
  root.querySelector('.qopt').dispatchEvent(new window.MouseEvent('click', { bubbles: true, composed: true, detail: 1 })); await tick();
  let target = root.querySelector('.turn:last-child .withdraw');
  if (control !== 'withdraw') {
    target = document.createElement(control === 'read-full' ? 'button' : 'a');
    if (target.tagName === 'A') target.href = '#moved-link';
    else target.className = 'turn-read-full';
    target.textContent = 'Moved control';
    (control === 'card-link' ? root.querySelector('.qcard') : root.querySelector('.turn:last-child')).append(target);
  }
  assert.ok(target, 'the moved control exists');
  let activated = 0; target.addEventListener('click', () => activated++);
  const accepted = target.dispatchEvent(new window.MouseEvent('click', { bubbles: true, composed: true, detail: 2, cancelable: true }));
  await tick();
  assert.equal(activated, 0, 'the capture guard stops control handlers');
  assert.equal(accepted, false, 'the guard also cancels link navigation');
  assert.equal(withdrawals, 0, 'a second click never withdraws the row');
  target.click(); await tick();
  assert.equal(activated, 1, 'keyboard activation stays unblocked');
  if (control === 'withdraw') assert.equal(withdrawals, 1);
});

for (const cancel of ['wheel', 'touchstart', 'external scroll']) test(`AIT-512: ${cancel} ends following during a reply`, async t => {
  const { root, shell, partial, acknowledge } = navigationScene(t);
  t.mock.method(globalThis, 'fetch', acknowledge);
  root.querySelector('.qopt').click(); await tick();
  if (cancel === 'external scroll') { shell.scrollTop = 100; shell.dispatchEvent(new window.Event('scroll')); }
  else shell.dispatchEvent(new window.Event(cancel, { bubbles: true, composed: true }));
  const before = shell.scrollTop; partial('cancelled-navigation');
  assert.equal(shell.scrollTop, before, 'the next partial respects the visitor reading position');
});

test('AIT-512: the hover exception ends after the final reply and card are painted', async t => {
  const { c, root, shell, partial, acknowledge } = navigationScene(t), frames = [];
  t.mock.method(window, 'requestAnimationFrame', callback => { frames.push(callback); return frames.length; });
  t.mock.method(window, 'cancelAnimationFrame', () => {});
  t.mock.method(globalThis, 'fetch', acknowledge);
  root.querySelector('.qopt').click(); await tick();
  question(c);
  for (let round = 0; round < 4 && frames.length; round++) { const ready = frames.splice(0); for (const frame of ready) frame(); }
  const before = shell.scrollTop; partial('later-unrelated-content');
  assert.equal(shell.scrollTop, before, 'a later paint cannot reuse the completed navigation intent');
});

test('AIT-512: the pointer guard expires 500 ms after the last programmatic scroll', async t => {
  const { c, root, acknowledge } = navigationScene(t); let now = 1000, requests = 0;
  t.mock.method(window.performance, 'now', () => now);
  t.mock.method(globalThis, 'fetch', (...args) => { requests++; return acknowledge(...args); });
  root.querySelector('.qopt').dispatchEvent(new window.MouseEvent('click', { bubbles: true, composed: true, detail: 1 })); await tick();
  question(c);
  now += 501;
  root.querySelector('.qopt').dispatchEvent(new window.MouseEvent('click', { bubbles: true, composed: true, detail: 1 })); await tick();
  assert.equal(requests, 2, 'a pointer click is available again after the bounded guard');
});

test('AIT-512: withdrawing already-read text does not invent new messages below', t => {
  const { c, root, shell } = navigationScene(t);
  c.receive({ seq: c.session.seq + 1, type: 'turn.final', data: { id: 'short-statement', role: 'user', content: 'I' } });
  shell.scrollTop = shell.scrollHeight; shell.dispatchEvent(new window.Event('scroll'));
  shell.scrollTop = 100; shell.dispatchEvent(new window.Event('scroll'));
  const jump = root.querySelector('.transcript-latest');
  assert.equal(jump.style.visibility, 'hidden');
  c.receive({ seq: c.session.seq + 1, type: 'turn.withdrawn', data: { turnId: 'short-statement', reason: 'withdrawal' } });
  assert.equal(jump.style.visibility, 'hidden', 'a longer withdrawal placeholder is not a new message');
});

for (const acknowledged of [true, false]) test(`AIT-512: a restored final reply ends navigation (user acknowledgement received: ${acknowledged})`, async t => {
  const { applyEvent } = await import('../../core/src/session.js');
  const { c, root, shell, partial } = navigationScene(t), frames = [];
  t.mock.method(window, 'requestAnimationFrame', callback => { frames.push(callback); return frames.length; });
  t.mock.method(window, 'cancelAnimationFrame', () => {});
  let snapshot;
  t.mock.method(globalThis, 'fetch', async (_url, request = {}) => {
    if (request.method !== 'POST') return Response.json(snapshot);
    const body = JSON.parse(request.body), before = c.session;
    const answer = { seq: before.seq + 1, type: 'turn.final', data: { id: body.clientEventId, role: 'user', content: body.content } };
    snapshot = applyEvent(before, answer);
    snapshot = applyEvent(snapshot, { seq: answer.seq + 2, type: 'turn.final', data: { id: 'restored-final', role: 'assistant',
      content: 'A restored final reply.', question_short: 'Choose again?', options, inputRevision: inputRevision(snapshot) } });
    return Response.json(acknowledged ? answer : { ...answer, seq: snapshot.seq });
  });
  root.querySelector('.qopt').click(); await tick(); await tick();
  if (acknowledged) c.receive({ seq: snapshot.seq, type: 'turn.final', data: snapshot.transcript.at(-1) });
  await tick(); await tick();
  assert.equal(c.session.transcript.at(-1).id, 'restored-final', 'the gap recovery snapshot contains the completed reply');
  assert.equal(shown(c), true, 'the restored card has painted');
  for (let round = 0; round < 4 && frames.length; round++) { const ready = frames.splice(0); for (const frame of ready) frame(); }
  const before = shell.scrollTop; partial('after-snapshot-completion');
  assert.equal(shell.scrollTop, before, 'later content cannot reuse a navigation completed by a snapshot');
});
