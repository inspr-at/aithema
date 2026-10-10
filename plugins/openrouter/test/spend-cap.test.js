import { test } from 'node:test';
import assert from 'node:assert/strict';
import { SQLiteStorage, createSpendCap, usdMicro } from '../../../packages/server/src/index.js';
import { listen } from '../../../packages/server/src/http.js';
import { createOpenRouterReasoning } from '../src/index.js';
import { requestCeilingMicro } from '../src/pricing.js';
import { temporaryDb } from '../../../test/helpers.js';
import { openRouterConfig } from '../../../demo/openrouter-config.js';

const schema = { type: 'object', additionalProperties: false, properties: { summary: { type: 'string' } }, required: ['summary'] };
const request = { system: '', messages: [{ role: 'user', content: 'Hello' }], schema };
const opts = (extra = {}) => ({ deadlineAt: Date.now() + 5000, attempt: { attemptId: crypto.randomUUID(), claimId: crypto.randomUUID(), consume() {} }, report() {}, ...extra });
const price = { prompt: 5e-7, completion: 1.4e-6 };
async function provider(t, { path, capMicro = 100, maxTokens = 5 } = {}) {
  let storage = new SQLiteStorage(path), cap = createSpendCap({ storage, account: 'shared', capMicro });
  const state = { bodies: [], cost: 0.00001, missing: false, truncated: false, stall: false, release: null, status: 200, invalid: false };
  const running = await listen(async req => {
    const body = await req.json(); state.bodies.push(body);
    if (state.stall) await new Promise(resolve => { state.release = resolve; });
    const usage = state.missing ? { prompt_tokens: 1, completion_tokens: 1 } : { prompt_tokens: 1, completion_tokens: 1, cost: state.cost };
    if (!body.stream || state.status !== 200) return Response.json({ choices: [{ finish_reason: 'stop', message: { content: state.invalid ? '{}' : '{"summary":"ok"}' } }], usage }, { status: state.status });
    const frames = `data: ${JSON.stringify({ choices: [{ delta: { content: 'Hello' }, finish_reason: 'stop' }] })}\n\n` +
      `data: ${JSON.stringify({ choices: [], usage })}\n\n` + (state.truncated ? '' : 'data: [DONE]\n\n');
    return new Response(frames, { headers: { 'content-type': 'text/event-stream' } });
  });
  const binding = { plugin: 'openrouter', model: 'openai/fixture', endpoint: running.url, effort: 'none', accountRef: 'shared', secretRef: 'local-ref',
    maxMicro: 1_000_000, maxTokens, rates: { inputMicro: 0, outputMicro: 0 }, routing: { max_price: { prompt: 0, completion: 0 } } };
  const plugin = () => createOpenRouterReasoning({ binding, spendCap: cap, prices: { [binding.model]: price }, resolveSecret: () => 'local-fake-key' });
  t.after(async () => { state.release?.(); running.server.closeAllConnections(); await new Promise(resolve => running.server.close(resolve)); storage.close(); });
  return { state, plugin, totals: () => cap.snapshot(), cap: () => cap,
    restart() { storage.close(); storage = new SQLiteStorage(path); cap = createSpendCap({ storage, account: 'shared', capMicro }); } };
}
const collect = async plugin => { let text = ''; for await (const part of plugin.stream(request, opts())) text += part; return text; };

