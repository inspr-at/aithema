import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readFile, readdir, rename, rm, stat, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { PRELIVE_CHECKS, createQualificationMediaProbe, runLiveQualification, validateQualificationPlan } from '../src/live-qualification.js';
import { readQualificationCorpus } from '../src/qualification-corpus.js';
import { IncompleteMediaEvidence } from '../src/live-qualification.js';
import { initializeQualificationBudget } from '../src/persisted-budget.js';
import { fixtureVoiceSettings } from '../../elevenlabs/test/component-fixtures.js';

const events = [ { kind: 'capture', voiced: true, captureAt: 100, durationMs: 40 },
  { kind: 'playback-start', firstAudioAt: 900, outputTimestamp: { contextTime: 0.9, performanceTime: 900 } },
  { kind: 'capture', voiced: true, captureAt: 1000, durationMs: 40 }, { kind: 'playback-stop', stoppedAt: 1100 } ];
const plan = () => ({ runId: 'fixture-run', corpus: [{ reference: 'Müller GmbH', expected: 'Müller GmbH', utterancePath: '/fixture/utterance.wav', bargeInPath: '/fixture/barge-in.wav' }],
  checks: Object.fromEntries(PRELIVE_CHECKS.map(key => [key, { verified: true, reference: 'offline-test-attestation', ...(key === 'ttsFinalFlag' ? { spelling: 'isFinal' } : {}) }])),
  ceilingChecks: [{ provider: 'fixture', accountRef: 'fixture-account', endpoint: 'https://fixture.invalid/stream', model: 'fixture', operation: 'stream', maxMicro: 100, request: { seconds: 1 } }] });

test('OPS entry point refuses missing operator flag, persisted budget, checklist and pricing before dispatch', async () => {
  let calls = 0;
  const host = { runSample() { calls++; assert.fail(); }, verifyCeiling: async () => null, verifyReceipt() {}, reconcile() {} };
  await assert.rejects(runLiveQualification({ plan: plan(), host }), /operator-approved/);
  await assert.rejects(runLiveQualification({ operatorApproved: true, plan: { ...plan(), checks: {} }, host, outputDirectory: 'unused' }), /checklist/);
  await assert.rejects(runLiveQualification({ operatorApproved: true, plan: plan(), host, outputDirectory: 'unused' }), /path required/);
  assert.equal(calls, 0);
});

test('physical media probe rejects schedules without observed device playback and preserves real clock evidence', () => {
  const probe = createQualificationMediaProbe();
  probe.onTiming({ kind: 'playback-scheduled', scheduledAt: 900 });
  assert.throws(() => probe.evidence(), /Incomplete qualification evidence/);
  for (const event of events) probe.onTiming(event);
  assert.equal(probe.evidence().speechEndAt, 140); assert.equal(probe.evidence().bargeInAt, 1000);
});

