import { PluginError } from '../../../packages/core/src/invocation.js';

export const QUALIFICATION_THRESHOLDS = Object.freeze({ wer: 0.08, entityAccuracy: 0.95,
  firstAudioP95Ms: 1500, bargeInStopMs: 300, capMicro: 25_000_000 });
const words = text => text.normalize('NFC').toLocaleLowerCase('de-AT').match(/[\p{L}\p{N}]+/gu) ?? [];
const entity = text => text.normalize('NFC').trim().toLocaleLowerCase('de-AT').replace(/\s+/gu, ' ');
function distance(reference, hypothesis) {
  let row = Array.from({ length: hypothesis.length + 1 }, (_, i) => i);
  for (let i = 0; i < reference.length; i++) {
    const next = [i + 1];
    for (let j = 0; j < hypothesis.length; j++) next.push(Math.min(next[j] + 1, row[j + 1] + 1, row[j] + Number(reference[i] !== hypothesis[j])));
    row = next;
  }
  return row.at(-1);
}
const percentile = (sorted, p) => sorted[Math.max(0, Math.ceil(sorted.length * p) - 1)];
export function evaluateQualification(samples, { blindPreference = 'pending' } = {}) {
  if (!Array.isArray(samples) || !samples.length || !['pending', 'at-par', 'preferred', 'worse'].includes(blindPreference)) throw new TypeError('Qualification requires observations');
  let errors = 0, references = 0, entities = 0, correct = 0;
  const latency = [], stops = [];
  for (const sample of samples) {
    if (typeof sample.reference !== 'string' || !sample.reference.trim() || typeof sample.hypothesis !== 'string' ||
      !Array.isArray(sample.entities) || !sample.entities.length ||
      ![sample.speechEndAt, sample.firstAudioAt, sample.bargeInAt, sample.stoppedAt].every(Number.isFinite) ||
      sample.firstAudioAt < sample.speechEndAt || sample.stoppedAt < sample.bargeInAt) throw new TypeError('Incomplete qualification evidence');
    const ref = words(sample.reference), hyp = words(sample.hypothesis);
    if (!ref.length || ref.length > 4096 || hyp.length > 4096) throw new TypeError('Invalid transcript');
    errors += distance(ref, hyp); references += ref.length;
    for (const value of sample.entities) {
      if (typeof value.expected !== 'string' || !value.expected.trim() || typeof value.actual !== 'string') throw new TypeError('Entity evidence required');
      entities++; correct += Number(entity(value.expected) === entity(value.actual));
    }
    latency.push(sample.firstAudioAt - sample.speechEndAt); stops.push(sample.stoppedAt - sample.bargeInAt);
  }
  latency.sort((a, b) => a - b);
  const wer = errors / references, entityAccuracy = correct / entities, bargeInStopMs = Math.max(...stops),
    firstAudioMs = { p50: percentile(latency, 0.5), p95: percentile(latency, 0.95) };
  const automatedPass = wer <= QUALIFICATION_THRESHOLDS.wer && entityAccuracy >= QUALIFICATION_THRESHOLDS.entityAccuracy &&
    firstAudioMs.p95 <= QUALIFICATION_THRESHOLDS.firstAudioP95Ms && bargeInStopMs <= QUALIFICATION_THRESHOLDS.bargeInStopMs;
  return { wer, entityAccuracy, firstAudioMs, bargeInStopMs, automatedPass, blindPreference,
    qualified: automatedPass && ['at-par', 'preferred'].includes(blindPreference), samples: samples.length,
    thresholds: QUALIFICATION_THRESHOLDS };
}

/** One shared ledger for every vendor, baseline, component and retry in a run.
 * OPS must persist the snapshot before dispatch for the later live run. */
