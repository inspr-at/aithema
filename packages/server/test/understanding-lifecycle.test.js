import { test } from 'node:test';
import assert from 'node:assert/strict';
import { setTimeout as delay, setImmediate as nextTurn } from 'node:timers/promises';
import { createDemoHost } from '../../../demo/host-ports.js';
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
function fixture(t, { replyMs = 1000, analysisMs = 6000, analysisHttpError = false, analysisStatus = 400, rejectBounds = false, rejectConstrained = false, invalidAssessment = false, visitorCredits = false } = {}) {
  const storage = new SQLiteStorage(), calls = [], logs = [];
  const config = openRouterConfig({ OPENROUTER_MODEL: 'anthropic/fixture-understanding', OPENROUTER_SPEECH_MODEL: 'anthropic/fixture-reply',
    AITHEMA_OPENROUTER_PRICES: JSON.stringify({ 'anthropic/fixture-understanding': { prompt: 1e-6, completion: 2e-6 },
      'anthropic/fixture-reply': { prompt: 1e-6, completion: 2e-6 } }) });
  const plugin = createOpenRouterReasoning({ binding: config.reaction, prices: config.prices, resolveSecret: () => 'fake-only',
    async fetchImpl(_url, init) {
      const body = JSON.parse(init.body), call = { stream: body.stream, aborted: false, messages: body.messages, body };
      calls.push(call);
      // Keep the actual adapter invocation dispatched and unsettled for the
      // whole provider latency. Settling an instant mock before a gate hides this race.
      try { await delay(body.stream ? replyMs : analysisMs, undefined, { signal: init.signal }); }
      catch (error) { call.aborted = true; throw error; }
      if (!body.stream && (rejectBounds && /"(?:minimum|maximum)":/u.test(JSON.stringify(body.response_format)) || rejectConstrained && body.response_format)) return Response.json({ error: { message: 'Invalid schema: minimum/maximum unsupported' } }, { status: 400 });
      if (!body.stream && analysisHttpError) return new Response('Private provider refusal', { status: analysisStatus });
      const usage = { prompt_tokens: 30, completion_tokens: 40, cost: 0.00011 };
      if (!body.stream) return Response.json({ usage, choices: [{ finish_reason: 'stop', message: { content: JSON.stringify(invalidAssessment ? { ...assessment, progress: { ...assessment.progress, talk: { value: 2, reasoning: 'Invalid' } } } : assessment) } }] });
      const off = body.messages.at(-1).content === offTopic;
      const content = JSON.stringify({ content: 'Welcher Arbeitsschritt kostet heute am meisten Zeit?', scope: off ? 'off' : 'in', question_short: null, options: [] });
      return new Response(`data: ${JSON.stringify({ choices: [{ delta: { content }, finish_reason: 'stop' }], usage })}\n\ndata: [DONE]\n\n`);
    } });
  const runtime = createPluginRuntime({ storage, registry: new PluginRegistry().register(plugin),
    consent: { coverage: ({ scope, consentRevision }) => ({ covered: true, ...scope, scope, consentRevision, checkedAt: Date.now(), expiresAt: Date.now() + 60_000 }) },
    presets: { best: { plugins: ['openrouter'], bindings: { reaction: config.reaction, understanding: config.understanding },
      policy: { endpoints: [config.reaction.endpoint] } } } });
  const host = visitorCredits ? createDemoHost({ storage, ownerGuard: false }) : undefined;
  const handlers = createHandlers({ storage, pluginRuntime: runtime, host, purposePolicy: start2PurposePolicy, log: event => logs.push(event) });
  const session = storage.create({ demo: true, locale: 'de', ownerToken: testToken });
  t.after(async () => { await handlers.close(); storage.close(); });
  const send = content => handlers.handle(ownedRequest(`http://localhost/api/sessions/${session.id}/turns`, {
    method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ content, clientEventId: crypto.randomUUID() }),
  }));
  const rows = () => storage.db.prepare("SELECT * FROM budget_attempts WHERE lane='understanding' ORDER BY rowid").all();
  return { storage, session, handlers, send, rows, calls, logs, host };
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
  assert.deepEqual(f.logs, [
    { event: 'understanding.started', count: 1, lane: 'understanding' },
    { event: 'understanding.completed', count: 1, lane: 'understanding' },
  ]);
  assert.doesNotMatch(JSON.stringify(f.logs), /Auftragsbearbeitung|Betrieb|Erste Angaben/u);
});

