import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { PluginRegistry, createMockReasoning, consentCoverage, MOCK_PROCESSING_SCOPE } from '@inspr/aithema-core';
import { createComposedVoiceAuthority } from '../packages/server/src/composed/authority.js';
import { SQLiteStorage, createHandlers, createPluginRuntime, mockPresets, createLocalHTML,
  localHTMLBinding, createSpendCap, createLocalImages, createFacadeSecrets } from '@inspr/aithema-server';
import { createLocalVoiceProvider, localVoiceBinding } from '@inspr/aithema-server/dev/local-voice';
import { createConceptHandlers } from '../packages/server/src/concept-handlers.js';
import { createMockConsent } from '../demo/mock-consent.js';
import { createProcessingConsent } from '../demo/processing-consent.js';
import { createDemoHost } from '../demo/host-ports.js';
import { startExpiry } from '../demo/session-lifecycle.js';
import { createVoiceHost } from '../demo/start2-voice-host.js';
import { stubAgentApi } from './fixtures/voice-self-heal-host.js';
import { createComposedVoiceCoordinator } from '../packages/server/src/voice-coordinator.js';
import { ownedRequest, testToken } from './helpers.js';

const wall = Date.parse('2030-06-15T00:00:30Z');
const day = at => new Date(at).toISOString().slice(0, 10);
function fixture(t, { explicit = false, voiceCap, renderLimiter } = {}) {
  t.mock.timers.enable({ apis: ['Date'], now: wall });
  let at = wall - 60_000;
  const now = () => at, storage = new SQLiteStorage();
  // As demo/server.js: compose components before handlers install the clock.
  const consent = createMockConsent(storage), html = createLocalHTML(), presets = mockPresets();
  presets.best.plugins.push(html.manifest.id); presets.best.bindings.html = localHTMLBinding;
  const runtime = createPluginRuntime({ storage, consent, presets, voiceCap, renderLimiter,
    registry: new PluginRegistry().register(createMockReasoning()).register(html),
    uiRenderLimits: { perDay: 1, perSession: 20 }, ...(explicit ? { now } : {}) });
  const host = createDemoHost({ storage, now: explicit ? () => wall : now });
  const handlers = createHandlers({ storage, consent, pluginRuntime: runtime, host, log() {} });
  t.after(async () => { await handlers.close(); storage.close(); });
  const session = storage.create({ ownerToken: testToken, demo: true });
  consent.grant({ sessionId: session.id, consentRevision: session.consentRevision });
  return { now, advance: ms => { at += ms; }, storage, consent, html, runtime, host, handlers, session };
}

for (const explicit of [false, true]) {
  test(`AIT-403 sweep render day admission and atomic consumption use installed runtime clock (explicit ${explicit})`, async t => {
    const h = fixture(t, { explicit });
    h.storage.db.prepare('INSERT INTO ui_render_claims VALUES (?,?,?)').run('prior-render', h.session.id, day(h.now()));
    const attempts = () => h.storage.db.prepare('SELECT COUNT(*) n FROM budget_attempts').get().n;
    const before = attempts();
    const response = await h.handlers.handle(ownedRequest(`https://fixture.invalid/api/sessions/${h.session.id}/concepts`, {
      method: 'POST', body: JSON.stringify({ clientEventId: 'refused-render', intent: true, sourceTurnId: 'unused' }),
    }));
    assert.equal(response.status, 429, 'exhausted host day refuses before intent validation or spend');
    assert.equal(h.runtime.renderLimiter.reason(h.session.id), 'UI render limit reached for this UTC day');
    let dispatched = false;
    assert.throws(() => h.runtime.renderLimiter.consume('must-refuse', h.session.id, () => { dispatched = true; }),
      { code: 'rate-limit', message: 'UI render limit reached for this UTC day' });
    assert.equal(dispatched, false); assert.equal(attempts(), before);
    h.advance(60_000);
    h.runtime.renderLimiter.consume('next-day', h.session.id, () => { dispatched = true; });
    assert.equal(dispatched, true);
    assert.equal(h.storage.db.prepare('SELECT day FROM ui_render_claims WHERE attempt_id=?').get('next-day').day, day(h.now()));
  });
}

test('AIT-403 sweep direct runtime conversation deadline follows later clock installation', async t => {
  const h = fixture(t);
  h.runtime.setHostClock(() => h.now() + 1000);
  const state = h.runtime.conversationLimits.start(h.session.id);
  assert.equal(state.startedAt, h.now() + 1000);
  h.advance(3_600_000);
  assert.equal(h.runtime.conversationLimits.reason(h.session.id), 'one-hour');
});

