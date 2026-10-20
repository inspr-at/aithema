import { test } from 'node:test';
import assert from 'node:assert/strict';
import { SessionLanes, createMockReasoning, createSession, applyEvent, inputRevision, PluginError } from '../src/index.js';
import { purposePolicy } from '../../../test/safeguards-corpus.js';

function harness(plugin = createMockReasoning(), options = {}, laneOptions = {}) {
  let session = createSession({ demo: true, ...options }); const published = [], partials = [];
  const turn = content => { session = applyEvent(session, { seq: session.seq + 1, type: 'turn.final', data: { role: 'user', content } }); };
  const lanes = new SessionLanes({ beforeDispatch: async () => true, ...laneOptions, reasoning: plugin, getSession: () => structuredClone(session), deadlineMs: 1000,
    publish(id, type, data, revision) {
      if (inputRevision(session) !== revision) return false;
      const event = { seq: session.seq + 1, type, data }; session = applyEvent(session, event); published.push(event); return true;
    }, transient: (id, event) => partials.push(event),
  });
  return { lanes, turn, published, partials, get session() { return session; } };
}
const deferred = () => { let resolve; const promise = new Promise(r => { resolve = r; }); return { promise, resolve }; };

for (const policy of [false, true]) for (const change of ['answered', 'chosenBy', 'focus-revision', 'identity']) {
  test(`AIT-418: focused reply revalidates ${change} (purpose=${policy})`, async () => {
    const started = deferred(), gate = deferred();
    const h = harness({ ...createMockReasoning(), async *stream() {
      started.resolve(); await gate.promise;
      yield policy ? JSON.stringify({ content: 'Launch date?', scope: 'in', question_short: null, options: [] }) : 'Launch date?';
    } }, { identified: true }, policy ? { purposePolicy } : {});
    h.turn('We need a website.');
    Object.assign(h.session, { focusedQuestion: 'Launch date?',
      questionFocus: { requestId: 'selected', chosenBy: 'user', inputRevision: inputRevision(h.session) },
      understanding: { ...h.session.understanding, inputRevision: inputRevision(h.session), openQuestions: ['Launch date?'], draft: false } });
    const pending = h.lanes.run(h.session.id, 'reaction');
    try {
      await started.promise;
      if (change === 'answered') h.session.transcript.push({ id: 'already-answered', role: 'assistant', content: 'Launch date?', focusRequestId: 'selected' });
      if (change === 'chosenBy') h.session.questionFocus.chosenBy = 'system';
      if (change === 'focus-revision') h.session.questionFocus.inputRevision = 'obsolete-focus-revision';
      if (change === 'identity') Object.assign(h.session, applyEvent(h.session, { seq: h.session.seq + 1, type: 'identity.state', data: { status: 'verification-pending', identified: false } }));
    } finally { gate.resolve(); }
    assert.equal(await pending, change === 'identity' ? 'completed' : 'stale');
    assert.equal(h.published.length, change === 'identity' ? 1 : 0);
    if (change !== 'identity') assert.deepEqual(h.partials, [], 'invalid focus never reaches the visitor');
    else assert.equal(h.published[0].data.focusRequestId, 'selected');
  });
}