test('AIT-198 slow provider: off-topic within three seconds preserves dispatched project analysis', async t => {
  const f = fixture(t);
  await f.send(project); await dispatched(f);
  assert.equal(f.rows()[0]?.state, 'dispatched');
  await f.send(offTopic); await f.handlers.idle();
  assert.equal(f.storage.read(f.session.id).filter(event => event.type === 'understanding.updated').length, 1);
  assertPaidWorkCompleted(f, 1);
  assert.equal(f.storage.safeguards(f.session.id).offTopicTurns, 1);
  assert.ok(f.calls.filter(call => !call.stream).every(call => !JSON.stringify(call.messages).includes(offTopic)));
});

test('AIT-198 slow provider: superseding project input never aborts already dispatched paid analysis', async t => {
  const f = fixture(t);
  await f.send(project); await dispatched(f);
  assert.equal(f.rows()[0]?.state, 'dispatched');
  await f.send('Unsere neue Anforderung ist eine Schnittstelle zur Buchhaltung.');
  await f.handlers.idle();
  assertPaidWorkCompleted(f, 2);
  assert.equal(f.logs.filter(event => event.event === 'understanding.superseded').length, 1);
  assert.equal(f.logs.filter(event => event.event === 'understanding.aborted' || event.event === 'understanding.uncertain').length, 0);
  const updates = f.storage.read(f.session.id).filter(event => event.type === 'understanding.updated');
  assert.equal(updates.length, 1, 'only the current project revision may publish');
});


test('AIT-198 unknown provider refusal remains conservative and logs its HTTP class without values', async t => {
  const f = fixture(t, { replyMs: 5, analysisMs: 5, analysisHttpError: true });
  await f.send(project); await f.handlers.idle();
  const [row] = f.rows();
  assert.equal(f.rows().length, 1, 'a generic 400 is not a schema compatibility rejection');
  assert.equal(row.outcome, 'uncertain'); assert.equal(row.settled_micro, row.max_micro);
  assert.equal(row.usage, null, 'a provider error without a receipt gives no evidence of zero spend');
  assert.deepEqual(f.logs, [
    { event: 'understanding.started', count: 1, lane: 'understanding' },
    { event: 'understanding.uncertain', count: 1, lane: 'understanding', reason: 'provider-cost-unknown' },
    { event: 'understanding.failed', count: 1, lane: 'understanding', reason: 'provider-4xx' },
  ]);
  assert.doesNotMatch(JSON.stringify(f.logs), /Private|Auftragsbearbeitung|fake-only/u);
});


test('AIT-198 a duplicate Retry joins a pending analysis without causing another paid retry after provider failure', async t => {
  const f = fixture(t, { replyMs: 5, analysisMs: 100, analysisHttpError: true });
  await f.send(project);
  await dispatched(f);
  assert.equal(f.rows()[0]?.state, 'dispatched');
  assert.equal((await f.handlers.handle(ownedRequest(`http://localhost/api/sessions/${f.session.id}/retry`, {
    method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}',
  }))).status, 202);
  await f.handlers.idle();
  assert.equal(f.rows().length, 1, 'a join adds no attempt and a generic 400 cannot trigger compatibility retry');
  assert.equal(f.calls.filter(call => !call.stream).length, 1);
  assert.equal(f.calls.filter(call => !call.stream && !call.body.response_format).length, 0);
});

