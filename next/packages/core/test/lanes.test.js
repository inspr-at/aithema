import { test } from 'node:test';
import assert from 'node:assert/strict';
import { SessionLanes, createMockReasoning, createSession, applyEvent, inputRevision } from '../src/index.js';

function harness(plugin = createMockReasoning(), options = {}) {
  let session = createSession({ demo: true, ...options }); const published = [], partials = [];
  const turn = content => { session = applyEvent(session, { seq: session.seq + 1, type: 'turn.final', data: { role: 'user', content } }); };
  const lanes = new SessionLanes({ reasoning: plugin, getSession: () => structuredClone(session), deadlineMs: 1000,
    publish(id, type, data, revision) {
      if (inputRevision(session) !== revision) return false;
      const event = { seq: session.seq + 1, type, data }; session = applyEvent(session, event); published.push(event); return true;
    }, transient: (id, event) => partials.push(event),
  });
  return { lanes, turn, published, partials, get session() { return session; } };
}
const deferred = () => { let resolve; const promise = new Promise(r => { resolve = r; }); return { promise, resolve }; };
test('single-flight joins the same promise; draft then final are published and cache costs no calls', async () => {
  const mock = createMockReasoning(), gate = deferred(); let calls = 0;
  const h = harness({ ...mock, async structured(...args) { calls++; await gate.promise; return mock.structured(...args); } });
  h.turn('systems: SAP'); const first = h.lanes.run(h.session.id, 'understanding');
  assert.equal(first, h.lanes.run(h.session.id, 'understanding')); gate.resolve();
  assert.equal(await first, 'completed'); assert.equal(calls, 2);
  assert.deepEqual(h.published.map(e => e.data.draft), [true, false]);
  assert.equal(await h.lanes.run(h.session.id, 'understanding'), 'cached'); assert.equal(calls, 2);
});
test('understanding ignores stale results even if provider wins the cancellation race', async () => {
  const mock = createMockReasoning(), started = deferred(), gate = deferred();
  const h = harness({ ...mock, async structured(...args) { started.resolve(); await gate.promise; return mock.structured(...args); } });
  h.turn('First'); const old = h.lanes.run(h.session.id, 'understanding'); await started.promise;
  h.turn('Second'); gate.resolve(); assert.equal(await old, 'stale'); assert.equal(h.published.length, 0);
  await h.lanes.run(h.session.id, 'understanding'); assert.equal(h.session.understanding.inputRevision, inputRevision(h.session));
});
test('final refinement is discarded when input advances after draft publication', async () => {
  const mock = createMockReasoning(), started = deferred(), gate = deferred();
  const h = harness({ ...mock, async structured(request, opts) {
    if (!request.draft) { started.resolve(); await gate.promise; } return mock.structured(request, opts);
  } });
  h.turn('First'); const run = h.lanes.run(h.session.id, 'understanding'); await started.promise;
  assert.equal(h.published.length, 1); h.turn('Second'); gate.resolve();
  assert.equal(await run, 'stale'); assert.equal(h.published.length, 1); assert.equal(h.session.understanding.draft, true);
});
test('reaction streams deltas and only publishes one complete durable assistant turn', async () => {
  const h = harness(); h.turn('Hello');
  const run = h.lanes.run(h.session.id, 'reaction'); assert.equal(run, h.lanes.run(h.session.id, 'reaction'));
  await run; assert.ok(h.partials.length > 1); assert.equal(h.published.length, 1);
  assert.equal(h.published[0].data.content, h.partials.map(e => e.data.delta).join(''));
  assert.equal(await h.lanes.run(h.session.id, 'reaction'), 'cached');
});
test('stale reaction fragments never become a final turn', async () => {
  const started = deferred(), gate = deferred();
  const h = harness({ ...createMockReasoning(), async *stream() { yield 'first'; started.resolve(); await gate.promise; yield 'second'; } });
  h.turn('First'); const run = h.lanes.run(h.session.id, 'reaction'); await started.promise;
  h.turn('Second'); gate.resolve(); assert.equal(await run, 'stale'); assert.equal(h.published.length, 0);
});
test('anonymous analysis starts after three user turns; identified/demo starts immediately', async () => {
  const h = harness(createMockReasoning(), { demo: false }); h.turn('One');
  assert.equal(await h.lanes.run(h.session.id, 'understanding'), 'deferred'); h.turn('Two'); h.turn('Three');
  assert.equal(await h.lanes.run(h.session.id, 'understanding'), 'completed');
});
test('cancelled lane publishes no durable result and releases its flight', async () => {
  const h = harness(), controller = new AbortController(); h.turn('Hello'); controller.abort();
  await assert.rejects(h.lanes.run(h.session.id, 'understanding', { signal: controller.signal }));
  assert.equal(h.published.length, 0); assert.equal(await h.lanes.run(h.session.id, 'understanding'), 'completed');
});
test('invalid structured output cannot damage a previous understanding', async () => {
  const h = harness({ ...createMockReasoning(), async structured() { return { summary: 'Invalid' }; } }); h.turn('Hello');
  await assert.rejects(h.lanes.run(h.session.id, 'understanding'), /Invalid understanding/); assert.equal(h.published.length, 0);
});
