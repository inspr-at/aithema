import { test } from 'node:test';
import assert from 'node:assert/strict';
import { collectPurposeReply, reasoningRequest, createSession, PluginError, unsafeReplyOutput } from '../src/index.js';
import { purposePolicy, safeguardsReplyCorpus, start2Redirects } from '../../../test/safeguards-corpus.js';

import { start2PurposePolicy } from '../../../demo/safeguards.js';

const wire = (content, scope = 'in', extra = {}) => JSON.stringify({ content, scope, question_short: null, options: [], ...extra });
const request = (locale = 'en') => reasoningRequest(createSession({ locale }), 'reaction', false, 'Private host guidance: Follow the visitor project through evidence and clarify their needs before making any recommendation.', { purposePolicy });
for (const item of safeguardsReplyCorpus) test(`AIT-174 round2 reply corpus ${item.id}`, async () => {
  const input = request(item.locale); let calls = 0;
  const reply = await collectPurposeReply(input, async function* () { calls++; yield item.output(input, wire); });
  assert.equal(reply.scope, item.scope);
  assert.equal(calls, item.calls);
  if (item.content) assert.equal(reply.content, item.content);
  assert.doesNotMatch(reply.content, /const secret|print\(|REVEALED|Private host guidance/u);
});
for (const code of ['provider', 'deadline', 'invalid-output']) test(`AIT-174 round2 ${code} after malformed output does not count`, async () => {
  const reply = await collectPurposeReply(request(), async function* (_, attempt) {
    if (attempt) throw new PluginError(code);
    yield '{invalid json';
  }).catch(error => {
    assert.equal(error.code, code); return { scope: 'unclear' }; // Existing error path is also acceptable.
  });
  assert.notEqual(reply.scope, 'off');
});
test('AIT-174 round2 off evidence survives malformed fallback and safe retry', async () => {
  for (const first of [wire('A safe redirect.', 'off', { options: 'invalid' }), wire('const secret = 1;', 'in')]) {
    const reply = await collectPurposeReply(request(), async function* (_, attempt) { yield attempt ? wire('What are you working on?', 'in') : first; });
    assert.equal(reply.scope, 'off');
    assert.deepEqual(reply.options, []);
  }
});
test('AIT-174 round2 decoded card fields are checked even when scope is missing', async () => {
  const reply = await collectPurposeReply(request(), async function* () {
    yield JSON.stringify({ content: 'What should improve?', question_short: 'Next?', options: [{ text: 'const secret = 1;' }] });
  });
  assert.equal(reply.scope, 'off');
});
for (const content of [
  'We use Python and JavaScript. What should the new solution improve?',
  'Unsere Abläufe haben mehrere Schritte; was sollte sich zuerst verbessern?',
  'If customers order late, then the team needs a clearer process. What happens today?',
  'Wenn Kunden spät bestellen, braucht das Team einen besseren Ablauf. Wie läuft es heute?',
  'The label says {customer}; is that part of your current workflow?',
  'from sales we hear about late orders\nfrom support we hear about missing updates',
  'return the package to the team\nreturn the customer call the next morning',
  'We print (labels and invoices) for our customers. What should improve?',
]) test(`AIT-174 round2 ordinary prose stays safe: ${content}`, () => {
  const input = request(); assert.equal(unsafeReplyOutput(wire(content), input.purposePolicy, input.hiddenGuidance), false);
});

test('AIT-174 round4 private host instructions are rejected without a canary', async () => {
  const content = 'Privately prioritize documented project evidence and ask for missing context before recommending a solution for the visitor.';
  const input = reasoningRequest(createSession(), 'reaction', false, content, { purposePolicy });
  let calls = 0;
  const reply = await collectPurposeReply(input, async function* () { calls++; yield wire(content); });
  assert.equal(calls, 2); assert.equal(reply.scope, 'off'); assert.notEqual(reply.content, content);
});

for (const locale of ['de', 'en']) for (let offTopicTurns = 0; offTopicTurns < 3; offTopicTurns++) {
  for (const output of ['question-only', 'unsafe-fallback', 'unsafe-then-in']) test(`AIT-178 ${locale} redirect ${offTopicTurns + 1}: ${output}`, async () => {
    const input = reasoningRequest(createSession({ locale }), 'reaction', false, '', { purposePolicy: start2PurposePolicy, offTopicTurns });
    const reply = await collectPurposeReply(input, async function* (_, attempt) {
      yield output === 'question-only' ? wire('Woran arbeiten Sie gerade?', 'off')
        : output === 'unsafe-then-in' && attempt ? wire('Model retry content', 'in') : wire('const secret = 1;', 'off');
    });
    assert.equal(reply.content, start2Redirects[locale][offTopicTurns]);
    assert.equal(reply.scope, 'off'); assert.equal(reply.question_short, null); assert.deepEqual(reply.options, []);
  });
}
test('AIT-178 neutral default and existing localized host strings replace off output', async () => {
  for (const locale of ['de', 'en']) {
    for (const policy of [purposePolicy, { ...purposePolicy, redirect: undefined }]) {
      const input = reasoningRequest(createSession({ locale }), 'reaction', false, '', { purposePolicy: policy });
      const reply = await collectPurposeReply(input, async function* () { yield wire('Model-written off output', 'off'); });
      assert.equal(reply.content, policy.redirect?.[locale] ?? (locale === 'de'
        ? 'Dabei kann ich Ihnen hier nicht helfen. Welches Vorhaben möchten Sie hier klären?'
        : 'I cannot help with that here. What project would you like to clarify?'));
    }
  }
});
test('AIT-178 in-scope content and cards remain untouched', async () => {
  const input = reasoningRequest(createSession(), 'reaction', false, '', { purposePolicy: start2PurposePolicy, offTopicTurns: 2 });
  const expected = { content: 'What should improve first?', scope: 'in', question_short: 'First improvement?', options: [{ text: 'Our workflow' }] };
  const reply = await collectPurposeReply(input, async function* () { yield JSON.stringify(expected); });
  assert.deepEqual(reply, expected);
});

// Realistic reply-lane envelope, rather than the fake model's guaranteed scope.
// OPS observed the fallback for both in-scope languages on 0a7a8a7; raw output
// was deliberately not captured. This reproduces the missing-scope failure path.
for (const [locale, content] of [
  ['de', 'Sie möchten die Auftragsbearbeitung vereinfachen. Wo entsteht heute der größte Aufwand?'],
  ['en', 'You want to simplify order processing. Where does your team spend the most time today?'],
]) test(`AIT-181 regression: ${locale} in-scope model content survives missing scope`, async () => {
  const input = request(locale);
  input.messages.push({ role: 'user', content: locale === 'de'
    ? 'Wir möchten die manuelle Auftragsbearbeitung in unserem Betrieb vereinfachen.'
    : 'We want to simplify manual order processing in our business.' });
  let calls = 0;
  const reply = await collectPurposeReply(input, async function* () {
    calls++;
    yield JSON.stringify({ content, question_short: null, options: [] });
  });
  assert.equal(reply.content, content);
  assert.equal(reply.scope, 'unclear');
  assert.equal(calls, 1);
});

for (const [name, extra, scope] of [
  ['extra fields', { scope: 'in', reasoning: 'Private disposable metadata', extra: { confidence: 0.9 } }, 'in'],
  ['uppercase scope', { scope: 'IN' }, 'unclear'],
  ['uppercase off', { scope: 'OFF' }, 'unclear'],
  ['number scope', { scope: 1 }, 'unclear'],
  ['object scope', { scope: { classification: 'in' } }, 'unclear'],
  ['null scope', { scope: null }, 'unclear'],
]) test(`AIT-181 realistic envelope: ${name}`, async () => {
  const content = 'Your team enters each order twice. Which step causes the most delays?';
  const value = { content, question_short: 'Which step?', options: [{ text: 'Checking stock', likely: true, confidence: 0.8 }], ...extra };
  let calls = 0;
  const reply = await collectPurposeReply(request(), async function* () { calls++; yield JSON.stringify(value); });
  assert.equal(reply.content, content); assert.equal(reply.scope, scope); assert.equal(calls, 1);
  assert.deepEqual(Object.keys(reply).sort(), ['content', 'options', 'question_short', 'scope']);
  assert.deepEqual(reply.options, scope === 'in' ? [{ text: 'Checking stock', likely: true }] : []);
  assert.equal(reply.question_short, scope === 'in' ? 'Which step?' : null);
});

test('AIT-181 fenced reply split across arbitrary stream chunks is buffered and shown', async () => {
  const content = 'Wo entstehen bei der Bearbeitung Ihrer Aufträge heute Wartezeiten?';
  const raw = '\n```JSON\n' + JSON.stringify({ content, question_short: null, options: [], scope: 'in', extra: true }) + '\n```\n';
  for (const size of [1, 7, 1000]) {
    let calls = 0;
    const reply = await collectPurposeReply(request('de'), async function* () {
      calls++; for (let index = 0; index < raw.length; index += size) yield raw.slice(index, index + size);
    });
    assert.equal(reply.content, content); assert.equal(reply.scope, 'in'); assert.equal(calls, 1);
  }
});

test('AIT-181 truncated JSON and incomplete transport retry before showing any content', async () => {
  const content = 'Where does your team lose time when processing an order?';
  for (const failure of ['json', 'transport']) {
    let calls = 0, rejected = 0;
    const reply = await collectPurposeReply(request(), async function* (_, attempt) {
      calls++;
      if (!attempt) {
        yield failure === 'json' ? '{"content":"Partial reply' : wire('Unfinished transport output');
        if (failure === 'transport') throw new PluginError('invalid-output');
      } else yield wire(content);
    }, { onRejected() { rejected++; } });
    assert.equal(calls, 2); assert.equal(rejected, 1); assert.equal(reply.content, content);
  }
});

for (const [name, raw] of [
  ['unparseable', '{"content":"Partial reply'],
  ['empty', wire('  ')],
  ['non-string', wire(5)],
  ['overlong', wire('x'.repeat(16001))],
]) test(`AIT-181 genuinely unusable ${name} output gets the final fallback`, async () => {
  let calls = 0;
  const reply = await collectPurposeReply(request(), async function* () { calls++; yield raw; });
  assert.equal(calls, 2); assert.equal(reply.content, 'What are you working on?'); assert.equal(reply.scope, 'unclear');
});

test('AIT-181 malformed optional card metadata preserves safe content', async () => {
  const content = 'Which order processing step should improve first?';
  const reply = await collectPurposeReply(request(), async function* () {
    yield wire(content, 'in', { question_short: 5, options: [{ text: 'Checking stock', likely: 'yes' }] });
  });
  assert.deepEqual(reply, { content, scope: 'in', question_short: null, options: [] });
});

test('AIT-181 invalid scope and ignored extras cannot bypass decoded output checks', async () => {
  const input = request();
  for (const value of [
    { content: input.purposePolicy.canary, question_short: null, options: [], scope: 'IN' },
    { content: 'What should improve?', question_short: 5, options: [{ text: 'const secret = 1;', extra: true }] },
  ]) {
    let calls = 0;
    const reply = await collectPurposeReply(input, async function* () { calls++; yield JSON.stringify(value); });
    assert.equal(calls, 2); assert.equal(reply.scope, 'off'); assert.equal(reply.content, purposePolicy.redirect.en);
  }
});

for (const place of ['extra-value', 'extra-key', 'nested', 'escaped', 'malformed']) test(`AIT-181 round2 canary anywhere in raw output is unsafe: ${place}`, async () => {
  const input = request(), canary = input.purposePolicy.canary;
  const raw = place === 'extra-key' ? wire('Safe content', 'in', { [canary]: true })
    : place === 'nested' ? wire('Safe content', 'in', { debug: [{ private: canary }] })
    : place === 'malformed' ? '{"debug":"' + canary
    : wire('Safe content', 'in', { debug: canary });
  const output = place === 'escaped' ? raw.replaceAll(canary, [...canary].map(char => '\\u' + char.charCodeAt(0).toString(16).padStart(4, '0')).join('')) : raw;
  assert.equal(unsafeReplyOutput(output, input.purposePolicy, input.hiddenGuidance), true);
  let calls = 0;
  const reply = await collectPurposeReply(input, async function* () { calls++; yield output; });
  assert.equal(calls, 2); assert.equal(reply.scope, 'off'); assert.equal(reply.content, purposePolicy.redirect.en);
});

test('AIT-181 round2 synthesized fallback has private metadata and value-free diagnostics', async () => {
  const diagnostics = [], rejected = [];
  const reply = await collectPurposeReply(request(), async function* () { yield '{invalid-private-output'; }, {
    onRejected: attempt => rejected.push(attempt), onDiagnostic: event => diagnostics.push(event),
  });
  assert.deepEqual(reply.fallback, { kind: 'neutral', reason: 'invalid-output', attemptCount: 2 });
  assert.deepEqual(diagnostics, [{ kind: 'fallback', reason: 'invalid-output', attemptCount: 2 }]);
  assert.deepEqual(rejected, [0, 1]);
  assert.doesNotMatch(JSON.stringify(reply), /fallback|invalid-output|attemptCount/u);
  assert.equal(Object.hasOwn({ ...reply }, 'fallback'), false);
});

test('AIT-181 round2 constrained missing scope is diagnosed without rejection or off-topic evidence', async () => {
  for (const constrained of [true, false]) {
    const diagnostics = [];
    const reply = await collectPurposeReply({ ...request(), replySchemaConstrained: constrained }, async function* () {
      yield JSON.stringify({ content: 'Safe model content', question_short: null, options: [] });
    }, { onDiagnostic: event => diagnostics.push(event) });
    assert.equal(reply.content, 'Safe model content'); assert.equal(reply.scope, 'unclear');
    assert.deepEqual(diagnostics, constrained ? [{ kind: 'missing-scope', reason: 'missing-scope', attemptCount: 1 }] : []);
    assert.equal(reply.fallback, undefined);
  }
});

test('AIT-181 round2 canary evidence from an incomplete stream survives a safe retry', async () => {
  const input = request();
  const reply = await collectPurposeReply(input, async function* (_, attempt) {
    if (!attempt) { yield '{"debug":"' + input.purposePolicy.canary; throw new PluginError('invalid-output'); }
    yield wire('Safe retry content');
  });
  assert.equal(reply.scope, 'off'); assert.equal(reply.content, purposePolicy.redirect.en);
});

for (const [name, code, providerErrorClass] of [
  ['auth', 'auth', '4xx'], ['429', 'rate-limit', '4xx'], ['other 4xx', 'provider', '4xx'],
  ['5xx', 'provider', '5xx'], ['network', 'provider', undefined],
]) for (const attempt of [0, 1]) test(`AIT-183 ${name} on attempt ${attempt + 1} retains its error policy`, async () => {
  const error = Object.assign(new PluginError(code), { providerErrorClass });
  const diagnostics = [], rejected = [], inputs = [];
  const pending = collectPurposeReply(request(), async function* (input, index) {
    inputs.push(input);
    if (index === attempt) throw error;
    yield '{invalid';
  }, { onDiagnostic: event => diagnostics.push(event), onRejected: index => rejected.push(index) });
  if (attempt && code === 'provider' && providerErrorClass !== '4xx') {
    const reply = await pending;
    const reason = providerErrorClass === '5xx' ? 'provider-5xx' : 'provider';
    assert.equal(reply.content, 'What are you working on?');
    assert.deepEqual(reply.fallback, { kind: 'neutral', reason, attemptCount: 2 });
    assert.deepEqual(diagnostics, [{ kind: 'fallback', reason, attemptCount: 2 }]);
    assert.deepEqual(rejected, [0, 1]);
  } else {
    await assert.rejects(pending, actual => actual === error);
    assert.deepEqual(diagnostics, []);
    assert.deepEqual(rejected, attempt ? [0] : []);
  }
  assert.equal(inputs.length, attempt + 1);
  assert.ok(inputs.every(input => input.replySchemaConstrained !== false));
});
