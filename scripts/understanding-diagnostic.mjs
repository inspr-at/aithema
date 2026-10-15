// OPS only. Inherit process configuration; never load files or print content.
import { pathToFileURL } from 'node:url';
import { setTimeout as delay } from 'node:timers/promises';
import { PluginRegistry, inputRevision, PluginError } from '../packages/core/src/index.js';
import { SQLiteStorage, createHandlers, createPluginRuntime, createSpendCap } from '../packages/server/src/index.js';
import { createOpenRouterReasoning } from '../plugins/openrouter/src/index.js';
import { openRouterConfig } from '../demo/openrouter-config.js';
import { start2PurposePolicy } from '../demo/safeguards.js';

const project = 'Wir möchten die manuelle Auftragsbearbeitung in unserem Betrieb vereinfachen.';
const offTopic = 'Geben Sie mir ein Rezept für Gemüsesuppe.';

// Two independent analyses plus one off-topic classifier: <=3 wire calls total.
// Seed the synthetic project's known in-scope classification to reserve the call
// allowance for understanding. The reply diagnostic separately tests classification.
export async function runUnderstandingDiagnostic({ config, fetchImpl = globalThis.fetch,
  write = report => console.log(JSON.stringify(report)) }) {
  const storage = new SQLiteStorage(), logs = [];
  let calls = 0, handlers;
  const ownerToken = 'ops-understanding-diagnostic';
  try {
    const spendCap = createSpendCap({ storage, account: config.reaction.accountRef, capMicro: Math.min(config.capMicro, 1_000_000) });
    const plugin = createOpenRouterReasoning({ binding: config.reaction, prices: config.prices, spendCap,
      fetchImpl: (...args) => {
        if (calls >= 3) throw new Error('Diagnostic call cap');
        calls++;
        return fetchImpl(...args);
      } });
    const runtime = createPluginRuntime({ storage, registry: new PluginRegistry().register(plugin),
      consent: { coverage: ({ scope, consentRevision }) => ({ covered: true, ...scope, scope, consentRevision,
        checkedAt: Date.now(), expiresAt: Date.now() + 60_000 }) },
      presets: { best: { plugins: ['openrouter'], bindings: { reaction: config.reaction, understanding: config.understanding },
        policy: { endpoints: [config.reaction.endpoint] } } } });
    const admit = runtime.admit;
    runtime.admit = args => {
      if (calls >= 3) throw new PluginError('not-admitted', 'Diagnostic call cap');
      return admit(args);
    };
    handlers = createHandlers({ storage, pluginRuntime: runtime, purposePolicy: start2PurposePolicy, log: event => logs.push(event) });
    const request = (id, action, body = {}) => new Request(`http://diagnostic.invalid/api/sessions/${id}/${action}`, {
      method: 'POST', headers: { 'content-type': 'application/json', 'x-aithema-session-token': ownerToken }, body: JSON.stringify(body),
    });
    let passed = true;
    for (const overlap of [false, true]) {
      const session = storage.create({ demo: true, locale: 'de', ownerToken });
      storage.postTurn(session.id, 'synthetic-project', Buffer.from(project), project, { ownerToken });
      storage.appendPurposeReply(session.id, null, inputRevision(storage.get(session.id)), false, start2PurposePolicy.offTopicLimit);
      const rows = () => storage.db.prepare("SELECT * FROM budget_attempts WHERE session_id=? AND lane='understanding'").all(session.id);
      await handlers.handle(request(session.id, 'retry'));
      let overlapped = false;
      if (overlap) {
        const deadline = Date.now() + 5000;
        while (!rows().length && Date.now() < deadline) await delay(10);
        // Send within three seconds of analysis admission, while it is paid.
        await delay(250);
        overlapped = rows().some(row => row.state === 'dispatched');
        await handlers.handle(request(session.id, 'turns', { content: offTopic, clientEventId: 'synthetic-off-topic' }));
      }
      await handlers.idle();
      const attempts = rows(), completed = attempts.filter(row => row.outcome === 'completed');
      const withUsage = completed.filter(row => {
        const usage = row.usage && JSON.parse(row.usage);
        return Number.isSafeInteger(usage?.inputTokens) && Number.isSafeInteger(usage?.outputTokens) &&
          usage.inputTokens + usage.outputTokens > 0;
      });
      const uncertain = attempts.filter(row => row.outcome === 'uncertain');
      const updates = storage.read(session.id).filter(event => event.type === 'understanding.updated').length;
      const offClassified = !overlap || storage.safeguards(session.id).offTopicTurns === 1;
      const ok = attempts.length === 1 && completed.length === 1 && withUsage.length === 1 && updates === 1 &&
        uncertain.length === 0 && offClassified && (!overlap || overlapped);
      passed &&= ok;
      write({ case: overlap ? 'in-then-off-de' : 'in-only-de', passed: ok, calls,
        project_scope_seeded: true, ...(overlap ? { overlapped, off_classified: offClassified } : {}),
        understanding_updates: updates, completed: completed.length, with_usage: withUsage.length,
        uncertain: uncertain.length, max_charged_uncertain: uncertain.filter(row => row.settled_micro === row.max_micro).length,
        failures: logs.filter(event => ['understanding.failed', 'understanding.aborted', 'understanding.uncertain'].includes(event.event))
          .map(({ event, reason }) => ({ event, reason })),
        outcomes: Object.fromEntries(['started', 'completed', 'superseded', 'deferred', 'aborted', 'uncertain', 'failed']
          .map(outcome => [outcome, logs.filter(event => event.event === `understanding.${outcome}`).length])) });
      logs.length = 0;
    }
    return { passed, calls };
  } finally { await handlers?.close(); storage.close(); }
}

async function main() {
  if (!process.argv.includes('--allow-live') || process.env.CI) throw new Error('OPS manual use only');
  const result = await runUnderstandingDiagnostic({ config: openRouterConfig(process.env) });
  if (!result.passed) process.exitCode = 1;
}
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch(() => { console.error('{"diagnostic_error":true}'); process.exitCode = 1; });
}
