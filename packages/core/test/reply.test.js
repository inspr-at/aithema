import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as core from '../src/index.js';

const reply = {
  content: 'Should customers choose their own design or buy a finished cushion?',
  question_short: 'Choose a design or buy a finished cushion?',
  options: [{ text: 'Buy a finished cushion' }, { text: 'Choose my own design', likely: true }, { text: 'Both' }],
};

test('AIT-132: the provider-neutral reply schema and prompt describe one optional question and four answers', () => {
  assert.equal(typeof core.replySchema, 'object');
  assert.equal(core.replySchema.properties.options.maxItems, 4);
  assert.equal(core.replySchema.properties.options.items.additionalProperties, false);
  for (const locale of ['de', 'en']) {
    const request = core.reasoningRequest(core.createSession({ locale }), 'reaction');
    assert.deepEqual(request.schema, core.replySchema);
    for (const word of ['question_short', 'options', 'likely']) assert.ok(request.system.includes(word));
    assert.match(request.system, /at most (?:4|four) options/iu);
    assert.match(request.system, /at most one[^\n]*likely/iu);
    assert.match(request.system, /Ask at most one question per reply/u);
    assert.match(request.system, /Never open formulaically with "Danke"/u);
    assert.match(request.system, /polite Sie form/u);
  }
});

test('AIT-132: voice replies retain plain speech, shared policies and no card output instructions', () => {
  const request = core.reasoningRequest(core.createSession(), 'reaction', false, '', { voiceReply: true });
  assert.equal(request.schema, undefined);
  assert.doesNotMatch(request.system, /question_short|Return[^\n]*JSON/u);
  assert.match(request.system, /Never re-ask/u);
  assert.match(request.system, /Ask at most one question/u);
});

test('AIT-132: reply JSON, fenced JSON and legacy plain replies parse without leaking metadata', () => {
  assert.equal(typeof core.parseReply, 'function');
  for (const input of [reply, JSON.stringify(reply), `\`\`\`json\n${JSON.stringify(reply)}\n\`\`\``]) {
    assert.deepEqual(core.parseReply(input), reply);
  }
  for (const content of ['A plain question?', '[A label] Follow-up?', '```js\nconst value = 1;\n```']) {
    assert.deepEqual(core.parseReply(content), { content, question_short: null, options: [] });
  }
});

test('AIT-132: schema validation enforces answer types, length, four options and a single likely', () => {
  assert.equal(core.matchesSchema(reply, core.replySchema), true);
  assert.equal(core.matchesSchema({ ...reply, options: Array.from({ length: 5 }, () => ({ text: 'Five' })) }, core.replySchema), false);
  assert.equal(core.matchesSchema({ ...reply, options: [{ text: 'One', likely: true }, { text: 'Two', likely: true }] }, core.replySchema), false);
  for (const option of [{ text: '', likely: false }, { text: 7 }, { text: 'No', likely: 'true' }, { text: 'No', extra: true }, { text: 'x'.repeat(8001) }]) {
    assert.equal(core.matchesSchema({ ...reply, options: [option] }, core.replySchema), false);
  }
  assert.equal(core.matchesSchema({ content: 'Hello', question_short: null, options: [] }, core.replySchema), true);
});

test('AIT-132: malformed answers are dropped strictly, four valid answers survive, only the first likely survives', () => {
  assert.equal(typeof core.normalizeQuestionCard, 'function');
  const options = [null, 'wrong', {}, { text: '' }, { text: '  ' }, { text: 7 }, { text: 'Bad likely', likely: 'true' },
    { text: 'Extra fields', pill: true }, { text: 'Over limit'.repeat(1000) },
    { text: 'One', likely: true }, { text: 'Two', likely: true }, { text: 'Three', likely: false }, { text: 'Four' }, { text: 'Five' }];
  assert.deepEqual(core.normalizeQuestionCard({ question_short: 'Choose?', options }), {
    question_short: 'Choose?', options: [{ text: 'One', likely: true }, { text: 'Two' }, { text: 'Three', likely: false }, { text: 'Four' }],
  });
});