test('latest alias uses its configured price ceiling and the same account cap, regardless of served model', async () => {
  const model = '~anthropic/claude-opus-latest', storage = new SQLiteStorage(), bodies = [];
  try {
    const configured = openRouterConfig({ OPENROUTER_MODEL: model, OPENROUTER_ANALYSIS_EFFORT: 'low',
      OPENROUTER_ANALYSIS_MAX_TOKENS: '5', AITHEMA_OPENROUTER_CAP_USD: '0.0001',
      AITHEMA_OPENROUTER_PRICES: JSON.stringify({ [model]: price }) });
    const cap = createSpendCap({ storage, account: 'shared', capMicro: configured.capMicro });
    const plugin = createOpenRouterReasoning({ binding: configured.understanding, prices: configured.prices, spendCap: cap,
      resolveSecret: () => 'local-fixture', fetchImpl: async (url, init) => {
        bodies.push(JSON.parse(init.body));
        return Response.json({ model: 'anthropic/claude-opus-5.5', usage: { prompt_tokens: 1, completion_tokens: 1, cost: 0.00003 },
          choices: [{ finish_reason: 'stop', message: { content: '{"summary":"ok"}' } }] });
      } });
    for (let i = 0; i < 3; i++) await plugin.structured(request, opts());
    assert.deepEqual(cap.snapshot(), { spentMicro: 90, reservedMicro: 0, capMicro: 100, breached: false });
    await assert.rejects(plugin.structured(request, opts()), /spend cap exhausted/);
    assert.equal(bodies.length, 3);
    assert.equal(requestCeilingMicro(bodies[0], price), 40);
    for (const body of bodies) {
      assert.equal(body.model, model);
      assert.deepEqual(body.provider.max_price, { prompt: 0.5, completion: 1.4 });
      assert.equal(body.provider.require_parameters, true); assert.equal(body.provider.allow_fallbacks, false);
    }
  } finally { storage.close(); }
});

test('sums non-stream usage.cost; all dispatches ask for usage; refuses before provider dispatch', async t => {
  const h = await provider(t); h.state.cost = 0.00003;
  for (let i = 0; i < 3; i++) assert.deepEqual(await h.plugin().structured(request, opts()), { summary: 'ok' });
  assert.equal(h.totals().spentMicro, 90); assert.equal(h.totals().reservedMicro, 0);
  await assert.rejects(h.plugin().structured(request, opts()), /OpenRouter spend cap exhausted/);
  assert.equal(h.state.bodies.length, 3); assert.ok(h.state.bodies.every(b => b.usage.include === true));
  assert.deepEqual(h.state.bodies[0].provider.max_price, { prompt: 0.5, completion: 1.4 });
  assert.ok(h.state.bodies.every(b => b.max_tokens === 5));
});
test('final streaming usage settles one cumulative cost and includes usage request fields', async t => {
  const h = await provider(t); h.state.cost = 0.00002;
  assert.equal(await collect(h.plugin()), 'Hello');
  assert.deepEqual(h.totals(), { spentMicro: 20, reservedMicro: 0, capMicro: 100, breached: false });
  assert.deepEqual(h.state.bodies[0].usage, { include: true }); assert.equal(h.state.bodies[0].stream_options.include_usage, true);
});
test('missing usage holds survive a restart and are shared by another plugin/account counter', async t => {
  const h = await provider(t, { path: await temporaryDb() }); h.state.missing = true;
  await h.plugin().structured(request, opts()); await collect(h.plugin());
  assert.deepEqual(h.totals(), { spentMicro: 0, reservedMicro: 80, capMicro: 100, breached: false });
  h.restart(); assert.equal(h.cap().snapshot().reservedMicro, 80);
  assert.throws(() => h.cap().reserve(40), /spend cap exhausted/);
  await assert.rejects(h.plugin().structured(request, opts()), /spend cap exhausted/); assert.equal(h.state.bodies.length, 2);
});
test('completed actual spend is persistent across restart', async t => {
  const h = await provider(t, { path: await temporaryDb() });
  await h.plugin().structured(request, opts()); h.restart(); assert.equal(h.totals().spentMicro, 10);
  await collect(h.plugin()); assert.equal(h.totals().spentMicro, 20);
});
test('parallel requests cannot overshoot reservations; rejected request never reaches provider', async t => {
  const h = await provider(t, { maxTokens: 19 }); h.state.stall = true;
  const first = h.plugin().structured(request, opts());
  while (!h.state.release) await new Promise(resolve => setImmediate(resolve));
  const others = await Promise.allSettled([h.plugin().structured(request, opts()), h.plugin().structured(request, opts())]);
  assert.ok(others.every(r => r.status === 'rejected' && /spend cap exhausted/.test(r.reason.message)));
  assert.equal(h.state.bodies.length, 1); assert.equal(h.totals().reservedMicro, 60);
  h.state.stall = false; h.state.release(); await first; assert.equal(h.totals().spentMicro, 10);
});
test('uncertain or cancelled responses keep reservation even when a partial stream supplied cost', async t => {
  const h = await provider(t); h.state.truncated = true;
  await assert.rejects(collect(h.plugin()), /Incomplete/);
  assert.equal(h.totals().reservedMicro, 40);
  h.state.truncated = false; h.state.stall = true;
  const controller = new AbortController(), pending = h.plugin().structured(request, opts({ signal: controller.signal }));
  while (!h.state.release) await new Promise(resolve => setImmediate(resolve));
  controller.abort(); await assert.rejects(pending, /abort/i); h.state.release();
  assert.equal(h.totals().reservedMicro, 80); assert.equal(h.totals().spentMicro, 0);
});
test('USD configuration rejects ambiguous or unsafe amounts', () => {
  assert.equal(usdMicro('10'), 10_000_000); assert.equal(usdMicro('0.000001'), 1);
  for (const value of ['-1', 'NaN', '1e2', '1.0000001', 'Infinity', '', '9007199254740991']) assert.throws(() => usdMicro(value));
});
test('request price/byte ceiling refuses before dispatch and creates no spend hold', async t => {
  const h = await provider(t);
  await assert.rejects(h.plugin().structured({ ...request, messages: [{ role: 'user', content: 'x'.repeat(50_000) }] }, opts()), /spend cap exhausted/);
  assert.equal(h.state.bodies.length, 0); assert.equal(h.totals().reservedMicro, 0);
});

