import { test } from 'node:test';
import assert from 'node:assert/strict';
import { collectPurposeReply, reasoningRequest, createSession, PluginError, unsafeReplyOutput } from '../src/index.js';
import { purposePolicy, safeguardsReplyCorpus } from '../../../test/safeguards-corpus.js';

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
