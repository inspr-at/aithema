import { createHash, randomInt, randomUUID } from 'node:crypto';
import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { evaluateQualification, QUALIFICATION_THRESHOLDS } from './qualification.js';
import { openPersistedQualificationBudget } from './persisted-budget.js';
import { readQualificationCorpus } from './qualification-corpus.js';
import { validateVoiceSettings } from '../../elevenlabs/src/voice-settings.js';

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

// Only literal harness messages may survive in abort diagnostics. Never persist
// stacks, causes, provider codes/names, or arbitrary host error properties.
const FAILURE_MESSAGES = new Set([
  'Media evidence bound exceeded', 'Real capture/output/barge-in evidence required',
  'Incomplete corpus WAV', 'PCM16 mono corpus WAV required', 'Invalid corpus sample rate',
  'Corpus WAV bound exceeded', 'Absolute corpus utterancePath and bargeInPath required',
  'PCM16 mono corpus WAV data required', 'Explicit lane TTS model and saved voice required',
  'Explicit valid ElevenLabs voice settings required', 'Blind PCM audio and explicit format required',
  'Invalid blind PCM format', 'Invalid blind PCM sample', 'Qualification budget blocked',
  'Qualification spend overrun', 'Qualification requires observations', 'Incomplete qualification evidence',
  'Invalid transcript', 'Entity evidence required', 'Qualification lane has zero valid samples',
  'Qualification refusal limit reached',
]);
const TIMING_KINDS = new Set(['capture', 'playback-start', 'playback-stop', 'playback-scheduled',
  'opener-finished', 'opener-drained', 'opener-final', 'user-final', 'invalid-evidence']);
const TIMING_FIELDS = ['at', 'captureAt', 'receivedAt', 'durationMs', 'captureFrame', 'contextSampleRate',
  'firstAudioAt', 'scheduledAt', 'contextStart', 'requestedAt', 'stoppedAt', 'speechEndAt'];
function traceSummary(trace = []) {
  const counts = {}, events = trace.map(event => {
    const kind = TIMING_KINDS.has(event?.kind) ? event.kind : 'unknown';
    counts[kind] = (counts[kind] ?? 0) + 1;
    const row = { kind };
    for (const key of TIMING_FIELDS) if (Number.isFinite(event?.[key])) row[key] = event[key];
    if (typeof event?.voiced === 'boolean') row.voiced = event.voiced;
    const timestamp = event?.outputTimestamp;
    if (timestamp) row.outputTimestamp = Object.fromEntries(['contextTime', 'performanceTime']
      .filter(key => Number.isFinite(timestamp[key])).map(key => [key, timestamp[key]]));
    return row;
  });
  return { total: events.length, counts, events };
}
function redactedMessage(error) {
  const message = typeof error?.message === 'string' ? error.message : typeof error === 'string' ? error : typeof error;
  if (FAILURE_MESSAGES.has(message)) return message;
  const errorClass = ['Error', 'TypeError', 'RangeError', 'SyntaxError', 'ReferenceError', 'URIError', 'EvalError', 'AggregateError', 'PluginError']
    .includes(error?.name) ? error.name : 'Error';
  return `${errorClass} sha256:${createHash('sha256').update(message).digest('hex')}`;
}
async function writeFailure(outputDirectory, context, error) {
  // Diagnostic storage must never replace the original exception (including
  // disk/permission failures). Preserve an earlier abort on a reused directory.
  try {
    await mkdir(outputDirectory, { recursive: true });
    const record = JSON.stringify({ message: redactedMessage(error), phase: context.phase,
      sample: context.sample, lane: context.lane, trace: context.probe?.summary() ?? traceSummary() }, null, 2);
    const file = context.runClaimed ? 'failure.json' : `failure-${randomUUID()}.json`;
    try { await writeFile(join(outputDirectory, file), record, { flag: 'wx', mode: 0o600 }); }
    catch (failure) {
      if (failure.code !== 'EEXIST') throw failure;
      await writeFile(join(outputDirectory, `failure-${randomUUID()}.json`), record, { flag: 'wx', mode: 0o600 });
    }
  } catch { /* The durable ledger remains authoritative if diagnostics cannot be stored. */ }
}
export class IncompleteMediaEvidence extends Error {
  constructor(reason) {
    super('Real capture/output/barge-in evidence required');
    if (!['media-wait-limit', 'missing-first-audio', 'missing-speech-end', 'missing-barge-in', 'missing-playback-stop'].includes(reason)) {
      throw new TypeError('Unknown qualification media refusal');
    }
    this.reason = reason;
  }
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
    summary: () => traceSummary(trace),
    evidence() {
      // Worklet delivery and output clock observations can arrive out of order;
      // compare their device timestamps, never callback delivery order.
      const firstAudioAt = Math.min(...trace.filter(e => e.kind === 'playback-start').map(e => e.firstAudioAt));
      const voiced = trace.filter(e => e.kind === 'capture' && e.voiced);
      const speechEndAt = Math.max(...voiced.filter(e => e.captureAt < firstAudioAt).map(e => e.captureAt + e.durationMs));
      const bargeInAt = Math.min(...voiced.filter(e => e.captureAt >= firstAudioAt).map(e => e.captureAt));
      const stoppedAt = Math.min(...trace.filter(e => e.kind === 'playback-stop' && e.stoppedAt >= bargeInAt).map(e => e.stoppedAt));
      if (!Number.isFinite(firstAudioAt)) throw new IncompleteMediaEvidence('missing-first-audio');
      if (!Number.isFinite(speechEndAt)) throw new IncompleteMediaEvidence('missing-speech-end');
      if (!Number.isFinite(bargeInAt)) throw new IncompleteMediaEvidence('missing-barge-in');
      if (!Number.isFinite(stoppedAt)) throw new IncompleteMediaEvidence('missing-playback-stop');
      return { speechEndAt, firstAudioAt, bargeInAt, stoppedAt, trace: structuredClone(trace) };
    },
  });
}

