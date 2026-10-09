import { test as nodeTest } from 'node:test';
import assert from 'node:assert/strict';
import { SQLiteStorage, createHandlers, createPluginRuntime, createVoiceProvider, createFacadeSecrets, mockPresets,
  SQLiteBudgetLedger } from '../src/index.js';
import { PluginRegistry, createMockReasoning, activeTurns, PluginError } from '@inspr/aithema-core';
import { readFile } from 'node:fs/promises';
import { temporaryDb, unzip } from '../../../test/helpers.js';
import { eventProbe } from '../../../test/voice-test-events.js';

const test = (name, fn) => nodeTest(name, { timeout: 60_000 }, fn);

export function voiceFixture(t, { unknown = false, leaseMs = 30_000, slowClosure = false, path } = {}) {
  const storage = new SQLiteStorage(path), secrets = createFacadeSecrets();
  let clock = Date.now(), sequence = 0, covered = true, secretReads = 0, coverageReads = 0, healthReads = 0, releasing = false;
  const opened = new Map(), ended = new Set(), waiting = new Map(), provisioned = [], traffic = [], closeRequests = [];
  const providerEvents = eventProbe();
  const endClient = id => { ended.add(id); waiting.get(id)?.(); waiting.delete(id); };
  const now = () => clock;
  const binding = { plugin: 'elevenlabs', model: 'fixture-agent', agentId: 'fixture-agent', effort: 'none',
    endpoint: 'https://provider.test', accountRef: 'fixture', secretRef: 'fixture-ref', maxMicro: 60_000,
    maxTokens: 1, rates: { inputMicro: 0, outputMicro: 0 }, maxDurationSeconds: 60,
    upstreamMicroPerMinute: 60_000, visitorMicroPerMinute: 120_000, publicFacadeBaseUrl: 'https://facade.test' };
  binding.legal = { approved: true, countries: ['AT'], training: false, retention: 'fixture', purpose: 'conversation',
    recipient: 'fixture', processors: [], dataCategories: ['conversation'], consentVersion: 1,
    evidence: { qualified: true, accountRef: binding.accountRef, secretRef: binding.secretRef,
      model: binding.model, endpoint: binding.endpoint, routing: {}, verifiedAt: clock - 1000, expiresAt: clock + 100_000 } };
  const plugin = createVoiceProvider({ storage, now, binding: { agentId: binding.agentId, secretRef: binding.secretRef,
    apiBaseUrl: binding.endpoint, upstreamMicroPerMinute: binding.upstreamMicroPerMinute, visitorMicroPerMinute: binding.visitorMicroPerMinute },
    resolveSecret: () => { secretReads++; return 'provider-fixture-value'; }, revokeFacade: secrets.revoke,
    closureTimeoutMs: slowClosure ? 30_000 : 10_000,
    requestProviderClose: record => { closeRequests.push(record.providerSessionId); providerEvents.record({ type: 'close', id: record.providerSessionId }); },
    async provisionFacade(record) { assert.ok(secrets.resolve(record.facadeSecretRef)); provisioned.push(record); },
    fetchImpl: async url => {
      traffic.push(String(url));
      if (String(url).includes('/token?')) {
        const id = `provider-${++sequence}`; opened.set(id, clock);
        return Response.json({ token: 'fixture-credential', conversation_id: id });
      }
      const id = String(url).split('/').at(-1);
      providerEvents.record({ type: 'details', id });
      // Provider closure is unavailable until the browser ends the SDK session.
      if (slowClosure && !ended.has(id) && !releasing) await new Promise(resolve => waiting.set(id, resolve));
      return Response.json({ conversation_id: id, status: unknown ? 'processing' : 'done',
        metadata: { start_time_unix_secs: opened.get(id) / 1000, call_duration_secs: (clock - opened.get(id)) / 1000, cost: 7 } });
    } });
  const reasoning = createMockReasoning(), presets = mockPresets();
  const health = plugin.health; plugin.health = options => { healthReads++; return health(options); };
  presets.best.plugins.push('elevenlabs'); presets.best.bindings.voice = binding; presets.best.policy = { endpoints: [binding.endpoint] };
  const consent = { async coverage({ scope, consentRevision }) { coverageReads++; return { covered, ...scope, scope, consentRevision, checkedAt: clock, expiresAt: clock + 100_000 }; } };
  const registry = new PluginRegistry().register(reasoning).register(plugin);
  const runtime = createPluginRuntime({ storage, reasoning, registry, presets, consent, now });
  const handlers = createHandlers({ storage, reasoning, pluginRuntime: runtime, consent, voice: { secrets, now, browserLeaseMs: leaseMs } });
  t.after(async () => { releasing = true; for (const id of waiting.keys()) endClient(id); await handlers.close(); storage.close(); });
  const token = 'voice-owner', session = storage.create({ ownerToken: token, demo: true });
  const route = async (suffix, body = {}, owner = token) => handlers.handle(new Request(`http://host/api/sessions/${session.id}${suffix}`, {
    method: 'POST', headers: { 'x-aithema-session-token': owner }, body: JSON.stringify(body) }));
  const start = async (callId = 'call-1') => {
    const response = await route('/voice', { callId }); assert.equal(response.status, 201); return response.json();
  };
  return { storage, secrets, runtime, handlers, session, route, start, presets, provisioned, traffic, now, plugin: registry.get('elevenlabs'), endClient, closeRequests,
    waitForClosure: id => providerEvents.waitFor(event => event.type === 'details' && event.id === id),
    authChecks: () => ({ secretReads, coverageReads, healthReads }),
    advance: ms => { clock += ms; }, coverage: value => { covered = value; } };
}

