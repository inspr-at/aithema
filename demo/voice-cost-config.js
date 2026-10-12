import { usdMicro } from '../packages/server/src/spend-cap.js';

/** Non-secret prices and technical bounds. No plan-specific credit price is guessed. */
export function voiceCostConfig(values = {}) {
  const seconds = (name, fallback) => {
    const raw = values[name];
    const value = raw === undefined ? fallback : /^\d+$/u.test(raw) ? Number(raw) : NaN;
    if (!Number.isSafeInteger(value) || value < 1 || value > 86400) throw new TypeError(`${name} must be positive seconds, at most 86400`);
    return value;
  };
  const maxDurationSeconds = seconds('AITHEMA_VOICE_MAX_DURATION_SECONDS', 3600);
  const reservationSeconds = seconds('AITHEMA_VOICE_RESERVATION_SECONDS', 30);
  if (reservationSeconds > maxDurationSeconds) throw new TypeError('Voice reservation must fit the technical duration');
  const upstreamMicroPerMinute = usdMicro(values.AITHEMA_VOICE_USD_PER_MINUTE ?? '0.10');
  const raw = values.AITHEMA_ELEVENLABS_USD_PER_CREDIT;
  const usdPerCredit = raw === undefined ? undefined : Number(raw);
  if (raw !== undefined && (typeof raw !== 'string' || !/^\d+(?:\.\d+)?$/u.test(raw) || !Number.isFinite(usdPerCredit) || usdPerCredit < 0)) {
    throw new TypeError('AITHEMA_ELEVENLABS_USD_PER_CREDIT must be a nonnegative decimal USD rate');
  }
  return { maxDurationSeconds, reservationSeconds, upstreamMicroPerMinute, ...(usdPerCredit === undefined ? {} : { usdPerCredit }) };
}
