// Synthetic process-death fixture. No provider transport or credential ports.
import { SQLiteStorage, SQLiteBudgetLedger } from '../../packages/server/src/index.js';
import { createComposedComponentAccounting } from '@inspr/aithema-server/composed-voice/accounting';
import { componentInvocation } from '@inspr/aithema-core/voice-components';
const [path, phase] = process.argv.slice(2);
const storage = new SQLiteStorage(path), session = storage.create(), budget = new SQLiteBudgetLedger(storage);
const parent = budget.admit({ sessionId: session.id, lane: 'voice', maxMicro: 0,
  requestSha256: 'a'.repeat(64), bindingSha256: 'b'.repeat(64) });
budget.claim(parent.attemptId).consume();
const options = await createComposedComponentAccounting({ storage, budget }).admit({ sessionId: session.id,
  callId: 'crash-call', providerSessionId: 'crash-provider', epoch: 0, parentAttemptId: parent.attemptId,
  role: 'tts', maxMicro: 90, request: { text: 'fixture' }, binding: { plugin: 'fixture', model: 'speech' } });
if (phase !== 'claimed') {
  const invocation = await componentInvocation(options, { role: 'tts', unit: 'characters', model: 'speech' });
  invocation.dispatch();
  if (phase === 'observed') {
    try { invocation.usage(10, 130, 'synthetic-overrun', true); }
    catch (error) { if (error.code !== 'limit') throw error; }
  }
}
process.on('message', () => {});
process.send({ sessionId: session.id, attemptId: options.attempt.attemptId });
// The test kills this process without reporting, closing SQLite or running cleanup.
