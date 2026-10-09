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

/** Shared account counter, independent of plugin/session. Unsettled holds survive death. */
export function createSpendCap({ storage, account, capMicro } = {}) {
  if (!storage?.db || !storage.transaction || typeof account !== 'string' || !account || !amount(capMicro)) throw new TypeError('Invalid spend cap');
  const db = storage.db;
  db.exec(`CREATE TABLE IF NOT EXISTS spend_reservations (
    id TEXT PRIMARY KEY, account TEXT NOT NULL, reserved_micro INTEGER NOT NULL CHECK(reserved_micro > 0),
    actual_micro INTEGER CHECK(actual_micro >= 0));
    CREATE INDEX IF NOT EXISTS spend_account ON spend_reservations(account);`);
  const totals = () => {
    const row = db.prepare(`SELECT COALESCE(SUM(actual_micro),0) AS spentMicro,
      COALESCE(SUM(CASE WHEN actual_micro IS NULL THEN reserved_micro ELSE 0 END),0) AS reservedMicro
      FROM spend_reservations WHERE account=?`).get(account);
    return { ...row, capMicro };
  };
  return { totals,
    reserve(reservedMicro) {
      if (!amount(reservedMicro) || !reservedMicro) throw new TypeError('Positive spend reservation required');
      return storage.transaction(() => {
        const { spentMicro, reservedMicro: held } = totals();
        if (reservedMicro > capMicro - spentMicro - held) throw new PluginError('not-admitted', 'OpenRouter spend cap exhausted');
        const id = randomUUID();
        db.prepare('INSERT INTO spend_reservations VALUES (?,?,?,NULL)').run(id, account, reservedMicro);
        return { settle(actualMicro) {
          if (!amount(actualMicro)) throw new TypeError('Invalid actual spend');
          return storage.transaction(() => {
            const row = db.prepare('SELECT actual_micro FROM spend_reservations WHERE id=? AND account=?').get(id, account);
            if (!row) throw new Error('Spend reservation missing');
            if (row.actual_micro !== null && row.actual_micro !== actualMicro) throw new Error('Spend already settled');
            db.prepare('UPDATE spend_reservations SET actual_micro=? WHERE id=? AND actual_micro IS NULL').run(actualMicro, id);
          });
        } };
      });
    },
  };
}