test('voice start, speak, heard correction, type, pause, resume and close share durable turns and duration settlement', async t => {
  const h = voiceFixture(t), grant = await h.start(), identity = { providerSessionId: grant.providerSessionId };
  const event = async value => {
    const response = await h.route(`/voice/${grant.callId}/events`, { ...identity, event: { callId: grant.callId, ...value } });
    assert.equal(response.status, 200); return response.json();
  };
  const spoken = { type: 'final', turnId: `${grant.providerSessionId}:user:1`, role: 'user', text: 'systems: API; data: public' };
  await event(spoken); const rows = h.storage.read(h.session.id).filter(e => e.type === 'turn.final').length;
  await event(spoken); assert.equal(h.storage.read(h.session.id).filter(e => e.type === 'turn.final').length, rows, 'final callback is idempotent');
  await event({ type: 'final', turnId: `${grant.providerSessionId}:assistant:2`, role: 'assistant', text: 'Understood. This remainder was not heard.' });
  await event({ type: 'heard', turnId: `${grant.providerSessionId}:assistant:2`, prefix: 'Understood.' });
  await event({ type: 'final', turnId: `${grant.providerSessionId}:user:3`, role: 'user', text: 'Typed during the call' });
  h.advance(2000);
  const pause = await h.route(`/voice/${grant.callId}/pause`, identity); assert.deepEqual(await pause.json(), { acknowledged: true, paused: true });
  assert.equal(h.storage.get(h.session.id).paused, true);
  h.advance(5000);
  const beat = await h.route(`/voice/${grant.callId}/heartbeat`, { ...identity, browserLivenessDeadlineAt: 1e15 });
  const lease = await beat.json(); assert.equal(lease.browserLivenessDeadlineAt, h.now() + 30_000);
  const resume = await h.route(`/voice/${grant.callId}/resume`, identity); assert.equal((await resume.json()).acknowledged, true);
  h.advance(3000);
  const terminal = await h.route(`/voice/${grant.callId}/close`, identity).then(r => r.json());
  assert.equal(terminal.outcome, 'completed'); assert.equal(terminal.closureConfirmed, true);
  assert.deepEqual(terminal.usage, { providerSeconds: 10, providerMinutes: 10 / 60, pausedSeconds: 5, visitorSeconds: 5,
    upstreamMicro: 10_000, visitorMicro: 10_000, providerCredits: 7 });
  assert.deepEqual(await h.route(`/voice/${grant.callId}/close`, identity).then(r => r.json()), terminal);
  const budget = h.storage.db.prepare("SELECT * FROM budget_attempts WHERE lane='voice'").all();
  assert.equal(budget.length, 1); assert.equal(budget[0].settled_micro, 10_000); assert.equal(budget[0].settled_visitor_micro, 10_000);
  assert.equal(h.runtime.budget.visitorUsed(h.session.id), 10_000); assert.equal(budget[0].state, 'settled');
  assert.equal(JSON.parse(budget[0].usage).visitorSeconds, 5);
  await h.handlers.idle();
  assert.ok(h.storage.get(h.session.id).understanding.constraints.systems);
  const exported = await h.handlers.handle(new Request(`http://host/api/sessions/${h.session.id}/export`, { headers: { 'x-aithema-session-token': 'voice-owner' } }));
  const bytes = Buffer.from(await exported.arrayBuffer()).toString(); assert.ok(!bytes.includes('This remainder was not heard'));
  assert.ok(h.storage.read(h.session.id).some(e => e.type === 'turn.corrected' && e.data.content === 'Understood.'));
  assert.equal(h.secrets.resolve(h.provisioned[0].facadeSecretRef), undefined);
  assert.ok(!JSON.stringify(h.storage.voiceCalls()).includes('fixture-credential'));
});

test('voice facade uses per-call auth, route binding, session reasoning and separately settled reaction claims', async t => {
  const h = voiceFixture(t), grant = await h.start();
  const secret = h.secrets.resolve(h.provisioned[0].facadeSecretRef);
  const facade = (callId = grant.callId, auth = secret, extra = {}) => h.handlers.handle(new Request(`https://facade.test/api/voice/${callId}/llm/chat/completions`, {
    method: 'POST', headers: { authorization: `Bearer ${auth}` }, body: JSON.stringify({ aithema_call: grant.callId,
      messages: [{ role: 'user', content: 'Hello' }], ...extra }) }));
  assert.equal((await facade('other')).status, 401); assert.equal((await facade(grant.callId, 'wrong')).status, 401);
  const completion = await facade(); assert.equal(completion.status, 200); assert.ok((await completion.json()).choices[0].message.content);
  const row = h.storage.db.prepare("SELECT * FROM budget_attempts WHERE lane='reaction'").get(); assert.equal(row.state, 'settled');
  await h.route(`/voice/${grant.callId}/pause`, { providerSessionId: grant.providerSessionId });
  assert.equal((await facade()).status, 403);
  await h.route(`/voice/${grant.callId}/close`, { providerSessionId: grant.providerSessionId });
  assert.equal((await facade()).status, 401);
});

test('consent withdrawal mid-call closes provider, settles once and rejects late finals and callback auth', async t => {
  const h = voiceFixture(t), grant = await h.start(); h.advance(3000);
  assert.equal((await h.route('/consent', { granted: false })).status, 200);
  assert.equal(h.secrets.resolve(h.provisioned[0].facadeSecretRef), undefined);
  await h.handlers.idle();
  const row = h.storage.db.prepare("SELECT * FROM budget_attempts WHERE lane='voice'").get();
  assert.equal(row.state, 'settled'); assert.equal(row.outcome, 'cancelled'); assert.equal(row.settled_micro, 3000);
  const response = await h.route(`/voice/${grant.callId}/events`, { providerSessionId: grant.providerSessionId,
    event: { type: 'final', callId: grant.callId, turnId: `${grant.providerSessionId}:user:late`, role: 'user', text: 'late sensitive voice' } });
  assert.equal(response.status, 403); assert.equal(h.storage.get(h.session.id).transcript.length, 0);
});

