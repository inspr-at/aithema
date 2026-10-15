import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { fileURLToPath } from 'node:url';

const command = fileURLToPath(new URL('../scripts/understanding-diagnostic.mjs', import.meta.url));
const assessment = { summary: 'Private model assessment', signals: [], openQuestions: [],
  constraints: { operations: null, data: null, systems: null, reach: null, requirements: null },
  progress: { talk: { value: 0.2, reasoning: 'Private reason' }, build: { value: 0, reasoning: 'Private reason' } },
  actor: null, engagement: null, conceptIntent: null };
const config = { PATH: process.env.PATH, OPENROUTER_API_KEY: 'fixture-not-a-key',
  OPENROUTER_MODEL: 'anthropic/fixture', AITHEMA_OPENROUTER_PRICES: '{"anthropic/fixture":{"prompt":1e-6,"completion":2e-6}}' };
function stub({ capped = false, rejection = null } = {}) {
  return `
    let calls = 0, finishAnalysis;
    globalThis.fetch = async (_, init) => {
      if (++calls > 5) throw new Error('Uncapped network call');
      const body = JSON.parse(init.body);
      if (!body.stream && body.reasoning?.effort && body.messages.at(-1).role === 'assistant') return Response.json({ error: {
        type: 'invalid_request_error', message: 'Assistant prefill is not supported when thinking is enabled',
      } }, { status: 400 });
      if (body.stream && body.messages.at(-1).content.includes('Gemüsesuppe')) finishAnalysis?.();
      const rejection = ${JSON.stringify(rejection)};
      if (!body.stream && rejection) return new Response(rejection.body, { status: rejection.status, headers: { 'content-type': 'application/json' } });
      if (${capped} && body.response_format) return Response.json({ error: { code: 400, message: 'Private unsupported schema' }, usage: { cost: 0 } }, { status: 400 });
      // Only the happy-path fixture gates analysis on a later reply. The cap
      // fixture must settle independently when admission refuses that reply.
      if (!body.stream && !${capped}) await new Promise(resolve => { finishAnalysis = resolve; });
      const usage = { prompt_tokens: 30, completion_tokens: 40, cost: 0.00011 };
      if (!body.stream) return Response.json({ usage, choices: [{ finish_reason: 'stop', message: { content: JSON.stringify(${JSON.stringify(assessment)}) } }] });
      const content = JSON.stringify({ content: 'Welches Vorhaben möchten Sie klären?', scope: body.messages.at(-1).content.includes('Gemüsesuppe') ? 'off' : 'in', question_short: null, options: [] });
      return new Response('data: ' + JSON.stringify({ usage, choices: [{ delta: { content }, finish_reason: 'stop' }] }) + '\\n\\ndata: [DONE]\\n\\n');
    };
    process.on('exit', () => { if (calls > 5) process.exitCode = 1; });
  `;
}
test('AIT-198 OPS command covers both cases through real handlers within three stubbed calls, without values', async () => {
  const { stdout } = await promisify(execFile)(process.execPath, ['--import', `data:text/javascript,${encodeURIComponent(stub())}`, command, '--allow-live'],
    { timeout: 15_000, env: config });
  const rows = stdout.trim().split('\n').map(line => JSON.parse(line));
  const reports = rows.filter(row => row.case !== 'provider-call');
  const wire = rows.filter(row => row.case === 'provider-call').sort((a, b) => a.call_order - b.call_order);
  assert.deepEqual(wire.map(row => row.call_order), [1, 2, 3]);
  assert.deepEqual(wire.map(row => row.lane), ['reply', 'understanding', 'reply']);
  assert.ok(wire.every(row => row.http_status === 200 && row.http_status_class === '2xx' && row.usage_present && row.usage_cost_present));
  assert.ok(wire.every(row => row.request_shape.model === 'anthropic/fixture' && row.finish_reason === 'stop'));
  assert.ok(wire.filter(row => row.lane === 'understanding').every(row => row.request_shape.roles.at(-1) === 'user' &&
    row.request_shape.reasoning_present && row.request_shape.effort_present));
  assert.ok(wire.filter(row => row.lane === 'reply').every(row => row.stream_end.done_seen && row.stream_end.terminal_event_seen));
  assert.deepEqual(reports.map(row => row.case), ['live-sequence-de', 'in-then-off-de']);
  assert.deepEqual(reports.map(row => row.calls), [3, 3]);
  assert.ok(reports.every(row => row.passed && row.completed === 1 && row.with_usage === 1 && row.understanding_updates === 1 && !row.uncertain));
  assert.ok(reports.every(row => row.project_scope_seeded === false && row.outcome_reason === 'completed'));
  assert.ok(reports.every(row => row.dispatch_to_terminal_ms.length === 1 && Number.isFinite(row.dispatch_to_terminal_ms[0]) && row.dispatch_to_terminal_ms[0] >= 0));
  assert.equal(reports[0].reply_before_understanding, true);
  assert.equal(reports[1].overlapped, true); assert.equal(reports[1].off_classified, true);
  assert.ok(reports.every(row => row.outcomes.started === 1 && row.outcomes.completed === 1 && row.outcomes.aborted === 0));
  assert.doesNotMatch(stdout, /Private|fixture-not-a-key|Auftragsbearbeitung|Gemüsesuppe|AITHEMA_CANARY_|gen-/u);
});

