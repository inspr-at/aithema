import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createComposedVoiceCoordinator } from '../../../packages/server/src/composed-voice.js';
import { createVoiceReplyExecutor, createVoiceTurnOperations } from '../../../packages/server/src/voice-turns.js';
import { SQLiteStorage } from '../../../packages/server/src/storage.js';
import { SQLiteBudgetLedger } from '../../../packages/server/src/budget.js';
import { PluginError } from '../../../packages/core/src/invocation.js';
import { readVoiceObservabilityFixture, voiceFixtureFrames } from '../../../test/voice-observability-fixtures.js';

const collect = async events => { const rows = []; for await (const row of events) rows.push(row); return rows; };
const pcm = (ms, amplitude) => {
  const bytes = Buffer.alloc(ms * 32);
  for (let i = 0; i < bytes.length; i += 2) bytes.writeInt16LE(amplitude, i);
  return bytes;
};

test('AIT-139: composed capture, retries, truncated history and partial replies share independent wire oracles', async t => {
  t.mock.method(globalThis, 'fetch', () => assert.fail('Offline fixtures cannot call a provider'));
  const { fixture } = await readVoiceObservabilityFixture('callbacks');
  const { fixture: reconciliation } = await readVoiceObservabilityFixture('reconciliation');
  const records = new Map(fixture.callbacks.map(row => [row.name, row]));
  const captured = ['history-base', 'history-growth', 'partial-stream'].map(name => records.get(name));
  const storage = new SQLiteStorage(), session = storage.create({ ownerToken: 'synthetic-owner' });
  const ledger = new SQLiteBudgetLedger(storage), logs = [], envelopes = [], finals = [];
  let clock = reconciliation.reconciliation[0].call.startedAt, admissions = 0, settlements = 0, capture = 0;
  const turns = createVoiceTurnOperations({ storage, now: () => clock,
    log: row => logs.push(typeof row === 'string' ? JSON.parse(row) : row) });
  const callId = 'call_observability', providerSessionId = 'conv_observability';
  const executor = createVoiceReplyExecutor({ execute(envelope, options) {
    envelopes.push(envelope);
    const text = envelope.payload.callbackBody.messages.at(-1).content;
    const record = captured.find(row => JSON.parse(row.request.body).messages.at(-1).content === text);
    assert.ok(record, 'Use only independently authored synthetic replies');
    return turns.run(envelope.payload, worker => {
      worker.beforeAdmission();
      const attempt = ledger.admit({ sessionId: session.id, lane: 'reaction', maxMicro: 40,
        requestSha256: 'a'.repeat(64), bindingSha256: 'b'.repeat(64) });
      const claim = ledger.claim(attempt.attemptId); claim.consume();
      admissions++; clock += 10; worker.admitted(attempt.attemptId);
      const frames = voiceFixtureFrames(record);
      return { replyId: `synthetic-${record.name}`, created: frames[0].created, events: (async function* () {
        let full = '';
        try {
          for (const frame of frames) {
            clock += 10;
            if (frame.error) throw new PluginError(frame.error, 'Private synthetic failure');
            const delta = frame.choices?.[0]?.delta?.content;
            if (delta) { full += delta; yield { type: 'delta', text: delta }; }
            if (frame === '[DONE]') yield { type: 'completion', text: full };
          }
        } finally {
          settlements++;
          ledger.settle(claim.claimId, { attemptId: attempt.attemptId, outcome: 'completed', chargedMicro: 7,
          usage: { inputTokens: 8, outputTokens: 4 } });
        }
      })() };
    }, options);
  } });
  const coordinator = createComposedVoiceCoordinator({ sessionId: session.id, callId, providerSessionId,
    spendDeadlineAt: Date.now() + 60_000, browserLivenessDeadlineAt: Date.now() + 60_000,
    replyExecutor: executor, authorize: async () => true, commitUtterance: async () => {},
    stt: { async *stream({ audio }, options) {
      await options.attempt.consume(); await collect(audio);
      const body = JSON.parse(captured[capture++].request.body);
      yield { text: body.messages.at(-1).content, final: true };
    } },
    tts: { async *speak(_request, options) { await options.attempt.consume(); yield new Uint8Array([1, 2, 3, 4]); } },
    admitComponent: async ({ role, signal, deadlineAt }) => ({ signal, deadlineAt,
      attempt: { attemptId: `synthetic-${role}-${capture}`, claimId: 'synthetic-claim', consume() {} }, report() {} }),
    relay: { audio() {}, silence() {}, event(row) { if (row.type === 'final' && row.role === 'assistant') finals.push(row); } } });
  t.after(async () => { await coordinator.close(); await coordinator.idle(); await turns.idle(); storage.close(); });

  for (const _record of captured) {
    await coordinator.receiveAudio(pcm(100, 8000)); await coordinator.receiveAudio(pcm(500, 0));
    await coordinator.idle(); await turns.idle();
  }
  assert.equal(coordinator.state.state, 'waiting', 'A partial failure requires recovery');
  assert.equal(finals.length, 2, 'Partial replies are never published as completed turns');
  for (let i = 0; i < 2; i++) {
    const expected = JSON.parse(captured[i].request.body).messages.filter(row => row.role !== 'system');
    assert.deepEqual(envelopes[i].payload.callbackBody.messages, expected, 'Composed history follows the shared vendor-shaped oracle');
  }
  assert.equal(finals[0].text, voiceFixtureFrames(records.get('retry-json'))[0].choices[0].message.content);
  const replay = await collect(executor.execute(envelopes[0], {}));
  assert.equal(replay.at(-1).text, finals[0].text);
  // Truncation is an independent admitted history, never evidence to reuse an old paid operation.
  const truncated = { source: 'server-coordinator', payload: { sessionId: session.id, callId, providerSessionId, stream: true,
    callbackBody: JSON.parse(records.get('history-truncation').request.body) } };
  await collect(executor.execute(truncated, {})); await turns.idle();
  assert.equal(admissions, fixture.admissions); assert.equal(settlements, fixture.admissions);
  assert.equal(ledger.used(session.id), 28, 'Duplicate replay adds no charge and partial work settles once');

  const beforeReconciliation = ledger.used(session.id);
  for (const [index, row] of reconciliation.reconciliation.entries()) {
    clock = row.call.endedAt + (index + 1) * 100;
    turns.observeClosure({ ...row.call, sessionId: session.id, callId }, row.terminal);
    turns.observeClosure({ ...row.call, sessionId: session.id, callId }, row.terminal);
    if (index === 0) assert.equal(logs.filter(row => row.event === 'voice.turn.closure').length, 0);
  }
  const closures = logs.filter(row => row.event === 'voice.turn.closure');
  assert.equal(closures.length, 4); assert.ok(closures.every(row => row.closureConfirmed && row.reconciliationAgeMs === 200));
  assert.equal(ledger.used(session.id), beforeReconciliation, 'Observing closure/usage is never another ledger settlement');
  for (const completion of logs.filter(row => row.event === 'voice.turn.completion')) {
    const rows = logs.filter(row => row.attemptHash === completion.attemptHash && row.event !== 'voice.turn.retry');
    assert.deepEqual(rows.map(row => row.event), ['voice.turn.admission', 'voice.turn.first-token', 'voice.turn.completion', 'voice.turn.closure']);
    assert.ok(rows[0].admissionMs <= rows[1].firstTokenMs && rows[1].firstTokenMs <= rows[2].totalMs);
    assert.equal(new Set(rows.map(row => row.turnHash)).size, 1);
    assert.equal(new Set(rows.map(row => row.generationHash)).size, 1);
  }
  assert.equal(new Set(closures.map(row => row.turnHash)).size, 4);
  assert.equal(new Set(closures.map(row => row.generationHash)).size, 1);
  assert.equal(logs.find(row => row.event === 'voice.turn.retry').cause, 'replay');
  assert.doesNotMatch(JSON.stringify(logs), /Private|synthetic|https?:|Bearer|prompt|speech|reference|credential|Tokens/iu);
});
