import { createHash } from 'node:crypto';
import { PLUGIN_ERROR_CODES } from '../../core/src/invocation.js';

// The schema is closed: callers cannot add free-form diagnostic fields or values.
const stages = Object.freeze({
  'voice.turn.admission': ['admissionMs'],
  'voice.turn.first-token': ['firstTokenMs'],
  'voice.turn.completion': ['totalMs', 'outcome', 'cause'],
  'voice.turn.retry': ['cause'],
  'voice.turn.closure': ['closureConfirmed', 'costEstimated', 'reconciliationAgeMs'],
  'voice.segment.reconnect': ['cause'],
  'voice.cost-reconciled': ['chargedMicro', 'costEstimated', 'closureConfirmed', 'reconciliationAgeMs'],
  'voice.reconciliation-retry': ['code', 'cause', 'reconciliationAgeMs'],
});
const causes = new Set([...PLUGIN_ERROR_CODES, 'duplicate-callback', 'replay', 'session-changed', 'server-restart', 'transport-lost',
  'recovery-failed', 'browser-liveness-deadline', 'server-stopping', 'tab-takeover', 'sleep']);
const digest = value => createHash('sha256').update(value).digest('hex');
const opaque = (domain, values) => digest(JSON.stringify([domain, ...values]));
const number = value => Number.isFinite(value) && value >= 0 && value <= Number.MAX_SAFE_INTEGER ? Math.round(value) : undefined;

/** IDs refer to server-owned identities, never utterance text or callback metadata.
 * turnHash uses the first random operation attempt, so retries retain correlation
 * without exposing the content-derived operation key. Hashes survive restarts.
 * Times are milliseconds; reconciliation age begins at segment end (start if open).
 */
export function createVoiceDiagnostics({ log } = {}) {
  return (event, identity, fields = {}) => {
    if (!log || !Object.hasOwn(stages, event)) return;
    try {
      const { callId, providerSessionId, fence, attempts } = identity;
      if (typeof callId !== 'string' || !callId) return;
      const record = { event, callHash: digest(callId) };
      if (typeof providerSessionId === 'string' && providerSessionId) {
        record.generationHash = opaque('voice-generation', [callId, providerSessionId]);
        // Retain the existing reconciliation diagnostic's providerHash contract.
        if (event === 'voice.cost-reconciled' || event === 'voice.reconciliation-retry') record.providerHash = digest(providerSessionId);
      }
      if (typeof attempts?.[0]?.id === 'string') record.turnHash = opaque('voice-turn', [callId, providerSessionId, attempts[0].id]);
      if (typeof fence === 'string') record.attemptHash = opaque('voice-attempt', [fence]);
      for (const key of stages[event]) {
        const value = fields[key];
        if (key.endsWith('Ms') || key === 'chargedMicro') {
          const safe = number(value); if (safe !== undefined) record[key] = safe;
        } else if (key === 'cause' || key === 'code') {
          if (value !== undefined) record[key] = causes.has(value) ? value : 'provider';
        } else if (key === 'outcome') {
          if (['completed', 'failed'].includes(value)) record[key] = value;
        } else if (typeof value === 'boolean') record[key] = value;
      }
      const legacy = event === 'voice.cost-reconciled' || event === 'voice.reconciliation-retry';
      Promise.resolve(log(legacy ? record : JSON.stringify(record))).catch(() => {});
    } catch { /* Diagnostics cannot change admission, publication or settlement. */ }
  };
}

export const voiceReconciliationAge = (record, now) => Math.max(0, now - (record.endedAt ?? record.startedAt ?? now));
