import { closeSync, existsSync, fsyncSync, mkdirSync, openSync, readFileSync, renameSync, unlinkSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import { hostname } from 'node:os';
import { PluginError, generationId } from '@inspr/aithema-core';
export const DEFAULT_CAP_MICRO = 10_000_000; // USD 10 in micro-dollars
const PROCESS_INCARNATION = crypto.randomUUID();
const LEASE_TTL_MS = 30_000, LEASE_RENEWAL_MS = 5_000;
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
/** All serialized message bytes, at most one input token per byte, plus maxTokens
 * at the output rate. maxTokens includes reasoning and visible output together;
 * effort never discounts the reservation or silently increases the token limit.
 */
export function callCeilingMicro(messages, binding) {
  const input = roundedMicro(binding.rates.inputUSD, Buffer.byteLength(JSON.stringify(messages), 'utf8'));
  const output = roundedMicro(binding.rates.outputUSD, binding.maxTokens), ceiling = input + output;
  if (input === null || output === null || !Number.isSafeInteger(ceiling) || ceiling < 1) throw new PluginError('limit');
  return ceiling;
}
/**
 * Default spend port: reserve/dispatch/record/uncertain/settle, durable attempt
 * evidence/reconciliation/recovery, and snapshots separating unknown costs.
 * Every transaction takes an exclusive process lock. Active reservations carry
 * a process incarnation and a 30-second lease, renewed every five seconds.
 * Expiry permanently fences that writer's handle; renewal cannot revive it.
 * Recovery waits for expiry even across PID reuse or a different hostname.
 */
export function createSpendLedger({ path, capMicro = DEFAULT_CAP_MICRO, now = Date.now }) {
  if (typeof path !== 'string' || !path) throw new TypeError('Spend ledger requires a file path');
  if (!Number.isSafeInteger(capMicro) || capMicro < 0) throw new TypeError('Invalid spend cap');
  if (typeof now !== 'function') throw new TypeError('Invalid spend clock');
  const lockPath = `${path}.lock`, recoveryPath = `${lockPath}.recovery`;
  const normalized = Symbol('normalized ownership metadata');
  const owner = { pid: process.pid, host: hostname(), writerId: crypto.randomUUID(), incarnationId: PROCESS_INCARNATION };
  const unavailable = () => new PluginError('unavailable', 'Spend ledger unreadable or locked');
  const amount = n => Number.isSafeInteger(n) && n >= 0;
  const clock = () => {
    const at = now();
    if (!amount(at) || !amount(at + LEASE_TTL_MS)) throw unavailable();
    return at;
  };
  const object = value => value && typeof value === 'object' && !Array.isArray(value);
  const deadPid = pid => {
    if (!Number.isSafeInteger(pid) || pid < 1) throw unavailable();
    try { process.kill(pid, 0); return false; } catch (error) { return error.code === 'ESRCH'; }
  };
  const deadOwner = file => deadPid(JSON.parse(readFileSync(file, 'utf8')).pid);
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
      if (error.code === 'ENOENT') return { version: 2, spentMicro: 0, reservations: {}, operations: {}, costCeilingBreached: false };
      throw unavailable();
    }
    try {
      const state = JSON.parse(raw);
      if (![1, 2].includes(state?.version) || !amount(state.spentMicro) || !object(state.reservations) ||
        Object.values(state.reservations).some(v => !Number.isSafeInteger(v) || v < 1) ||
        state.costCeilingBreached !== undefined && typeof state.costCeilingBreached !== 'boolean') throw new Error();
      if (state.version === 1) {
        // Legacy holds have no dispatch evidence: never recover them as free.
        state.operations = Object.fromEntries(Object.entries(state.reservations)
          .map(([id, ceilingMicro]) => [id, { ceilingMicro, state: 'uncertain' }]));
        state.reservations = {}; state.version = 2;
      }
      if (!object(state.operations)) throw new Error();
      const attempts = new Set();
      for (const [id, row] of Object.entries(state.operations)) {
        // Pre-lease writers spread the current row when finishing, retaining
        // unfamiliar lease fields. Terminal rows have no ownership authority:
        // discard those fields before validation, preserving all cost evidence.
        if (object(row) && ['uncertain', 'confirmed'].includes(row.state) &&
          (Object.hasOwn(row, 'owner') || Object.hasOwn(row, 'leaseExpiresAt'))) {
          delete row.owner; delete row.leaseExpiresAt; state[normalized] = true;
        }
        if (!object(row) || !amount(row.ceilingMicro) || row.ceilingMicro < 1 ||
          !['reserved', 'dispatched', 'uncertain', 'confirmed'].includes(row.state) ||
          row.actualMicro !== undefined && !amount(row.actualMicro) ||
          row.observedMicro !== undefined && !amount(row.observedMicro) ||
          row.generationId !== undefined && !generationId(row.generationId) ||
          row.leaseExpiresAt !== undefined && (!amount(row.leaseExpiresAt) || !['reserved', 'dispatched'].includes(row.state)) ||
          row.owner !== undefined && (!object(row.owner) || !Number.isSafeInteger(row.owner.pid) || row.owner.pid < 1 ||
            typeof row.owner.host !== 'string' || !row.owner.host || row.owner.host.length > 253 ||
            typeof row.owner.writerId !== 'string' || !/^[a-zA-Z0-9_-]{1,128}$/u.test(row.owner.writerId) ||
            row.owner.incarnationId !== undefined && (typeof row.owner.incarnationId !== 'string' ||
              !/^[a-zA-Z0-9_-]{1,128}$/u.test(row.owner.incarnationId) || row.leaseExpiresAt === undefined) ||
            !['reserved', 'dispatched'].includes(row.state)) ||
          (row.state === 'confirmed') !== (row.actualMicro !== undefined)) throw new Error();
        if (row.attemptId !== undefined) {
          if (typeof row.attemptId !== 'string' || !/^[a-zA-Z0-9_-]{1,128}$/u.test(row.attemptId) || attempts.has(row.attemptId)) throw new Error();
          attempts.add(row.attemptId);
        }
        const reserved = ['reserved', 'dispatched'].includes(row.state);
        if (reserved ? state.reservations[id] !== row.ceilingMicro : Object.hasOwn(state.reservations, id)) throw new Error();
      }
      if (Object.keys(state.reservations).some(id => !Object.hasOwn(state.operations, id))) throw new Error();
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
    const reservedMicro = Object.values(state.reservations).reduce((sum, v) => sum + v, 0);
    const uncertainMicro = Object.values(state.operations).reduce((sum, row) => sum + (row.state === 'uncertain' ? row.ceilingMicro : 0), 0);
    const totalMicro = state.spentMicro + reservedMicro + uncertainMicro;
    if (!Number.isSafeInteger(totalMicro)) throw unavailable();
    return { spentMicro: state.spentMicro, reservedMicro, uncertainMicro, totalMicro, costCeilingBreached: state.costCeilingBreached ?? false };
  };
  const settle = (state, id, micro) => {
    const row = Object.hasOwn(state.operations, id) ? state.operations[id] : null;
    if (!row) return;
    if (row.actualMicro !== undefined) {
      if (row.actualMicro !== micro) throw new PluginError('already-claimed', 'Spend already settled');
      return;
    }
    if (micro > row.ceilingMicro) state.costCeilingBreached = true;
    if (!amount(state.spentMicro + micro)) throw unavailable();
    delete state.reservations[id]; state.spentMicro += micro;
    state.operations[id] = { ...row, state: 'confirmed', actualMicro: micro };
    delete state.operations[id].owner;
    delete state.operations[id].leaseExpiresAt;
  };
  const operation = (state, id) => {
    if (!Object.hasOwn(state.operations, id)) throw new PluginError('not-admitted', 'Spend reservation missing');
    return state.operations[id];
  };
  const owns = row => row?.owner?.writerId === owner.writerId && row.owner.incarnationId === owner.incarnationId &&
    row.owner.pid === owner.pid && row.owner.host === owner.host;
  const active = new Set(), lost = new Set();
  let renewal;
  const release = id => {
    active.delete(id);
    if (!active.size && renewal !== undefined) { clearInterval(renewal); renewal = undefined; }
  };
  const leaseLost = () => new PluginError('not-admitted', 'Spend reservation lease lost');
  const lose = id => { if (active.has(id)) { lost.add(id); release(id); } };
  const requireLease = (id, row, at = clock()) => {
    if (lost.has(id) || !owns(row) || !['reserved', 'dispatched'].includes(row.state) ||
      row.leaseExpiresAt === undefined || row.leaseExpiresAt <= at) {
      lose(id); throw leaseLost();
    }
    return at;
  };
  const keepAlive = id => {
    active.add(id);
    if (renewal !== undefined) return;
    renewal = setInterval(() => {
      try {
        locked(() => {
          const state = read(), at = clock(), deadline = at + LEASE_TTL_MS;
          let changed = false;
          for (const id of active) {
            const row = state.operations[id];
            if (!owns(row) || !['reserved', 'dispatched'].includes(row.state) || row.leaseExpiresAt <= at) {
              lose(id);
              console.warn('[aithema/spend] reservation lease lost; dispatch and settlement fenced');
              continue;
            }
            const expiresAt = Math.max(row.leaseExpiresAt, deadline);
            if (expiresAt !== row.leaseExpiresAt) { row.leaseExpiresAt = expiresAt; changed = true; }
          }
          if (changed) write(state);
        });
      } catch (error) {
        // A retry may renew only a still-valid persisted lease. Transaction
        // failures never extend the deadline or silently restore authority.
        console.warn('[aithema/spend] lease renewal failed; persisted deadline still applies', error.code);
      }
    }, LEASE_RENEWAL_MS);
    // A pending reservation must not prevent a crashed/exiting process from ending.
    renewal.unref?.();
  };
  const recover = state => {
    const at = clock(), reclaimed = [];
    let changed = Boolean(state[normalized]);
    for (const [id, row] of Object.entries(state.operations)) {
      if (row.state === 'confirmed') continue;
      if (['reserved', 'dispatched'].includes(row.state)) {
        if (row.leaseExpiresAt === undefined) {
          // Pre-lease journals get one persisted grace period, never another
          // full grace period on each replacement process's startup.
          row.leaseExpiresAt = at + LEASE_TTL_MS; changed = true; continue;
        }
        if (row.leaseExpiresAt > at) continue;
      }
      if (row.observedMicro !== undefined) settle(state, id, row.observedMicro);
      else if (row.state === 'reserved' && row.owner?.incarnationId !== undefined) settle(state, id, 0);
      else {
        if (row.state === 'uncertain') continue;
        // A pre-lease writer cannot be fenced by an expiry check. Its unsent
        // hold therefore stays conservative uncertainty, never confirmed zero.
        row.state = 'uncertain'; delete row.owner; delete row.leaseExpiresAt; delete state.reservations[id];
      }
      reclaimed.push(id); changed = true;
    }
    if (changed) write(state);
    for (const id of reclaimed) lose(id);
    return state;
  };
  return {
    path,
    snapshot: () => locked(() => snapshot(recover(read()))),
    reserve(micro, { attemptId, provider } = {}) {
      if (!Number.isSafeInteger(micro) || micro < 1) throw new TypeError('Invalid reservation');
      if (attemptId !== undefined && (typeof attemptId !== 'string' || !/^[a-zA-Z0-9_-]{1,128}$/u.test(attemptId)) ||
        provider !== undefined && (typeof provider !== 'string' || !/^[a-zA-Z0-9_-]{1,128}$/u.test(provider))) throw new TypeError('Invalid spend identity');
      return locked(() => {
        const state = recover(read()), current = snapshot(state);
        if (current.costCeilingBreached || micro > capMicro - current.totalMicro) throw new PluginError('limit', 'Spend cap reached');
        if (attemptId && Object.values(state.operations).some(row => row.attemptId === attemptId)) throw new PluginError('already-claimed');
        const id = crypto.randomUUID(); state.reservations[id] = micro;
        state.operations[id] = { ceilingMicro: micro, state: 'reserved', owner, leaseExpiresAt: clock() + LEASE_TTL_MS,
          ...(attemptId ? { attemptId } : {}), ...(provider ? { provider } : {}) };
        write(state); keepAlive(id); return id;
      });
    },
    settle(id, micro) {
      if (!Number.isSafeInteger(micro) || micro < 0) throw new TypeError('Invalid settlement');
      return locked(() => {
        const state = read();
        if (lost.has(id)) throw leaseLost();
        const row = Object.hasOwn(state.operations, id) ? state.operations[id] : null;
        // Exact replays of an already completed settlement remain idempotent.
        // Uncertainty is settled only through durable attempt reconciliation.
        if (row && (row.state !== 'confirmed' || active.has(id))) requireLease(id, row);
        settle(state, id, micro); write(state); release(id);
      });
    },
    dispatch(id) {
      return locked(() => {
        const state = read(), row = operation(state, id);
        if (lost.has(id) || active.has(id) && !owns(row)) { lose(id); throw leaseLost(); }
        if (!['reserved', 'dispatched'].includes(row.state)) throw new PluginError('already-claimed', 'Spend already settled');
        const at = requireLease(id, row);
        row.state = 'dispatched'; row.leaseExpiresAt = Math.max(row.leaseExpiresAt, at + LEASE_TTL_MS); write(state);
      });
    },
    record(id, { generationId: generation, chargedMicro }) {
      if (generation !== undefined && !generationId(generation) || chargedMicro !== undefined && !amount(chargedMicro)) throw new TypeError('Invalid spend receipt');
      return locked(() => {
        const state = read(), row = operation(state, id);
        if (generation && row.generationId && generation !== row.generationId ||
          chargedMicro !== undefined && [row.observedMicro, row.actualMicro].some(n => n !== undefined && n !== chargedMicro)) {
          throw new PluginError('already-claimed', 'Spend receipt conflict');
        }
        if (generation) row.generationId = generation;
        if (chargedMicro !== undefined) row.observedMicro = chargedMicro;
        write(state);
      });
    },
    uncertain(id) {
      return locked(() => {
        const state = read(), row = operation(state, id);
        if (lost.has(id)) throw leaseLost();
        if (['confirmed', 'uncertain'].includes(row.state) && !active.has(id)) return;
        requireLease(id, row);
        row.state = 'uncertain'; delete row.owner; delete row.leaseExpiresAt; delete state.reservations[id]; write(state); release(id);
      });
    },
    evidence(attemptId) {
      return locked(() => {
        const row = Object.values(read().operations).find(row => row.attemptId === attemptId);
        if (!row) return null;
        return { ...(row.generationId ? { generationId: row.generationId } : {}),
          ...(row.actualMicro !== undefined || row.observedMicro !== undefined ? { chargedMicro: row.actualMicro ?? row.observedMicro } : {}) };
      });
    },
    reconcileAttempt(attemptId, actualMicro) {
      if (!amount(actualMicro)) throw new TypeError('Invalid actual spend');
      return locked(() => {
        const state = recover(read()), id = Object.keys(state.operations).find(id => state.operations[id].attemptId === attemptId);
        if (!id) throw new PluginError('not-admitted', 'Spend reservation missing');
        if (['reserved', 'dispatched'].includes(state.operations[id].state)) requireLease(id, state.operations[id]);
        settle(state, id, actualMicro); write(state); release(id);
      });
    },
    recover() {
      return locked(() => { recover(read()); });
    },
  };
}