test('AIT-430 custom voice cap without a clock port rejects host installation before changing clocks', t => {
  t.mock.timers.enable({ apis: ['Date'], now: wall });
  const storage = new SQLiteStorage(); t.after(() => storage.close());
  const cap = { reason: () => null, reserve() {}, settle() {} };
  const runtime = createPluginRuntime({ storage, voiceCap: cap });
  assert.throws(() => runtime.setHostClock(() => wall - 60_000),
    { name: 'TypeError', message: 'Host clock requires voiceCap.setClock(clock)' });
  assert.equal(runtime.now(), wall);
  assert.throws(() => createPluginRuntime({ storage, voiceCap: cap, now: () => wall - 60_000 }),
    { name: 'TypeError', message: 'Host clock requires voiceCap.setClock(clock)' });
});

test('AIT-403 custom render limiter without a clock port rejects host installation', t => {
  t.mock.timers.enable({ apis: ['Date'], now: wall });
  const storage = new SQLiteStorage(); t.after(() => storage.close());
  const runtime = createPluginRuntime({ storage, renderLimiter: { reason: () => null, consume() {} } });
  assert.throws(() => runtime.setHostClock(() => wall - 60_000),
    { name: 'TypeError', message: 'Host clock requires renderLimiter.setClock(clock)' });
  assert.equal(runtime.now(), wall);
});

test('AIT-430 real host handover port receives runtime deadline and clock', async t => {
  const h = fixture(t), observed = [];
  const handover = h.host.handover;
  h.host.handover = (...args) => {
    const port = handover(...args), offer = port.offer;
    return { ...port, offer(request, options) { observed.push(options); return offer(request, options); } };
  };
  const response = await h.handlers.handle(ownedRequest(`https://fixture.invalid/api/sessions/${h.session.id}/handover`));
  assert.equal(response.status, 200, await response.clone().text());
  assert.equal(observed.length, 1);
  assert.equal(observed[0].deadlineAt, h.runtime.now() + 30_000);
  assert.equal(observed[0].now(), h.runtime.now());
});

test('AIT-403 sweep demo mock consent evidence uses the clock installed after construction', async t => {
  const h = fixture(t);
  assert.equal(h.consent.coverage({ sessionId: h.session.id }).expiresAt, h.now() + 365 * 86_400_000);
});

test('AIT-403 sweep durable processing consent records and expires on installed host clock', async t => {
  const h = fixture(t), port = createProcessingConsent({ storage: h.storage, bindings: [] });
  assert.equal(port.grant({ sessionId: h.session.id, consentRevision: h.session.consentRevision + 1,
    decision: { contract: port.describe().contract, items: [] } }), true);
  assert.equal(h.storage.db.prepare('SELECT at FROM processing_consent_events WHERE session_id=?').get(h.session.id).at, h.now());
});

test('AIT-403 sweep storage event and content evidence timestamps follow installed host clock', async t => {
  const h = fixture(t);
  const event = h.storage.append(h.session.id, 'turn.final', { id: 'clock-turn', role: 'user', content: 'clock' });
  assert.equal(event.at, new Date(h.now()).toISOString());
  assert.equal(h.storage.db.prepare('SELECT at FROM content WHERE session_id=? LIMIT 1').get(h.session.id).at,
    new Date(h.now()).toISOString());
});

test('AIT-403 explicit runtime policy clock also owns storage retention and evidence', async t => {
  const h = fixture(t, { explicit: true });
  assert.equal(h.storage.now(), h.runtime.now());
  h.runtime.setHostClock(() => wall + 60_000);
  assert.equal(h.storage.now(), h.runtime.now(), 'later host accounting installation cannot change storage policy epoch');
  assert.equal(h.runtime.budget.now(), wall + 60_000, 'ledger attribution keeps its documented host epoch');
  const event = h.storage.append(h.session.id, 'session.paused', { paused: true });
  assert.equal(event.at, new Date(h.runtime.now()).toISOString());
});

test('AIT-403 sweep retirement receipt deferral defaults to installed storage clock', async t => {
  const h = fixture(t);
  h.storage.erase(h.session.id);
  h.storage.assertRetirementSettled(h.session.id);
  assert.equal(h.storage.db.prepare('SELECT billing_deadline_ms FROM retirement_pending WHERE session_id=?').get(h.session.id).billing_deadline_ms,
    h.now() + 3_600_000);
});

test('AIT-403 sweep provider-cap audit evidence uses installed host clock', async t => {
  const h = fixture(t), cap = createSpendCap({ storage: h.storage, account: 'clock', capMicro: 100 });
  cap.saveSettings({ baseRevision: cap.settings().revision, capUsd: '0.000100' }, { actor: 'ops-cli:fixture', source: 'ops-cli' });
  assert.equal(cap.audit()[0].at, new Date(h.now()).toISOString());
});

