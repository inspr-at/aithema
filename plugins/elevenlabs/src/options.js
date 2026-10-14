import { assertVoiceMediaGrant, unavailableVoiceCommand } from '../../../packages/core/src/live-voice.js';
import { PluginError } from '../../../packages/core/src/invocation.js';

import { AI_NOTICE, aiNoticeText } from '../../../packages/core/src/ai-notice.js';

// Only language and the matching opening AI notice or silent continuation cross this boundary.
export function voiceOverrides(value) {
  if (value === undefined) return undefined;
  if (!value || typeof value !== 'object' || Array.isArray(value) || Object.keys(value).some(key => key !== 'agent') ||
    !value.agent || typeof value.agent !== 'object' || Array.isArray(value.agent) ||
    Object.keys(value.agent).some(key => !['language', 'firstMessage'].includes(key)) ||
    value.agent.language !== undefined && (typeof value.agent.language !== 'string' ||
      !/^[a-z]{2,3}(?:-[A-Za-z]{2,4})?$/u.test(value.agent.language))) throw new TypeError('Invalid voice presentation overrides');
  if (value.agent.firstMessage !== undefined && (!Object.hasOwn(AI_NOTICE, value.agent.language ?? '') ||
    !['', aiNoticeText(value.agent.language)].includes(value.agent.firstMessage))) throw new TypeError('Invalid voice AI notice');
  return structuredClone(value);
}

/** Only the browser adapter interprets opaque. No account key belongs here. */
export function elevenLabsMediaGrant(receipt, now = Date.now()) {
  if (!receipt?.credential || !Number.isFinite(receipt.credential.ttlMs) || receipt.credential.ttlMs <= 0 || receipt.credential.ttlMs > 60_000) throw new PluginError('invalid-output', 'Invalid ElevenLabs media grant TTL');
  const expiresAt = Math.min(now + receipt.credential.ttlMs, receipt.spendDeadlineAt, receipt.browserLivenessDeadlineAt);
  return Object.freeze(assertVoiceMediaGrant({ callId: receipt.callId, providerSessionId: receipt.providerSessionId, expiresAt,
    opaque: structuredClone(receipt) }, now));
}

export function createElevenLabsBrowserMedia(createClient) {
  return Object.freeze({
    async connect(grant, options) {
      assertVoiceMediaGrant(grant);
      const receipt = structuredClone(grant.opaque);
      if (receipt?.callId !== grant.callId || receipt.providerSessionId !== grant.providerSessionId || !receipt.credential) throw new PluginError('invalid-output', 'Invalid ElevenLabs media grant');
      receipt.credential.ttlMs = Math.min(receipt.credential.ttlMs, grant.expiresAt - Date.now());
      return createClient(receipt).start({ callId: grant.callId }, options);
    },
    capture: (session, on, options) => session.setInput(on, options),
    playback: (session, on, options) => session.setOutput(on, options),
    teardown: (session, options) => session.close(options),
    retryPlayback: (session, options) => session.retryPlayback(options),
  });
}

// Agent-platform STT/TTS are provider-owned, not independently callable kits.
// Expose honest coded unavailable ports rather than synthesize component usage.
export const elevenLabsComponents = Object.freeze({
  stt: Object.freeze({ transcribe: unavailableVoiceCommand('transcribe'), negotiateAudioFormat: unavailableVoiceCommand('negotiateAudioFormat') }),
  tts: Object.freeze({ async *speak() { throw new PluginError('unavailable', 'Live voice speak is unavailable'); },
    negotiateAudioFormat: unavailableVoiceCommand('negotiateAudioFormat') }),
});