for (const voiceSettings of [fixtureVoiceSettings, { stability: 0.5, similarity_boost: 0.8, style: null, use_speaker_boost: null, speed: 1 }])
test(`OPS harness preserves saved TTS settings (${voiceSettings.style === null ? 'start2 nulls' : 'explicit overrides'}) in blind PCM evidence and metrics; ledger blocks repeated run`, async t => {
  const directory = await mkdtemp(join(tmpdir(), 'ops-qualification-')), budgetPath = join(directory, 'budget.sqlite'), outputDirectory = join(directory, 'evidence');
  t.after(() => rm(directory, { recursive: true, force: true })); initializeQualificationBudget({ path: budgetPath });
  const host = {
    verifyCeiling: async attempt => ({ ...attempt, verified: true, reference: 'offline-fixture-price', expiresAt: Date.now() + 60_000 }),
    verifyReceipt: async () => true,
    async runSample({ lane, admit, onTiming }) {
      for (const role of ['stt', 'tts', 'reasoning']) {
        const attemptId = `${lane}-${role}`, admission = await admit({ attemptId, provider: 'fixture', accountRef: 'fixture-account', endpoint: 'https://fixture.invalid/stream', model: 'fixture', operation: 'stream',
          role, maxMicro: 100, request: { fixture: true } });
        await admission.dispatch(async () => admission.report({ attemptId, outcome: 'completed', chargedMicro: 1 }));
      }
      events.forEach(onTiming);
      return { hypothesis: 'Müller GmbH', entities: [{ expected: 'Müller GmbH', actual: 'Müller GmbH' }],
        ttsConfig: { model: lane === 'candidate' ? 'eleven_flash_v2_5' : 'eleven_turbo_v2', voiceId: 'fixture-voice', voiceSettings },
        ttsPCM: lane === 'candidate' ? new Uint8Array([0, 0, 128, 62]) : new Uint8Array([0, 32]),
        ttsFormat: { encoding: lane === 'candidate' ? 'pcm_f32le' : 'pcm_s16le', sampleRateHz: 24000, channels: 1 } };
    },
    async reconcile({ snapshot, reconcile }) {
      for (const row of snapshot.records.filter(row => !row.receipt)) await reconcile({ attemptId: row.attemptId,
        receiptId: row.attemptId, provider: row.provider, model: row.model, operation: row.operation, accountRef: row.accountRef, endpoint: row.endpoint, chargedMicro: 1, estimated: false });
    },
  };
  const input = plan(); input.corpus[0].utterancePath = input.corpus[0].bargeInPath = join(directory, 'corpus.wav');
  await writeFile(input.corpus[0].utterancePath, corpusWav());
  const options = { operatorApproved: true, plan: input, host, budgetPath, outputDirectory };
  const report = await runLiveQualification(options);
  assert.equal(report.candidate.wer, 0); assert.equal(report.candidate.firstAudioMs.p95, 760);
  assert.equal(report.candidate.bargeInStopMs, 100); assert.equal(report.candidate.qualified, false);
  assert.equal(report.budget.exposureMicro, 6); assert.equal(report.budget.records.length, 6);
  assert.deepEqual(report.tts, {
    candidate: [{ model: 'eleven_flash_v2_5', voiceId: 'fixture-voice', voiceSettings }],
    baseline: [{ model: 'eleven_turbo_v2', voiceId: 'fixture-voice', voiceSettings }],
  });
  const savedReport = JSON.parse(await readFile(join(outputDirectory, 'report.json')));
  assert.deepEqual(savedReport.tts, report.tts);
  assert.equal(savedReport.ttsNullSemantics, "Null style/use_speaker_boost means the voice's own default, the same as the saved agent; omitted from candidate stream-input voice_settings, preserved in lane evidence.");
  const observations = JSON.parse(await readFile(join(outputDirectory, 'observations.json')));
  for (const lane of ['candidate', 'baseline']) assert.deepEqual(observations[lane][0].ttsConfig, report.tts[lane][0]);
  const blind = JSON.parse(await readFile(join(outputDirectory, 'blind.json')));
  assert.deepEqual(blind.map(row => row.label), ['A', 'B']); assert.ok(blind.every(row => !Object.hasOwn(row, 'lane')));
  const wavs = await Promise.all(blind.map(row => readFile(join(outputDirectory, row.file))));
  assert.ok(wavs.every(wav => wav.subarray(0, 4).toString() === 'RIFF' && wav.readUInt16LE(20) === 1 && wav.readUInt16LE(34) === 16));
  assert.ok(blind.every(row => row.format.encoding === 'pcm_s16le' && row.format.sampleRateHz === 24000));
  assert.deepEqual(wavs[0], wavs[1]);
  const answerKey = JSON.parse(await readFile(join(outputDirectory, 'ops-answer-key.json')));
  assert.equal(answerKey.length, 2);
  for (const row of answerKey) assert.deepEqual(row.ttsConfig, report.tts[row.lane][0]);
  await assert.rejects(runLiveQualification(options), /Run already claimed/);
});

test('unverified pricing and unresolved final-flag spelling prevent all sample/provider work', async t => {
  const directory = await mkdtemp(join(tmpdir(), 'ops-refusal-')), budgetPath = join(directory, 'budget.sqlite');
  t.after(() => rm(directory, { recursive: true, force: true })); initializeQualificationBudget({ path: budgetPath });
  let calls = 0;
  const host = { runSample() { calls++; }, verifyCeiling: async () => null, verifyReceipt: async () => false, reconcile() { calls++; } };
  await assert.rejects(runLiveQualification({ operatorApproved: true, budgetPath, plan: plan(), host, outputDirectory: directory }), /Verified provider attempt ceiling/);
  const unresolved = plan(); unresolved.checks.ttsFinalFlag.spelling = 'is_final';
  await assert.rejects(runLiveQualification({ operatorApproved: true, budgetPath, plan: unresolved, host, outputDirectory: directory }), /Adapter expects isFinal/);
  assert.equal(calls, 0);
});