test('withdrawing voice input removes it and its dependent replies everywhere, including receipts and export', async t => {
  const h = voiceFixture(t), grant = await h.start();
  for (const [role, id, text] of [['user', 1, 'private spoken statement'], ['assistant', 2, 'private dependent reply']]) {
    assert.equal((await h.route(`/voice/${grant.callId}/events`, { providerSessionId: grant.providerSessionId,
      event: { type: 'final', callId: grant.callId, turnId: `${grant.providerSessionId}:${role}:${id}`, role, text } })).status, 200);
  }
  const turnId = `${grant.providerSessionId}:user:1`; assert.equal((await h.route('/withdraw', { turnId })).status, 200);
  await h.handlers.idle(); assert.equal(activeTurns(h.storage.get(h.session.id)).length, 0);
  assert.ok(!JSON.stringify(h.storage.read(h.session.id)).includes('private spoken'));
  assert.ok(!h.storage.db.prepare('SELECT bytes FROM content WHERE bytes IS NOT NULL').all().some(r => r.bytes.includes('private')));
  assert.ok(!h.storage.db.prepare('SELECT result FROM receipts').all().some(r => r.result.includes('private spoken')));
});

test('all voice routes hide ownership and foreign call/provider identity with 404s', async t => {
  const h = voiceFixture(t), grant = await h.start();
  for (const action of ['pause', 'resume', 'heartbeat', 'close', 'recover', 'events']) {
    assert.equal((await h.route(`/voice/${grant.callId}/${action}`, { providerSessionId: grant.providerSessionId }, 'other-owner')).status, 404);
    assert.equal((await h.route(`/voice/${grant.callId}/${action}`, { providerSessionId: 'foreign-provider' })).status, 404);
  }
  assert.equal((await h.route('/voice', { callId: 'other' }, 'other-owner')).status, 404);
  assert.equal(h.storage.db.prepare("SELECT COUNT(*) n FROM budget_attempts WHERE lane='voice'").get().n, 1);
});

test('unknown provider closure settles at maximum and retains its uncertain terminal', async t => {
  t.mock.timers.enable({ apis: ['Date', 'setTimeout'], now: Date.now() });
  const h = voiceFixture(t, { unknown: true }), grant = await h.start();
  h.advance(2000); const closing = h.route(`/voice/${grant.callId}/close`, { providerSessionId: grant.providerSessionId });
  await h.waitForClosure(grant.providerSessionId); t.mock.timers.tick(10_000);
  const terminal = await closing.then(r => r.json());
  assert.equal(terminal.closureConfirmed, false); assert.equal(terminal.outcome, 'uncertain'); assert.equal(terminal.chargedMicro, 60_000);
  assert.equal(h.storage.db.prepare("SELECT settled_micro FROM budget_attempts WHERE lane='voice'").get().settled_micro, 60_000);
});

test('each reconnect admits a new duration claim, rotates facade auth and keeps call identity and absolute deadline', async t => {
  const h = voiceFixture(t), first = await h.start(), refs = [];
  let grant = first;
  for (let i = 0; i < 3; i++) {
    refs.push(h.provisioned.at(-1).facadeSecretRef);
    const response = await h.route(`/voice/${grant.callId}/recover`, { providerSessionId: grant.providerSessionId });
    assert.equal(response.status, 200); grant = await response.json();
    assert.equal(grant.callId, first.callId); assert.equal(grant.spendDeadlineAt, first.spendDeadlineAt);
    assert.equal(h.secrets.resolve(refs.at(-1)), undefined);
  }
  const denied = await h.route(`/voice/${grant.callId}/recover`, { providerSessionId: grant.providerSessionId }); assert.equal(denied.status, 502);
  assert.equal(h.storage.db.prepare("SELECT COUNT(*) n FROM budget_attempts WHERE lane='voice'").get().n, 4);
});

test('voice admission fails closed on evidence, coverage, pause, and changed consent at consume without provider traffic', async t => {
  const h = voiceFixture(t);
  h.presets.best.bindings.voice.legal.evidence.model = 'other'; assert.equal((await h.route('/voice', { callId: 'bad-evidence' })).status, 403);
  h.presets.best.bindings.voice.legal.evidence.model = 'fixture-agent'; h.coverage(false);
  assert.equal((await h.route('/voice', { callId: 'bad-consent' })).status, 403); h.coverage(true);
  h.storage.pause(h.session.id, true); assert.equal((await h.route('/voice', { callId: 'paused' })).status, 403);
  h.storage.pause(h.session.id, false);
  const admitted = await h.runtime.admitVoice({ session: h.storage.get(h.session.id), request: { callId: 'consume-race' } });
  h.storage.reviseConsent(h.session.id, false);
  await assert.rejects(admitted.options.attempt.consume(), /refused/); admitted.finish();
  assert.equal(h.traffic.length, 0); assert.equal(h.storage.db.prepare("SELECT settled_micro FROM budget_attempts WHERE lane='voice'").get().settled_micro, 0);
});

