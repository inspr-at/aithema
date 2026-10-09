import { test } from 'node:test';
import assert from 'node:assert/strict';
import { SQLiteStorage, createSpendCap, usdMicro } from '../../../packages/server/src/index.js';
import { listen } from '../../../packages/server/src/http.js';
import { createOpenRouterReasoning } from '../src/index.js';
import { temporaryDb } from '../../../test/helpers.js';

const schema = { type: 'object', additionalProperties: false, properties: { summary: { type: 'string' } }, required: ['summary'] };
const request = { system: '', messages: [{ role: 'user', content: 'Hello' }], schema };
const opts = (extra = {}) => ({ deadlineAt: Date.now() + 5000, attempt: { attemptId: crypto.randomUUID(), claimId: crypto.randomUUID(), consume() {} }, report() {}, ...extra });
async function provider(t, { path, capMicro = 100, reserve = 40 } = {}) {
  let storage = new SQLiteStorage(path), cap = createSpendCap({ storage, account: 'shared', capMicro });
  const state = { bodies: [], cost: 0.00001, missing: false, truncated: false, stall: false, release: null };
  const running = await listen(async req => {
    const body = await req.json(); state.bodies.push(body);
    if (state.stall) await new Promise(resolve => { state.release = resolve; });
    const usage = state.missing ? { prompt_tokens: 1, completion_tokens: 1 } : { prompt_tokens: 1, completion_tokens: 1, cost: state.cost };
    if (!body.stream) return Response.json({ choices: [{ finish_reason: 'stop', message: { content: '{"summary":"ok"}' } }], usage });
    const frames = `data: ${JSON.stringify({ choices: [{ delta: { content: 'Hello' }, finish_reason: 'stop' }] })}\n\n` +
      `data: ${JSON.stringify({ choices: [], usage })}\n\n` + (state.truncated ? '' : 'data: [DONE]\n\n');
    return new Response(frames, { headers: { 'content-type': 'text/event-stream' } });
  });
  const binding = { plugin: 'openrouter', model: 'openai/fixture', endpoint: running.url, effort: 'none', accountRef: 'shared', secretRef: 'local-ref',
    maxMicro: reserve, maxTokens: 5, rates: { inputMicro: 0, outputMicro: 0 }, routing: { max_price: { prompt: 0.001, completion: 0.001 } } };
  const plugin = () => createOpenRouterReasoning({ binding, spendCap: cap, resolveSecret: () => 'local-fake-key' });
  t.after(async () => { state.release?.(); running.server.closeAllConnections(); await new Promise(resolve => running.server.close(resolve)); storage.close(); });
  return { state, plugin, totals: () => cap.totals(), cap: () => cap,
    restart() { storage.close(); storage = new SQLiteStorage(path); cap = createSpendCap({ storage, account: 'shared', capMicro }); } };
}
const collect = async plugin => { let text = ''; for await (const part of plugin.stream(request, opts())) text += part; return text; };

test('sums non-stream usage.cost; all dispatches ask for usage; refuses before provider dispatch', async t => {
  const h = await provider(t); h.state.cost = 0.00003;
  for (let i = 0; i < 3; i++) assert.deepEqual(await h.plugin().structured(request, opts()), { summary: 'ok' });
  assert.equal(h.totals().spentMicro, 90); assert.equal(h.totals().reservedMicro, 0);
  await assert.rejects(h.plugin().structured(request, opts()), /OpenRouter spend cap exhausted/);
  assert.equal(h.state.bodies.length, 3); assert.ok(h.state.bodies.every(b => b.usage.include === true));
  assert.deepEqual(h.state.bodies[0].provider.max_price, { prompt: 0.001, completion: 0.001 });
});
test('final streaming usage settles one cumulative cost and includes usage request fields', async t => {
  const h = await provider(t); h.state.cost = 0.00002;
  assert.equal(await collect(h.plugin()), 'Hello');
  assert.deepEqual(h.totals(), { spentMicro: 20, reservedMicro: 0, capMicro: 100 });
  assert.deepEqual(h.state.bodies[0].usage, { include: true }); assert.equal(h.state.bodies[0].stream_options.include_usage, true);
});
test('missing usage holds survive a restart and are shared by another plugin/account counter', async t => {
  const h = await provider(t, { path: await temporaryDb() }); h.state.missing = true;
  await h.plugin().structured(request, opts()); await collect(h.plugin());
  assert.deepEqual(h.totals(), { spentMicro: 0, reservedMicro: 80, capMicro: 100 });
  h.restart(); assert.equal(h.cap().totals().reservedMicro, 80);
  assert.throws(() => h.cap().reserve(40), /spend cap exhausted/);
  await assert.rejects(h.plugin().structured(request, opts()), /spend cap exhausted/); assert.equal(h.state.bodies.length, 2);
});
test('completed actual spend is persistent across restart', async t => {
  const h = await provider(t, { path: await temporaryDb() });
  await h.plugin().structured(request, opts()); h.restart(); assert.equal(h.totals().spentMicro, 10);
  await collect(h.plugin()); assert.equal(h.totals().spentMicro, 20);
});
test('parallel requests cannot overshoot reservations; rejected request never reaches provider', async t => {
  const h = await provider(t, { reserve: 60 }); h.state.stall = true;
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
  await assert.rejects(h.plugin().structured({ ...request, messages: [{ role: 'user', content: 'x'.repeat(50_000) }] }, opts()), /request exceeds spend reservation/);
  assert.equal(h.state.bodies.length, 0); assert.equal(h.totals().reservedMicro, 0);
});