test('OPS CLI refuses a missing persisted budget before importing account-specific host code', async t => {
  const { spawnSync } = await import('node:child_process'), { fileURLToPath } = await import('node:url');
  const directory = await mkdtemp(join(tmpdir(), 'ops-cli-preflight-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const planPath = join(directory, 'plan.json'), hostPath = join(directory, 'host.mjs'), missing = join(directory, 'missing.sqlite');
  await writeFile(planPath, JSON.stringify(plan())); await writeFile(hostPath, "throw new Error('OPS_HOST_SHOULD_NOT_LOAD');\n");
  const result = spawnSync(process.execPath, [fileURLToPath(new URL('../../../scripts/composed-qualification.js', import.meta.url)),
    '--operator-approved', '--budget', missing, '--plan', planPath, '--host', hostPath, '--out', directory, '--keys-file', join(directory, 'unread-fake.keys')], {
    env: { PATH: process.env.PATH }, timeout: 15_000,
  });
  assert.notEqual(result.status, 0); assert.doesNotMatch(result.stderr.toString(), /OPS_HOST_SHOULD_NOT_LOAD/);
  await assert.rejects(readFile(missing), { code: 'ENOENT' });
});

test('OPS CLI still refuses absent accounting ports and checklist before sample work', async t => {
  const { spawnSync } = await import('node:child_process'), { fileURLToPath } = await import('node:url');
  const directory = await mkdtemp(join(tmpdir(), 'ops-cli-ports-')), budgetPath = join(directory, 'budget.sqlite');
  t.after(() => rm(directory, { recursive: true, force: true })); initializeQualificationBudget({ path: budgetPath });
  const planPath = join(directory, 'plan.json'), hostPath = join(directory, 'host.mjs');
  await writeFile(hostPath, "export function createQualificationHost() { return { runSample() { throw new Error('SAMPLE_SHOULD_NOT_RUN'); } }; }\n");
  for (const [input, expected] of [[plan(), /OPS host ports required/], [{ ...plan(), checks: {} }, /checklist/]]) {
    await writeFile(planPath, JSON.stringify(input));
    const child = spawnSync(process.execPath, [fileURLToPath(new URL('../../../scripts/composed-qualification.js', import.meta.url)),
      '--operator-approved', '--budget', budgetPath, '--plan', planPath, '--host', hostPath, '--out', directory, '--keys-file', join(directory, 'unread-fake.keys')], {
      env: { PATH: process.env.PATH }, timeout: 15_000,
    });
    assert.notEqual(child.status, 0); assert.match(child.stderr.toString(), expected);
    assert.doesNotMatch(child.stderr.toString(), /SAMPLE_SHOULD_NOT_RUN/);
  }
});

test('CLI creates private per-run control authority and removes it after factory failure', async t => {
  const { spawnSync } = await import('node:child_process'), { fileURLToPath } = await import('node:url');
  const directory = await mkdtemp(join(tmpdir(), 'ops-cli-control-')), budgetPath = join(directory, 'budget.sqlite');
  t.after(() => rm(directory, { recursive: true, force: true })); initializeQualificationBudget({ path: budgetPath });
  const planPath = join(directory, 'plan.json'), hostPath = join(directory, 'host.mjs'), handoff = join(directory, 'handoff.json');
  const input = plan(); await writeFile(planPath, JSON.stringify(input));
  await writeFile(hostPath, `
import { readFile, stat, writeFile } from 'node:fs/promises';
import { dirname } from 'node:path';
export async function createQualificationHost({ controlFile, controlCapability }) {
  const authority = JSON.parse(await readFile(controlFile));
  const valid = /^[a-f0-9]{64}$/.test(controlCapability) && authority.capability === controlCapability &&
    authority.runId === ${JSON.stringify(input.runId)} && authority.budgetPath === ${JSON.stringify(budgetPath)} &&
    ((await stat(controlFile)).mode & 0o777) === 0o600 && ((await stat(dirname(controlFile))).mode & 0o777) === 0o700;
  await writeFile(${JSON.stringify(handoff)}, JSON.stringify({ controlFile, valid }));
  throw new Error('FAKE_FACTORY_REFUSAL');
}`);
  const child = spawnSync(process.execPath, [fileURLToPath(new URL('../../../scripts/composed-qualification.js', import.meta.url)),
    '--operator-approved', '--budget', budgetPath, '--plan', planPath, '--host', hostPath, '--out', directory,
    '--keys-file', join(directory, 'unread-fake.keys')], { env: { PATH: process.env.PATH }, timeout: 15_000 });
  assert.notEqual(child.status, 0); assert.match(child.stderr.toString(), /FAKE_FACTORY_REFUSAL/);
  const result = JSON.parse(await readFile(handoff)); assert.equal(result.valid, true);
  await assert.rejects(readFile(result.controlFile), { code: 'ENOENT' });
});

for (const key of ['utterancePath', 'bargeInPath']) for (const value of [undefined, 'relative.wav'])
test(`plan requires absolute separate ${key}: ${value}`, () => {
  const input = plan(); input.corpus[0][key] = value;
  assert.throws(() => validateQualificationPlan(input), /utterancePath and bargeInPath/);
});

test('leadingSilenceMs is optional and unused', () => {
  for (const value of [undefined, 0, 20000]) {
    const input = plan(); input.corpus[0].leadingSilenceMs = value; validateQualificationPlan(input);
  }
});

function corpusWav() {
  const rate = 16000, dataBytes = rate * 2, wav = Buffer.alloc(44 + dataBytes);
  wav.write('RIFF'); wav.writeUInt32LE(wav.length - 8, 4); wav.write('WAVEfmt ', 8); wav.writeUInt32LE(16, 16);
  wav.writeUInt16LE(1, 20); wav.writeUInt16LE(1, 22); wav.writeUInt32LE(rate, 24); wav.writeUInt32LE(rate * 2, 28);
  wav.writeUInt16LE(2, 32); wav.writeUInt16LE(16, 34); wav.write('data', 36); wav.writeUInt32LE(dataBytes, 40);
  wav.writeInt16LE(10000, 44); return wav;
}

test('separate corpus PCM is preserved without a silence prefix; both inputs validate before dispatch', async t => {
  const directory = await mkdtemp(join(tmpdir(), 'corpus-clips-')), utterancePath = join(directory, 'utterance.wav'), bargeInPath = join(directory, 'barge-in.wav');
  t.after(() => rm(directory, { recursive: true, force: true }));
  const wav = corpusWav(), item = { utterancePath, bargeInPath };
  await writeFile(utterancePath, wav); await writeFile(bargeInPath, wav);
  const clips = await readQualificationCorpus(item);
  for (const clip of Object.values(clips)) {
    assert.equal(clip.sampleRateHz, 16000);
    assert.deepEqual(Buffer.from(clip.pcm, 'base64'), wav.subarray(44));
  }
  for (const path of [utterancePath, bargeInPath]) {
    await writeFile(path, wav.subarray(0, 43));
    await assert.rejects(readQualificationCorpus(item), /Incomplete corpus WAV/);
    await writeFile(path, wav);
  }
  const stereo = Buffer.from(wav); stereo.writeUInt16LE(2, 22); await writeFile(bargeInPath, stereo);
  await assert.rejects(readQualificationCorpus(item), /PCM16 mono/);
});

// Host-injected clocks and PCM only: these tests never launch a browser or provider.
const privateSentinels = ['PRIVATE_TRANSCRIPT_254', 'sk-secret-254', 'https://secret.invalid/private',
  '/private/secret/254.wav', 'Bearer_token_254'];
const sentinel = privateSentinels.join(' ');
const diagnosticEvents = () => events.map(event => ({ ...event, text: sentinel, audio: sentinel,
  replyId: sentinel, token: sentinel, outputTimestamp: { ...event.outputTimestamp, url: sentinel } }));
const fixtureResult = () => ({ hypothesis: 'Müller GmbH', entities: [{ expected: 'Müller GmbH', actual: 'Müller GmbH' }],
  ttsConfig: { model: 'fixture', voiceId: 'fixture', voiceSettings: fixtureVoiceSettings },
  ttsPCM: new Uint8Array([0, 32]), ttsFormat: { encoding: 'pcm_s16le', sampleRateHz: 24000, channels: 1 } });
async function failureFixture(t, { count = 1, timing = () => diagnosticEvents(), refusal = () => undefined, result = () => fixtureResult() } = {}) {
  const directory = await mkdtemp(join(tmpdir(), 'qualification-failure-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const budgetPath = join(directory, 'budget.sqlite'), outputDirectory = join(directory, 'evidence');
  initializeQualificationBudget({ path: budgetPath });
  const input = plan(), wavPath = join(directory, 'corpus.wav');
  await writeFile(wavPath, corpusWav());
  input.corpus = Array.from({ length: count }, (_, index) => ({ ...input.corpus[0], fixtureIndex: index + 1, utterancePath: wavPath, bargeInPath: wavPath }));
  const calls = [], reconciliations = [];
  const host = {
    verifyCeiling: async attempt => ({ ...attempt, verified: true, reference: 'fixture', expiresAt: Date.now() + 60_000 }),
    verifyReceipt: async () => true,
    async runSample({ item, lane, admit, onTiming }) {
      calls.push([item.fixtureIndex, lane]);
      const admission = await admit({ ...input.ceilingChecks[0], role: 'tts', attemptId: `${item.fixtureIndex}-${lane}` });
      await admission.dispatch(async () => {}); // Missing receipts must retain the full uncertain ceiling.
      timing(item.fixtureIndex, lane).forEach(onTiming);
      const reason = refusal(item.fixtureIndex, lane);
      if (reason) throw new IncompleteMediaEvidence(reason);
      return result(item.fixtureIndex, lane);
    },
    async reconcile({ snapshot }) { reconciliations.push(snapshot); },
  };
  return { options: { operatorApproved: true, plan: input, host, budgetPath, outputDirectory }, calls, reconciliations };
}
function assertValueFree(record) {
  const json = JSON.stringify(record);
  for (const value of privateSentinels) assert.ok(!json.includes(value), `diagnostics leaked ${value}`);
  for (const value of ['hypothesis', 'reference', 'replyId', 'token', 'stack', 'cause', 'audio', 'text']) {
    assert.ok(!json.includes(`"${value}"`), `diagnostics retained ${value}`);
  }
}

for (const phase of ['verifyCorpus', 'runSample', 'evidence', 'ttsConfig', 'pcm', 'reconcile', 'blocked', 'blindWrite', 'report']) {
  test(`abort capture identifies ${phase} without content and preserves the thrown error`, async t => {
    const abort = new TypeError(sentinel);
    const fixture = await failureFixture(t, {
      timing: () => phase === 'evidence' ? [...diagnosticEvents(), null] : diagnosticEvents(),
      result: (_index, lane) => {
        const value = fixtureResult();
        if (phase === 'ttsConfig' || phase === 'pcm') Object.defineProperty(value, phase === 'pcm' ? 'ttsPCM' : 'ttsConfig', { get() { throw abort; } });
        if (phase === 'blindWrite' && lane === 'candidate') {
          value.ttsPCM = new Uint8Array([0, 0, 192, 127]); value.ttsFormat.encoding = 'pcm_f32le';
        }
        if (phase === 'report') value.entities[Symbol.iterator] = function() { throw abort; };
        return value;
      },
    });
    const { options } = fixture;
    if (phase === 'verifyCorpus') {
      // Plan validation now checks both paths; inject the fault at the subsequent
      // corpus read so this still verifies the post-claim diagnostic phase.
      const path = options.plan.corpus[0].utterancePath; let reads = 0;
      Object.defineProperty(options.plan.corpus[0], 'utterancePath', { get() { if (reads++ < 2) return path; throw abort; } });
    }
    if (phase === 'runSample') {
      const run = options.host.runSample;
      options.host.runSample = async args => { await run(args); throw abort; };
    }
    if (phase === 'reconcile') options.host.reconcile = async () => { throw abort; };
    if (phase === 'blocked') options.host.reconcile = async ({ snapshot, reconcile }) => {
      for (const row of snapshot.records.filter(row => !row.receipt)) {
        await assert.rejects(reconcile({ ...row, receiptId: row.attemptId, chargedMicro: 101, estimated: false }), /spend overrun/);
      }
    };
    let thrown;
    await assert.rejects(runLiveQualification(options), error => { thrown = error; return true; });
    if (!['evidence', 'blocked', 'blindWrite'].includes(phase)) assert.equal(thrown, abort);
    else assert.match(thrown.message, phase === 'evidence' ? /null/ : phase === 'blocked' ? /spend overrun/ : /Invalid blind PCM sample/);
    const path = join(options.outputDirectory, 'failure.json'), record = JSON.parse(await readFile(path));
    assert.equal((await stat(path)).mode & 0o777, 0o600);
    assert.equal(record.phase, phase);
    assert.equal(record.sample, phase === 'report' ? null : 1);
    assert.equal(record.lane, phase === 'verifyCorpus' ? null : 'candidate');
    if (['blocked', 'blindWrite'].includes(phase)) assert.equal(record.message, thrown.message);
    else assert.match(record.message, /^TypeError sha256:[a-f0-9]{64}$/);
    if (!['verifyCorpus', 'report'].includes(phase)) {
      assert.equal(record.trace.counts.capture, 2);
      assert.deepEqual(record.trace.events[0], { kind: 'capture', captureAt: 100, durationMs: 40, voiced: true, outputTimestamp: {} });
      assert.deepEqual(record.trace.events[1].outputTimestamp, { contextTime: 0.9, performanceTime: 900 });
    }
    assertValueFree(record);
    const finalBudget = JSON.parse(await readFile(join(options.outputDirectory, 'budget-final.json')));
    for (const row of finalBudget.records) assert.ok(row.exposureMicro >= 100);
  });
}

test('abort retains its error/phase even if final reconciliation fails, and never overwrites prior diagnostics', async t => {
  const { options, reconciliations } = await failureFixture(t);
  await mkdir(options.outputDirectory);
  await writeFile(join(options.outputDirectory, 'failure.json'), 'prior abort', { mode: 0o600 });
  const abort = new RangeError(sentinel), run = options.host.runSample;
  options.host.runSample = async args => { await run(args); throw abort; };
  options.host.reconcile = async args => { reconciliations.push(args.snapshot); throw new Error('cleanup ' + sentinel); };
  await assert.rejects(runLiveQualification(options), error => error === abort);
  assert.equal(reconciliations.length, 1);
  assert.equal(await readFile(join(options.outputDirectory, 'failure.json'), 'utf8'), 'prior abort');
  const files = (await readdir(options.outputDirectory)).filter(file => /^failure-.*\.json$/.test(file));
  assert.equal(files.length, 1);
  const path = join(options.outputDirectory, files[0]), record = JSON.parse(await readFile(path));
  assert.equal(record.phase, 'runSample'); assert.equal(record.sample, 1); assert.equal(record.lane, 'candidate');
  assert.match(record.message, /^RangeError sha256:[a-f0-9]{64}$/);
  assert.equal((await stat(path)).mode & 0o777, 0o600); assertValueFree(record);
});

test('final reconciliation failures are captured after a successful report', async t => {
  const { options } = await failureFixture(t);
  const abort = new Error(sentinel); let reconciliations = 0;
  options.host.reconcile = async () => { if (++reconciliations === 3) throw abort; };
  await assert.rejects(runLiveQualification(options), error => error === abort);
  const record = JSON.parse(await readFile(join(options.outputDirectory, 'failure.json')));
  assert.equal(record.phase, 'reconcile'); assert.equal(record.sample, null); assert.equal(record.lane, null);
  assertValueFree(record);
});

test('unwritable failure destination still rethrows the original error and reconciles', async t => {
  const { options, reconciliations } = await failureFixture(t);
  const abort = new Error(sentinel), run = options.host.runSample;
  options.host.runSample = async args => {
    await run(args);
    // Obstruct storage after dispatch, independent of the test user's privileges.
    await rename(options.outputDirectory, options.outputDirectory + '.saved');
    await writeFile(options.outputDirectory, 'storage unavailable');
    throw abort;
  };
  await assert.rejects(runLiveQualification(options), error => error === abort);
  assert.equal(reconciliations.length, 1);
  assert.equal(await readFile(options.outputDirectory, 'utf8'), 'storage unavailable');
});

test('an abort in a later baseline lane keeps that sample and lane trace', async t => {
  const { options, calls } = await failureFixture(t, { count: 2 });
  const abort = new SyntaxError(sentinel), run = options.host.runSample;
  options.host.runSample = async args => {
    const value = await run(args);
    if (args.item.fixtureIndex === 2 && args.lane === 'baseline') throw abort;
    return value;
  };
  await assert.rejects(runLiveQualification(options), error => error === abort);
  assert.equal(calls.length, 4);
  const record = JSON.parse(await readFile(join(options.outputDirectory, 'failure.json')));
  assert.equal(record.phase, 'runSample'); assert.equal(record.sample, 2); assert.equal(record.lane, 'baseline');
  assert.equal(record.trace.total, 4); assert.equal(record.trace.counts.capture, 2);
  assert.match(record.message, /^SyntaxError sha256:[a-f0-9]{64}$/); assertValueFree(record);
});

for (const [reason, timing] of [
  ['missing-playback-stop', () => events.map(e => e.kind === 'playback-stop' ? { ...e, stoppedAt: 999 } : e)],
]) test(`incomplete ${reason} refuses once in each lane, retains exposure, skips pairs and continues`, async t => {
  const { options, calls, reconciliations } = await failureFixture(t, { count: 4,
    timing: (index, lane) => index === (lane === 'candidate' ? 1 : 2) ? timing() : diagnosticEvents() });
  const report = await runLiveQualification(options);
  assert.equal(calls.length, 8); assert.equal(reconciliations.length, 9);
  assert.deepEqual(report.refusals.map(row => [row.sample, row.lane, row.reason]), [[1, 'candidate', reason], [2, 'baseline', reason]]);
  for (const lane of ['candidate', 'baseline']) {
    assert.equal(report[lane].samples, 3); assert.equal(report[lane].attemptedSamples, 4);
    assert.equal(report[lane].automatedPass, false); assert.equal(report[lane].reason, 'insufficient-valid-samples');
    assert.equal(report[lane].refusedSamples, 1); assert.deepEqual(report[lane].refusalsByReason, { [reason]: 1 });
  }
  const saved = JSON.parse(await readFile(join(options.outputDirectory, 'report.json')));
  assert.deepEqual(saved, report);
  const refusals = JSON.parse(await readFile(join(options.outputDirectory, 'refusals.json')));
  assert.deepEqual(refusals, report.refusals); assertValueFree(refusals);
  assert.equal((await stat(join(options.outputDirectory, 'refusals.json'))).mode & 0o777, 0o600);
  const blind = JSON.parse(await readFile(join(options.outputDirectory, 'blind.json')));
  assert.deepEqual(blind.map(row => row.sample), [3, 3, 4, 4]);
  assert.equal((await readdir(options.outputDirectory)).filter(file => file.endsWith('.wav')).length, 4);
  assert.equal(report.budget.exposureMicro, 800);
  for (const row of report.budget.records) {
    assert.equal(row.state, 'settled'); assert.equal(row.outcome, 'uncertain');
    assert.equal(row.exposureMicro, 100); assert.equal(row.receipt, undefined);
  }
  await assert.rejects(readFile(join(options.outputDirectory, 'failure.json')), { code: 'ENOENT' });
  await assert.rejects(runLiveQualification(options), /Run already claimed/);
});

for (const lane of ['candidate', 'baseline']) {
  test(`two consecutive same-reason ${lane} refusals abort before another dispatch`, async t => {
    const { options, calls, reconciliations } = await failureFixture(t, { count: 12,
      timing: (_index, currentLane) => currentLane === lane ? events.filter(e => e.kind !== 'playback-stop') : diagnosticEvents() });
    await assert.rejects(runLiveQualification(options), /Qualification refusal limit reached/);
    assert.equal(calls.length, lane === 'candidate' ? 3 : 4);
    assert.deepEqual(calls.at(-1), [2, lane]);
    assert.equal(reconciliations.length, calls.length);
    const record = JSON.parse(await readFile(join(options.outputDirectory, 'failure.json')));
    assert.equal(record.phase, 'refusal-limit'); assert.equal(record.lane, lane); assert.equal(record.sample, 2);
    assert.equal(record.message, 'Qualification refusal limit reached');
    const refusals = JSON.parse(await readFile(join(options.outputDirectory, 'refusals.json')));
    assert.deepEqual(refusals.map(row => [row.sample, row.lane, row.reason]),
      [[1, lane, 'missing-playback-stop'], [2, lane, 'missing-playback-stop']]);
    assertValueFree(refusals); assertValueFree(record);
    const budget = JSON.parse(await readFile(join(options.outputDirectory, 'budget-final.json')));
    assert.equal(budget.exposureMicro, calls.length * 100);
    assert.ok(budget.records.every(row => row.exposureMicro === 100 && row.outcome === 'uncertain'));
    await assert.rejects(readFile(join(options.outputDirectory, 'report.json')), { code: 'ENOENT' });
  });

  test(`more than 25 percent ${lane} refusals abort even with intervening valid samples`, async t => {
    const { options, calls } = await failureFixture(t, { count: 12,
      refusal: (index, currentLane) => currentLane === lane && index % 2 ? 'late-first-audio' : undefined });
    await assert.rejects(runLiveQualification(options), /refusal limit/);
    assert.deepEqual(calls.at(-1), [7, lane]);
    assert.equal(calls.length, lane === 'candidate' ? 13 : 14);
    const record = JSON.parse(await readFile(join(options.outputDirectory, 'failure.json')));
    assert.equal(record.phase, 'refusal-limit'); assert.equal(record.lane, lane); assert.equal(record.sample, 7);
    assert.equal(JSON.parse(await readFile(join(options.outputDirectory, 'refusals.json'))).length, 4);
    const budget = JSON.parse(await readFile(join(options.outputDirectory, 'budget-final.json')));
    assert.equal(budget.exposureMicro, calls.length * 100);
  });
}

test('lane metrics expose valid/refused corpus counts; 9 of 12 qualifies at the exact 25 percent refusal boundary', async t => {
  const { options } = await failureFixture(t, { count: 12,
    refusal: (index, lane) => [1, 3, 5].includes(index) && lane === 'candidate' ? 'late-first-audio' : undefined });
  const report = await runLiveQualification(options);
  assert.equal(report.candidate.samples, 9); assert.equal(report.candidate.validSamples, 9);
  assert.equal(report.candidate.corpusSamples, 12); assert.equal(report.candidate.refusedSamples, 3);
  assert.equal(report.candidate.automatedPass, true); assert.equal(report.baseline.automatedPass, true);
  assert.equal(report.baseline.samples, 12); assert.equal(report.baseline.refusedSamples, 0);
  assert.deepEqual(report.candidate.refusalsByReason, { 'late-first-audio': 3 });
  assert.deepEqual(report.baseline.refusalsByReason, {});
  assert.equal(JSON.parse(await readFile(join(options.outputDirectory, 'blind.json'))).length, 18);
});

test('a changed refusal reason resets the consecutive count within its lane', async t => {
  const { options } = await failureFixture(t, { count: 12,
    refusal: (index, lane) => lane === 'candidate' && index <= 3 ?
      (index === 2 ? 'barge-in-before-first-audio' : 'late-first-audio') : undefined });
  const report = await runLiveQualification(options);
  assert.equal(report.candidate.automatedPass, true);
  assert.deepEqual(report.candidate.refusalsByReason, { 'late-first-audio': 2, 'barge-in-before-first-audio': 1 });
});

for (const phase of ['validate', 'budget', 'verifyPricing']) {
  test(`pre-claim ${phase} errors use unique diagnostics and preserve earlier output`, async t => {
    const { options, calls } = await failureFixture(t);
    await mkdir(options.outputDirectory);
    await writeFile(join(options.outputDirectory, 'failure.json'), 'earlier failure');
    await writeFile(join(options.outputDirectory, 'budget-final.json'), 'earlier budget');
    if (phase === 'validate') options.operatorApproved = false;
    if (phase === 'budget') options.budgetPath += '.missing';
    if (phase === 'verifyPricing') options.host.verifyCeiling = async () => null;
    await assert.rejects(runLiveQualification(options));
    assert.equal(calls.length, 0);
    assert.equal(await readFile(join(options.outputDirectory, 'failure.json'), 'utf8'), 'earlier failure');
    assert.equal(await readFile(join(options.outputDirectory, 'budget-final.json'), 'utf8'), 'earlier budget');
    const files = (await readdir(options.outputDirectory)).filter(file => /^failure-.*\.json$/.test(file));
    assert.equal(files.length, 1);
    const record = JSON.parse(await readFile(join(options.outputDirectory, files[0])));
    assert.equal(record.phase, phase); assert.equal(record.sample, null); assert.equal(record.lane, null);
  });
}

test('a refused repeated claim preserves every earlier run file and captures phase claim uniquely', async t => {
  const { options, calls } = await failureFixture(t);
  await runLiveQualification(options);
  const files = await readdir(options.outputDirectory);
  const before = await Promise.all(files.map(file => readFile(join(options.outputDirectory, file))));
  await assert.rejects(runLiveQualification(options), /Run already claimed/);
  assert.equal(calls.length, 2);
  for (const [index, file] of files.entries()) assert.deepEqual(await readFile(join(options.outputDirectory, file)), before[index]);
  await assert.rejects(readFile(join(options.outputDirectory, 'failure.json')), { code: 'ENOENT' });
  const fresh = (await readdir(options.outputDirectory)).filter(file => !files.includes(file));
  assert.equal(fresh.length, 1); assert.match(fresh[0], /^failure-.*\.json$/);
  assert.equal(JSON.parse(await readFile(join(options.outputDirectory, fresh[0]))).phase, 'claim');
});

test('refusal diagnostics use exclusive creation and preserve an earlier refusals file', async t => {
  const { options } = await failureFixture(t, { count: 4,
    refusal: (index, lane) => index === 1 && lane === 'candidate' ? 'late-first-audio' : undefined });
  await mkdir(options.outputDirectory);
  await writeFile(join(options.outputDirectory, 'refusals.json'), 'earlier refusals');
  await assert.rejects(runLiveQualification(options), { code: 'EEXIST' });
  assert.equal(await readFile(join(options.outputDirectory, 'refusals.json'), 'utf8'), 'earlier refusals');
  assert.equal(JSON.parse(await readFile(join(options.outputDirectory, 'failure.json'))).phase, 'refusalsWrite');
});

test('trace summaries allowlist kinds and numeric clocks, including malformed input', () => {
  const probe = createQualificationMediaProbe();
  probe.onTiming({ kind: sentinel, captureAt: sentinel, voiced: sentinel, text: sentinel });
  probe.onTiming(null);
  probe.onTiming({ kind: 'capture', captureAt: 12, voiced: false, outputTimestamp: { contextTime: sentinel, performanceTime: 45, text: sentinel } });
  assert.deepEqual(probe.summary(), { total: 3, counts: { unknown: 2, capture: 1 },
    events: [{ kind: 'unknown' }, { kind: 'unknown' }, { kind: 'capture', captureAt: 12, voiced: false, outputTimestamp: { performanceTime: 45 } }] });
  assertValueFree(probe.summary());
});

test('final reconciliation error retains its phase while refusal diagnostics are flushed', async t => {
  const { options } = await failureFixture(t, { count: 4,
    refusal: (index, lane) => index === 1 && lane === 'candidate' ? 'late-first-audio' : undefined });
  const abort = new Error(sentinel); let reconciliations = 0;
  options.host.reconcile = async () => { if (++reconciliations === 9) throw abort; };
  await assert.rejects(runLiveQualification(options), error => error === abort);
  assert.equal(JSON.parse(await readFile(join(options.outputDirectory, 'failure.json'))).phase, 'reconcile');
  assert.equal(JSON.parse(await readFile(join(options.outputDirectory, 'refusals.json'))).length, 1);
});

for (const lane of ['candidate', 'baseline']) {
  test(`runSample late-first-audio refusal continues once with exposure retained (${lane})`, async t => {
    const h = await failureFixture(t, { count: 8, result(index, current) {
      if (index === 1 && current === lane) throw new IncompleteMediaEvidence('late-first-audio');
      return fixtureResult();
    } });
    const report = await runLiveQualification(h.options);
    assert.equal(h.calls.length, 16);
    assert.deepEqual(report.refusals.map(row => [row.sample, row.lane, row.reason]), [[1, lane, 'late-first-audio']]);
    assert.equal(report.budget.exposureMicro, 1600);
    assert.equal(JSON.parse(await readFile(join(h.options.outputDirectory, 'blind.json'))).length, 14);
    assertValueFree(report.refusals);
  });
  test(`two same-reason runSample late-first-audio refusals trip early stop (${lane})`, async t => {
    const h = await failureFixture(t, { count: 12, result(index, current) {
      if (current === lane && index <= 2) throw new IncompleteMediaEvidence('late-first-audio');
      return fixtureResult();
    } });
    await assert.rejects(runLiveQualification(h.options), /refusal limit/);
    const refusals = JSON.parse(await readFile(join(h.options.outputDirectory, 'refusals.json')));
    assert.deepEqual(refusals.map(row => row.reason), ['late-first-audio', 'late-first-audio']);
    assert.deepEqual(h.calls.at(-1), [2, lane]); assertValueFree(refusals);
    const budget = JSON.parse(await readFile(join(h.options.outputDirectory, 'budget-final.json')));
    assert.equal(budget.exposureMicro, h.calls.length * 100);
  });
}

for (const kind of ['playback-start', 'speech-end', 'barge-in']) test(`missing ${kind} evidence aborts instead of inferring a timing refusal`, async t => {
  const { options } = await failureFixture(t, { timing: () => events.filter(event => kind === 'playback-start' ? event.kind !== kind :
    event.captureAt !== (kind === 'speech-end' ? 100 : 1000)) });
  await assert.rejects(runLiveQualification(options), error => {
    assert.equal(error.reason, undefined); return error.message === 'Incomplete qualification evidence';
  });
  const record = JSON.parse(await readFile(join(options.outputDirectory, 'failure.json')));
  assert.equal(record.phase, 'evidence'); assert.equal(record.message, 'Incomplete qualification evidence');
  assertValueFree(record);
});

for (const reason of ['media-wait-limit', 'missing-first-audio', 'missing-speech-end', 'missing-barge-in'])
test(`non-timing or untyped ${reason} cannot be constructed as a refusal`, () => {
  assert.throws(() => new IncompleteMediaEvidence(reason), /Unknown qualification media refusal/);
});
