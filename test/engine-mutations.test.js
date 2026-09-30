import { it } from 'node:test';
import assert from 'node:assert/strict';
import { cpSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';

// Real copies are essential: symlinks make ESM import.meta.url load the original
// engine and silently invalidate the mutation proof. These children use only
// the same deterministic clocks, SQLite fixtures and stub ports as the parent.
const root = fileURLToPath(new URL('../', import.meta.url));
const scratch = mkdtempSync(join(tmpdir(), 'aithema-engine-mutations-'));
for (const directory of ['contracts', 'lib', 'runtime', 'test/fixtures']) cpSync(join(root, directory), join(scratch, directory), { recursive: true });
for (const name of ['engine-helpers', 'engine', 'engine-confirmation', 'engine-regressions', 'engine-scheduler', 'engine-recovery']) {
  cpSync(join(root, `test/${name}.test.js`), join(scratch, `test/${name}.test.js`));
}
const originals = new Map(['engine', 'patch', 'reaction', 'design', 'metadata'].map((name) => {
  const path = `runtime/engine/${name}.js`;
  return [path, readFileSync(join(root, path), 'utf8')];
}));

function replace(source, before, after) {
  assert.equal(source.split(before).length, 2, 'mutation must identify exactly one source site');
  return source.replace(before, after);
}
function within(source, start, end, before, after) {
  const a = source.indexOf(start), b = source.indexOf(end, a + start.length);
  assert.ok(a >= 0 && b > a);
  return source.slice(0, a) + replace(source.slice(a, b), before, after) + source.slice(b);
}

const mutations = [
  ['positive constructor maximum', 'engine', 'engine-regressions', 'zero maxMicro', (s) => replace(s, 'maxMicro[lane] < 1', 'maxMicro[lane] < 0')],
  ['positive settings maximum', 'engine', 'engine-regressions', 'zero settings provider_max', (s) => replace(s,
    "if (maximum < 1) throw new EngineError('invalid_configuration', 'Foundation ledger requires a positive reservation maximum');", '')],
  ['lane-B trusted confirmation', 'engine', 'engine-confirmation', 'lane B applies a matching', (s) => replace(s, 'applyConfirmations(changed.state, changed.metadata, confirmations);', '')],
  ['start confirmation recovery', 'engine', 'engine-confirmation', '^start recovers', (s) => within(s, '  start() {', '  resume(options', 'await this.#commitConfirmations();', '')],
  ['resume confirmation recovery', 'engine', 'engine-confirmation', '^resume recovers', (s) => within(s, '  resume(options', '  replay() {', 'await this.#commitConfirmations();', '')],
  ['journal recovery confirmation', 'engine', 'engine-confirmation', 'lost confirmation acknowledgement', (s) => within(s, '  recoverJournal() {', '  async #paid(', 'await this.#commitConfirmations();', '')],
  ['public write-ahead confirmation effect', 'engine', 'engine-confirmation', 'public confirmation journals', (s) => replace(s, 'return this.#commitConfirmations();', 'return this.state;')],
  ['historical confirmation scan', 'engine', 'engine-confirmation', 'passSpec recovers a historical', (s) => within(s,
    '  async #specLoop()', '  react(turnSeq)', 'pendingConfirmations(view.metadata, view.events)',
    'pendingConfirmations(view.metadata, view.events).filter((record) => record.seq > view.state.consumed_seq)')],
  ['confirmation receipt persistence', 'patch', 'engine-confirmation', 'confirmation receipts survive', (s) => replace(s, 'metadata.confirmation_results = results;', '')],
  ['shared confirmation receipt guard', 'patch', 'engine-confirmation', 'shared confirmation authority', (s) => replace(s, 'if (consumed.has(record.seq)) continue;', '')],
  ['confirmation receipt scan guard', 'patch', 'engine-confirmation', 'confirmation receipts survive', (s) => replace(s, " && !consumed.has(record.seq)", '')],
  ['stale confirmation no-op', 'patch', 'engine-confirmation', 'same lane-B batch consumes', (s) => replace(s,
    "reason = 'superseded';", "domain = confirmWorkingItem(domain, record.data); reason = 'confirmed';")],
  ['already-confirmed no-op reason', 'patch', 'engine-confirmation', 'already-confirmed action journals', (s) => replace(s,
    "else if (item.state === 'confirmed') reason = 'already_confirmed';", '')],
  ['stale/no-op confirmation content binding', 'patch', 'engine-confirmation', 'content_sha256 binding is still enforced', (s) => replace(s,
    ' || item.content_sha256 !== record.data.content_sha256', '')],
  ['confirmation watermark advancement', 'engine', 'engine-confirmation', 'confirm then revise consumes each', (s) => replace(s,
    'changed.state.consumed_seq = Math.max(view.state.consumed_seq, ...events.map((r) => r.seq));', '')],
  ['confirmation receipt validation', 'metadata', 'engine-confirmation', 'malformed confirmation receipts', (s) => within(s,
    '    const confirms = new Set();', '    const ids = new Set();', 'fail();\n      confirms.add', '{}\n      confirms.add')],
  ['asked echo acceptance', 'patch', 'engine-regressions', 'lane B can echo', (s) => replace(s,
    "!['open', 'asked', 'answered', 'dropped'].includes(question.state)", "!['open', 'answered', 'dropped'].includes(question.state)")],
  ['asked provenance guard', 'patch', 'engine-regressions', 'models cannot invent asked', (s) => replace(s, "|| question.state === 'asked' && prior?.state !== 'asked'", '')],
  ['open echo keeps asked state', 'patch', 'engine-regressions', 'lane B can echo.*echo=open', (s) => replace(s,
    "if (prior?.state === 'asked' && ['open', 'asked'].includes(question.state))", "if (question.state === 'asked')")],
  ['silence correction retry', 'engine', 'engine-regressions', 'a failed silence-timer delivery', (s) => replace(s, 'this.#armCorrections(true);', '')],
  ['silence re-arm before observer', 'engine', 'engine-regressions', 'silence retry is armed before', (s) => {
    s = replace(s, 'this.#armCorrections(true);', '');
    return replace(s, 'Promise.resolve(this.#onError(normalizeError(error)))',
      'Promise.resolve((() => { const observed = this.#onError(normalizeError(error)); this.#armCorrections(true); return observed; })())');
  }],
  ['silence observer throw isolation', 'engine', 'engine-regressions', 'silence retry is armed before', (s) => replace(s,
    '} catch { this.#metrics.error_observer_failures++; }', '} catch (error) { throw error; }')],
  ['correction text identity', 'engine', 'engine-regressions', 'a correction id with different segment', (s) => replace(s,
    " && outbox.text.slice(segment.start, segment.end) === correction.text", '')],
  ['durable design completion', 'engine', 'engine-regressions', 'terminal design intents survive', (s) => replace(s,
    'onComplete: (results) => this.#persistDesignResults(results)', 'onComplete: () => {}')],
  ['design completion restoration', 'engine', 'engine-regressions', 'terminal design intents survive', (s) => replace(s, 'this.#design.restore(this.#meta.design_results);', '')],
  ['design completion error isolation', 'design', 'engine-recovery', 'design.before_finalize throw retains', (s) => replace(s,
    'await this.recoverCompletions().catch((error) => this.#report(error));', 'await this.recoverCompletions();')],
  ['design completion retention', 'design', 'engine-recovery', 'design.before_finalize throw retains', (s) => replace(s,
    'this.#completions.set(intent_id, { intent_id, state, working_rev, rendered_rev, attempts });', '')],
  ['design completion timed retry', 'design', 'engine-recovery', 'throw retains completion and timer', (s) => replace(s, 'this.#retryCompletions();', '')],
  ['design completion single-flight', 'design', 'engine-recovery', 'completion retries are single-flight', (s) => replace(s,
    'if (this.#completionFlight) return this.#completionFlight;', '')],
  ['design journal recovery retries local completion', 'engine', 'engine-recovery', 'throw retains completion and recoverJournal', (s) => replace(s,
    'await this.#design.recoverCompletions();', '')],
  ['design known intent after stop', 'design', 'engine-recovery', 'intent returns an already-known', (s) => {
    const guard = "if (this.#stopped) throw new EngineError('scheduler_stopped', 'Design scheduling is stopped', { status: 409 });";
    return replace(replace(s, guard, ''), 'const prior = this.#intents.get(intent_id);', `${guard}\n      const prior = this.#intents.get(intent_id);`);
  }],
  ['single-flight spec pass', 'engine', 'engine', 'lane B is single-flight', (s) => replace(s, 'if (this.#specFlight) return this.#specFlight;', '')],
  ['snapshot CAS retry', 'engine', 'engine', 'CAS loser re-reads consumed_seq', (s) => replace(s,
    'if (current.working_rev > state.working_rev) { this.#metrics.cas_retries++; return false; }', 'throw error;')],
  ['canonical question append', 'reaction', 'engine', 'canonical question text comes from', (s) => replace(s,
    "append('question', question.text, { question_id: question.question_id });", '')],
  ['pending correction persistence', 'patch', 'engine', 'corrections persist, same-claim', (s) => replace(s,
    "state.corrections.push({ ...document, state: 'pending' });", '')],
  ['reasoning claim before dispatch', 'engine', 'engine', 'each reasoning pass admits', (s) => replace(s,
    'const operation = dispatch({ hold_id: hold.hold_id, request_bytes: requestBytes });', "const operation = invoke(JSON.parse(requestBytes.toString('utf8')));")],
  ['design claim before dispatch', 'engine', 'engine-scheduler', 'engine design attempts each claim', (s) => replace(s,
    'const operation = dispatch({ hold_id: hold.hold_id, request_bytes: requestBytes });', "const operation = invoke(JSON.parse(requestBytes.toString('utf8')));")],
  ['scheduler start window', 'design', 'engine-scheduler', 'freshness <=', (s) => replace(s,
    'const start = base + Math.max(this.#wait, this.#audio ? 20_000 : 0);', 'const start = base + 31_000 + Math.max(this.#wait, this.#audio ? 20_000 : 0);')],
];

const baselines = new Set();
function regression(suite, pattern) {
  return spawnSync(process.execPath, ['--test', '--test-reporter=tap',
    `--test-name-pattern=${pattern}`, `test/${suite}.test.js`], { cwd: scratch, encoding: 'utf8', timeout: 10_000,
    // The child is an independent test runner, not another parent test worker.
    env: { ...process.env, NODE_TEST_CONTEXT: undefined } });
}

for (const [name, module, suite, pattern, mutate] of mutations) {
  it(`mutation proof: ${name} turns its regression red`, () => {
    // Node runs this file's tests serially; restore every source before the next
    // child. The live worktree is always untouched by these deliberate defects.
    for (const [path, source] of originals) writeFileSync(join(scratch, path), source);
    const baselineId = `${suite}:${pattern}`;
    if (!baselines.has(baselineId)) {
      const baseline = regression(suite, pattern), report = baseline.stdout + baseline.stderr;
      assert.equal(baseline.error, undefined, report);
      assert.equal(baseline.status, 0, `Unmutated regression must be green:\n${report}`);
      assert.match(report, /# pass [1-9][0-9]*/, 'pattern must run a passing baseline test');
      baselines.add(baselineId);
    }
    const path = `runtime/engine/${module}.js`;
    writeFileSync(join(scratch, path), mutate(originals.get(path)));
    const child = regression(suite, pattern);
    const report = child.stdout + child.stderr;
    assert.equal(child.error, undefined, report);
    assert.equal(child.status, 1, report);
    assert.doesNotMatch(report, /SyntaxError|ERR_MODULE_NOT_FOUND/);
    assert.match(report, /# fail [1-9][0-9]*/);
    assert.match(report, /failureType: '(?:testCodeFailure|unhandledRejection)'/);
  });
}
