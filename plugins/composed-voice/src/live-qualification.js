import { randomInt } from 'node:crypto';
import { mkdir, open, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { evaluateQualification } from './qualification.js';
import { openPersistedQualificationBudget } from './persisted-budget.js';

const BLIND_FORMAT = Object.freeze({ encoding: 'pcm_s16le', sampleRateHz: 24000, channels: 1 });
function blindWav(pcm, format) {
  const width = format.encoding === 'pcm_s16le' ? 2 : 4;
  if (pcm.byteLength % width || format.sampleRateHz < 8000 || format.sampleRateHz > 96000) throw new TypeError('Invalid blind PCM format');
  // Conceal provider-specific bit depths/rates in Markus's listening files.
  const frames = pcm.byteLength / width, count = Math.ceil(frames * BLIND_FORMAT.sampleRateHz / format.sampleRateHz);
  const audio = Buffer.alloc(count * 2), source = new DataView(pcm.buffer, pcm.byteOffset, pcm.byteLength);
  const sample = index => {
    const value = width === 2 ? source.getInt16(index * width, true) / 32768 : source.getFloat32(index * width, true);
    if (!Number.isFinite(value)) throw new TypeError('Invalid blind PCM sample');
    return Math.max(-1, Math.min(1, value));
  };
  for (let index = 0; index < count; index++) {
    const position = index * format.sampleRateHz / BLIND_FORMAT.sampleRateHz, left = Math.min(frames - 1, Math.floor(position)),
      right = Math.min(frames - 1, left + 1), fraction = position - left;
    const value = sample(left) * (1 - fraction) + sample(right) * fraction;
    audio.writeInt16LE(Math.round(value * (value < 0 ? 32768 : 32767)), index * 2);
  }
  const wav = Buffer.alloc(44 + audio.byteLength);
  wav.write('RIFF', 0); wav.writeUInt32LE(36 + audio.byteLength, 4); wav.write('WAVEfmt ', 8);
  wav.writeUInt32LE(16, 16); wav.writeUInt16LE(1, 20); wav.writeUInt16LE(1, 22);
  wav.writeUInt32LE(BLIND_FORMAT.sampleRateHz, 24); wav.writeUInt32LE(BLIND_FORMAT.sampleRateHz * 2, 28);
  wav.writeUInt16LE(2, 32); wav.writeUInt16LE(16, 34); wav.write('data', 36); wav.writeUInt32LE(audio.byteLength, 40);
  wav.set(audio, 44); return wav;
}

export const PRELIVE_CHECKS = Object.freeze([
  'authenticatedRelay', 'physicalBrowserMedia', 'consentAndHolds', 'verifiedTariffsAndRounding',
  'authenticatedReceipts', 'sttEmptyCommitAndMinimumDuration', 'ttsFinalFlag', 'pcmOutputAndAccountModels',
  'retentionAndResidency', 'ruleCAndNoSilentRerun',
]);

/** Feed directly from createPCMCapture/createPCMPlayer onTiming in one browser.
 * Timestamps come from device frames/output clocks, never fixture offsets or
 * server/browser wall-clock subtraction. Baseline text is the production final user callback. */
export function createQualificationMediaProbe() {
  const trace = [];
  return Object.freeze({
    onTiming(event) {
      if (trace.length >= 100_000) throw new Error('Media evidence bound exceeded');
      trace.push(structuredClone(event));
    },
    evidence() {
      // Worklet delivery and output clock observations can arrive out of order;
      // compare their device timestamps, never callback delivery order.
      const firstAudioAt = Math.min(...trace.filter(e => e.kind === 'playback-start').map(e => e.firstAudioAt));
      const voiced = trace.filter(e => e.kind === 'capture' && e.voiced);
      const speechEndAt = Math.max(...voiced.filter(e => e.captureAt < firstAudioAt).map(e => e.captureAt + e.durationMs));
      const bargeInAt = Math.min(...voiced.filter(e => e.captureAt >= firstAudioAt).map(e => e.captureAt));
      const stoppedAt = Math.min(...trace.filter(e => e.kind === 'playback-stop' && e.stoppedAt >= bargeInAt).map(e => e.stoppedAt));
      if (![speechEndAt, firstAudioAt, bargeInAt, stoppedAt].every(Number.isFinite)) throw new Error('Real capture/output/barge-in evidence required');
      return { speechEndAt, firstAudioAt, bargeInAt, stoppedAt, trace: structuredClone(trace) };
    },
  });
}

export function validateQualificationPlan(plan) {
  if (!plan || typeof plan.runId !== 'string' || !Array.isArray(plan.corpus) || !plan.corpus.length ||
    !Array.isArray(plan.ceilingChecks) || !plan.ceilingChecks.length ||
    PRELIVE_CHECKS.some(key => plan.checks?.[key]?.verified !== true || !plan.checks[key].reference) ||
    !['is_final', 'isFinal'].includes(plan.checks.ttsFinalFlag.spelling)) throw new Error('Verified pre-live checklist and pricing plan required');
  if (plan.corpus.some(item => !Number.isSafeInteger(item?.leadingSilenceMs) || item.leadingSilenceMs < 20_000)) {
    throw new Error('Corpus requires declared leading silence of at least 20000 ms in each identical lane WAV');
  }
  if (plan.checks.ttsFinalFlag.spelling !== 'isFinal') throw new Error('Adapter expects isFinal; resolve protocol spelling before run');
}

/** Both lanes consume the same unmodified PCM16 mono WAV. Check the declared
 * prefix before either dispatch; no per-lane padding, seek or retry is allowed. */
export async function verifyCorpusLeadingSilence(item) {
  const file = await open(item.wavPath, 'r');
  try {
    const size = (await file.stat()).size;
    const read = async (length, position) => {
      const bytes = Buffer.alloc(length);
      if ((await file.read(bytes, 0, length, position)).bytesRead !== length) throw new Error('Incomplete corpus WAV');
      return bytes;
    };
    const header = await read(12, 0);
    if (header.toString('ascii', 0, 4) !== 'RIFF' || header.toString('ascii', 8, 12) !== 'WAVE') throw new Error('PCM16 mono corpus WAV required');
    if (header.readUInt32LE(4) + 8 > size) throw new Error('Incomplete corpus WAV');
    let format;
    for (let at = 12, chunks = 0; at + 8 <= size && chunks < 128; chunks++) {
      const chunk = await read(8, at), length = chunk.readUInt32LE(4), start = at + 8;
      if (start + length > size) throw new Error('Incomplete corpus WAV');
      if (chunk.toString('ascii', 0, 4) === 'fmt ' && length >= 16) {
        const fmt = await read(16, start);
        if (fmt.readUInt16LE(0) !== 1 || fmt.readUInt16LE(2) !== 1 || fmt.readUInt16LE(12) !== 2 || fmt.readUInt16LE(14) !== 16) throw new Error('PCM16 mono corpus WAV required');
        format = fmt.readUInt32LE(4);
        if (format < 8000 || format > 96000) throw new Error('Invalid corpus sample rate');
      }
      if (chunk.toString('ascii', 0, 4) === 'data' && format) {
        const needed = Math.ceil(item.leadingSilenceMs * format / 1000) * 2;
        if (!Number.isSafeInteger(needed) || needed < 1 || needed >= length) throw new Error('Declared leading silence exceeds corpus WAV');
        for (let offset = 0; offset < needed; offset += 65536) {
          const bytes = await read(Math.min(65536, needed - offset), start + offset);
          if (bytes.some(value => value !== 0)) throw new Error('Corpus leading silence must contain zero PCM before user speech');
        }
        return;
      }
      at = start + length + length % 2;
    }
    throw new Error('PCM16 mono corpus WAV data required');
  } finally { await file.close(); }
}

/** OPS supplies an account-specific host with existing Rule C, consent,
 * reconciliation, network auth and physical browser bindings. No provider key,
 * default network connector or synthetic observation is installed here. */
export async function runLiveQualification({ operatorApproved = false, budgetPath, plan, host, outputDirectory } = {}) {
  if (operatorApproved !== true) throw new Error('Explicit --operator-approved required');
  if (typeof outputDirectory !== 'string' || !outputDirectory) throw new Error('Evidence output directory required');
  validateQualificationPlan(plan);
  if (![host?.verifyCeiling, host?.verifyReceipt, host?.runSample, host?.reconcile].every(fn => typeof fn === 'function')) throw new Error('OPS host ports required');
  const budget = openPersistedQualificationBudget({ path: budgetPath, verifyCeiling: host.verifyCeiling, verifyReceipt: host.verifyReceipt });
  let runClaimed = false;
  try {
    if (budget.snapshot().blocked) throw new Error('Qualification budget blocked');
    for (const attempt of plan.ceilingChecks) await budget.verifyPricing(attempt);
    // Persist identity before touching media/providers. Interrupted runs require
    // an explicit new operator-approved plan and reuse the SAME shared ledger.
    budget.claimRun(plan.runId); runClaimed = true;
    await mkdir(outputDirectory, { recursive: true });
    const samples = { candidate: [], baseline: [] }, blind = [], answerKey = [];
    for (const [index, item] of plan.corpus.entries()) {
      await verifyCorpusLeadingSilence(item);
      const pair = [];
      for (const lane of ['candidate', 'baseline']) {
        const probe = createQualificationMediaProbe();
        // The OPS browser forwards these onTiming events from its physical ports.
        // Every component/reasoning attempt and retry must use this shared admit.
        const result = await host.runSample({ item, lane, runId: plan.runId,
          admit: spec => budget.admit({ ...spec, lane, runId: plan.runId }), onTiming: probe.onTiming });
        const media = probe.evidence();
        const sample = { ...media, physicalBrowserMedia: result.physicalBrowserMedia,
          reference: item.reference, hypothesis: result.hypothesis, entities: result.entities,
          ...(result.baselineSession ? { baselineSession: result.baselineSession } : {}) };
        samples[lane].push(sample);
        if (!(result.ttsPCM instanceof Uint8Array) || !result.ttsPCM.length ||
          !['pcm_s16le', 'pcm_f32le'].includes(result.ttsFormat?.encoding) || result.ttsFormat.channels !== 1 ||
          !Number.isSafeInteger(result.ttsFormat.sampleRateHz)) throw new Error('Blind PCM audio and explicit format required');
        pair.push({ lane, audio: result.ttsPCM, format: result.ttsFormat });
        await host.reconcile({ snapshot: budget.snapshot(), reconcile: receipt => budget.reconcile(receipt) });
        if (budget.snapshot().blocked) throw new Error('Qualification spend overrun');
      }
      if (randomInt(2)) pair.reverse();
      for (const [slot, entry] of pair.entries()) {
        const file = `${index + 1}-${slot ? 'B' : 'A'}.wav`;
        await writeFile(join(outputDirectory, file), blindWav(entry.audio, entry.format), { flag: 'wx', mode: 0o600 });
        blind.push({ sample: index + 1, label: slot ? 'B' : 'A', file, format: BLIND_FORMAT });
        answerKey.push({ file, lane: entry.lane, sourceFormat: entry.format });
      }
      await writeFile(join(outputDirectory, 'observations.json'), JSON.stringify(samples, null, 2), { mode: 0o600 });
    }
    const report = { mode: 'live', runId: plan.runId, candidate: evaluateQualification(samples.candidate),
      baseline: evaluateQualification(samples.baseline), budget: budget.snapshot(), blindPreference: 'pending' };
    await writeFile(join(outputDirectory, 'blind.json'), JSON.stringify(blind, null, 2), { flag: 'wx', mode: 0o600 });
    await writeFile(join(outputDirectory, 'ops-answer-key.json'), JSON.stringify(answerKey, null, 2), { flag: 'wx', mode: 0o600 });
    await writeFile(join(outputDirectory, 'report.json'), JSON.stringify(report, null, 2), { flag: 'wx', mode: 0o600 });
    return report;
  } finally {
    try {
      if (runClaimed) await host.reconcile({ snapshot: budget.snapshot(), reconcile: receipt => budget.reconcile(receipt) });
    } finally {
      try { await writeFile(join(outputDirectory, 'budget-final.json'), JSON.stringify(budget.snapshot(), null, 2), { mode: 0o600 }); }
      catch { /* The durable ledger remains authoritative if evidence storage fails. */ }
      budget.close();
    }
  }
}