test('startup recovers undispatched duration holds at zero and dispatched holds at maximum under the writer', async () => {
  const storage = new SQLiteStorage(), budget = new SQLiteBudgetLedger(storage), session = storage.create();
  try {
    const claims = [];
    for (const dispatch of [false, true]) {
      const { attemptId } = budget.admit({ sessionId: session.id, lane: 'voice', maxMicro: 50,
        requestSha256: 'a'.repeat(64), bindingSha256: 'b'.repeat(64) });
      const claim = budget.claim(attemptId); if (dispatch) claim.consume(); claims.push(claim);
    }
    assert.equal(budget.recover(), 2); assert.deepEqual(claims.map(c => budget.get(c.attemptId).settled_micro), [0, 50]);
    assert.equal(budget.recover(), 0);
  } finally { storage.close(); }
});

test('restart revokes callback auth, rehydrates orphan closure, reconciles costs and replays the original terminal receipt', async t => {
  const storage = new SQLiteStorage(), budget = new SQLiteBudgetLedger(storage), secrets = createFacadeSecrets();
  const session = storage.create({ ownerToken: 'restart-owner' });
  const { attemptId } = budget.admit({ sessionId: session.id, lane: 'voice', maxMicro: 100, maxVisitorMicro: 200,
    requestSha256: 'a'.repeat(64), bindingSha256: 'b'.repeat(64) });
  const claim = budget.claim(attemptId); claim.consume(); secrets.provision('orphan-ref');
  storage.saveVoiceCall(session.id, { callId: 'orphan-call', providerSessionId: 'orphan-provider', facadeSecretRef: 'orphan-ref',
    attemptId, claimId: claim.claimId, maxMicro: 100, paused: true, pauses: [{ from: Date.now() - 2000, to: null }],
    spendDeadlineAt: Date.now() + 10_000, browserLivenessDeadlineAt: Date.now() + 5000 });
  let closed = 0;
  const runtime = createPluginRuntime({ storage, budget, consent: { coverage: () => ({ covered: false }) } });
  const handlers = createHandlers({ storage, pluginRuntime: runtime, voice: { secrets, async closeOrphan(record) {
    closed++; assert.equal(record.providerSessionId, 'orphan-provider');
    return { providerSessionId: record.providerSessionId, closureConfirmed: true,
      usage: { providerSeconds: 10, providerMinutes: 10 / 60, pausedSeconds: 2, visitorSeconds: 8, upstreamMicro: 50, visitorMicro: 80 } };
  } } });
  t.after(async () => { await handlers.close(); storage.close(); });
  await handlers.resume(); assert.equal(closed, 1); assert.equal(secrets.resolve('orphan-ref'), undefined);
  const row = budget.get(attemptId); assert.equal(row.outcome, 'uncertain'); assert.equal(row.settled_micro, 50);
  assert.equal(row.settled_visitor_micro, 80); assert.equal(JSON.parse(row.terminal_json).chargedMicro, 100);
  const saved = storage.voiceCalls()[0]; assert.equal(saved.reconciliationPending, false); assert.equal(saved.reconciliation.usage.visitorSeconds, 8);
  const response = await handlers.handle(new Request(`http://host/api/sessions/${session.id}/voice/orphan-call/close`, {
    method: 'POST', headers: { 'x-aithema-session-token': 'restart-owner' }, body: JSON.stringify({ providerSessionId: 'orphan-provider' }) }));
  assert.equal(response.status, 200); assert.equal((await response.json()).chargedMicro, 100);
  await handlers.resume(); assert.equal(closed, 1);
});

test('voice turn conflicts and invalid heard prefixes cannot replace durable content; erasure stops and fences the call', async t => {
  const h = voiceFixture(t), grant = await h.start();
  const base = { type: 'final', callId: grant.callId, turnId: `${grant.providerSessionId}:assistant:1`, role: 'assistant', text: 'Actual spoken text' };
  const send = value => h.route(`/voice/${grant.callId}/events`, { providerSessionId: grant.providerSessionId, event: value });
  assert.equal((await send(base)).status, 200); assert.equal((await send({ ...base, text: 'Different bytes' })).status, 409);
  assert.equal((await send({ type: 'heard', callId: grant.callId, turnId: base.turnId, prefix: 'Invented text' })).status, 409);
  assert.equal(h.storage.get(h.session.id).transcript[0].content, 'Actual spoken text');
  assert.equal((await h.route('/erase')).status, 200); assert.equal((await send(base)).status, 404);
  assert.equal(h.secrets.resolve(h.provisioned[0].facadeSecretRef), undefined);
  await h.handlers.idle();
  assert.equal(h.storage.db.prepare("SELECT state FROM budget_attempts WHERE lane='voice'").get().state, 'settled');
});

test('browser lease and spend expiry settle a call even while the engine is paused', async t => {
  t.mock.timers.enable({ apis: ['Date', 'setTimeout'], now: Date.now() });
  const h = voiceFixture(t, { leaseMs: 20 }), grant = await h.start();
  const { waitFor } = await observeVoice(h, t);
  await h.route(`/voice/${grant.callId}/pause`, { providerSessionId: grant.providerSessionId });
  h.advance(20); t.mock.timers.tick(20);
  await waitFor(e => e.type === 'voice.state' && e.data.state === 'ended' && e.data.reason === 'browser-liveness-deadline');
  await h.handlers.idle();
  const row = h.storage.db.prepare("SELECT * FROM budget_attempts WHERE lane='voice'").get();
  assert.equal(row.state, 'settled'); assert.equal(row.outcome, 'cancelled');
  assert.equal(h.secrets.resolve(h.provisioned[0].facadeSecretRef), undefined);
});