test('AIT-403 sweep expiry scheduler uses handler clock for the retention cutoff', t => {
  t.mock.timers.enable({ apis: ['Date', 'setInterval'], now: wall });
  const now = () => wall - 60_000, calls = [];
  const interval = startExpiry({ now, retire: async options => { calls.push(options); } });
  t.after(() => clearInterval(interval));
  t.mock.timers.tick(60_000);
  assert.deepEqual(calls, [{ before: now() - 365 * 86_400_000, limit: 100 }]);
});

test('AIT-403 sweep concept lane and intent events inherit the installed runtime clock', async t => {
  const h = fixture(t), observed = [];
  const runtime = { now: h.runtime.now, visualKind: () => 'html', admit: args => { observed.push(args); throw new Error('offline probe'); } };
  const concepts = createConceptHandlers({ storage: h.storage, runtime, ownership: {}, readBody() {}, publish() {} });
  h.storage.append(h.session.id, 'turn.final', { id: 'concept-person', role: 'user', content: 'a concept' });
  concepts.lane.recordIntent(h.session.id, { intentId: 'concept-person', sourceTurnId: 'concept-person' });
  await concepts.lane.run(h.session.id, { trigger: 'manual' });
  assert.equal(observed.length, 1);
  assert.equal(observed[0].options.now(), h.now());
  assert.equal(observed[0].options.deadlineAt, h.now() + 120_000);
  assert.equal(h.storage.get(h.session.id).conceptIntent.lastActivityAt, h.now());
});

test('AIT-403 sweep local HTML provenance uses admitted runtime clock', async t => {
  const h = fixture(t), options = { now: h.runtime.now, deadlineAt: h.now() + 1000,
    attempt: { attemptId: 'artifact-clock', claimId: 'fixture', consume() {} }, report() {} };
  const artifact = await h.html.generate({ prompt: 'fixture', understanding: { summary: 'fixture' } }, '', options);
  assert.equal(artifact.provenance.generatedAt, new Date(h.now()).toISOString());
});

test('AIT-403 sweep local image provenance uses admitted runtime clock', async t => {
  const h = fixture(t), plugin = createLocalImages({ delayMs: 0 });
  const artifact = await plugin.generate({ prompt: 'fixture' }, '', {
    now: h.runtime.now, deadlineAt: h.now() + 1000,
    attempt: { attemptId: 'image-clock', claimId: 'fixture', consume() {} }, report() {} });
  assert.equal(artifact.provenance.generatedAt, new Date(h.now()).toISOString());
});

test('AIT-403 sweep demo-wired local voice provider follows runtime clock without a constructor clock', async t => {
  const h = fixture(t), plugin = createLocalVoiceProvider({ storage: h.storage });
  const options = { now: h.runtime.now, deadlineAt: h.now() + 1000, spendDeadlineAt: h.now() + 60_000,
    browserLivenessDeadlineAt: h.now() + 30_000,
    attempt: { attemptId: 'local-clock', claimId: 'fixture', maxMicro: 0, consume() {} }, report() {} };
  const voice = await plugin.start({ sessionId: h.session.id, callId: 'local-clock', ownerToken: testToken }, options);
  try {
    assert.equal(voice.snapshot().startedAt, h.now());
    assert.equal(voice.snapshot().spendDeadlineAt, options.spendDeadlineAt);
  } finally { await voice.close(); }
});

test('AIT-403 local reconciliation does not use its elapsed lookup clock for call duration', async t => {
  const h = fixture(t), plugin = createLocalVoiceProvider({ storage: h.storage });
  const result = await plugin.ports.serverAdapter.reconciliationEvidence({
    call: { providerSessionId: 'clock-orphan', startedAt: h.now() - 1000, pauses: [] }, outcome: 'completed',
  }, { now: Date.now, deadlineAt: wall + 1000 });
  assert.equal(result.terminal.usage.providerSeconds, 1);
  assert.equal(result.terminal.usage.visitorSeconds, 1);
});

