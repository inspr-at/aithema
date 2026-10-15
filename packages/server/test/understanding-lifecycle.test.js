import { test } from 'node:test';
import assert from 'node:assert/strict';
import { setTimeout as delay } from 'node:timers/promises';
import { SQLiteStorage, createHandlers, createPluginRuntime } from '../src/index.js';
import { PluginRegistry } from '@inspr/aithema-core';
import { createOpenRouterReasoning } from '../../../plugins/openrouter/src/index.js';
import { openRouterConfig } from '../../../demo/openrouter-config.js';
import { start2PurposePolicy } from '../../../demo/safeguards.js';
import { ownedRequest, testToken } from '../../../test/helpers.js';

const project = 'Wir möchten die manuelle Auftragsbearbeitung in unserem Betrieb vereinfachen.';
const offTopic = 'Geben Sie mir ein Rezept für Gemüsesuppe.';
const assessment = {
  summary: 'Die Auftragsbearbeitung soll vereinfacht werden.', signals: [], openQuestions: [],
  constraints: { operations: null, data: null, systems: null, reach: null, requirements: null },
  progress: { talk: { value: 0.2, reasoning: 'Erste Angaben' }, build: { value: 0, reasoning: 'Offene Details' } },
  actor: null, engagement: null, conceptIntent: null,
};
function fixture(t) {
  const storage = new SQLiteStorage(), calls = [], logs = [];
  const config = openRouterConfig({ OPENROUTER_MODEL: 'anthropic/fixture-understanding', OPENROUTER_SPEECH_MODEL: 'anthropic/fixture-reply',
    AITHEMA_OPENROUTER_PRICES: JSON.stringify({ 'anthropic/fixture-understanding': { prompt: 1e-6, completion: 2e-6 },
      'anthropic/fixture-reply': { prompt: 1e-6, completion: 2e-6 } }) });
  const plugin = createOpenRouterReasoning({ binding: config.reaction, prices: config.prices, resolveSecret: () => 'fake-only',
    async fetchImpl(_url, init) {
      const body = JSON.parse(init.body), call = { stream: body.stream, aborted: false, messages: body.messages };
      calls.push(call);
      // Keep the actual adapter invocation dispatched and unsettled for the
      // whole provider latency. Settling an instant mock before a gate hides this race.
      try { await delay(body.stream ? 1000 : 6000, undefined, { signal: init.signal }); }
      catch (error) { call.aborted = true; throw error; }
      const usage = { prompt_tokens: 30, completion_tokens: 40, cost: 0.00011 };
      if (!body.stream) return Response.json({ usage, choices: [{ finish_reason: 'stop', message: { content: JSON.stringify(assessment) } }] });
      const off = body.messages.at(-1).content === offTopic;
      const content = JSON.stringify({ content: 'Welcher Arbeitsschritt kostet heute am meisten Zeit?', scope: off ? 'off' : 'in', question_short: null, options: [] });
      return new Response(`data: ${JSON.stringify({ choices: [{ delta: { content }, finish_reason: 'stop' }], usage })}\n\ndata: [DONE]\n\n`);
    } });
  const runtime = createPluginRuntime({ storage, registry: new PluginRegistry().register(plugin),
    consent: { coverage: ({ scope, consentRevision }) => ({ covered: true, ...scope, scope, consentRevision, checkedAt: Date.now(), expiresAt: Date.now() + 60_000 }) },
    presets: { best: { plugins: ['openrouter'], bindings: { reaction: config.reaction, understanding: config.understanding },
      policy: { endpoints: [config.reaction.endpoint] } } } });
  const handlers = createHandlers({ storage, pluginRuntime: runtime, purposePolicy: start2PurposePolicy, log: event => logs.push(event) });
  const session = storage.create({ demo: true, locale: 'de', ownerToken: testToken });
  t.after(async () => { await handlers.close(); storage.close(); });
  const send = content => handlers.handle(ownedRequest(`http://localhost/api/sessions/${session.id}/turns`, {
    method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ content, clientEventId: crypto.randomUUID() }),
  }));
  const rows = () => storage.db.prepare("SELECT * FROM budget_attempts WHERE lane='understanding' ORDER BY rowid").all();
  return { storage, session, handlers, send, rows, calls, logs };
}
function assertPaidWorkCompleted(f, expected) {
  const rows = f.rows();
  assert.equal(rows.length, expected);
  assert.ok(rows.every(row => row.outcome === 'completed' && row.settled_micro === 110 && row.settled_micro < row.max_micro),
    JSON.stringify(rows.map(({ outcome, settled_micro, max_micro, usage }) => ({ outcome, settled_micro, max_micro, usage }))));
  assert.ok(rows.every(row => JSON.parse(row.usage).inputTokens === 30 && JSON.parse(row.usage).outputTokens === 40));
  assert.equal(f.calls.filter(call => !call.stream && call.aborted).length, 0, 'a dispatched project analysis must finish');
}

test('AIT-198 slow provider: one in-scope DE turn publishes understanding and settles actual usage', async t => {
  const f = fixture(t);
  assert.equal((await f.send(project)).status, 200);
  await f.handlers.idle();
  assert.equal(f.storage.read(f.session.id).filter(event => event.type === 'understanding.updated').length, 1);
  assertPaidWorkCompleted(f, 1);
});

test('AIT-198 slow provider: off-topic within three seconds preserves dispatched project analysis', async t => {
  const f = fixture(t);
  await f.send(project); await delay(2000);
  assert.equal(f.rows()[0]?.state, 'dispatched');
  await f.send(offTopic); await f.handlers.idle();
  assert.equal(f.storage.read(f.session.id).filter(event => event.type === 'understanding.updated').length, 1);
  assertPaidWorkCompleted(f, 1);
  assert.equal(f.storage.safeguards(f.session.id).offTopicTurns, 1);
  assert.ok(f.calls.filter(call => !call.stream).every(call => !JSON.stringify(call.messages).includes(offTopic)));
});

test('AIT-198 slow provider: superseding project input never aborts already dispatched paid analysis', async t => {
  const f = fixture(t);
  await f.send(project); await delay(2000);
  assert.equal(f.rows()[0]?.state, 'dispatched');
  await f.send('Unsere neue Anforderung ist eine Schnittstelle zur Buchhaltung.');
  await f.handlers.idle();
  assertPaidWorkCompleted(f, 2);
  const updates = f.storage.read(f.session.id).filter(event => event.type === 'understanding.updated');
  assert.equal(updates.length, 1, 'only the current project revision may publish');
});