test('ceiling includes every message and uses UTF-8 bytes and upward decimal rounding', async t => {
  const h = await provider(t); h.state.missing = true;
  await h.plugin().structured({ ...request, system: 'Ä', messages: [{ role: 'user', content: '🌍' }] }, opts());
  assert.equal(h.totals().reservedMicro, 41); // 67 UTF-8 bytes * 0.5 micro + 5 * 1.4 micro
  assert.equal(requestCeilingMicro({ messages: [], max_tokens: 1 }, { prompt: 1e-7, completion: 0 }), 1);
  assert.equal(requestCeilingMicro({ messages: [], max_tokens: 1 }, { prompt: 1e-7, completion: 8e-7 }), 1);
});

test('$9.50 spent plus a $1.00 ceiling refuses before dispatch', async t => {
  const h = await provider(t, { capMicro: 10_000_000, maxTokens: 714_262 });
  const seed = h.cap().reserve(9_500_000); h.cap().settle(seed, 9_500_000);
  await assert.rejects(h.plugin().structured(request, opts()), /spend cap exhausted/);
  assert.deepEqual(h.totals(), { spentMicro: 9_500_000, reservedMicro: 0, capMicro: 10_000_000, breached: false });
  assert.equal(h.state.bodies.length, 0);
});

test('$9.50 spent plus an unexpected $1.00 actual charge records $10.50 and locks the cap across restart', async t => {
  const h = await provider(t, { path: await temporaryDb(), capMicro: 10_000_000 });
  const seed = h.cap().reserve(9_500_000); h.cap().settle(seed, 9_500_000);
  h.state.cost = 1; await h.plugin().structured(request, opts());
  assert.deepEqual(h.totals(), { spentMicro: 10_500_000, reservedMicro: 0, capMicro: 10_000_000, breached: true });
  h.restart(); await assert.rejects(h.plugin().structured(request, opts()), /spend cap exhausted/);
  assert.equal(h.state.bodies.length, 1);
});

test('an over-ceiling stream closes the cap even below the account maximum and without DONE', async t => {
  const h = await provider(t, { path: await temporaryDb() }); h.state.cost = 0.00005; h.state.truncated = true;
  await assert.rejects(collect(h.plugin()), /spend cap exhausted/);
  assert.deepEqual(h.totals(), { spentMicro: 50, reservedMicro: 0, capMicro: 100, breached: true });
  h.restart(); await assert.rejects(h.plugin().structured(request, opts()), /spend cap exhausted/);
  assert.equal(h.state.bodies.length, 1);
});

test('HTTP errors retain dispatched holds unless usage.cost explicitly settles them, including zero', async t => {
  const h = await provider(t); h.state.status = 500; h.state.missing = true;
  await assert.rejects(h.plugin().structured(request, opts()), /request failed/);
  assert.equal(h.totals().reservedMicro, 40);
  h.state.missing = false; h.state.cost = 0;
  await assert.rejects(collect(h.plugin()), /request failed/);
  assert.equal(h.totals().reservedMicro, 40); assert.equal(h.totals().spentMicro, 0);
});

