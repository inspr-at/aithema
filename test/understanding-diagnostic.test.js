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
function stub({ offScope = 'off' } = {}) {
  return `
    let calls = 0;
    globalThis.fetch = async (_, init) => {
      if (++calls > 3) throw new Error('Uncapped network call');
      const body = JSON.parse(init.body);
      await new Promise(resolve => setTimeout(resolve, body.stream ? 20 : 500));
      const usage = { prompt_tokens: 30, completion_tokens: 40, cost: 0.00011 };
      if (!body.stream) return Response.json({ usage, choices: [{ finish_reason: 'stop', message: { content: JSON.stringify(${JSON.stringify(assessment)}) } }] });
      const content = JSON.stringify({ content: 'Welches Vorhaben möchten Sie klären?', scope: body.messages.at(-1).content.includes('Gemüsesuppe') ? '${offScope}' : 'in', question_short: null, options: [] });
      return new Response('data: ' + JSON.stringify({ usage, choices: [{ delta: { content }, finish_reason: 'stop' }] }) + '\\n\\ndata: [DONE]\\n\\n');
    };
    process.on('exit', () => { if (calls !== 3) process.exitCode = 1; });
  `;
}
test('AIT-198 OPS command covers both cases through real handlers within three stubbed calls, without values', async () => {
  const { stdout } = await promisify(execFile)(process.execPath, ['--import', `data:text/javascript,${encodeURIComponent(stub())}`, command, '--allow-live'],
    { timeout: 15_000, env: config });
  const reports = stdout.trim().split('\n').map(line => JSON.parse(line));
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

test('AIT-198 diagnostic enforces call cap even if off-topic is misclassified and a replacement analysis is scheduled', async () => {
  await assert.rejects(promisify(execFile)(process.execPath, ['--import', `data:text/javascript,${encodeURIComponent(stub({ offScope: 'in' }))}`, command, '--allow-live'],
    { timeout: 15_000, env: config }), error => {
    const reports = error.stdout.trim().split('\n').map(line => JSON.parse(line));
    assert.equal(reports.at(-1).passed, false); assert.equal(reports.at(-1).calls, 3);
    assert.equal(reports.at(-1).off_classified, false);
    assert.doesNotMatch(error.stdout + error.stderr, /Private|fixture-not-a-key/u);
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
