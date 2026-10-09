import { mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import { PluginError } from '@inspr/aithema-core';
export const DEFAULT_CAP_MICRO = 10_000_000; // USD 10 in micro-dollars
/** OpenRouter reports usage.cost in USD credits; round up to whole micro-dollars. */
export function costMicro(cost) {
  return typeof cost === 'number' && Number.isFinite(cost) && cost >= 0 ? Math.ceil(Math.round(cost * 1e9) / 1000) : null;
}
/**
 * Persistent per-deployment spend counter, one writer process per file.
 * Reservations are written before dispatch, so a crash leaves them counted as
 * spent (uncertain at the claim maximum). Synchronous read-check-write keeps
 * concurrent operations in this process from overcommitting the cap.
 */
export function createSpendLedger({ path }) {
  if (typeof path !== 'string' || !path) throw new TypeError('Spend ledger requires a file path');
  const read = () => {
    let raw;
    try { raw = readFileSync(path, 'utf8'); } catch (error) {
      if (error.code === 'ENOENT') return { version: 1, spentMicro: 0, reservations: {} };
      throw new PluginError('unavailable', 'Spend ledger unreadable');
    }
    try {
      const state = JSON.parse(raw);
      if (state?.version !== 1 || !Number.isSafeInteger(state.spentMicro) || state.spentMicro < 0 || !state.reservations ||
        typeof state.reservations !== 'object' || Object.values(state.reservations).some(v => !Number.isSafeInteger(v) || v < 0)) throw new Error();
      return state;
    } catch { throw new PluginError('unavailable', 'Spend ledger unreadable'); }
  };
  const write = state => {
    mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
    const temporary = `${path}.${process.pid}.tmp`;
    writeFileSync(temporary, `${JSON.stringify(state)}\n`, { mode: 0o600 }); renameSync(temporary, path);
  };
  const committed = state => state.spentMicro + Object.values(state.reservations).reduce((sum, v) => sum + v, 0);
  return {
    path,
    /** Spent plus open reservations; throws `unavailable` when the file is unreadable. */
    totalMicro: () => committed(read()),
    reserve(micro, capMicro) {
      if (!Number.isSafeInteger(micro) || micro < 1 || !Number.isSafeInteger(capMicro) || capMicro < 0) throw new TypeError('Invalid reservation');
      const state = read();
      if (committed(state) + micro > capMicro) throw new PluginError('limit', 'Spend cap reached');
      const id = crypto.randomUUID(); state.reservations[id] = micro; write(state); return id;
    },
    settle(id, micro) {
      const state = read();
      if (!Object.hasOwn(state.reservations, id)) return;
      delete state.reservations[id]; state.spentMicro += micro; write(state);
    },
  };
}
