import { test } from 'node:test';
import assert from 'node:assert/strict';
import { diagnoseReplySchema, runReplySchemaDiagnostics } from '../scripts/diagnose-reply-schema.js';

const value = { content: 'Private model content', question_short: null, options: [], scope: 'in' };
for (const [name, output, failure] of [
  ['missing scope', { content: value.content, question_short: null, options: [] }, { path: '$.scope', rule: 'required' }],
  ['scope case', { ...value, scope: 'IN' }, { path: '$.scope', rule: 'enum' }],
  ['scope type', { ...value, scope: 4 }, { path: '$.scope', rule: 'type' }],
  ['extra field', { ...value, 'private-name': 'private-value' }, { path: '$.*', rule: 'additionalProperties' }],
  ['nested extra', { ...value, options: [{ text: 'Answer', 'private-name': 'private-value' }] }, { path: '$.options[0].*', rule: 'additionalProperties' }],
  ['question type', { ...value, question_short: 4 }, { path: '$.question_short', rule: 'anyOf' }],
  ['content length', { ...value, content: 'x'.repeat(16001) }, { path: '$.content', rule: 'maxLength' }],
  ['too many likely', { ...value, options: [{ text: 'One', likely: true }, { text: 'Two', likely: true }] }, { path: '$.options', rule: 'maxContains' }],
]) test(`AIT-181 value-free diagnostic: ${name}`, () => {
  const report = diagnoseReplySchema(JSON.stringify(output));
  assert.equal(report.parsed, true); assert.deepEqual(report.schema_failure, failure);
  assert.doesNotMatch(JSON.stringify(report), /Private model content|private-name|private-value|Answer/u);
});
test('AIT-181 diagnostics report fences, valid scope and partial JSON without values', () => {
  const report = diagnoseReplySchema('```json\n' + JSON.stringify(value) + '\n```');
  assert.deepEqual(report, { parsed: true, top_level_keys: ['content', 'options', 'question_short', 'scope'], scope_present: true,
    scope_valid: true, schema_failure: null, fence_present: true, stream_complete: true });
  assert.deepEqual(diagnoseReplySchema('{"content":"partial private data', false), {
    parsed: false, top_level_keys: [], scope_present: false, scope_valid: false,
    schema_failure: { path: '$', rule: 'parse' }, fence_present: false, stream_complete: false,
  });
});
test('AIT-181 diagnostics invoke exactly three guarded DE/EN/off-topic streams, without retries or values', async () => {
  const requests = [], reports = [];
  await runReplySchemaDiagnostics({ write: report => reports.push(report), async *invoke(request) {
    requests.push(request);
    if (requests.length === 3) { yield '{"content":"partial private output'; throw new Error('private provider error'); }
    const raw = JSON.stringify({ ...value, 'private-key': 'private-value' });
    yield raw.slice(0, 10); yield raw.slice(10);
  } });
  assert.equal(requests.length, 3); assert.deepEqual(requests.map(request => request.locale), ['de', 'en', 'de']);
  assert.ok(requests[2].messages.at(-1).content.includes('Rezept'));
  assert.ok(requests.every(request => request.schema.required.includes('scope') && request.purposePolicy.outputCheck));
  assert.deepEqual(reports.map(report => report.case), ['in-de', 'in-en', 'off-de']);
  assert.equal(reports[2].stream_complete, false);
  assert.doesNotMatch(JSON.stringify(reports), /Private model content|private-key|private-value|private output|private provider error|AITHEMA_CANARY_|Rezept/u);
});
