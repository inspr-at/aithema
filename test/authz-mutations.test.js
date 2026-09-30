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
    ['markPurged', "this.#dispatch({ type: 'cache-purged' });", 'tombstone is committed before cancellation/drain'],
    ['markPurgeAcknowledged', "this.#dispatch({ type: 'purge-acknowledged' });", 'journal re-drives a failed purge cache'],
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
  ...['markPurged', 'markPurgeAcknowledged'].map((entry) => ({
    name: `${entry} enqueues from an observer without a nested transition`, file: 'session.js',
    changes: [["if (this.#draining) return;", '/* mutation: run a nested transition synchronously */']],
    regression: `an onChange observer queues ${entry} before the next purge state commit`,
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
    changes: [["catch (error) { failure ??= error; }", "catch (error) { failure ??= error; break; }"]],
    regression: 'an observer failure cannot strand queued revocation',
  },
  {
    name: 'PURGING retains the authority receipt before observer notification', file: 'transition.js',
    changes: [["if (authority.tombstone === 'purge' && event.record)", 'if (false)']],
    regression: 'an observer stopping the monitor on PURGING cannot skip receipt retention',
  },
  {
    name: 'stopping the monitor cannot skip the purge lifecycle effect', file: 'session.js',
    changes: [["entry.result = this.#startPurge(effect.error);", 'entry.result = undefined; /* mutation: omitted purge effect */']],
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
    changes: [["const artifacts = this.#artifacts();", "this.#artifactsSnapshot = [];\n        const artifacts = this.#artifacts();"]],
    regression: 'journal re-drives a failed purge inventory',
  },
  {
    name: 'failed drain is retried within the remaining allowance', file: 'purge.js',
    changes: [["if (!(error instanceof AuthzError) || error.status !== 504) throw error;", "if (!(error instanceof AuthzError) || error.status !== 504) { this.#drained = true; throw error; }"]],
    regression: 'journal re-drives a failed purge drain',
  },
  {
    name: 'drain retry does not reset the original 10s bound', file: 'purge.js',
    changes: [["this.#drainDeadline ??=", "this.#drainDeadline ="]],
    regression: 'a retried drain shares the original 10s allowance',
  },
  {
    name: 'failed cache purge is retried', file: 'purge.js',
    changes: [["  #drained;", "  #drained;\n  #cacheAttempted = false;"],
      ["await this.#purgeCache();", "if (!this.#cacheAttempted) { this.#cacheAttempted = true; await this.#purgeCache(); }"]],
    regression: 'journal re-drives a failed purge cache',
  },
  {
    name: 'unrecorded acknowledgement is retried', file: 'purge.js',
    changes: [["  #drained;", "  #drained;\n  #ackAttempted = false;"],
      ["if (!this.#session.purgeAcknowledged) {", "if (!this.#session.purgeAcknowledged && !this.#ackAttempted) {\n      this.#ackAttempted = true;"]],
    regression: 'journal re-drives a failed purge acknowledgement',
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
