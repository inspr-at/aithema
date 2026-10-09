import { test } from 'node:test';
import assert from 'node:assert/strict';
import { SQLiteStorage, createHandlers, createPluginRuntime, createVoiceProvider, createFacadeSecrets, mockPresets,
  SQLiteBudgetLedger } from '../src/index.js';
import { PluginRegistry, createMockReasoning, activeTurns } from '@inspr/aithema-core';

export function voiceFixture(t, { unknown = false, leaseMs = 30_000 } = {}) {
  const storage = new SQLiteStorage(), secrets = createFacadeSecrets();
  let clock = Date.now(), sequence = 0, covered = true; const opened = new Map(), provisioned = [], traffic = [];
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
    resolveSecret: () => 'provider-fixture-value', revokeFacade: secrets.revoke, closureTimeoutMs: 5,
    async provisionFacade(record) { assert.ok(secrets.resolve(record.facadeSecretRef)); provisioned.push(record); },
    fetchImpl: async url => {
      traffic.push(String(url));
      if (String(url).includes('/token?')) {
        const id = `provider-${++sequence}`; opened.set(id, clock);
        return Response.json({ token: 'fixture-credential', conversation_id: id });
      }
      const id = String(url).split('/').at(-1);
      return Response.json({ conversation_id: id, status: unknown ? 'processing' : 'done',
        metadata: { start_time_unix_secs: opened.get(id) / 1000, call_duration_secs: (clock - opened.get(id)) / 1000, cost: 7 } });
    } });
  const reasoning = createMockReasoning(), presets = mockPresets();
  presets.best.plugins.push('elevenlabs'); presets.best.bindings.voice = binding; presets.best.policy = { endpoints: [binding.endpoint] };
  const consent = { async coverage({ scope, consentRevision }) { return { covered, ...scope, scope, consentRevision, checkedAt: clock, expiresAt: clock + 100_000 }; } };
  const runtime = createPluginRuntime({ storage, reasoning, registry: new PluginRegistry().register(reasoning).register(plugin), presets, consent, now });
  const handlers = createHandlers({ storage, reasoning, pluginRuntime: runtime, consent, voice: { secrets, now, browserLeaseMs: leaseMs } });
  t.after(async () => { await handlers.close(); storage.close(); });
  const token = 'voice-owner', session = storage.create({ ownerToken: token, demo: true });
  const route = async (suffix, body = {}, owner = token) => handlers.handle(new Request(`http://host/api/sessions/${session.id}${suffix}`, {
    method: 'POST', headers: { 'x-aithema-session-token': owner }, body: JSON.stringify(body) }));
  const start = async (callId = 'call-1') => {
    const response = await route('/voice', { callId }); assert.equal(response.status, 201); return response.json();
  };
  return { storage, secrets, runtime, handlers, session, route, start, presets, provisioned, traffic, now,
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
  const h = voiceFixture(t, { unknown: true }), grant = await h.start();
  h.advance(2000); const terminal = await h.route(`/voice/${grant.callId}/close`, { providerSessionId: grant.providerSessionId }).then(r => r.json());
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
  assert.equal(h.storage.db.prepare("SELECT state FROM budget_attempts WHERE lane='voice'").get().state, 'settled');
});

test('browser lease and spend expiry settle a call even while the engine is paused', async t => {
  const h = voiceFixture(t, { leaseMs: 20 }), grant = await h.start();
  await h.route(`/voice/${grant.callId}/pause`, { providerSessionId: grant.providerSessionId });
  await new Promise(resolve => setTimeout(resolve, 35));
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
