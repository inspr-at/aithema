import { test } from 'node:test';
import assert from 'node:assert/strict';
import { SQLiteStorage } from '@inspr/aithema-server';
import { SQLiteBudgetLedger } from '../../packages/server/src/budget.js';
import { createClaudeHTML } from '@inspr/aithema-plugin-claude-html';
import { createSpendCap } from '../../packages/server/src/spend-cap.js';
import { htmlConfig } from '../html-config.js';

const model = 'anthropic/claude-opus-5.5';
const values = { AITHEMA_HTML_MODE: 'claude', OPENROUTER_MODEL: model,
  AITHEMA_OPENROUTER_PRICES: JSON.stringify({ [model]: { prompt: 5e-6, completion: 25e-6 } }) };
const document = '<!doctype html><html lang="en"><head><!-- Revision 1: Repairs. --><meta charset="utf-8"><title>Repairs</title></head><body><button onclick="this.textContent=\'Open\'">Repairs</button></body></html>';

for (const mode of ['completed', 'invalid-output', 'http-error', 'cancelled-known', 'cancelled-unknown', 'unsent']) {
  test(`draft holds settle both ledgers: ${mode}`, async t => {
    const storage = new SQLiteStorage(); t.after(() => storage.close());
    const session = storage.create(), budget = new SQLiteBudgetLedger(storage);
    const configured = htmlConfig(values);
    const binding = configured.binding, spend = createSpendCap({ storage, account: binding.accountRef, capMicro: 10_000_000 });
    const { attemptId } = budget.admit({ sessionId: session.id, lane: 'concept', maxMicro: binding.maxMicro,
      requestSha256: 'a'.repeat(64), bindingSha256: 'b'.repeat(64) });
    assert.equal(budget.used(session.id), 1_000_000);
    const claim = budget.claim(attemptId), controller = new AbortController();
    const started = Promise.withResolvers(); let calls = 0;
    const plugin = createClaudeHTML({ binding, spend, resolveSecret: () => mode === 'unsent' ? null : 'fixture',
      now: () => { if (mode === 'cancelled-known') controller.abort(); return Date.now(); },
      fetchImpl: async () => {
        calls++; assert.equal(budget.used(session.id), 1_000_000);
        assert.ok(spend.snapshot().reservedMicro > 0); started.resolve();
        if (mode === 'cancelled-unknown') return new Promise(() => {});
        return Response.json({ usage: { prompt_tokens: 10, completion_tokens: 20, cost: 0.001234 },
          choices: [{ finish_reason: mode === 'invalid-output' ? 'length' : 'stop', message: { content: document } }] },
        { status: mode === 'http-error' ? 500 : 200 });
      } });
    const pending = plugin.generate({ prompt: 'Repairs', language: 'en' }, '', { signal: controller.signal,
      deadlineAt: Date.now() + 5000, attempt: claim, report: terminal => budget.settle(claim.claimId, terminal, binding.rates) });
    if (mode === 'completed') await pending;
    else {
      const rejected = assert.rejects(pending, { code: { 'invalid-output': 'invalid-output', 'http-error': 'provider',
        'cancelled-known': 'cancelled', 'cancelled-unknown': 'cancelled', unsent: 'auth' }[mode] });
      if (mode === 'cancelled-unknown') { await started.promise; controller.abort(); }
      await rejected;
    }
    const row = budget.get(attemptId), account = spend.snapshot();
    assert.equal(row.state, 'settled'); assert.equal(account.reservedMicro, 0);
    if (mode === 'cancelled-unknown') {
      assert.equal(row.outcome, 'uncertain'); assert.equal(row.settled_micro, 1_000_000);
      assert.ok(account.spentMicro > 0, 'unknown dispatched spend remains conservatively charged');
    } else {
      const actual = mode === 'unsent' ? 0 : 1234;
      assert.equal(account.spentMicro, actual);
      assert.equal(row.settled_micro, actual, 'credits and the deployment cap use the provider cost');
      assert.equal(row.outcome, mode === 'completed' ? 'completed' : 'cancelled');
    }
    assert.equal(calls, mode === 'unsent' ? 0 : 1);
  });
}
