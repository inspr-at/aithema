import { randomUUID } from 'node:crypto';
import { PluginError } from '@inspr/aithema-core';

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
  const snapshot = () => {
    const row = db.prepare(`SELECT COALESCE(SUM(actual_micro),0) AS spentMicro,
      COALESCE(SUM(CASE WHEN actual_micro IS NULL THEN reserved_micro ELSE 0 END),0) AS reservedMicro
      FROM spend_reservations WHERE account=?`).get(account);
    if (!amount(row.spentMicro) || !amount(row.reservedMicro)) throw new PluginError('not-admitted', 'OpenRouter spend cap exhausted');
    const overrun = db.prepare('SELECT 1 FROM spend_reservations WHERE account=? AND actual_micro > COALESCE(ceiling_micro,reserved_micro) LIMIT 1').get(account);
    return { ...row, capMicro, breached: Boolean(overrun) || row.spentMicro > capMicro };
  };
  return { snapshot,
    reserve(ceilingMicro) {
      if (!amount(ceilingMicro)) throw new TypeError('Invalid spend ceiling');
      // A one-microdollar floor also supports explicitly free model prices.
      const reservedMicro = Math.max(1, ceilingMicro);
      return storage.transaction(() => {
        const { spentMicro, reservedMicro: held, breached } = snapshot();
        if (breached || reservedMicro > capMicro - spentMicro - held) throw new PluginError('not-admitted', 'OpenRouter spend cap exhausted');
        const id = randomUUID();
        db.prepare('INSERT INTO spend_reservations(id,account,reserved_micro,ceiling_micro) VALUES (?,?,?,?)').run(id, account, reservedMicro, ceilingMicro);
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
        db.prepare('UPDATE spend_reservations SET actual_micro=? WHERE id=? AND actual_micro IS NULL').run(actualMicro, handle.id);
      });
    },
  };
}
