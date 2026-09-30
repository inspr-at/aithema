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
for (const name of ['engine-helpers', 'engine', 'engine-confirmation', 'engine-regressions', 'engine-scheduler']) {
  cpSync(join(root, `test/${name}.test.js`), join(scratch, `test/${name}.test.js`));
}
const originals = new Map(['engine', 'patch', 'reaction', 'design'].map((name) => {
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
  ['lane-B trusted confirmation', 'engine', 'engine-confirmation', 'lane B applies a matching', (s) => replace(s, 'applyConfirmations(changed.state, confirmations);', '')],
  ['start confirmation recovery', 'engine', 'engine-confirmation', '^start recovers', (s) => within(s, '  start() {', '  resume(options', 'await this.#commitConfirmations();', '')],
  ['resume confirmation recovery', 'engine', 'engine-confirmation', '^resume recovers', (s) => within(s, '  resume(options', '  replay() {', 'await this.#commitConfirmations();', '')],
  ['journal recovery confirmation', 'engine', 'engine-confirmation', 'lost confirmation acknowledgement', (s) => within(s, '  recoverJournal() {', '  async #paid(', 'await this.#commitConfirmations();', '')],
  ['public write-ahead confirmation effect', 'engine', 'engine-confirmation', 'public confirmation journals', (s) => replace(s, 'return this.#commitConfirmations();', 'return this.state;')],
  ['historical confirmation scan', 'patch', 'engine-confirmation', 'passSpec recovers a historical', (s) => replace(s,
    "record.seq > state.consumed_seq || state.spec.items.some((item) => item.state === 'draft'\n      && item.item_ref === record.data.item_ref && item.version === record.data.version)", 'record.seq > state.consumed_seq')],
  ['asked echo acceptance', 'patch', 'engine-regressions', 'lane B can echo', (s) => replace(s,
    "!['open', 'asked', 'answered', 'dropped'].includes(question.state)", "!['open', 'answered', 'dropped'].includes(question.state)")],
  ['asked provenance guard', 'patch', 'engine-regressions', 'models cannot invent asked', (s) => replace(s, "|| question.state === 'asked' && prior?.state !== 'asked'", '')],
  ['silence correction retry', 'engine', 'engine-regressions', 'a failed silence-timer delivery', (s) => replace(s, 'this.#armCorrections(true);', '')],
  ['correction text identity', 'engine', 'engine-regressions', 'a correction id with different segment', (s) => replace(s,
    " && outbox.text.slice(segment.start, segment.end) === correction.text", '')],
  ['durable design completion', 'engine', 'engine-regressions', 'terminal design intents survive', (s) => replace(s,
    'onComplete: (results) => this.#persistDesignResults(results)', 'onComplete: () => {}')],
  ['design completion restoration', 'engine', 'engine-regressions', 'terminal design intents survive', (s) => replace(s, 'this.#design.restore(this.#meta.design_results);', '')],
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

for (const [name, module, suite, pattern, mutate] of mutations) {
  it(`mutation proof: ${name} turns its regression red`, () => {
    // Node runs this file's tests serially; restore every source before the next
    // child. The live worktree is always untouched by these deliberate defects.
    for (const [path, source] of originals) writeFileSync(join(scratch, path), source);
    const path = `runtime/engine/${module}.js`;
    writeFileSync(join(scratch, path), mutate(originals.get(path)));
    const child = spawnSync(process.execPath, ['--test', '--test-reporter=tap',
      `--test-name-pattern=${pattern}`, `test/${suite}.test.js`], { cwd: scratch, encoding: 'utf8', timeout: 10_000,
      // The child is an independent test runner, not another parent test worker.
      env: { ...process.env, NODE_TEST_CONTEXT: undefined } });
    const report = child.stdout + child.stderr;
    assert.equal(child.error, undefined, report);
    assert.equal(child.status, 1, report);
    assert.doesNotMatch(report, /SyntaxError|ERR_MODULE_NOT_FOUND/);
    assert.match(report, /# fail [1-9][0-9]*/);
    assert.match(report, /failureType: '(?:testCodeFailure|unhandledRejection)'/);
  });
}