test('visitor and provider ceilings are reserved independently and paused seconds release visitor credits', async () => {
  const storage = new SQLiteStorage(), session = storage.create(), budget = new SQLiteBudgetLedger(storage, { sessionCapMicro: 1000, visitorCapMicro: 100 });
  try {
    const { attemptId } = budget.admit({ sessionId: session.id, lane: 'voice', maxMicro: 500, maxVisitorMicro: 100,
      requestSha256: 'a'.repeat(64), bindingSha256: 'b'.repeat(64) });
    assert.equal(budget.canAdmit(session.id, 100, 1), false);
    const claim = budget.claim(attemptId); claim.consume();
    budget.settleVoice(claim.claimId, { attemptId, outcome: 'completed', closureConfirmed: true,
      usage: { providerSeconds: 10, providerMinutes: 10 / 60, pausedSeconds: 8, visitorSeconds: 2, upstreamMicro: 500, visitorMicro: 20 } });
    assert.equal(budget.used(session.id), 500); assert.equal(budget.visitorUsed(session.id), 20);
    assert.equal(budget.canAdmit(session.id, 100, 80), true);
  } finally { storage.close(); }
});

test('withdrawal clears a focused question and tombstones its content in replay and snapshots', () => {
  const storage = new SQLiteStorage(), session = storage.create();
  try {
    storage.postTurn(session.id, 'spoken', Buffer.from('spoken'), 'private voice input');
    storage.append(session.id, 'question.focused', { question: 'Question about private voice input?' });
    assert.equal(storage.get(session.id).focusedQuestion, 'Question about private voice input?');
    const raw = storage.db.prepare('SELECT snapshot FROM sessions WHERE id=?').get(session.id).snapshot;
    assert.ok(!raw.includes('Question about private voice'));
    storage.withdraw(session.id, 'spoken');
    assert.equal(storage.get(session.id).focusedQuestion, null);
    assert.ok(!JSON.stringify(storage.read(session.id)).includes('Question about private voice'));
  } finally { storage.close(); }
});

// Negative assertions need one event-loop turn, never a timed delay or repeated polling.
const flush = () => new Promise(resolve => setImmediate(resolve));
async function observeVoice(h, t) {
  const controller = new AbortController(), { events: rows, record, waitFor } = eventProbe();
  const response = await h.handlers.handle(new Request(`http://host/api/sessions/${h.session.id}/events?after=${h.storage.get(h.session.id).seq}`, {
    headers: { 'x-aithema-session-token': 'voice-owner' }, signal: controller.signal }));
  const reader = response.body.getReader();
  const reading = (async () => {
    let buffer = '';
    for (;;) {
      const { value, done } = await reader.read(); if (done) break;
      buffer += new TextDecoder().decode(value); let boundary;
      while ((boundary = buffer.indexOf('\n\n')) >= 0) {
        const block = buffer.slice(0, boundary); buffer = buffer.slice(boundary + 2);
        const line = block.split('\n').find(line => line.startsWith('data: '));
        if (line) record(JSON.parse(line.slice(6)));
      }
    }
  })();
  t.after(async () => { controller.abort(); await reading; });
  return { rows, waitFor };
}

for (const action of ['consent', 'host-consent', 'withdraw', 'erase', 'expiry']) {
  test(`slow closure: ${action} commits, cancels and broadcasts before the client ends`, async t => {
    const h = voiceFixture(t, { slowClosure: true }), grant = await h.start();
    h.storage.postTurn(h.session.id, 'private-turn', Buffer.from('private-turn'), 'private input');
    const { rows, waitFor } = await observeVoice(h, t), cancellations = [], cancel = h.handlers.lanes.cancel.bind(h.handlers.lanes);
    h.handlers.lanes.cancel = id => { cancellations.push(h.storage.read(id).at(-1).type); return cancel(id); };
    let response, acknowledged = false;
    const work = action === 'host-consent' ? h.handlers.withdrawConsent(h.session.id)
      : action === 'expiry' ? h.handlers.expire(Date.now() + 1000)
      : h.route('/' + action, action === 'consent' ? { granted: false } : action === 'withdraw' ? { turnId: 'private-turn' } : {});
    work.then(value => { response = value; acknowledged = true; });
    await work;
    assert.equal(acknowledged, true, 'privacy acknowledgement cannot wait for provider closure');
    if (response instanceof Response) assert.equal(response.status, 200);
    const type = action.includes('consent') ? 'consent.revised' : action === 'erase' ? 'session.erased' : 'turn.withdrawn';
    await waitFor(row => row.type === 'voice.state' && row.data.state === 'closing');
    await h.waitForClosure(grant.providerSessionId);
    assert.deepEqual(cancellations, [type], 'lane cancellation sees the committed invalidation');
    const invalidation = rows.findIndex(row => row.type === type), closing = rows.findIndex(row => row.type === 'voice.state' && row.data.state === 'closing');
    assert.ok(invalidation >= 0 && closing > invalidation, 'invalidation and closing arrive before provider closure');
    assert.equal(h.secrets.resolve(h.provisioned[0].facadeSecretRef), undefined);
    assert.equal(h.storage.db.prepare("SELECT state FROM budget_attempts WHERE lane='voice'").get().state, 'dispatched');
    assert.deepEqual(h.closeRequests, [grant.providerSessionId]);
    let idle = false; const draining = h.handlers.idle().then(() => { idle = true; }); await flush(); assert.equal(idle, false);
    h.advance(10_001); h.endClient(grant.providerSessionId); await draining; await work;
    assert.equal(h.storage.db.prepare("SELECT state FROM budget_attempts WHERE lane='voice'").get().state, 'settled');
    assert.equal(rows.filter(row => row.type === 'voice.state' && row.data.state === 'closing').length, 1);
  });
}

