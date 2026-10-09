import { closeSync, existsSync, fsyncSync, mkdirSync, openSync, readFileSync, renameSync, unlinkSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import { PluginError } from '@inspr/aithema-core';
export const DEFAULT_CAP_MICRO = 10_000_000; // USD 10 in micro-dollars
// Decimal arithmetic rounds upward without losing small fractions to binary floats.
function decimal(value) {
  const [digits, exponent = '0'] = String(value).split('e'), [whole, fraction = ''] = digits.split('.');
  const scale = fraction.length - Number(exponent);
  return { numerator: BigInt(whole + fraction) * 10n ** BigInt(Math.max(0, -scale)), denominator: 10n ** BigInt(Math.max(0, scale)) };
}
const roundedMicro = (value, tokens = 1) => {
  const { numerator, denominator } = decimal(value), scaled = numerator * BigInt(tokens) * 1_000_000n;
  const result = Number((scaled + denominator - 1n) / denominator);
  return Number.isSafeInteger(result) ? result : null;
};
/** OpenRouter reports usage.cost in USD credits; round up to whole micro-dollars. */
export function costMicro(cost) {
  return typeof cost === 'number' && Number.isFinite(cost) && cost >= 0 ? roundedMicro(cost) : null;
}
/** All serialized message bytes, at most one input token per byte, plus capped output. */
export function callCeilingMicro(messages, binding) {
  const input = roundedMicro(binding.rates.inputUSD, Buffer.byteLength(JSON.stringify(messages), 'utf8'));
  const output = roundedMicro(binding.rates.outputUSD, binding.maxTokens), ceiling = input + output;
  if (input === null || output === null || !Number.isSafeInteger(ceiling) || ceiling < 1) throw new PluginError('limit');
  return ceiling;
}
/**
 * Default spend port: reserve(ceilingMicro) → handle, settle(handle, actualMicro),
 * snapshot() → {spentMicro, reservedMicro, totalMicro, costCeilingBreached}.
 * Every transaction takes an exclusive process lock. Crashed reservations stay
 * counted; only a lock whose owner PID is provably dead may be recovered.
 */
export function createSpendLedger({ path, capMicro = DEFAULT_CAP_MICRO }) {
  if (typeof path !== 'string' || !path) throw new TypeError('Spend ledger requires a file path');
  if (!Number.isSafeInteger(capMicro) || capMicro < 0) throw new TypeError('Invalid spend cap');
  const lockPath = `${path}.lock`, recoveryPath = `${lockPath}.recovery`;
  const unavailable = () => new PluginError('unavailable', 'Spend ledger unreadable or locked');
  const deadOwner = file => {
    const pid = JSON.parse(readFileSync(file, 'utf8')).pid;
    if (!Number.isSafeInteger(pid) || pid < 1) throw unavailable();
    try { process.kill(pid, 0); return false; } catch (error) { return error.code === 'ESRCH'; }
  };
  const exclusive = file => {
    const fd = openSync(file, 'wx', 0o600);
    try { writeFileSync(fd, `${JSON.stringify({ pid: process.pid })}\n`); fsyncSync(fd); }
    finally { closeSync(fd); }
  };
  const acquire = () => {
    mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
    // A separate exclusive guard prevents competing stale-lock recoveries from
    // deleting a fresh owner's lock. A malformed/abandoned recovery fails closed.
    if (existsSync(recoveryPath)) throw unavailable();
    try { exclusive(lockPath); }
    catch (error) {
      if (error.code !== 'EEXIST' || !deadOwner(lockPath)) throw unavailable();
      exclusive(recoveryPath);
      try {
        if (!deadOwner(lockPath)) throw unavailable();
        unlinkSync(lockPath); exclusive(lockPath);
      } finally { unlinkSync(recoveryPath); }
      return;
    }
    if (existsSync(recoveryPath)) { unlinkSync(lockPath); throw unavailable(); }
  };
  const locked = work => {
    try { acquire(); } catch { throw unavailable(); }
    try { return work(); } catch (error) { throw error instanceof PluginError ? error : unavailable(); }
    finally { unlinkSync(lockPath); }
  };
  const read = () => {
    let raw;
    try { raw = readFileSync(path, 'utf8'); } catch (error) {
      if (error.code === 'ENOENT') return { version: 1, spentMicro: 0, reservations: {}, costCeilingBreached: false };
      throw unavailable();
    }
    try {
      const state = JSON.parse(raw);
      if (state?.version !== 1 || !Number.isSafeInteger(state.spentMicro) || state.spentMicro < 0 || !state.reservations ||
        typeof state.reservations !== 'object' || Array.isArray(state.reservations) ||
        Object.values(state.reservations).some(v => !Number.isSafeInteger(v) || v < 1) ||
        state.costCeilingBreached !== undefined && typeof state.costCeilingBreached !== 'boolean') throw new Error();
      return state;
    } catch { throw unavailable(); }
  };
  const write = state => {
    const temporary = `${path}.${process.pid}.tmp`, fd = openSync(temporary, 'w', 0o600);
    try {
      writeFileSync(fd, `${JSON.stringify(state)}\n`); fsyncSync(fd);
      renameSync(temporary, path); fsyncSync(fd); // synchronize the committed inode after rename, too
    } finally { closeSync(fd); }
    const directory = openSync(dirname(path), 'r');
    try { fsyncSync(directory); } finally { closeSync(directory); }
  };
  const snapshot = state => {
    const reservedMicro = Object.values(state.reservations).reduce((sum, v) => sum + v, 0), totalMicro = state.spentMicro + reservedMicro;
    if (!Number.isSafeInteger(totalMicro)) throw unavailable();
    return { spentMicro: state.spentMicro, reservedMicro, totalMicro, costCeilingBreached: state.costCeilingBreached ?? false };
  };
  return {
    path,
    snapshot: () => locked(() => snapshot(read())),
    reserve(micro) {
      if (!Number.isSafeInteger(micro) || micro < 1) throw new TypeError('Invalid reservation');
      return locked(() => {
        const state = read(), current = snapshot(state);
        if (current.costCeilingBreached || micro > capMicro - current.totalMicro) throw new PluginError('limit', 'Spend cap reached');
        const id = crypto.randomUUID(); state.reservations[id] = micro; write(state); return id;
      });
    },
    settle(id, micro) {
      if (!Number.isSafeInteger(micro) || micro < 0) throw new TypeError('Invalid settlement');
      return locked(() => {
        const state = read();
        if (!Object.hasOwn(state.reservations, id)) return;
        if (micro > state.reservations[id]) state.costCeilingBreached = true;
        if (!Number.isSafeInteger(state.spentMicro + micro)) throw unavailable();
        delete state.reservations[id]; state.spentMicro += micro; write(state);
      });
    },
  };
}