test('AIT-132: invalid envelopes, blank questions and absent answers never crash or create cards', () => {
  assert.equal(typeof core.parseReply, 'function');
  for (const value of [null, undefined, 0, [], {}, '{broken', { content: 'Question?', options: reply.options },
    { content: 'Question?', question_short: ' ', options: reply.options }, { ...reply, options: null },
    { ...reply, options: [] }, { ...reply, question_short: 5 }]) {
    assert.doesNotThrow(() => core.parseReply(value));
    assert.equal(core.normalizeQuestionCard(value), null);
    assert.deepEqual(core.parseReply(value).options, []);
  }
});

test('AIT-132: structured streams decode escaped content at every chunk boundary; no options enter partial turns', () => {
  assert.equal(typeof core.ReplyStream, 'function');
  const value = { ...reply, content: 'He said "yes".\nChoose \\ a colour? 😃' }, wire = JSON.stringify(value);
  for (let boundary = 1; boundary < wire.length; boundary++) {
    const stream = new core.ReplyStream();
    const first = stream.push(wire.slice(0, boundary)), last = stream.push(wire.slice(boundary));
    assert.equal(first + last, value.content, `boundary ${boundary}`);
    assert.deepEqual(stream.finish(), value);
  }
  const spaced = new core.ReplyStream();
  assert.equal(spaced.push('\n '), '');
  assert.equal(spaced.push(wire), value.content);
  assert.deepEqual(spaced.finish(), value);
});

test('AIT-132: a reaction persists the parsed card once and publishes only conversational partials', async () => {
  const plugin = { ...core.createMockReasoning(), async *stream(request) {
    assert.deepEqual(request.schema, core.replySchema);
    const wire = JSON.stringify(reply);
    for (let i = 0; i < wire.length; i += 9) yield wire.slice(i, i + 9);
  } };
  let session = core.applyEvent(core.createSession({ demo: true }), { seq: 1, type: 'turn.final', data: { role: 'user', content: 'I sell cushions.' } });
  const partials = [], published = [];
  const lanes = new core.SessionLanes({ reasoning: plugin, beforeDispatch: async () => true, getSession: () => session,
    transient: (id, event) => partials.push(event), publish(id, type, data) {
      const event = { seq: session.seq + 1, type, data }; published.push(event); session = core.applyEvent(session, event); return true;
    } });
  assert.equal(await lanes.run(session.id, 'reaction'), 'completed');
  assert.equal(published.length, 1);
  assert.equal(session.transcript.at(-1).content, reply.content);
  assert.deepEqual(session.transcript.at(-1).options, reply.options);
  assert.equal(partials.map(e => e.data.delta).join(''), reply.content);
  assert.equal(await lanes.run(session.id, 'reaction'), 'cached');
});

const boundaryReplies = [
  { name: 'two maximum-length options', value: { ...reply, options: [{ text: 'a'.repeat(8000) }, { text: 'b'.repeat(8000), likely: true }] } },
  { name: 'the full content, question and four-option budget', value: { content: 'c'.repeat(16000), question_short: 'q'.repeat(500),
    options: Array.from({ length: 4 }, (_, i) => ({ text: String(i).repeat(8000) })) } },
  { name: 'maximum-length JSON-escaped fields', value: { content: '\u0001'.repeat(16000), question_short: '\u0001'.repeat(500),
    options: Array.from({ length: 4 }, () => ({ text: '\u0001'.repeat(8000) })) } },
  { name: 'an oversized option beside a valid option', value: { ...reply, options: [{ text: 'x'.repeat(8001) }, { text: 'Keep this', likely: true }] },
    answers: [{ text: 'Keep this', likely: true }] },
  { name: 'malformed options beside a valid option', value: { ...reply, options: [null, { text: 7 }, { text: 'x'.repeat(16001), likely: 'yes' }, { text: 'Keep this' }] },
    answers: [{ text: 'Keep this' }] },
  { name: 'option metadata beyond the hard envelope budget', value: { ...reply, options: [{ text: 'x'.repeat(1_000_000) }] }, answers: [] },
  { name: 'oversized metadata before the reply text', value: { options: [{ text: 'x'.repeat(1_000_000) }], question_short: reply.question_short,
    content: 'Still usable: "yes".\nChoose \\ a colour? 😃' }, answers: [] },
  { name: 'syntactically malformed option metadata', value: { ...reply, options: [] },
    wire: `${JSON.stringify({ content: reply.content }).slice(0, -1)},"question_short":"Choose?","options":[{"text":broken}`, answers: [] },
];