for (const route of ['engine', 'rail']) {
  test(`slow closure: ${route} pause needs ownership only even with lost coverage and broken provider pause`, async t => {
    const h = voiceFixture(t, { slowClosure: true }), start = h.plugin.start;
    h.plugin.start = async (...args) => { const call = await start(...args); call.pause = async () => { throw new Error('provider pause failed'); }; return call; };
    const grant = await h.start(), { rows, waitFor } = await observeVoice(h, t); h.coverage(false);
    const before = h.authChecks();
    let response;
    const work = h.route(route === 'engine' ? '/pause' : `/voice/${grant.callId}/pause`,
      route === 'engine' ? { paused: true } : { providerSessionId: grant.providerSessionId });
    work.then(value => { response = value; }); await work; assert.ok(response, 'pause acknowledgement cannot wait for closure');
    assert.equal(response.status, 200, 'pause must not fail admission');
    assert.equal(h.storage.get(h.session.id).paused, true);
    assert.equal(h.authChecks().coverageReads, before.coverageReads, 'pause must not check coverage');
    assert.equal(h.authChecks().healthReads, before.healthReads, 'pause must not check provider health');
    await waitFor(row => row.type === 'voice.state' && row.data.state === 'closing');
    assert.equal(rows.filter(row => row.type === 'session.paused' && row.data.paused).length, 1);
    assert.ok(rows.some(row => row.type === 'voice.state' && row.data.state === 'closing'));
    h.advance(10_001); h.endClient(grant.providerSessionId); await h.handlers.idle();
  });
}

test('slow closure: pause during closing records a fresh event and never re-broadcasts an old pause', async t => {
  const h = voiceFixture(t, { slowClosure: true }), grant = await h.start(), identity = { providerSessionId: grant.providerSessionId };
  await h.route('/pause', { paused: true }); await h.route('/pause', { paused: false });
  const { rows, waitFor } = await observeVoice(h, t), closing = h.route(`/voice/${grant.callId}/close`, identity);
  await waitFor(row => row.type === 'voice.state' && row.data.state === 'closing');
  const before = h.storage.get(h.session.id).seq;
  let response; const work = h.route('/pause', { paused: true }); work.then(value => { response = value; });
  await work; assert.ok(response, 'pause cannot await an already closing provider'); assert.equal(response.status, 200);
  await waitFor(row => row.type === 'session.paused' && row.seq > before);
  const pauses = rows.filter(row => row.type === 'session.paused');
  assert.equal(pauses.length, 1); assert.ok(pauses[0].seq > before); assert.equal(h.storage.get(h.session.id).paused, true);
  h.advance(10_001); h.endClient(grant.providerSessionId); await closing;
});

test('slow closure: unauthenticated facade calls never check authorization or close the call', async t => {
  const h = voiceFixture(t, { slowClosure: true }), grant = await h.start(), ref = h.provisioned[0].facadeSecretRef;
  h.coverage(false); const before = h.authChecks();
  for (const authorization of [undefined, 'Bearer wrong']) {
    let response;
    const work = h.handlers.handle(new Request(`https://facade.test/api/voice/${grant.callId}/llm/chat/completions`, {
      method: 'POST', headers: authorization ? { authorization } : {}, body: JSON.stringify({ aithema_call: grant.callId, messages: [{ role: 'user', content: 'hello' }] }) }));
    work.then(value => { response = value; }); await work;
    assert.ok(response); assert.equal(response.status, 401);
    assert.deepEqual(h.authChecks(), before); assert.ok(h.secrets.resolve(ref)); assert.equal(h.closeRequests.length, 0);
  }
  const authorized = await h.handlers.handle(new Request(`https://facade.test/api/voice/${grant.callId}/llm/chat/completions`, {
    method: 'POST', headers: { authorization: `Bearer ${h.secrets.resolve(ref)}` },
    body: JSON.stringify({ aithema_call: grant.callId, messages: [{ role: 'user', content: 'hello' }] }) }));
  assert.equal(authorized.status, 403);
});

test('slow closure: recovery admits immediately while the old provider needs more than ten seconds to confirm closure', async t => {
  const h = voiceFixture(t, { slowClosure: true }), first = await h.start(), ref = h.provisioned[0].facadeSecretRef;
  h.advance(5000); let response;
  const work = h.route(`/voice/${first.callId}/recover`, { providerSessionId: first.providerSessionId });
  work.then(value => { response = value; }); await work;
  assert.ok(response, 'new credential must be available before old closure'); assert.equal(response.status, 200);
  const next = await response.json(); assert.notEqual(next.providerSessionId, first.providerSessionId);
  assert.equal(next.spendDeadlineAt, first.spendDeadlineAt); assert.equal(h.secrets.resolve(ref), undefined);
  assert.deepEqual(h.closeRequests, [first.providerSessionId]);
  const claims = h.storage.db.prepare("SELECT * FROM budget_attempts WHERE lane='voice'").all();
  assert.equal(claims.length, 2); assert.ok(claims.every(row => row.state === 'dispatched'));
  assert.equal(claims[1].max_visitor_micro, 110_000, 'reserve only the remaining 55 seconds');
  await h.waitForClosure(first.providerSessionId);
  h.advance(10_001); h.endClient(first.providerSessionId); await work; await h.handlers.idle();
  assert.equal(h.storage.db.prepare("SELECT state FROM budget_attempts WHERE attempt_id=?").get(claims[0].attempt_id).state, 'settled');
  assert.equal((await h.route(`/voice/${next.callId}/heartbeat`, { providerSessionId: next.providerSessionId })).status, 200, 'old settlement cannot remove the new call');
});