test('AIT-198 diagnostic enforces five wire calls including schema compatibility attempts', async () => {
  await assert.rejects(promisify(execFile)(process.execPath, ['--import', `data:text/javascript,${encodeURIComponent(stub({ capped: true }))}`, command, '--allow-live'],
    { timeout: 15_000, env: config }), error => {
    const reports = error.stdout.trim().split('\n').map(line => JSON.parse(line));
    assert.equal(reports.at(-1).passed, false); assert.equal(reports.at(-1).calls, 5);
    assert.equal(reports.filter(row => row.case === 'provider-call').length, 5);
    assert.equal(reports.at(-1).off_classified, false);
    assert.doesNotMatch(error.stdout + error.stderr, /Private|fixture-not-a-key/u);
    return true;
  });
});

for (const rejection of [
  { name: 'OpenRouter rejection', status: 400, body: JSON.stringify({ error: { code: 400, message: 'Private rejection body' } }), code: 400, type: null },
  { name: 'Anthropic rejection', status: 529, body: JSON.stringify({ type: 'error', error: { type: 'overloaded_error', message: 'Private overloaded body' } }), code: null, type: 'overloaded_error' },
  { name: 'empty 200', status: 200, body: '', code: null, type: null },
  { name: 'valid usage without cost', status: 200, body: JSON.stringify({ usage: { prompt_tokens: 30, completion_tokens: 40 }, choices: [{ finish_reason: 'stop', message: { content: JSON.stringify(assessment) } }] }), code: null, type: null, usage: true },
]) test(`AIT-198 offline ${rejection.name} ${rejection.status === 400 ? 'releases rejected requests' : 'keeps unknown provider cost conservative'} through real handlers`, async () => {
  await assert.rejects(promisify(execFile)(process.execPath, ['--import', `data:text/javascript,${encodeURIComponent(stub({ rejection }))}`, command, '--allow-live'],
    { timeout: 15_000, env: config }), error => {
    const rows = error.stdout.trim().split('\n').map(line => JSON.parse(line));
    const wire = rows.filter(row => row.case === 'provider-call' && row.lane === 'understanding');
    assert.ok(wire.length > 0);
    assert.ok(wire.every(row => row.http_status === rejection.status && row.provider_error_code === rejection.code &&
      row.provider_error_type === rejection.type && row.usage_present === Boolean(rejection.usage) && !row.usage_cost_present));
    const report = rows.at(-1);
    assert.equal(report.passed, false);
    if (rejection.status === 400) {
      assert.equal(report.uncertain, 0);
      assert.ok(report.failures.some(row => row.event === 'understanding.failed' && row.reason === 'provider-4xx'));
    } else {
      assert.ok(report.uncertain > 0);
      assert.equal(report.max_charged_uncertain, report.uncertain);
      assert.ok(report.failures.some(row => row.event === 'understanding.uncertain' && row.reason === 'provider-cost-unknown'));
    }
    assert.doesNotMatch(error.stdout + error.stderr, /Private|fixture-not-a-key|Auftragsbearbeitung|Gemüsesuppe/u);
    return true;
  });
});
for (const ci of [false, true]) test(`AIT-198 diagnostic refuses ${ci ? 'CI even with --allow-live' : 'missing --allow-live'} before any network call`, async () => {
  const noNetwork = "globalThis.fetch = () => { console.log('NETWORK_ATTEMPTED'); throw new Error(); };";
  await assert.rejects(promisify(execFile)(process.execPath, ['--import', `data:text/javascript,${encodeURIComponent(noNetwork)}`, command, ...(ci ? ['--allow-live'] : [])],
    { timeout: 5000, env: { PATH: process.env.PATH, ...(ci ? { CI: 'true' } : {}) } }), error => {
    assert.equal(error.stdout, ''); assert.match(error.stderr, /diagnostic_error/u); return true;
  });
});
