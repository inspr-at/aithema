import { randomInt } from 'node:crypto';
import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { evaluateQualification } from './qualification.js';
import { openPersistedQualificationBudget } from './persisted-budget.js';

function blindWav(pcm, format) {
  const width = format.encoding === 'pcm_s16le' ? 2 : 4;
  if (pcm.byteLength % width || format.sampleRateHz < 8000 || format.sampleRateHz > 96000) throw new TypeError('Invalid blind PCM format');
  const wav = Buffer.alloc(44 + pcm.byteLength);
  wav.write('RIFF', 0); wav.writeUInt32LE(36 + pcm.byteLength, 4); wav.write('WAVEfmt ', 8);
  wav.writeUInt32LE(16, 16); wav.writeUInt16LE(width === 2 ? 1 : 3, 20); wav.writeUInt16LE(1, 22);
  wav.writeUInt32LE(format.sampleRateHz, 24); wav.writeUInt32LE(format.sampleRateHz * width, 28);
  wav.writeUInt16LE(width, 32); wav.writeUInt16LE(width * 8, 34); wav.write('data', 36); wav.writeUInt32LE(pcm.byteLength, 40);
  wav.set(pcm, 44); return wav;
}

export const PRELIVE_CHECKS = Object.freeze([
  'authenticatedRelay', 'physicalBrowserMedia', 'consentAndHolds', 'verifiedTariffsAndRounding',
  'authenticatedReceipts', 'sttEmptyCommitAndMinimumDuration', 'ttsFinalFlag', 'pcmOutputAndAccountModels',
  'retentionAndResidency', 'ruleCAndNoSilentRerun',
]);

/** Feed directly from createPCMCapture/createPCMPlayer onTiming in one browser.
 * Timestamps come from device frames/output clocks, never fixture offsets or
 * server/browser wall-clock subtraction. Transcript authority remains server-only. */
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
  if (plan.checks.ttsFinalFlag.spelling !== 'is_final') throw new Error('Adapter expects is_final; resolve protocol spelling before run');
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
      const pair = [];
      for (const lane of ['candidate', 'baseline']) {
        const probe = createQualificationMediaProbe();
        // The OPS browser forwards these onTiming events from its physical ports.
        // Every component/reasoning attempt and retry must use this shared admit.
        const result = await host.runSample({ item, lane, runId: plan.runId,
          admit: spec => budget.admit({ ...spec, lane }), onTiming: probe.onTiming });
        const media = probe.evidence();
        const sample = { ...media, reference: item.reference, hypothesis: result.hypothesis, entities: result.entities };
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
        blind.push({ sample: index + 1, label: slot ? 'B' : 'A', file, format: entry.format });
        answerKey.push({ file, lane: entry.lane });
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