export function createQualificationBudget({ capMicro = QUALIFICATION_THRESHOLDS.capMicro, records = [] } = {}) {
  if (!Number.isSafeInteger(capMicro) || capMicro < 0 || capMicro > QUALIFICATION_THRESHOLDS.capMicro || !Array.isArray(records)) throw new TypeError('Invalid qualification cap');
  const claims = new Map(); let blocked = false;
  for (const record of records) {
    if (!record.attemptId || claims.has(record.attemptId) || !Number.isSafeInteger(record.maxMicro) || record.maxMicro < 0 ||
      !Number.isSafeInteger(record.exposureMicro) || record.exposureMicro < 0 || !['reserved', 'dispatched', 'settled'].includes(record.state)) throw new TypeError('Invalid spend checkpoint');
    claims.set(record.attemptId, structuredClone(record));
  }
  const exposure = () => [...claims.values()].reduce((sum, row) => sum + row.exposureMicro, 0);
  if (!Number.isSafeInteger(exposure()) || exposure() > capMicro) blocked = true;
  return {
    reserve({ attemptId, maxMicro }) {
      if (typeof attemptId !== 'string' || !attemptId || !Number.isSafeInteger(maxMicro) || maxMicro < 0) throw new TypeError('Invalid reservation');
      if (claims.has(attemptId)) throw new PluginError('already-claimed');
      if (blocked || exposure() + maxMicro > capMicro) throw new PluginError('not-admitted', 'Qualification spend cap reached');
      const row = { attemptId, maxMicro, exposureMicro: maxMicro, state: 'reserved' }; claims.set(attemptId, row);
      return {
        attemptId, claimId: `qualification-${attemptId}`, maxMicro,
        consume() { if (blocked) throw new PluginError('not-admitted'); if (row.state !== 'reserved') throw new PluginError('already-claimed'); row.state = 'dispatched'; },
        report(terminal) {
          if (row.state === 'settled') throw new PluginError('already-claimed');
          if (terminal?.attemptId !== attemptId || !['completed', 'cancelled', 'uncertain'].includes(terminal.outcome)) throw new TypeError('Invalid settlement');
          const charged = terminal.chargedMicro ?? terminal.usage?.upstreamMicro;
          const known = terminal.outcome !== 'uncertain' && Number.isSafeInteger(charged) && charged >= 0;
          if (row.state === 'reserved' && terminal.outcome !== 'cancelled') throw new PluginError('not-admitted');
          row.exposureMicro = row.state === 'reserved' ? 0 : known ? charged : maxMicro;
          row.state = 'settled'; row.outcome = terminal.outcome;
          if (row.exposureMicro > maxMicro || exposure() > capMicro) { blocked = true; throw new PluginError('limit', 'Qualification spend overrun'); }
        },
      };
    },
    snapshot: () => ({ capMicro, exposureMicro: exposure(), blocked, records: structuredClone([...claims.values()]) }),
  };
}

/** Synthetic oracle data exercises the scoring harness, never vendor quality. */
export const OFFLINE_CORPUS = Object.freeze([
  { reference: 'Grüß Gott, ich bin von Müller GmbH.', expected: 'Müller GmbH' },
  { reference: 'Unsere Firma heißt Augmentoring GmbH.', expected: 'Augmentoring GmbH' },
  { reference: 'Die Rechnung beträgt 1.234,56 Euro.', expected: '1.234,56' },
  { reference: 'Bitte an büro@example.test schreiben.', expected: 'büro@example.test' },
  { reference: 'Änderungen für Österreich, täglich um 14 Uhr.', expected: 'Österreich' },
  { reference: 'Ja, ähm, ungefähr 42 Mitarbeiter.', expected: '42' },
]);
export async function runOfflineQualification({ candidate, baseline } = {}) {
  const oracle = async item => ({ hypothesis: item.reference, actual: item.expected,
    speechEndAt: 0, firstAudioAt: 900, bargeInAt: 1000, stoppedAt: 1200 });
  async function run(observe = oracle) {
    const samples = [];
    for (const item of OFFLINE_CORPUS) {
      const observation = await observe(item);
      samples.push({ ...observation, reference: item.reference, entities: [{ expected: item.expected, actual: observation.actual }] });
    }
    return evaluateQualification(samples);
  }
  // Transport functions are host-injected offline observations. There is no key or live runner here.
  return { mode: 'offline', evidence: 'synthetic-harness-only', spendMicro: 0, samples: OFFLINE_CORPUS.length,
    candidate: await run(candidate), baseline: await run(baseline) };
}