export function validateQualificationPlan(plan) {
  if (!plan || typeof plan.runId !== 'string' || !Array.isArray(plan.corpus) || !plan.corpus.length ||
    !Array.isArray(plan.ceilingChecks) || !plan.ceilingChecks.length ||
    PRELIVE_CHECKS.some(key => plan.checks?.[key]?.verified !== true || !plan.checks[key].reference) ||
    !['is_final', 'isFinal'].includes(plan.checks.ttsFinalFlag.spelling)) throw new Error('Verified pre-live checklist and pricing plan required');
  if (plan.corpus.some(item => !['utterancePath', 'bargeInPath'].every(key => typeof item?.[key] === 'string' && item[key].startsWith('/')))) {
    throw new Error('Absolute corpus utterancePath and bargeInPath required');
  }
  if (plan.checks.ttsFinalFlag.spelling !== 'isFinal') throw new Error('Adapter expects isFinal; resolve protocol spelling before run');
}

/** OPS supplies an account-specific host with existing Rule C, consent,
 * reconciliation, network auth and physical browser bindings. No provider key,
 * default network connector or synthetic observation is installed here. */
export async function runLiveQualification(options = {}) {
  const context = { phase: 'validate', sample: null, lane: null, probe: null, runClaimed: false };
  try { return await executeLiveQualification(options, context); }
  catch (error) { await writeFailure(options.outputDirectory, context, error); throw error; }
}