async function dispatched(f) {
  const deadline = Date.now() + 5000;
  while (f.rows()[0]?.state !== 'dispatched' && Date.now() < deadline) await nextTurn();
  assert.equal(f.rows()[0]?.state, 'dispatched');
}

test('AIT-198 portable understanding schema avoids the production 400/no-usage/max-charge shape', async t => {
  const f = fixture(t, { replyMs: 1, analysisMs: 1, rejectBounds: true });
  await f.send(project); await f.handlers.idle();
  assertPaidWorkCompleted(f, 1);
  assert.equal(f.storage.read(f.session.id).filter(e => e.type === 'understanding.updated').length, 1);
  const schema = f.calls.find(c => !c.stream).body.response_format.json_schema.schema;
  assert.doesNotMatch(JSON.stringify(schema), /"(?:minimum|maximum)":/u);
  assert.equal(schema.additionalProperties, false);
  assert.deepEqual(schema.required, Object.keys(schema.properties));
});

test('AIT-198 constrained understanding 400 gets exactly one freshly admitted prompt-only retry', async t => {
  const f = fixture(t, { replyMs: 1, analysisMs: 1, rejectConstrained: true });
  await f.send(project); await f.handlers.idle();
  const attempts = f.rows(), calls = f.calls.filter(c => !c.stream);
  assert.equal(attempts.length, 2);
  assert.notEqual(attempts[0].attempt_id, attempts[1].attempt_id);
  assert.equal(attempts[0].outcome, 'uncertain', 'unknown provider spend remains conservative');
  assert.equal(attempts[1].outcome, 'completed'); assert.equal(attempts[1].settled_micro, 110);
  assert.ok(calls[0].body.response_format); assert.equal(calls[1].body.response_format, undefined);
  assert.match(calls[1].body.messages[0].content, /schema/iu);
  assert.equal(f.storage.read(f.session.id).filter(e => e.type === 'understanding.updated').length, 1);
});

for (const invalid of [false, true]) test(`AIT-198 failed understanding releases visitor credits with ${invalid ? 'actual provider spend' : 'unknown provider spend'}`, async t => {
  const f = fixture(t, { replyMs: 1, analysisMs: 100, analysisHttpError: !invalid, invalidAssessment: invalid, visitorCredits: true });
  await f.send(project); await dispatched(f);
  const held = f.host.wallet(testToken).balance();
  assert.ok(held.reservedMicro > 0);
  await f.handlers.idle();
  const attempts = f.rows();
  assert.ok(attempts.every(row => row.settled_micro > 0), 'provider liability stays recorded');
  assert.equal(f.storage.read(f.session.id).filter(e => e.type === 'understanding.updated').length, 0, 'full numeric constraints remain host-side');
  assert.equal(f.host.wallet(testToken).balance().committedMicro, 110, 'only the successful reply costs visitor credits');
  const shown = f.host.wallet(testToken).displayBalance();
  assert.equal(shown.confirmedSpendMicro, 110); assert.equal(shown.uncertainSpendMicro, 0); assert.equal(shown.pendingHoldMicro, 0);
});

for (const status of [401, 402, 429]) test(`AIT-198 HTTP ${status} takes the error path without a prompt-only retry`, async t => {
  const f = fixture(t, { replyMs: 0, analysisMs: 0, analysisHttpError: true, analysisStatus: status });
  await f.send(project); await f.handlers.idle();
  assert.equal(f.rows().length, 1, 'auth, payment and rate-limit errors get one admission only');
  assert.equal(f.calls.filter(c => !c.stream).length, 1);
  assert.ok(f.calls.find(c => !c.stream).body.response_format);
  assert.equal(f.storage.read(f.session.id).filter(e => e.type === 'understanding.updated').length, 0);
  assert.equal(f.logs.filter(e => e.event === 'understanding.failed').length, 1);
});
