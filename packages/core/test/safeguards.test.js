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