test('AIT-430 documented standalone coordinator forwards clock into component operation budgets', async t => {
  const h = fixture(t), observed = [];
  const coordinator = createComposedVoiceCoordinator({ now: h.runtime.now, sessionId: h.session.id, callId: 'composition-clock',
    spendDeadlineAt: h.now() + 60_000, browserLivenessDeadlineAt: h.now() + 30_000,
    stt: { stream() {} }, tts: { speak() {} }, replyExecutor: { execute() {} },
    admitComponent() {}, authorize(request, options) { observed.push(options); return true; }, commitUtterance() {},
    relay: { audio() {}, silence() {}, event() {} } });
  t.after(() => coordinator.close());
  await coordinator.setInput(false);
  assert.equal(observed.length, 1);
  assert.equal(observed[0].now(), h.now());
  assert.equal(observed[0].deadlineAt, h.now() + 60_000);
  const docs = await readFile(new URL('../docs/embedding.md', import.meta.url), 'utf8');
  assert.match(docs, /now: runtime\.now/);
});

test('AIT-430 reconciliation evidence age uses the accounting clock that stamped settledAt', async t => {
  const h = fixture(t, { explicit: true }), binding = localVoiceBinding;
  const plugin = { ...createMockReasoning(), manifest: { ...createMockReasoning().manifest, id: 'cost-clock' }, reconcileCost: async () => null,
    uncertainEstimateMicro: 25 };
  // A separate runtime policy epoch is supported; host accounting remains wall.
  const runtime = createPluginRuntime({ storage: h.storage, now: h.now,
    registry: new PluginRegistry().register(plugin), costReconciliationWindowMs: 1000 });
  let accountingAt = wall - 1000;
  runtime.setHostClock(() => accountingAt);
  runtime.budget.admit({ attemptId: 'cost-clock', sessionId: h.session.id, lane: 'reaction', maxMicro: 100,
    requestSha256: 'a'.repeat(64), bindingSha256: 'b'.repeat(64),
    providerCost: { plugin: plugin.manifest.id, settledAt: wall - 1000, estimateMicro: 25 } });
  const claim = runtime.budget.claim('cost-clock'); claim.consume();
  runtime.budget.settle(claim.claimId, { attemptId: 'cost-clock', outcome: 'uncertain' }, binding.rates);
  accountingAt = wall;
  await runtime.reconcileCosts();
  assert.equal(runtime.budget.get('cost-clock').settled_micro, 25);
  assert.equal(JSON.parse(runtime.budget.get('cost-clock').cost_reconciliation_json).estimated, true);
});

test('AIT-403 sweep component consent refuses host-expired evidence even when wall clock still accepts it', async t => {
  const h = fixture(t);
  h.runtime.setHostClock(() => h.now() + 120_000);
  const scope = MOCK_PROCESSING_SCOPE;
  const port = { coverage: () => ({ ...scope, covered: true, consentRevision: h.session.consentRevision,
    expiresAt: h.runtime.now() - 1 }) };
  assert.equal(await consentCoverage(port, h.session, scope, { now: h.runtime.now }), false);
});

test('AIT-403 sweep demo voice host qualifies binding evidence on its forwarding clock', async t => {
  const h = fixture(t), api = stubAgentApi();
  const host = await createVoiceHost({ storage: h.storage, now: h.runtime.now, facadeSecrets: createFacadeSecrets(),
    templateAgentId: 'template-agent', publicOrigin: 'https://fixture.test', apiBaseUrl: api.endpoint, values: {},
    resolveSecret: () => 'synthetic-offline-fixture', fetchImpl: api.fetchImpl, log() {} });
  try {
    assert.ok(host.binding);
    assert.equal(host.binding.legal.evidence.verifiedAt, h.now());
    assert.equal(host.binding.legal.evidence.expiresAt, h.now() + 90 * 86_400_000);
  } finally { await host.close(); }
});

test('AIT-403 sweep composed reply creation evidence uses the admitted runtime clock', async t => {
  const h = fixture(t), done = new Error('reply observed'); let created;
  const authority = createComposedVoiceAuthority({ authorizeComposition() {}, commitCoordinator() {},
    turnOperations: { async run(context, execute) {
      const reply = await execute({ beforeAdmission() {}, admitted() {}, assertCurrent() {}, ordinal: 1,
        signal: new AbortController().signal });
      created = reply.created; throw done;
    } },
    admitReasoning: async () => ({ request: { system: '', messages: [] }, producer: localVoiceBinding,
      options: { now: h.runtime.now, deadlineAt: h.now() + 1000, attempt: { attemptId: 'reply-clock' }, report() {} },
      plugin: { async *stream(request, options) { yield 'Hello'; options.report({}); } }, finish() {} }) });
  await assert.rejects(async () => {
    for await (const _event of authority.replyExecutor.execute({ source: 'server-coordinator', payload: {
      callId: 'reply-clock', providerSessionId: 'fixture', callbackBody: { messages: [] } } },
    { now: h.runtime.now, deadlineAt: h.now() + 1000 })) {}
  }, done);
  assert.equal(created, Math.floor(h.now() / 1000));
});