test('slow closure: typed input is durable on send and provider echoes never add another person turn', async t => {
  const h = voiceFixture(t, { slowClosure: true }), grant = await h.start();
  const response = await h.route('/turns', { clientEventId: 'typed-1', content: 'Typed during the call', voiceCallId: grant.callId, providerSessionId: grant.providerSessionId });
  assert.equal(response.status, 200); const typed = await response.json();
  const echo = { type: 'final', callId: grant.callId, turnId: `${grant.providerSessionId}:user:echo`, role: 'user', text: typed.data.content };
  for (const turnId of [echo.turnId, echo.turnId, `${grant.providerSessionId}:user:echo-again`]) {
    const acknowledged = await h.route(`/voice/${grant.callId}/events`, { providerSessionId: grant.providerSessionId, event: { ...echo, turnId } });
    assert.equal(acknowledged.status, 200); assert.equal((await acknowledged.json()).data.id, 'typed-1');
  }
  await h.handlers.idle();
  assert.equal(h.storage.get(h.session.id).transcript.filter(t => t.role === 'user').length, 1);
  assert.equal(h.storage.read(h.session.id).filter(e => e.type === 'turn.final' && e.data.role === 'user').length, 1);
  const exported = await h.handlers.handle(new Request(`http://host/api/sessions/${h.session.id}/export`, { headers: { 'x-aithema-session-token': 'voice-owner' } }));
  assert.equal(JSON.parse(unzip(await exported.arrayBuffer())['transcript.json']).turns.filter(t => t.role === 'user').length, 1);
});

test('slow closure: concurrent closes publish each transition once and prune the active call after settlement', async t => {
  const h = voiceFixture(t, { slowClosure: true }), grant = await h.start(), { rows, waitFor } = await observeVoice(h, t);
  const identity = { providerSessionId: grant.providerSessionId };
  const closes = [h.route(`/voice/${grant.callId}/close`, identity), h.route(`/voice/${grant.callId}/close`, identity)];
  await waitFor(row => row.type === 'voice.state' && row.data.state === 'closing');
  h.advance(10_001); h.endClient(grant.providerSessionId);
  const terminals = await Promise.all(closes.map(async work => (await work).json())); assert.deepEqual(terminals[0], terminals[1]);
  await waitFor(row => row.type === 'voice.state' && row.data.state === 'ended');
  assert.equal(rows.filter(row => row.type === 'voice.state' && row.data.state === 'closing').length, 1);
  assert.equal(rows.filter(row => row.type === 'voice.state' && row.data.state === 'ended').length, 1);
  assert.equal((await h.route(`/voice/${grant.callId}/heartbeat`, identity)).status, 404, 'settled call is no longer in the active calls map');
  assert.deepEqual(await h.route(`/voice/${grant.callId}/close`, identity).then(r => r.json()), terminals[0], 'durable terminal remains replayable');
});

test('heard-prefix invalidation removes the unheard suffix from a file-backed WAL', async t => {
  const path = await temporaryDb(), h = voiceFixture(t, { path, slowClosure: true }), grant = await h.start();
  const turnId = `${grant.providerSessionId}:assistant:1`, suffix = 'unique-unheard-sensitive-suffix-ait101';
  const send = event => h.route(`/voice/${grant.callId}/events`, { providerSessionId: grant.providerSessionId, event: { callId: grant.callId, turnId, ...event } });
  assert.equal((await send({ type: 'final', role: 'assistant', text: `Heard. ${suffix}` })).status, 200);
  assert.ok((await readFile(path + '-wal')).includes(Buffer.from(suffix)));
  assert.equal((await send({ type: 'heard', prefix: 'Heard.' })).status, 200);
  assert.ok(!(await readFile(path + '-wal')).includes(Buffer.from(suffix)), 'checkpoint must truncate superseded WAL content');
});

test('assistant voice finals retain facade-produced or browser-asserted provenance in snapshots, replay and export', async t => {
  const h = voiceFixture(t, { slowClosure: true }), grant = await h.start(), secret = h.secrets.resolve(h.provisioned[0].facadeSecretRef);
  const completion = await h.handlers.handle(new Request(`https://facade.test/api/voice/${grant.callId}/llm/chat/completions`, {
    method: 'POST', headers: { authorization: `Bearer ${secret}` }, body: JSON.stringify({ aithema_call: grant.callId, messages: [{ role: 'user', content: 'Hello' }] }) }));
  const produced = (await completion.json()).choices[0].message.content;
  for (const [index, text] of [produced, 'Browser invented assistant speech'].entries()) {
    const response = await h.route(`/voice/${grant.callId}/events`, { providerSessionId: grant.providerSessionId,
      event: { type: 'final', callId: grant.callId, turnId: `${grant.providerSessionId}:assistant:${index}`, role: 'assistant', text, provenance: 'facade-produced' } });
    assert.equal(response.status, 200);
  }
  assert.deepEqual(h.storage.get(h.session.id).transcript.map(t => t.provenance), ['facade-produced', 'browser-asserted']);
  assert.deepEqual(h.storage.read(h.session.id).filter(e => e.type === 'turn.final').map(e => e.data.provenance), ['facade-produced', 'browser-asserted']);
  const exported = await h.handlers.handle(new Request(`http://host/api/sessions/${h.session.id}/export`, { headers: { 'x-aithema-session-token': 'voice-owner' } }));
  assert.match(unzip(await exported.arrayBuffer())['transcript.md'], /assistant \(browser-asserted\)/);
});

test('slow closure: recovery reserves remaining visitor duration after previously settled usage', async t => {
  const h = voiceFixture(t, { slowClosure: true }), first = await h.start();
  h.runtime.budget.visitorCapMicro = 121_000;
  const closing = h.route(`/voice/${first.callId}/close`, { providerSessionId: first.providerSessionId, reason: 'transport-lost' });
  await h.waitForClosure(first.providerSessionId); h.advance(15_000); h.endClient(first.providerSessionId); await closing;
  const response = await h.route(`/voice/${first.callId}/recover`, { providerSessionId: first.providerSessionId });
  assert.equal(response.status, 200, '30k spent plus 90k remaining fits the visitor cap');
  const claims = h.storage.db.prepare("SELECT * FROM budget_attempts WHERE lane='voice'").all();
  assert.equal(claims[1].max_visitor_micro, 90_000);
});

