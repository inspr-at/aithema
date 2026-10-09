import { PluginError } from '@inspr/aithema-core';

export const UI_RENDER_SESSION_REASON = 'UI render limit reached for this session';
export const UI_RENDER_DAY_REASON = 'UI render limit reached for this UTC day';
export function uiRenderLimitConfig(values = {}) {
  const integer = (key, fallback) => {
    const value = values[key] ?? String(fallback);
    if (!/^\d+$/u.test(value) || !Number.isSafeInteger(Number(value))) throw new TypeError(`${key} must be a nonnegative integer`);
    return Number(value);
  };
  return { perSession: integer('AITHEMA_UI_RENDERS_PER_SESSION', 20), perDay: integer('AITHEMA_UI_RENDERS_PER_DAY', 200) };
}
/** All visual kinds share durable lifetime-session and deployment UTC-day counts.
 * Count at claim consumption, conservatively retaining failed/crashed attempts.
 * Checking and recording with the dispatch claim is one SQLite transaction.
 */
export function createUIRenderLimiter({ storage, perSession = 20, perDay = 200, now = Date.now }) {
  if (![perSession, perDay].every(n => Number.isSafeInteger(n) && n >= 0)) throw new TypeError('Invalid UI render limits');
  const db = storage.db;
  db.exec(`CREATE TABLE IF NOT EXISTS ui_render_claims (attempt_id TEXT PRIMARY KEY,
    session_id TEXT NOT NULL REFERENCES sessions(id), day TEXT NOT NULL);
    CREATE INDEX IF NOT EXISTS ui_render_session ON ui_render_claims(session_id);
    CREATE INDEX IF NOT EXISTS ui_render_day ON ui_render_claims(day);`);
  const day = () => new Date(now()).toISOString().slice(0, 10);
  const reason = (sessionId, date = day()) => {
    if (db.prepare('SELECT COUNT(*) AS n FROM ui_render_claims WHERE session_id=?').get(sessionId).n >= perSession) return UI_RENDER_SESSION_REASON;
    if (db.prepare('SELECT COUNT(*) AS n FROM ui_render_claims WHERE day=?').get(date).n >= perDay) return UI_RENDER_DAY_REASON;
    return null;
  };
  return { reason,
    consume(attemptId, sessionId, dispatch) {
      return storage.transaction(() => {
        const date = day(), denied = reason(sessionId, date);
        if (denied) throw new PluginError('rate-limit', denied);
        db.prepare('INSERT INTO ui_render_claims VALUES (?,?,?)').run(attemptId, sessionId, date);
        return dispatch();
      });
    },
  };
}