for (const fixture of boundaryReplies) test(`AIT-132 streamed boundary: ${fixture.name}`, async () => {
  const wire = fixture.wire ?? JSON.stringify(fixture.value), expected = fixture.answers ?? fixture.value.options;
  // Include one provider delta, splits around the former limit, and many chunks.
  const layouts = [[wire], [wire.slice(0, 15999), wire.slice(15999, 16001), wire.slice(16001)],
    Array.from({ length: Math.ceil(wire.length / 997) }, (_, i) => wire.slice(i * 997, (i + 1) * 997))];
  for (const chunks of layouts) {
    let session = core.applyEvent(core.createSession({ demo: true }), { seq: 1, type: 'turn.final', data: { role: 'user', content: 'I sell cushions.' } });
    const partials = [], published = [];
    const reasoning = { ...core.createMockReasoning(), async *stream() { yield* chunks; } };
    const lanes = new core.SessionLanes({ reasoning, beforeDispatch: async () => true, getSession: () => session,
      transient: (id, event) => partials.push(event), publish(id, type, data) {
        const event = { seq: session.seq + 1, type, data }; published.push(event); session = core.applyEvent(session, event); return true;
      } });
    assert.equal(await lanes.run(session.id, 'reaction'), 'completed', `${chunks.length} provider chunks`);
    assert.equal(published.length, 1, 'one durable reply survives');
    assert.equal(published[0].type, 'turn.final');
    assert.equal(session.transcript.at(-1).content, fixture.value.content, 'valid reply text survives optional metadata');
    assert.deepEqual(session.transcript.at(-1).options, expected);
    assert.equal(partials.map(event => event.data.delta).join(''), fixture.value.content, 'only conversational text is streamed');
    if (!expected.length) assert.equal(core.currentQuestionCard(session), null);
  }
});

test('AIT-132: a current final reply owns the card; partials, later input and stale replies cannot reopen it', () => {
  assert.equal(typeof core.currentQuestionCard, 'function');
  let session = core.createSession();
  const event = (type, data) => { session = core.applyEvent(session, { seq: session.seq + 1, type, data }); };
  event('turn.final', { id: 'u1', role: 'user', content: 'Cushions' });
  const revision = core.inputRevision(session);
  event('turn.final', { id: 'a1', role: 'assistant', inputRevision: revision, ...reply });
  assert.deepEqual(core.currentQuestionCard(session), { turnId: 'a1', question_short: reply.question_short, options: reply.options });
  event('turn.final', { id: 'u2', role: 'user', content: reply.options[0].text, provenance: { source: 'voice' } });
  assert.equal(core.currentQuestionCard(session), null);
  event('turn.final', { id: 'old', role: 'assistant', inputRevision: revision, ...reply });
  assert.equal(core.currentQuestionCard(session), null);
});

test('AIT-132: withdrawal removes question and answer content from the core projection', () => {
  let session = core.createSession();
  const apply = (type, data) => { session = core.applyEvent(session, { seq: session.seq + 1, type, data }); };
  apply('turn.final', { id: 'u', role: 'user', content: 'Cushions' });
  apply('turn.final', { id: 'a', role: 'assistant', inputRevision: core.inputRevision(session), ...reply });
  apply('turn.withdrawn', { turnId: 'u' });
  assert.equal(session.transcript.at(-1).question_short, undefined);
  assert.equal(session.transcript.at(-1).options, undefined);
});

test('AIT-132: a heard-prefix correction cannot keep an unheard question or its answers', () => {
  let session = core.applyEvent(core.createSession(), { seq: 1, type: 'turn.final', data: { id: 'u', role: 'user', content: 'Cushions' } });
  session = core.applyEvent(session, { seq: 2, type: 'turn.final', data: { id: 'a', role: 'assistant', inputRevision: core.inputRevision(session), ...reply } });
  session = core.applyEvent(session, { seq: 3, type: 'turn.corrected', data: { id: 'a', role: 'assistant', content: 'Heard prefix.' } });
  assert.equal(core.currentQuestionCard(session), null);
  assert.equal(session.transcript.at(-1).options, undefined);
});