for (const prefix of ['Gut, ', 'x'.repeat(80)]) test(`AIT-157: normal streaming opens at a clause or 80 characters (${prefix.length})`, async () => {
  const entered = deferred(), release = deferred();
  const h = harness({ ...createMockReasoning(), async *stream() {
    yield prefix; entered.resolve(); await release.promise; yield 'dann beginnen wir.';
  } });
  h.turn('Hallo'); const pending = h.lanes.run(h.session.id, 'reaction');
  try {
    await entered.promise;
    assert.equal(h.partials.map(event => event.data.delta).join(''), prefix);
  } finally { release.resolve(); await pending; }
});
test('AIT-157: a fragment fallback is identical in draft and final', async () => {
  const input = 'Danke, sehr hilfreich.';
  const h = harness({ ...createMockReasoning(), async *stream() { for (const char of input) yield char; } });
  h.turn('Hallo'); await h.lanes.run(h.session.id, 'reaction');
  assert.equal(h.partials.map(event => event.data.delta).join(''), input);
  assert.equal(h.session.transcript.at(-1).content, input);
});
test('single-flight joins the same promise; a shared binding calls only final and cache costs no calls', async () => {
  const mock = createMockReasoning(), gate = deferred(); let calls = 0;
  const h = harness({ ...mock, async structured(...args) { calls++; await gate.promise; return mock.structured(...args); } });
  h.turn('systems: SAP'); const first = h.lanes.run(h.session.id, 'understanding');
  assert.equal(first, h.lanes.run(h.session.id, 'understanding')); gate.resolve();
  assert.equal(await first, 'completed'); assert.equal(calls, 1);
  assert.deepEqual(h.published.map(e => e.data.draft), [false]);
  assert.equal(await h.lanes.run(h.session.id, 'understanding'), 'cached'); assert.equal(calls, 1);
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
  } }, {}, { draftReasoning: mock });
  h.turn('First'); const run = h.lanes.run(h.session.id, 'understanding'); await started.promise;
  assert.equal(h.published.length, 1); h.turn('Second'); gate.resolve();
  assert.equal(await run, 'stale'); assert.equal(h.published.length, 1); assert.equal(h.session.understanding.draft, true);
});
test('reaction streams deltas and only publishes one complete durable assistant turn', async () => {
  const h = harness(); h.turn('Hello');
  const run = h.lanes.run(h.session.id, 'reaction'); assert.equal(run, h.lanes.run(h.session.id, 'reaction'));
  await run; assert.ok(h.partials.length > 0); assert.equal(h.published.length, 1);
  assert.equal(h.published[0].data.content, h.partials.map(e => e.data.delta).join(''));
  for (const data of [...h.partials.map(e => e.data), h.published[0].data]) {
    assert.equal(data.origin, 'ai-generated'); assert.equal(data.model, 'mock'); assert.equal(data.provider, 'mock');
  }
  assert.equal(h.session.transcript[0].origin, undefined);
  assert.equal(await h.lanes.run(h.session.id, 'reaction'), 'cached');
});
test('draft and final understanding name their own producers rather than copying provider output', async () => {
  const h = harness(createMockReasoning({ model: 'final-fixture' }), {}, { draftReasoning: createMockReasoning({ model: 'draft-fixture' }) });
  h.turn('systems: API'); await h.lanes.run(h.session.id, 'understanding');
  assert.deepEqual(h.published.map(e => [e.data.draft, e.data.origin, e.data.model, e.data.provider]),
    [[true, 'ai-generated', 'draft-fixture', 'mock'], [false, 'ai-generated', 'final-fixture', 'mock']]);
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

for (const phase of ['before attempt 1', 'during admission', 'between attempts', 'mid-stream', 'mid-stream with abort']) {
  test(`AIT-183 superseded reply ${phase} returns stale without fallback or output`, async () => {
    const diagnostics = [], admissions = [], settlements = [], streams = [], guards = [], scopes = [];
    const plugin = { ...createMockReasoning(), async *stream() {
      streams.push(streams.length);
      if (phase.startsWith('mid-stream')) {
        yield '{"content":"Private partial';
        h.turn('Replacement input');
        if (phase.endsWith('with abort')) h.lanes.supersede(h.session.id);
      }
      yield '{invalid';
    } };
    const h = harness(plugin, {}, { purposePolicy, onReplyDiagnostic: event => diagnostics.push(event),
      guardDirection: (_, reply) => { guards.push(reply); return reply; }, onScope: (...args) => scopes.push(args),
      async admit() {
        const attempt = admissions.length;
        admissions.push(attempt);
        if (phase === 'during admission') h.turn('Replacement input');
        return { plugin, async finish(result) {
          settlements.push({ attempt, ...result });
          if (phase === 'between attempts') h.turn('Replacement input');
        } };
      },
    });
    // Advance during the request snapshot, after the lane's initial freshness check.
    if (phase === 'before attempt 1') h.lanes.offTopicTurns = () => { h.turn('Replacement input'); return 0; };
    h.turn('First input');
    assert.equal(await h.lanes.run(h.session.id, 'reaction'), 'stale');
    assert.deepEqual(diagnostics, []);
    assert.deepEqual(h.published, []); assert.deepEqual(h.partials, []);
    assert.deepEqual(guards, []); assert.deepEqual(scopes, []);
    const count = phase === 'before attempt 1' ? 0 : 1;
    assert.equal(admissions.length, count); assert.equal(settlements.length, count);
    assert.equal(streams.length, phase === 'during admission' ? 0 : count);
    assert.equal(new Set(settlements.map(item => item.attempt)).size, count);
  });
}

for (const [code, providerErrorClass] of [
  ['auth', '4xx'], ['rate-limit', '4xx'], ['provider', '4xx'], ['provider', '5xx'], ['provider', undefined],
]) for (const attempt of [0, 1]) test(`AIT-183 separately settles ${code}/${providerErrorClass ?? 'network'} on attempt ${attempt + 1}`, async () => {
  const error = Object.assign(new PluginError(code), { providerErrorClass });
  const admissions = [], settlements = [], diagnostics = [];
  const h = harness(createMockReasoning(), {}, { purposePolicy, onReplyDiagnostic: event => diagnostics.push(event),
    async admit({ request }) {
      const index = admissions.length;
      admissions.push(request);
      return { plugin: { ...createMockReasoning(), async *stream() {
        if (index === attempt) throw error;
        yield '{invalid';
      } }, finish: result => settlements.push({ index, ...result }) };
    },
  });
  h.turn('First input');
  const pending = h.lanes.run(h.session.id, 'reaction');
  const fallback = attempt && code === 'provider' && providerErrorClass !== '4xx';
  if (fallback) assert.equal(await pending, 'completed');
  else await assert.rejects(pending, actual => actual === error);
  assert.equal(admissions.length, attempt + 1);
  assert.deepEqual(settlements, attempt ? [{ index: 0, failed: false }, { index: 1, failed: true }] : [{ index: 0, failed: true }]);
  assert.equal(h.published.length, fallback ? 1 : 0);
  assert.equal(diagnostics.length, fallback ? 1 : 0);
  assert.deepEqual(h.partials, []);
});

for (const code of ['invalid-output', 'provider']) test(`AIT-183 supersession during attempt-2 ${code} emits no fallback`, async () => {
  const diagnostics = [], admissions = [], settlements = [];
  const h = harness(createMockReasoning(), {}, { purposePolicy, onReplyDiagnostic: event => diagnostics.push(event),
    async admit() {
      const index = admissions.length;
      admissions.push(index);
      return { plugin: { ...createMockReasoning(), async *stream() {
        yield '{invalid';
        if (index) {
          h.turn('Replacement input');
          throw Object.assign(new PluginError(code), { providerErrorClass: '5xx' });
        }
      } }, finish: result => settlements.push({ index, ...result }) };
    },
  });
  h.turn('First input');
  assert.equal(await h.lanes.run(h.session.id, 'reaction'), 'stale');
  assert.deepEqual(diagnostics, []);
  assert.deepEqual(admissions, [0, 1]);
  assert.deepEqual(settlements, [{ index: 0, failed: false }, { index: 1, failed: true }]);
  assert.deepEqual(h.published, []); assert.deepEqual(h.partials, []);
});

for (const kind of ['deadline', 'cancel']) test(`AIT-183 current reply ${kind} retains cancellation error and settles once`, async () => {
  const entered = deferred(), release = deferred(), diagnostics = [], settlements = [];
  const controller = new AbortController();
  const plugin = { ...createMockReasoning(), async *stream() { entered.resolve(); await release.promise; yield '{invalid'; } };
  const h = harness(plugin, {}, { purposePolicy, onReplyDiagnostic: event => diagnostics.push(event),
    admit: async () => ({ plugin, finish: result => settlements.push(result) }),
  });
  h.lanes.deadlineMs = kind === 'deadline' ? 50 : 1000;
  h.turn('First input');
  const pending = h.lanes.run(h.session.id, 'reaction', { signal: controller.signal });
  const rejected = assert.rejects(pending, error => error.name === (kind === 'deadline' ? 'TimeoutError' : 'AbortError'));
  try {
    await entered.promise;
    if (kind === 'cancel') controller.abort(new DOMException('User cancelled', 'AbortError'));
    await rejected;
  } finally { release.resolve(); await pending.catch(() => {}); }
  assert.deepEqual(settlements, [{ failed: true }]);
  assert.deepEqual(diagnostics, []); assert.deepEqual(h.published, []); assert.deepEqual(h.partials, []);
});

// Plain provider 4xx on attempt 2 now escapes the neutral fallback; auth and
// rate-limit errors already escaped because they have their own error codes.
for (const status of [400, 402, 404, 422]) for (const first of ['schema rejection', 'invalid output']) {
  test(`AIT-183 plain provider ${status} on attempt 2 after ${first} rejects and settles both attempts`, async () => {
    const error = Object.assign(new PluginError('provider'), { providerErrorClass: '4xx', status });
    const admissions = [], settlements = [], diagnostics = [];
    const h = harness(createMockReasoning(), {}, { purposePolicy, onReplyDiagnostic: event => diagnostics.push(event),
      async admit({ request }) {
        const index = admissions.length;
        admissions.push(request);
        return { plugin: { ...createMockReasoning(), async *stream() {
          if (index) throw error;
          if (first === 'schema rejection') throw Object.assign(new PluginError('provider'), {
            providerErrorClass: '4xx', responseFormatUnsupported: true,
          });
          yield '{invalid';
        } }, finish: result => settlements.push({ index, ...result }) };
      },
    });
    h.turn('First input');
    await assert.rejects(h.lanes.run(h.session.id, 'reaction'), actual => actual === error);
    assert.equal(admissions.length, 2);
    assert.notEqual(admissions[0].replySchemaConstrained, false);
    assert.equal(admissions[1].replySchemaConstrained, first === 'schema rejection' ? false : undefined);
    assert.deepEqual(settlements, [{ index: 0, failed: first === 'schema rejection' }, { index: 1, failed: true }]);
    assert.deepEqual(diagnostics, first === 'schema rejection'
      ? [{ lane: 'reaction', kind: 'schema-retry', reason: 'provider-4xx', attemptCount: 1 }] : []);
    assert.deepEqual(h.published, []); assert.deepEqual(h.partials, []);
  });
}

for (const output of ['valid', 'invalid']) test(`AIT-183 revoke during ${output} reply settle returns stale exactly once`, async () => {
  const entered = deferred(), release = deferred(), settlements = [], diagnostics = [];
  const plugin = { ...createMockReasoning(), async *stream() {
    yield output === 'valid' ? JSON.stringify({ content: 'Safe reply', question_short: null, options: [], scope: 'in' }) : '{invalid';
  } };
  const h = harness(plugin, {}, { purposePolicy, onReplyDiagnostic: event => diagnostics.push(event),
    admit: async () => ({ plugin, async finish(result) {
      settlements.push(result); entered.resolve(); await release.promise;
    } }),
  });
  h.turn('First input');
  const pending = h.lanes.run(h.session.id, 'reaction');
  await entered.promise;
  const cancelled = h.lanes.cancel(h.session.id);
  release.resolve();
  assert.equal(await pending, 'stale');
  await cancelled;
  assert.deepEqual(settlements, [{ failed: false }]);
  assert.deepEqual(diagnostics, []); assert.deepEqual(h.published, []); assert.deepEqual(h.partials, []);
});
