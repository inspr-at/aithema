import { randomUUID } from 'node:crypto';
import { PluginError } from '@inspr/aithema-core';
import { createSpendCapSettings } from './spend-cap-settings.js';

const amount = n => Number.isSafeInteger(n) && n >= 0;
export function usdMicro(value) {
  if (typeof value !== 'string' || !/^\d+(?:\.\d{1,6})?$/u.test(value)) throw new TypeError('Invalid USD amount');
  const [whole, fraction = ''] = value.split('.');
  const micro = Number(whole) * 1_000_000 + Number(fraction.padEnd(6, '0'));
  if (!amount(micro)) throw new TypeError('Invalid USD amount');
  return micro;
}

/** Port: reserve(ceilingMicro) -> handle, settle(handle, actualMicro), snapshot().
 * Shared across plugins/sessions. Unsettled holds and ceiling breaches survive death.
 */
export function createSpendCap({ storage, account, capMicro } = {}) {
  if (!storage?.db || !storage.transaction || typeof account !== 'string' || !account || !amount(capMicro)) throw new TypeError('Invalid spend cap');
  const db = storage.db;
  db.exec(`CREATE TABLE IF NOT EXISTS spend_reservations (
    id TEXT PRIMARY KEY, account TEXT NOT NULL, reserved_micro INTEGER NOT NULL CHECK(reserved_micro > 0),
    actual_micro INTEGER CHECK(actual_micro >= 0), ceiling_micro INTEGER CHECK(ceiling_micro >= 0));
    CREATE INDEX IF NOT EXISTS spend_account ON spend_reservations(account);`);
  if (!db.prepare('PRAGMA table_info(spend_reservations)').all().some(column => column.name === 'ceiling_micro')) {
    db.exec('ALTER TABLE spend_reservations ADD COLUMN ceiling_micro INTEGER CHECK(ceiling_micro >= 0)');
  }
  const columns = db.prepare('PRAGMA table_info(spend_reservations)').all();
  for (const [name, type] of [['state', "TEXT NOT NULL DEFAULT 'uncertain'"], ['attempt_id', 'TEXT'],
    ['provider', 'TEXT'], ['generation_id', 'TEXT'], ['observed_micro', 'INTEGER']]) {
    if (!columns.some(c => c.name === name)) db.exec(`ALTER TABLE spend_reservations ADD COLUMN ${name} ${type}`);
  }
  db.prepare("UPDATE spend_reservations SET state='confirmed' WHERE actual_micro IS NOT NULL").run();
  db.exec('CREATE UNIQUE INDEX IF NOT EXISTS spend_attempt ON spend_reservations(account,attempt_id) WHERE attempt_id IS NOT NULL');
  const totals = () => {
    const row = db.prepare(`SELECT COALESCE(SUM(actual_micro),0) AS spentMicro,
      COALESCE(SUM(CASE WHEN actual_micro IS NULL AND state!='uncertain' THEN reserved_micro ELSE 0 END),0) AS reservedMicro,
      COALESCE(SUM(CASE WHEN actual_micro IS NULL AND state='uncertain' THEN reserved_micro ELSE 0 END),0) AS uncertainMicro
      FROM spend_reservations WHERE account=?`).get(account);
    const retired = db.prepare('SELECT * FROM retired_spend WHERE account=?').get(account);
    if (retired) { row.spentMicro += retired.spent_micro; row.reservedMicro += retired.reserved_micro; row.uncertainMicro += retired.uncertain_micro; }
    if (!Object.values(row).every(amount)) throw new PluginError('not-admitted', 'OpenRouter spend cap exhausted');
    return row;
  };
  const policy = createSpendCapSettings({ storage, account, configuredCapMicro: capMicro, totals });
  const snapshot = ({ includeBreachReason = false } = {}) => {
    const row = totals(), capMicro = policy.capMicro();
    const overrun = db.prepare('SELECT 1 FROM spend_reservations WHERE account=? AND actual_micro > COALESCE(ceiling_micro,reserved_micro) LIMIT 1').get(account) || db.prepare('SELECT 1 FROM retired_spend WHERE account=? AND breached=1').get(account);
    return { ...row, capMicro, breached: Boolean(overrun) || row.spentMicro > capMicro,
      ...(includeBreachReason ? { breachReason: overrun ? 'overrun' : row.spentMicro > capMicro ? 'over-cap' : null } : {}) };
  };
  return { snapshot, settings: policy.settings, saveSettings: policy.saveSettings, resetSettings: policy.resetSettings, audit: policy.audit,
    reserve(ceilingMicro, { attemptId, provider } = {}) {
      if (!amount(ceilingMicro)) throw new TypeError('Invalid spend ceiling');
      // A one-microdollar floor also supports explicitly free model prices.
      const reservedMicro = Math.max(1, ceilingMicro);
      return storage.transaction(() => {
        const { spentMicro, reservedMicro: held, uncertainMicro, breached, capMicro } = snapshot();
        if (breached || reservedMicro > capMicro - spentMicro - held - uncertainMicro) throw new PluginError('not-admitted', 'OpenRouter spend cap exhausted');
        const id = randomUUID();
        db.prepare("INSERT INTO spend_reservations(id,account,reserved_micro,ceiling_micro,attempt_id,provider,state) VALUES (?,?,?,?,?,?,'reserved')")
          .run(id, account, reservedMicro, ceilingMicro, attemptId ?? null, provider ?? null);
        return Object.freeze({ id });
      });
    },
    settle(handle, actualMicro) {
      if (!amount(actualMicro)) throw new TypeError('Invalid actual spend');
      return storage.transaction(() => {
        const row = db.prepare('SELECT actual_micro FROM spend_reservations WHERE id=? AND account=?').get(handle?.id ?? '', account);
        if (!row) throw new Error('Spend reservation missing');
        if (row.actual_micro !== null && row.actual_micro !== actualMicro) throw new Error('Spend already settled');
        // Record the real charge even above the hold/cap; snapshot latches the breach.
        db.prepare("UPDATE spend_reservations SET actual_micro=?,state='confirmed' WHERE id=? AND actual_micro IS NULL").run(actualMicro, handle.id);
      });
    },
    dispatch(handle) {
      db.prepare("UPDATE spend_reservations SET state='dispatched' WHERE id=? AND account=? AND state='reserved'").run(handle.id, account);
    },
    record(handle, { generationId, chargedMicro }) {
      if (chargedMicro !== undefined && !amount(chargedMicro)) throw new TypeError('Invalid observed cost');
      return storage.transaction(() => {
        const row = db.prepare('SELECT * FROM spend_reservations WHERE id=? AND account=?').get(handle.id, account);
        if (!row) throw new Error('Spend reservation missing');
        if (row.generation_id && generationId && row.generation_id !== generationId ||
          row.actual_micro !== null && chargedMicro !== undefined && row.actual_micro !== chargedMicro) throw new Error('Spend receipt conflict');
        db.prepare('UPDATE spend_reservations SET generation_id=COALESCE(?,generation_id),observed_micro=COALESCE(?,observed_micro) WHERE id=?')
          .run(generationId ?? null, chargedMicro ?? null, handle.id);
      });
    },
    uncertain(handle) {
      db.prepare("UPDATE spend_reservations SET state='uncertain' WHERE id=? AND account=? AND actual_micro IS NULL").run(handle.id, account);
    },
    reconcileAttempt(attemptId, actualMicro) {
      const row = db.prepare('SELECT id FROM spend_reservations WHERE account=? AND attempt_id=?').get(account, attemptId);
      if (row) this.settle(row, actualMicro);
    },
    evidence(attemptId) {
      const row = db.prepare('SELECT * FROM spend_reservations WHERE account=? AND attempt_id=?').get(account, attemptId);
      if (!row) return null;
      return { ...(row.generation_id ? { generationId: row.generation_id } : {}),
        ...(row.actual_micro !== null || row.observed_micro !== null ? { chargedMicro: row.actual_micro ?? row.observed_micro } : {}) };
    },
    recover() {
      // Called once by the exclusive writer on startup, never during active work.
      for (const row of db.prepare('SELECT * FROM spend_reservations WHERE account=? AND actual_micro IS NULL').all(account)) {
        if (row.observed_micro !== null) this.settle(row, row.observed_micro);
        else if (row.state === 'reserved') this.settle(row, 0);
        else this.uncertain(row);
      }
    },
  };
}