test('slow closure: engine pause records a new event even when the provider acknowledges without an event', async t => {
  const h = voiceFixture(t, { slowClosure: true }), start = h.plugin.start;
  h.plugin.start = async (...args) => { const call = await start(...args); call.pause = async () => ({ acknowledged: true, paused: true }); return call; };
  await h.start(); h.storage.pause(h.session.id, true); h.storage.pause(h.session.id, false);
  const before = h.storage.get(h.session.id).seq, { rows, waitFor } = await observeVoice(h, t);
  const response = await h.route('/pause', { paused: true }); assert.equal(response.status, 200);
  const ack = await response.json(); assert.equal(ack.paused, true); assert.ok(ack.event.seq > before);
  await waitFor(e => e.type === 'session.paused' && e.seq === ack.event.seq);
  assert.deepEqual(rows.filter(e => e.type === 'session.paused').map(e => e.seq), [ack.event.seq]);
});

test('slow closure: browser lease expiry publishes closing before the client ends', async t => {
  t.mock.timers.enable({ apis: ['Date', 'setTimeout'], now: Date.now() });
  const h = voiceFixture(t, { slowClosure: true, leaseMs: 20 }), grant = await h.start(), { rows, waitFor } = await observeVoice(h, t);
  h.advance(20); t.mock.timers.tick(20);
  await waitFor(e => e.type === 'voice.state' && e.data.state === 'closing' && e.data.reason === 'browser-liveness-deadline');
  assert.equal(h.secrets.resolve(h.provisioned[0].facadeSecretRef), undefined);
  assert.ok(rows.some(e => e.type === 'voice.state' && e.data.state === 'closing' && e.data.reason === 'browser-liveness-deadline'));
  assert.equal(h.storage.db.prepare("SELECT state FROM budget_attempts WHERE lane='voice'").get().state, 'dispatched');
  h.advance(10_001); h.endClient(grant.providerSessionId); await h.handlers.idle();
});

test('public server index does not export the local voice legal-check bypass', async () => {
  const api = await import('../src/index.js'); assert.equal(api.createLocalVoiceProvider, undefined);
});

test('slow closure: invalidation during startup keeps settlement tracked until the late call closes', async t => {
  const h = voiceFixture(t, { slowClosure: true }), start = h.plugin.start;
  let call, release; const ready = new Promise(resolve => { release = resolve; }), entered = Promise.withResolvers();
  h.plugin.start = async (...args) => { call = await start(...args); entered.resolve(); await ready; return call; };
  const startup = h.route('/voice', { callId: 'late-start' }); await entered.promise; assert.ok(call);
  try {
    assert.equal((await h.route('/consent', { granted: false })).status, 200);
    assert.equal(h.secrets.resolve(h.provisioned[0].facadeSecretRef), undefined);
    let idle = false; const draining = h.handlers.idle().then(() => { idle = true; }); await flush();
    assert.equal(idle, false, 'a dispatched startup is still awaiting provider settlement');
    h.advance(10_001); h.endClient(call.providerSessionId); release(); await startup; await draining;
    assert.equal(h.storage.db.prepare("SELECT state FROM budget_attempts WHERE lane='voice'").get().state, 'settled');
    assert.equal(h.storage.db.prepare("SELECT outcome FROM budget_attempts WHERE lane='voice'").get().outcome, 'cancelled');
  } finally { h.endClient(call.providerSessionId); release(); await startup; }
});

test('slow closure: a failed recovery admission can retry before the original provider settles', async t => {
  const h = voiceFixture(t, { slowClosure: true }), first = await h.start(), start = h.plugin.start;
  let starts = 0;
  h.plugin.start = (...args) => { if (++starts === 1) throw new PluginError('unavailable'); return start(...args); };
  const identity = { providerSessionId: first.providerSessionId };
  assert.equal((await h.route(`/voice/${first.callId}/recover`, identity)).status, 502);
  await h.waitForClosure(first.providerSessionId);
  assert.equal(h.storage.voiceCalls(h.session.id)[0].terminal, undefined, 'original closure is still pending');
  const response = await h.route(`/voice/${first.callId}/recover`, identity);
  assert.equal(response.status, 200, 'retry must not depend on the pending old terminal');
  const next = await response.json(); assert.notEqual(next.providerSessionId, first.providerSessionId);
  h.advance(10_001); h.endClient(first.providerSessionId);
});

test('slow closure: recovery retries the original identity after a new SDK connection fails and closes', async t => {
  const h = voiceFixture(t, { slowClosure: true }), original = await h.start();
  const recover = () => h.route(`/voice/${original.callId}/recover`, { providerSessionId: original.providerSessionId });
  const first = await recover().then(r => r.json());
  const closing = h.route(`/voice/${first.callId}/close`, { providerSessionId: first.providerSessionId, reason: 'recovery-failed' });
  await h.waitForClosure(first.providerSessionId);
  const response = await recover(); assert.equal(response.status, 200);
  const next = await response.json(); assert.notEqual(next.providerSessionId, first.providerSessionId, 'a closing credential cannot be reused');
  assert.equal(h.storage.db.prepare("SELECT COUNT(*) n FROM budget_attempts WHERE lane='voice' AND state='dispatched'").get().n, 3);
  h.advance(10_001); h.endClient(original.providerSessionId); h.endClient(first.providerSessionId); await closing;
});