test('malformed output still records known actual charges and cannot hide a breach', async t => {
  const h = await provider(t); h.state.invalid = true; h.state.cost = 0.00005;
  await assert.rejects(h.plugin().structured(request, opts()), /Invalid OpenRouter/);
  assert.equal(h.totals().spentMicro, 50); assert.equal(h.totals().breached, true);
  await assert.rejects(h.plugin().structured(request, opts()), /spend cap exhausted/);
  assert.equal(h.state.bodies.length, 1);
});

test('spend port supports another plugin, exact settlement retries and account isolation', () => {
  const storage = new SQLiteStorage();
  try {
    const first = createSpendCap({ storage, account: 'shared', capMicro: 100 });
    const second = createSpendCap({ storage, account: 'shared', capMicro: 100 });
    const foreign = createSpendCap({ storage, account: 'other', capMicro: 100 });
    const handle = first.reserve(60);
    assert.throws(() => second.reserve(41), /spend cap exhausted/);
    assert.throws(() => foreign.settle(handle, 20), /missing/);
    second.settle(handle, 20); first.settle(handle, 20);
    assert.throws(() => first.settle(handle, 19), /already settled/);
    assert.equal(first.snapshot().spentMicro, 20);
  } finally { storage.close(); }
});

test('OpenRouter accepts the spend port without coupling to its storage or handle shape', async () => {
  const calls = [], handle = Symbol('opaque');
  const spendCap = { reserve(ceiling) { calls.push(['reserve', ceiling]); return handle; },
    settle(received, actual) { assert.equal(received, handle); calls.push(['settle', actual]); }, snapshot() {} };
  const plugin = createOpenRouterReasoning({ model: 'openai/fixture', prices: { 'openai/fixture': price }, spendCap,
    resolveSecret: () => 'local-key', fetchImpl: async () => Response.json({ usage: { cost: 0.0000193 },
      choices: [{ finish_reason: 'stop', message: { content: '{"summary":"ok"}' } }] }) });
  await plugin.structured(request, opts());
  assert.deepEqual(calls, [['reserve', 11233], ['settle', 20]]);
});

test('upgrade preserves existing spend/unknown holds and a free-model charge breaches its zero ceiling', () => {
  const storage = new SQLiteStorage();
  try {
    storage.db.exec(`CREATE TABLE spend_reservations (id TEXT PRIMARY KEY, account TEXT NOT NULL,
      reserved_micro INTEGER NOT NULL CHECK(reserved_micro > 0), actual_micro INTEGER CHECK(actual_micro >= 0));
      INSERT INTO spend_reservations VALUES ('spent','shared',40,20), ('unknown','shared',40,NULL);`);
    const cap = createSpendCap({ storage, account: 'shared', capMicro: 100 });
    assert.deepEqual(cap.snapshot(), { spentMicro: 20, reservedMicro: 40, capMicro: 100, breached: false });
    const free = cap.reserve(0); cap.settle(free, 1);
    assert.equal(cap.snapshot().breached, true); assert.equal(cap.snapshot().spentMicro, 21);
    assert.equal(cap.snapshot().reservedMicro, 40);
    assert.throws(() => cap.reserve(1), /spend cap exhausted/);
  } finally { storage.close(); }
});

test('missing/invalid model prices refuse construction and rebind instead of selecting seed prices', () => {
  for (const prices of [undefined, {}, { 'openai/fixture': { prompt: -1, completion: 1 } },
    { 'openai/fixture': { prompt: 1, completion: Infinity } }, { 'openai/fixture': { prompt: '1', completion: 1 } }]) {
    assert.throws(() => createOpenRouterReasoning({ model: 'openai/fixture', prices }), /AITHEMA_OPENROUTER_PRICES/);
  }
  const plugin = createOpenRouterReasoning({ model: 'openai/fixture', prices: { 'openai/fixture': price } });
  assert.throws(() => plugin.bind({ ...plugin.binding, model: 'anthropic/missing' }), /for anthropic\/missing/);
});
