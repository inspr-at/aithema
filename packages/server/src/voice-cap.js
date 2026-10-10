import { PluginError } from '@inspr/aithema-core';

export const VOICE_CAP_REASON = 'Voice minute cap reached for this deployment';
export const VOICE_DAY_CAP_REASON = 'Voice minute cap reached for this UTC day';
export const VOICE_CAP_REASONS = new Set([VOICE_CAP_REASON, VOICE_DAY_CAP_REASON]);
const amount = n => Number.isSafeInteger(n) && n >= 0;
const identifier = value => typeof value === 'string' && /^[a-zA-Z0-9_-]{1,128}$/u.test(value);

export function voiceCapConfig(values = {}) {
  const minutes = key => {
    const value = values[key];
    if (value === undefined) return undefined;
    if (typeof value !== 'string' || !/^\d+(?:\.\d{1,6})?$/u.test(value)) throw new TypeError(`${key} must be nonnegative decimal minutes`);
    const [whole, fraction = ''] = value.split('.');
    // Exact decimal conversion; sub-millisecond headroom is rounded down.
    const milliseconds = Number((BigInt(whole) * 1_000_000n + BigInt(fraction.padEnd(6, '0'))) * 60_000n / 1_000_000n);
    if (!amount(milliseconds)) throw new TypeError(`${key} exceeds the supported duration`);
    return milliseconds;
  };
  return { capMilliseconds: minutes('AITHEMA_VOICE_CAP_MINUTES'), perDayMilliseconds: minutes('AITHEMA_VOICE_CAP_MINUTES_PER_DAY') };
}

/** Deployment-wide duration holds, independent of provider pricing and visitor pauses.
 * Each provider attempt extends the same logical call by its remaining maximum.
 * UTC-day accounting follows admission; unreconciled attempts never expire.
 */
export function createVoiceCap({ storage, capMilliseconds, perDayMilliseconds, now = Date.now } = {}) {
  if (!storage?.db || typeof storage.transaction !== 'function' || typeof now !== 'function' ||
    [capMilliseconds, perDayMilliseconds].some(n => n !== undefined && !amount(n))) throw new TypeError('Invalid voice cap');
  const db = storage.db;
  db.exec(`CREATE TABLE IF NOT EXISTS voice_cap_reservations (
    attempt_id TEXT PRIMARY KEY, session_id TEXT NOT NULL, call_id TEXT NOT NULL, day TEXT NOT NULL,
    reserved_ms INTEGER NOT NULL CHECK(reserved_ms >= 0), actual_ms INTEGER CHECK(actual_ms >= 0));
    CREATE INDEX IF NOT EXISTS voice_cap_day ON voice_cap_reservations(day);
    CREATE INDEX IF NOT EXISTS voice_cap_call ON voice_cap_reservations(session_id,call_id);`);
  const day = () => new Date(now()).toISOString().slice(0, 10);
  const totals = date => db.prepare(`SELECT COALESCE(SUM(actual_ms),0) AS spentMilliseconds,
    COALESCE(SUM(CASE WHEN actual_ms IS NULL THEN reserved_ms ELSE 0 END),0) AS reservedMilliseconds
    FROM voice_cap_reservations WHERE (? IS NULL OR day=?)`).get(date ?? null, date ?? null);
  const snapshot = (date = day()) => ({ ...totals(), capMilliseconds, day: date,
    perDay: { ...totals(date), capMilliseconds: perDayMilliseconds } });
  const reason = (maxMilliseconds, date = day()) => {
    if (!amount(maxMilliseconds)) throw new TypeError('Invalid voice duration ceiling');
    const total = snapshot(date), daily = total.perDay;
    const exceeds = (used, cap) => cap !== undefined && (!amount(used.spentMilliseconds) || !amount(used.reservedMilliseconds) ||
      maxMilliseconds > cap - used.spentMilliseconds - used.reservedMilliseconds);
    if (exceeds(total, capMilliseconds)) return VOICE_CAP_REASON;
    if (exceeds(daily, perDayMilliseconds)) return VOICE_DAY_CAP_REASON;
    return null;
  };
  return { snapshot, reason,
    reserve({ attemptId, sessionId, callId, maxMilliseconds }) {
      if (![attemptId, sessionId, callId].every(identifier) || !amount(maxMilliseconds)) throw new TypeError('Invalid voice reservation');
      return storage.transaction(() => {
        const existing = db.prepare('SELECT * FROM voice_cap_reservations WHERE attempt_id=?').get(attemptId);
        if (existing) {
          if (existing.session_id !== sessionId || existing.call_id !== callId || existing.reserved_ms !== maxMilliseconds) throw new Error('Voice reservation identity reused');
        } else {
          const date = day(), denied = reason(maxMilliseconds, date);
          if (denied) throw new PluginError('not-admitted', denied);
          db.prepare('INSERT INTO voice_cap_reservations(attempt_id,session_id,call_id,day,reserved_ms) VALUES (?,?,?,?,?)')
            .run(attemptId, sessionId, callId, date, maxMilliseconds);
        }
        return Object.freeze({ attemptId });
      });
    },
    settle({ attemptId }, providerSeconds) {
      const actualMilliseconds = Math.ceil(providerSeconds * 1000);
      if (typeof providerSeconds !== 'number' || providerSeconds < 0 || !amount(actualMilliseconds)) throw new TypeError('Invalid confirmed voice duration');
      return storage.transaction(() => {
        const row = db.prepare('SELECT actual_ms FROM voice_cap_reservations WHERE attempt_id=?').get(attemptId);
        if (!row) throw new Error('Voice reservation missing');
        if (row.actual_ms !== null && row.actual_ms !== actualMilliseconds) throw new Error('Voice reservation already settled');
        // Record real duration even above the ceiling. Unknown reports never call settle.
        db.prepare('UPDATE voice_cap_reservations SET actual_ms=? WHERE attempt_id=? AND actual_ms IS NULL').run(actualMilliseconds, attemptId);
      });
    },
    recover() {
      // Only a durable, confirmed terminal releases a hold, including pre-dispatch zeroes.
      // A crash between the budget report and this ledger update is safe to replay.
      for (const row of db.prepare(`SELECT v.attempt_id, b.terminal_json FROM voice_cap_reservations v
        JOIN budget_attempts b ON b.attempt_id=v.attempt_id WHERE v.actual_ms IS NULL AND b.state='settled'`).all()) {
        const terminal = JSON.parse(row.terminal_json);
        if (terminal.closureConfirmed === true && terminal.outcome !== 'uncertain') this.settle({ attemptId: row.attempt_id }, terminal.usage.providerSeconds);
      }
    },
  };
}
