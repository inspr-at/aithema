import { createHash } from 'node:crypto';
import { PluginError } from '@inspr/aithema-core/invocation';
import { SQLiteBudgetLedger } from '../budget.js';

const hash = value => createHash('sha256').update(JSON.stringify(value)).digest('hex');

/** Host speech admission/report ports. Reserve through the ordinary owner wallet
 * when mounted by the runtime; synthetic hosts may supply their own ledger.
 * The parent only funds visitor duration. Every invocation owns a fresh child. */
export function createComposedComponentAccounting({ storage, budget = new SQLiteBudgetLedger(storage),
  reserve = (_session, request) => budget.admit(request), assertCurrent = () => {} } = {}) {
  return Object.freeze({
    async admit({ sessionId, callId, providerSessionId, epoch, parentAttemptId, role, request, binding, maxMicro, signal, deadlineAt }) {
      if (!['stt', 'tts'].includes(role) || !binding?.model) throw new PluginError('not-admitted');
      const session = storage.get(sessionId);
      await assertCurrent({ sessionId, callId, providerSessionId, epoch });
      signal?.throwIfAborted();
      const parent = parentAttemptId ?? storage.voiceCalls(sessionId).find(call =>
        call.callId === callId && call.providerSessionId === providerSessionId && call.epoch === epoch && !call.terminal)?.attemptId;
      const component = { parentAttemptId: parent, callId, providerSessionId, epoch, role,
        unit: role === 'stt' ? 'seconds' : 'characters', model: binding.model };
      const admission = await reserve(session, { sessionId, lane: role, maxMicro, maxVisitorMicro: 0,
        component, requestSha256: hash(request), bindingSha256: hash(binding) });
      const attempt = { ...budget.claim(admission.attemptId), maxMicro };
      return {
        signal, deadlineAt,
        attempt: { ...attempt, async consume() {
          await assertCurrent({ sessionId, callId, providerSessionId, epoch });
          signal?.throwIfAborted();
          const parentRow = budget.get(parent);
          if (parentRow?.state !== 'dispatched' || parentRow.voice_closing) throw new PluginError('not-admitted');
          attempt.consume(); // SQLite FULL commit completes before provider dispatch.
        } },
        observe: usage => budget.observeComponent(attempt.attemptId, usage),
        report: terminal => budget.settleComponent(attempt.claimId, terminal),
      };
    },
  });
}