async function executeLiveQualification({ operatorApproved = false, budgetPath, plan, host, outputDirectory }, context) {
  if (operatorApproved !== true) throw new Error('Explicit --operator-approved required');
  if (typeof outputDirectory !== 'string' || !outputDirectory) throw new Error('Evidence output directory required');
  validateQualificationPlan(plan);
  if (![host?.verifyCeiling, host?.verifyReceipt, host?.runSample, host?.reconcile].every(fn => typeof fn === 'function')) throw new Error('OPS host ports required');
  context.phase = 'budget';
  const budget = openPersistedQualificationBudget({ path: budgetPath, verifyCeiling: host.verifyCeiling, verifyReceipt: host.verifyReceipt });
  let runClaimed = false, failed = false;
  const refusals = [], refusalState = Object.fromEntries(['candidate', 'baseline']
    .map(lane => [lane, { count: 0, consecutive: 0, reason: null }]));
  const at = (phase, sample = null, lane = null, probe = null) => Object.assign(context, { phase, sample, lane, probe });
  try {
    at('blocked');
    if (budget.snapshot().blocked) throw new Error('Qualification budget blocked');
    at('verifyPricing');
    for (const attempt of plan.ceilingChecks) await budget.verifyPricing(attempt);
    // Persist identity before touching media/providers. Interrupted runs require
    // an explicit new operator-approved plan and reuse the SAME shared ledger.
    at('claim');
    budget.claimRun(plan.runId); runClaimed = context.runClaimed = true;
    at('output');
    await mkdir(outputDirectory, { recursive: true });
    const samples = { candidate: [], baseline: [] }, blind = [], answerKey = [];
    for (const [index, item] of plan.corpus.entries()) {
      at('verifyCorpus', index + 1);
      await readQualificationCorpus(item);
      const pair = [];
      for (const lane of ['candidate', 'baseline']) {
        const probe = createQualificationMediaProbe();
        // The OPS browser forwards these onTiming events from its physical ports.
        // Every component/reasoning attempt and retry must use this shared admit.
        at('runSample', index + 1, lane, probe);
        let result, media;
        try {
          result = await host.runSample({ item, lane, runId: plan.runId,
            admit: spec => budget.admit({ ...spec, lane, runId: plan.runId }), onTiming: probe.onTiming });
          at('evidence', index + 1, lane, probe);
          media = probe.evidence();
        } catch (error) {
          if (!(error instanceof IncompleteMediaEvidence)) throw error;
          refusals.push({ sample: index + 1, lane, reason: error.reason, trace: probe.summary() });
          const state = refusalState[lane];
          state.count++;
          state.consecutive = state.reason === error.reason ? state.consecutive + 1 : 1;
          state.reason = error.reason;
          if (state.consecutive >= QUALIFICATION_THRESHOLDS.maxConsecutiveRefusals ||
            state.count > plan.corpus.length * (1 - QUALIFICATION_THRESHOLDS.minValidFraction)) {
            at('refusal-limit', index + 1, lane, probe);
            throw new Error('Qualification refusal limit reached');
          }
        }
        if (media) {
          refusalState[lane].consecutive = 0;
          refusalState[lane].reason = null;
          at('ttsConfig', index + 1, lane, probe);
          if (!/^[A-Za-z0-9_-]{1,128}$/u.test(result.ttsConfig?.model ?? '') ||
            !/^[A-Za-z0-9_-]{1,128}$/u.test(result.ttsConfig?.voiceId ?? '')) throw new Error('Explicit lane TTS model and saved voice required');
          const ttsConfig = { model: result.ttsConfig.model, voiceId: result.ttsConfig.voiceId,
            voiceSettings: validateVoiceSettings(result.ttsConfig.voiceSettings) };
          const sample = { ...media, physicalBrowserMedia: result.physicalBrowserMedia,
            ttsConfig,
            reference: item.reference, hypothesis: result.hypothesis, entities: result.entities,
            ...(result.baselineSession ? { baselineSession: result.baselineSession } : {}) };
          samples[lane].push(sample);
          at('pcm', index + 1, lane, probe);
          if (!(result.ttsPCM instanceof Uint8Array) || !result.ttsPCM.length ||
            !['pcm_s16le', 'pcm_f32le'].includes(result.ttsFormat?.encoding) || result.ttsFormat.channels !== 1 ||
            !Number.isSafeInteger(result.ttsFormat.sampleRateHz)) throw new Error('Blind PCM audio and explicit format required');
          pair.push({ lane, audio: result.ttsPCM, format: result.ttsFormat, ttsConfig, probe });
        }
        at('reconcile', index + 1, lane, probe);
        await host.reconcile({ snapshot: budget.snapshot(), reconcile: receipt => budget.reconcile(receipt) });
        at('blocked', index + 1, lane, probe);
        if (budget.snapshot().blocked) throw new Error('Qualification spend overrun');
      }
      // A blind comparison needs both lanes; each lane's metrics still retain
      // its own valid observations so unequal refusal rates remain visible.
      if (pair.length === 2) {
        if (randomInt(2)) pair.reverse();
        for (const [slot, entry] of pair.entries()) {
          at('blindWrite', index + 1, entry.lane, entry.probe);
          const file = `${index + 1}-${slot ? 'B' : 'A'}.wav`;
          await writeFile(join(outputDirectory, file), blindWav(entry.audio, entry.format), { flag: 'wx', mode: 0o600 });
          blind.push({ sample: index + 1, label: slot ? 'B' : 'A', file, format: BLIND_FORMAT });
          answerKey.push({ file, lane: entry.lane, sourceFormat: entry.format, ttsConfig: entry.ttsConfig });
        }
      }
      at('report', index + 1);
      await writeFile(join(outputDirectory, 'observations.json'), JSON.stringify(samples, null, 2), { mode: 0o600 });
    }
    at('report');
    const metrics = lane => {
      at('report', null, lane);
      if (!samples[lane].length) throw new Error('Qualification lane has zero valid samples');
      const refused = refusals.filter(row => row.lane === lane);
      return { ...evaluateQualification(samples[lane], { corpusSamples: plan.corpus.length }), attemptedSamples: plan.corpus.length, refusedSamples: refused.length,
        refusalsByReason: Object.fromEntries([...new Set(refused.map(row => row.reason))]
          .map(reason => [reason, refused.filter(row => row.reason === reason).length])) };
    };
    const report = { mode: 'live', runId: plan.runId, candidate: metrics('candidate'),
      baseline: metrics('baseline'), refusals,
      tts: Object.fromEntries(['candidate', 'baseline'].map(lane => [lane, samples[lane].map(sample => sample.ttsConfig)])),
      ttsNullSemantics: "Null style/use_speaker_boost means the voice's own default, the same as the saved agent; omitted from candidate stream-input voice_settings, preserved in lane evidence.",
      budget: budget.snapshot(), blindPreference: 'pending' };
    at('blindWrite');
    await writeFile(join(outputDirectory, 'blind.json'), JSON.stringify(blind, null, 2), { flag: 'wx', mode: 0o600 });
    await writeFile(join(outputDirectory, 'ops-answer-key.json'), JSON.stringify(answerKey, null, 2), { flag: 'wx', mode: 0o600 });
    at('report');
    await writeFile(join(outputDirectory, 'report.json'), JSON.stringify(report, null, 2), { flag: 'wx', mode: 0o600 });
    return report;
  } catch (error) { failed = true; throw error; }
  finally {
    try {
      if (runClaimed) {
        if (!failed) at('reconcile');
        await host.reconcile({ snapshot: budget.snapshot(), reconcile: receipt => budget.reconcile(receipt) });
      }
    } catch (error) {
      // Reconciliation still runs on every claimed abort, but must not mask its
      // original exception or phase when it too fails.
      if (!failed) { failed = true; throw error; }
    } finally {
      let refusalWriteError;
      try {
        // Flush once on success or abort; exclusive creation preserves earlier evidence.
        if (runClaimed && refusals.length) {
          if (!failed) at('refusalsWrite');
          await writeFile(join(outputDirectory, 'refusals.json'), JSON.stringify(refusals, null, 2), { flag: 'wx', mode: 0o600 });
        }
      } catch (error) { if (!failed) refusalWriteError = error; }
      try { if (runClaimed) await writeFile(join(outputDirectory, 'budget-final.json'), JSON.stringify(budget.snapshot(), null, 2), { mode: 0o600 }); }
      catch { /* The durable ledger remains authoritative if evidence storage fails. */ }
      try { budget.close(); } catch (error) { if (!failed && !refusalWriteError) throw error; }
      if (refusalWriteError) throw refusalWriteError;
    }
  }
}
