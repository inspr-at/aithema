import { after, before, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { cpSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

// Run real regressions against isolated source mutants. Never rewrite the live
// worktree, weaken the harness, or use providers/network. Each replacement must
// match once and each child must fail an assertion in its named regression.
const repo = fileURLToPath(new URL('../', import.meta.url));
const escape = (text) => text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
const stopRule = "{ type: 'stop-signals', channels: status === 'CAPTURE_ONLY' ? channels.slice(1) : channels, reason }";
const mutations = [
  ...['CAPTURE_ONLY', 'SUSPENDED', 'REVOKED', 'FENCED', 'PURGING', 'PURGED', 'ENDED'].map((state) => ({
    name: `${state} signal stop rule`, file: 'transition.js',
    changes: [[stopRule, `{ type: 'stop-signals', channels: status === '${state}' ? [] : status === 'CAPTURE_ONLY' ? channels.slice(1) : channels, reason }`]],
    regression: `the pure ${state} transition owns its complete signal stop effect`,
  })),
  {
    name: 'all historical signals, including before outage/resume', file: 'session.js',
    changes: [["for (const controller of this.#channels.get(channel).controllers)", "for (const controller of [this.#channels.get(channel).current])"]],
    regression: 'callback revoke stops every signal issued across repeated outage/resume cycles',
  },
  ...[
    ['revoke', "this.#dispatch({ type: 'revoke', epoch });", 'callback revoke stops every signal'],
    ['captureOnly', "this.#dispatch({ type: 'capture-only', reason });", 'callback revoke stops every signal'],
    ['end', "this.#dispatch({ type: 'end', reason });", 'session end stops every signal'],
    ['applyAuthority', "this.#dispatch({ type: 'authority', authority, purgeCoordinator });", 'authority epoch stops every signal'],
    ['consumeStoredRecord', "this.#dispatch({ type: 'journal-record', record: { document, bytes: Buffer.from(stored.bytes).toString('base64') }, purgeCoordinator });", 'journal suspend stops every signal'],
  ].map(([name, needle, regression]) => ({ name: `${name} calls the single transition authority`, file: 'session.js', changes: [[needle, 'undefined; /* mutation: omitted transition */']], regression })),
  {
    name: 'monitor callback calls the single transition authority', file: 'authority-monitor.js',
    changes: [["revoke(epoch) { this.#session.revoke(epoch); }", "revoke(epoch) {}"]],
    regression: 'callback does not shift polls',
  },
  {
    name: 'poll applies the accepted authority before purge effects', file: 'authority-monitor.js',
    changes: [["this.#session.applyAuthority(authority, { purgeCoordinator: this.#purge });", 'undefined; /* mutation: omitted authority */']],
    regression: 'a +60s clock spike followed by honest epoch',
  },
  {
    name: 'freshness uses only local monotonic receipt', file: 'authority-monitor.js',
    changes: [["this.#lastAuthority = now;", "this.#lastAuthority = Math.min(now, this.#origin + Date.parse(authority.issued_at) - this.#wallOrigin);"]],
    regression: 'local receipt renews freshness even when a plausible host clock is 30s behind',
  },
  {
    name: 'host issued_at never orders accepted responses', file: 'authority-monitor.js',
    changes: [["  #lastAuthority;", "  #lastAuthority;\n  #lastIssued = -Infinity;"],
      ["const purging = this.#session.applyAuthority(authority, { purgeCoordinator: this.#purge });", "if (Date.parse(authority.issued_at) < this.#lastIssued) throw new AuthzError(503, 'Backwards host time');\n      this.#lastIssued = Date.parse(authority.issued_at);\n      const purging = this.#session.applyAuthority(authority, { purgeCoordinator: this.#purge });"]],
    regression: 'a +60s clock spike followed by honest epoch stops old signals within 45s with 9000ms responses',
  },
  {
    name: 'lifecycle observer stop prevents authority lease renewal', file: 'authority-monitor.js',
    changes: [["if (!this.#running) { await purging; return; } // A synchronous lifecycle observer may stop us.", '/* mutation: renew after observer stop */']],
    regression: 'a lifecycle observer stopping the monitor cannot create new authority timers after stop',
  },
  {
    name: 'host future skew cannot advance the local lease', file: 'authority-monitor.js',
    changes: [["this.#lastAuthority = now;", "this.#lastAuthority = this.#origin + Date.parse(authority.issued_at) - this.#wallOrigin;"]],
    regression: 'host clock 60000ms ahead cannot extend the 70s outage',
  },
  {
    name: 'authority poll revoked refusal calls the single transition authority', file: 'authority-monitor.js',
    changes: [["if (error.code === 'revoked') this.#session.revoke();", "if (error.code === 'revoked') {}"]],
    regression: 'a revoked error from an authority poll',
  },
  {
    name: 'journal revoked refusal calls the single transition authority', file: 'session.js',
    changes: [["if (error.code === 'revoked') this.revoke();", "if (error.code === 'revoked') {}"]],
    regression: 'a revoked JournalPort read publishes permanent revocation',
  },
  {
    name: 'append revoked refusal closes claims after a lost tombstone response', file: 'purge.js',
    changes: [["if (error.code === 'revoked') this.#session.revoke();", "if (error.code === 'revoked') {}"]],
    regression: 'a lost tombstone response followed by revoked closes claims',
  },
  {
    name: 'initial journal purge uses the common re-drive entry point', file: 'session.js',
    changes: [["this.consumeStoredRecord(stored, { purgeCoordinator: options.purgeCoordinator });", 'undefined; /* mutation: omitted initial purge */']],
    regression: 'a purge learned through JournalPort runs the same bounded coordinator protocol',
  },
  {
    name: 'journal retries use retained tombstone state before denied reads', file: 'session.js',
    changes: [["if (this.scope.tombstone === 'purge') {", "if (false) {"]],
    regression: 'journal re-drives a failed purge cache',
  },
  {
    name: 'authority snapshots re-drive purge after a failed step', file: 'transition.js',
    changes: [["if (next.scope.tombstone === 'purge' && !next.purgeAcknowledged)", "if (event.type !== 'authority' && next.scope.tombstone === 'purge' && !next.purgeAcknowledged)"]],
    regression: 'authority re-drives a failed purge cache',
  },
  {
    name: 're-entrant inputs cannot run a nested transition synchronously', file: 'session.js',
    changes: [["if (this.#draining) return;", '/* mutation: run a nested transition synchronously */']],
    regression: 'an abort listener queues nested applyAuthority until captureOnly stops and notifies completely',
  },
  ...['revoke', 'captureOnly', 'end', 'applyAuthority', 'consumeStoredRecord suspend', 'consumeStoredRecord resume'].map((entry) => ({
    name: `${entry} enqueues from an observer without a nested transition`, file: 'session.js',
    changes: [["if (this.#draining) return;", '/* mutation: run a nested transition synchronously */']],
    regression: `an onChange observer queues ${entry} until the current notification completes`,
  })),
  ...['inventory', 'drain', 'cache', 'acknowledgement'].map((step) => ({
    name: `${step} callback enqueues without a nested transition`, file: 'session.js',
    changes: [["if (this.#draining) return;", '/* mutation: run a nested transition synchronously */']],
    regression: `a ${step} callback enqueues lifecycle inputs`,
  })),
  {
    name: 'redrivePurge enqueues from an observer without a nested transition', file: 'session.js',
    changes: [["if (this.#draining) return;", '/* mutation: run a nested transition synchronously */']],
    regression: 'an observer queues redrivePurge and retains its receipt only after the current event completes',
  },
  {
    name: 'queued authority owns a call-time snapshot', file: 'session.js',
    changes: [["authority: structuredClone(event.authority)", "authority: event.authority"]],
    regression: 'queued authority inputs retain their call-time bytes',
  },
  {
    name: 'the event loop commits state before abort callbacks', file: 'session.js',
    changes: [["this.#lifecycle = state;", 'if (!this.#lifecycle) this.#lifecycle = state; /* mutation: defer state commit */'],
      ["for (const effect of effects) {", "for (const effect of effects) {\n      if (effect.type === 'notify') this.#lifecycle = state;"]],
    regression: 'an abort listener queues nested applyAuthority until captureOnly stops and notifies completely',
  },
  {
    name: 'observer failure cannot strand already queued inputs', file: 'session.js',
    changes: [["catch (error) { eventError = error; failure ??= error; }", "catch (error) { eventError = error; failure ??= error; break; }"]],
    regression: 'an observer failure cannot strand queued revocation',
  },
  {
    name: 'PURGING retains the authority receipt before observer notification', file: 'transition.js',
    changes: [["if (authority.tombstone === 'purge' && event.record)", 'if (false)']],
    regression: 'an observer stopping the monitor on PURGING cannot skip receipt retention',
  },
  {
    name: 'stopping the monitor cannot skip the purge lifecycle effect', file: 'session.js',
    changes: [["entry.result = this.#startPurge(effect.step, effect.error);", 'entry.result = undefined; /* mutation: omitted purge effect */']],
    regression: 'an observer stopping the monitor on PURGING cannot skip receipt retention',
  },
  {
    name: 'PURGING schedules re-drive before observer notification', file: 'transition.js',
    changes: [["return { state: freeze(next), effects };", "return { state: freeze(next), effects: effects.sort((a, b) => (a.type === 'notify' ? -1 : b.type === 'notify' ? 1 : 0)) };"]],
    regression: 'purge re-drive is scheduled before a failing PURGING observer notification',
  },
  {
    name: 'initial journal receipt emits a purge lifecycle effect', file: 'transition.js',
    changes: [["if (next.scope.tombstone === 'purge' && !next.purgeAcknowledged)", "if (event.type !== 'journal-record' && next.scope.tombstone === 'purge' && !next.purgeAcknowledged)"]],
    regression: 'a purge learned through JournalPort runs the same bounded coordinator protocol',
  },
  {
    name: 'explicit purge retry emits the same lifecycle effect', file: 'transition.js',
    changes: [["if (next.scope.tombstone === 'purge' && !next.purgeAcknowledged)", "if (event.type !== 'redrive-purge' && next.scope.tombstone === 'purge' && !next.purgeAcknowledged)"]],
    regression: 'journal re-drives a failed purge cache',
  },
  {
    name: 'failed inventory is retried before drain/deletion/ack', file: 'purge.js',
    changes: [["const artifacts = this.#artifacts();", "let artifacts; try { artifacts = this.#artifacts(); } catch { artifacts = []; }"]],
    regression: 'journal re-drives a failed purge inventory',
  },
  {
    name: 'failed drain is retried within the remaining allowance', file: 'transition.js',
    changes: [["next.purge.retry = { step: event.step, message: event.error.message };", "next.purge.retry = { step: event.step, message: event.error.message };\n      if (event.step === 'drain') next.purge.drained = true;"]],
    regression: 'journal re-drives a failed purge drain',
  },
  {
    name: 'drain retry does not reset the original 10s bound', file: 'purge.js',
    changes: [["const remaining = deadline - this.#clock.monotonicNow();", "const remaining = 10_000;"]],
    regression: 'a retried drain shares the original 10s allowance',
  },
  {
    name: 'failed cache purge is retried', file: 'purge.js',
    changes: [["  #tombstone;", "  #tombstone;\n  #cacheAttempted = false;"],
      ["case 'cache': return Promise.resolve(this.#purgeCache()).then(() => true);", "case 'cache': if (this.#cacheAttempted) return true; this.#cacheAttempted = true; return Promise.resolve(this.#purgeCache()).then(() => true);"]],
    regression: 'journal re-drives a failed purge cache',
  },
  {
    name: 'unrecorded acknowledgement is retried', file: 'purge.js',
    changes: [["  #tombstone;", "  #tombstone;\n  #ackAttempted = false;"],
      ["case 'acknowledgement': return withDeadline", "case 'acknowledgement': if (this.#ackAttempted) return progress.receipt; this.#ackAttempted = true; return withDeadline"]],
    regression: 'journal re-drives a failed purge acknowledgement',
  },
  ...[
    ['markPurged', "this.#dispatch({ type: 'cache-purged' });"],
    ['markPurgeAcknowledged', "this.#dispatch({ type: 'purge_acknowledged', receipt: this.purgeReceipt });"],
  ].map(([name, body]) => ({
    name: `${name} has no public entry point`, file: 'session.js',
    changes: [["  get purgeAcknowledged()", `  ${name}() { ${body} }\n  get purgeAcknowledged()`]],
    regression: 'callers have no public purge completion or acknowledgement setter',
  })),
  {
    name: 'every other event is forbidden from entering PURGED', file: 'transition.js',
    changes: [["case 'purge_acknowledged':", "case 'cache-purged':\n      status = 'PURGED'; break;\n    case 'purge_acknowledged':"]],
    regression: 'only the internal receipt event with every completed step can enter PURGED',
  },
  ...[
    ["status !== 'PURGING' || next.scope.tombstone", 'false || next.scope.tombstone'],
    ["next.scope.tombstone !== 'purge' || !next.purgeRecord", 'false || !next.purgeRecord'],
    ["|| !next.purgeRecord\n          || next.purge.drainDeadline", '|| false\n          || next.purge.drainDeadline'],
    ['next.purge.drainDeadline === null ||', 'false ||'],
    ['next.purge.artifacts === null || next.purge.drained', 'false || next.purge.drained'],
    ['next.purge.drained === null\n          ||', 'false\n          ||'],
    ['!next.purge.cacheDeleted ||', 'false ||'],
    ['|| !next.purge.receipt\n          || canonicalJson', '|| false\n          || canonicalJson'],
    ['canonicalJson(event.receipt) !== canonicalJson(next.purge.receipt)', 'false'],
  ].map(([needle, replacement], index) => ({
    name: `internal acknowledgement checks completed purge prerequisite ${index + 1}`, file: 'transition.js',
    changes: [[needle, replacement]],
    regression: 'only the internal receipt event with every completed step can enter PURGED',
  })),
  {
    name: 'cache completion cannot enter PURGED before acknowledgement', file: 'transition.js',
    changes: [["next.purge.cacheDeleted = true;", "next.purge.cacheDeleted = true; status = 'PURGED';"]],
    regression: 'PURGED notification follows the recorded host acknowledgement',
  },
  {
    name: 'receipt is recorded before the PURGED observer', file: 'transition.js',
    changes: [["next.purgeAcknowledged = true;", '/* mutation: skip recording host acknowledgement */']],
    regression: 'PURGED notification follows the recorded host acknowledgement',
  },
  {
    name: 'pending acknowledgement cannot produce a PURGED notification', file: 'session.js',
    changes: [["value.then(completed, failed);", "step === 'acknowledgement' ? completed(this.#lifecycle.purge.receipt) : value.then(completed, failed);"]],
    regression: 'PURGED notification follows the recorded host acknowledgement',
  },
  {
    name: 'purge body starts inside the draining event', file: 'session.js',
    changes: [["const value = this.#purgeCoordinator.performStep(step,\n        { document: retained.document, bytes: Buffer.from(retained.bytes, 'base64') }, this.#lifecycle.purge);",
      "const value = Promise.resolve().then(() => this.#purgeCoordinator.performStep(step,\n        { document: retained.document, bytes: Buffer.from(retained.bytes, 'base64') }, this.#lifecycle.purge));"]],
    regression: 'purge step adapters run inside the draining event',
  },
  {
    name: 'drain adapter runs inside the draining event', file: 'purge.js',
    changes: [["milliseconds: remaining, deferOperation: false", "milliseconds: remaining, deferOperation: true"]],
    regression: 'a drain callback enqueues lifecycle inputs',
  },
  {
    name: 'acknowledgement adapter runs inside the draining event', file: 'purge.js',
    changes: [["scheduler: this.#scheduler, deferOperation: false", "scheduler: this.#scheduler, deferOperation: true"]],
    regression: 'a acknowledgement callback enqueues lifecycle inputs',
  },
  {
    name: 'cache adapter runs inside the draining event', file: 'purge.js',
    changes: [["Promise.resolve(this.#purgeCache()).then(() => true)", "Promise.resolve().then(() => this.#purgeCache()).then(() => true)"]],
    regression: 'a cache callback enqueues lifecycle inputs',
  },
  {
    name: 'failed terminal observer cannot leave authority timers running', file: 'authority-monitor.js',
    changes: [["if (this.#session.purgeAcknowledged && this.#running) this.stop();", '/* mutation: retain timers after observer failure */']],
    regression: 'a PURGED observer attempting start monitor cannot skip the host acknowledgement',
  },
  {
    name: 'coordinator host purge uses the single lifecycle queue', file: 'purge.js',
    changes: [["this.#session.redrivePurge(this, this.#stored)", 'null']],
    regression: 'tombstone is committed before cancellation/drain',
  },
  {
    name: 'coordinator completion uses the single lifecycle queue', file: 'purge.js',
    changes: [["this.#session.redrivePurge(this, checked)", 'null']],
    regression: 'complete: a observer cannot queue public markPurged',
  },
  {
    name: 'pending completion is installed before a purge callback', file: 'purge.js',
    changes: [["this.#busy = operation.promise;", '/* mutation: defer coalescing */'],
      ["return operation.promise;", "this.#busy = operation.promise; return operation.promise;"]],
    regression: 'coordinator completion is coalesced before a purge callback can re-enter it',
  },
  {
    name: 'cache step completion requires a successful result', file: 'transition.js',
    changes: [["if (event.value !== true) throw new TypeError('Completed cache deletion required');", '/* mutation: accept incomplete cache deletion */']],
    regression: 'only the internal receipt event with every completed step can enter PURGED',
  },
  {
    name: 'generation publishes the shared route scope', file: 'transition.js',
    changes: [["next.scope.worker_generation = authority.worker_generation;", '/* mutation: omitted generation */']],
    regression: 'authority generation publishes scope',
  },
  {
    name: 'authority verifies pid before applying the response', file: 'authority-monitor.js',
    changes: [["['tid', 'pid', 'sid']", "['tid', 'sid']"]],
    regression: 'refuses foreign pid without refreshing authority',
  },
  {
    name: 'processor_ref uniqueness is independent of evidence refs', file: 'session.js',
    changes: [["new Set(record.processors.map((processor) => processor.processor_ref)).size !== record.processors.length", 'false']],
    regression: 'refuses duplicate processor_ref even when the evidence references differ',
  },
  {
    name: 'route authority carries only the matched capability', file: 'capability-guard.js',
    changes: [["capabilities: [row.capability]", "capabilities: [...claims.capabilities]"]],
    regression: 'journal.records returns only its allowed capability',
  },
  {
    name: 'operation binds an exact literal matrix row', file: 'capability-guard.js',
    changes: [["['GET /journal/sessions/{sid}/records | …/cursor', ['journal.records', 'journal.cursor']]", "['ledger admit | claim | settle', ['journal.records', 'journal.cursor']]"]],
    regression: 'pins the literal capability, generation, epoch, pid and LiveGrant matrix',
  },
  {
    name: 'purge caches only a byte-exact original receipt', file: 'purge.js',
    changes: [["if (this.#submission && !bytes.equals(this.#submission))", 'if (false)']],
    regression: 'retries append after different id rather than caching a bad purge acknowledgement',
  },
  {
    name: 'byte-exact committed receipt survives a deadline race', file: 'purge.js',
    changes: [["if (!(error instanceof AuthzError) || error.status !== 504 || !this.#stored) throw error;", 'throw error;']],
    regression: 'adopts a byte-exact committed purge receipt resolved at 10000ms',
  },
];

describe('authorization mutation protections', { concurrency: false }, () => {
  let sandbox;
  before(() => {
    sandbox = mkdtempSync(join(tmpdir(), 'aithema-authz-mutations-'));
    writeFileSync(join(sandbox, 'package.json'), '{"type":"module"}\n');
    for (const directory of ['contracts', 'runtime/authz', 'runtime/journal', 'test/fixtures/journal']) {
      cpSync(join(repo, directory), join(sandbox, directory), { recursive: true });
    }
    cpSync(join(repo, 'test/authz.test.js'), join(sandbox, 'test/authz.test.js'));
  });
  after(() => { if (sandbox) rmSync(sandbox, { recursive: true, force: true }); });
  for (const mutant of mutations) it(`turns red without ${mutant.name}`, () => {
    const path = join(sandbox, 'runtime/authz', mutant.file);
    const original = readFileSync(path, 'utf8');
    let source = original;
    for (const [needle, replacement] of mutant.changes) {
      assert.equal(source.split(needle).length - 1, 1, `Mutation must match exactly once: ${needle}`);
      source = source.replace(needle, replacement);
    }
    try {
      writeFileSync(path, source);
      const result = spawnSync(process.execPath, ['--test', '--test-reporter=tap',
        `--test-name-pattern=${escape(mutant.regression)}`, 'test/authz.test.js'],
      // An isolated runner must not inherit NODE_TEST_CONTEXT (which suppresses
      // nested runners) or any provider credentials/settings from the parent.
      { cwd: sandbox, env: {}, encoding: 'utf8', timeout: 15_000, maxBuffer: 1024 * 1024 });
      assert.ifError(result.error);
      assert.equal(result.status, 1, `Mutation survived: ${mutant.name}\n${result.stdout}\n${result.stderr}`);
      assert.match(result.stdout, /# fail [1-9][0-9]*\b/);
      assert.match(result.stdout, /(?:AssertionError|ERR_TEST_FAILURE)/, 'The regression must fail an assertion');
      assert.doesNotMatch(result.stdout + result.stderr, /(?:SyntaxError|ERR_MODULE_NOT_FOUND)/, 'Broken imports/syntax do not prove a mutation');
    } finally { writeFileSync(path, original); }
  });
});
