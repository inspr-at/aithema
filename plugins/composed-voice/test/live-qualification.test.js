import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { PRELIVE_CHECKS, createQualificationMediaProbe, runLiveQualification, validateQualificationPlan, verifyCorpusLeadingSilence } from '../src/live-qualification.js';
import { initializeQualificationBudget } from '../src/persisted-budget.js';

const events = [ { kind: 'capture', voiced: true, captureAt: 100, durationMs: 40 },
  { kind: 'playback-start', firstAudioAt: 900, outputTimestamp: { contextTime: 0.9, performanceTime: 900 } },
  { kind: 'capture', voiced: true, captureAt: 1000, durationMs: 40 }, { kind: 'playback-stop', stoppedAt: 1100 } ];
const plan = () => ({ runId: 'fixture-run', corpus: [{ reference: 'Müller GmbH', expected: 'Müller GmbH', leadingSilenceMs: 20000 }],
  checks: Object.fromEntries(PRELIVE_CHECKS.map(key => [key, { verified: true, reference: 'offline-test-attestation', ...(key === 'ttsFinalFlag' ? { spelling: 'is_final' } : {}) }])),
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
  assert.throws(() => probe.evidence(), /Real capture/);
  for (const event of events) probe.onTiming(event);
  assert.equal(probe.evidence().speechEndAt, 140); assert.equal(probe.evidence().bargeInAt, 1000);
});

test('OPS harness produces blind PCM pairs and metrics with pending preference; ledger blocks repeated run', async t => {
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
        ttsPCM: lane === 'candidate' ? new Uint8Array([0, 0, 128, 62]) : new Uint8Array([0, 32]),
        ttsFormat: { encoding: lane === 'candidate' ? 'pcm_f32le' : 'pcm_s16le', sampleRateHz: 24000, channels: 1 } };
    },
    async reconcile({ snapshot, reconcile }) {
      for (const row of snapshot.records.filter(row => !row.receipt)) await reconcile({ attemptId: row.attemptId,
        receiptId: row.attemptId, provider: row.provider, model: row.model, operation: row.operation, accountRef: row.accountRef, endpoint: row.endpoint, chargedMicro: 1, estimated: false });
    },
  };
  const input = plan(); input.corpus[0].wavPath = join(directory, 'corpus.wav');
  await writeFile(input.corpus[0].wavPath, corpusWav());
  const options = { operatorApproved: true, plan: input, host, budgetPath, outputDirectory };
  const report = await runLiveQualification(options);
  assert.equal(report.candidate.wer, 0); assert.equal(report.candidate.firstAudioMs.p95, 760);
  assert.equal(report.candidate.bargeInStopMs, 100); assert.equal(report.candidate.qualified, false);
  assert.equal(report.budget.exposureMicro, 6); assert.equal(report.budget.records.length, 6);
  const blind = JSON.parse(await readFile(join(outputDirectory, 'blind.json')));
  assert.deepEqual(blind.map(row => row.label), ['A', 'B']); assert.ok(blind.every(row => !Object.hasOwn(row, 'lane')));
  const wavs = await Promise.all(blind.map(row => readFile(join(outputDirectory, row.file))));
  assert.ok(wavs.every(wav => wav.subarray(0, 4).toString() === 'RIFF' && wav.readUInt16LE(20) === 1 && wav.readUInt16LE(34) === 16));
  assert.ok(blind.every(row => row.format.encoding === 'pcm_s16le' && row.format.sampleRateHz === 24000));
  assert.deepEqual(wavs[0], wavs[1]);
  assert.equal(JSON.parse(await readFile(join(outputDirectory, 'ops-answer-key.json'))).length, 2);
  await assert.rejects(runLiveQualification(options), /Run already claimed/);
});

test('unverified pricing and unresolved final-flag spelling prevent all sample/provider work', async t => {
  const directory = await mkdtemp(join(tmpdir(), 'ops-refusal-')), budgetPath = join(directory, 'budget.sqlite');
  t.after(() => rm(directory, { recursive: true, force: true })); initializeQualificationBudget({ path: budgetPath });
  let calls = 0;
  const host = { runSample() { calls++; }, verifyCeiling: async () => null, verifyReceipt: async () => false, reconcile() { calls++; } };
  await assert.rejects(runLiveQualification({ operatorApproved: true, budgetPath, plan: plan(), host, outputDirectory: directory }), /Verified provider attempt ceiling/);
  const unresolved = plan(); unresolved.checks.ttsFinalFlag.spelling = 'isFinal';
  await assert.rejects(runLiveQualification({ operatorApproved: true, budgetPath, plan: unresolved, host, outputDirectory: directory }), /Adapter expects is_final/);
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

for (const leadingSilenceMs of [undefined, 0, 19999, '20000']) test(`plan refuses insufficient or undeclared leading silence: ${leadingSilenceMs}`, () => {
  const input = plan(); input.corpus[0].leadingSilenceMs = leadingSilenceMs;
  assert.throws(() => validateQualificationPlan(input), /leading silence/i);
});

function corpusWav() {
  const rate = 16000, dataBytes = rate * 21 * 2, wav = Buffer.alloc(44 + dataBytes);
  wav.write('RIFF'); wav.writeUInt32LE(wav.length - 8, 4); wav.write('WAVEfmt ', 8); wav.writeUInt32LE(16, 16);
  wav.writeUInt16LE(1, 20); wav.writeUInt16LE(1, 22); wav.writeUInt32LE(rate, 24); wav.writeUInt32LE(rate * 2, 28);
  wav.writeUInt16LE(2, 32); wav.writeUInt16LE(16, 34); wav.write('data', 36); wav.writeUInt32LE(dataBytes, 40);
  wav.writeInt16LE(10000, 44 + 20 * rate * 2); return wav;
}

test('corpus prefix is checked from the same WAV bytes before either lane, without padding or seeking', async t => {
  const directory = await mkdtemp(join(tmpdir(), 'corpus-silence-')), wavPath = join(directory, 'corpus.wav');
  t.after(() => rm(directory, { recursive: true, force: true }));
  const wav = corpusWav(), item = { wavPath, leadingSilenceMs: 20000 };
  await writeFile(wavPath, wav); await verifyCorpusLeadingSilence(item);
  wav.writeInt16LE(10000, 44 + 19 * 16000 * 2); await writeFile(wavPath, wav);
  await assert.rejects(verifyCorpusLeadingSilence(item), /leading silence/);
  await writeFile(wavPath, wav.subarray(0, 43)); await assert.rejects(verifyCorpusLeadingSilence(item), /Incomplete corpus WAV/);
});
