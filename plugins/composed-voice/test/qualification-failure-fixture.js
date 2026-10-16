import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PRELIVE_CHECKS, runLiveQualification } from '../src/live-qualification.js';
import { initializeQualificationBudget } from '../src/persisted-budget.js';
import { fixtureVoiceSettings } from '../../elevenlabs/test/component-fixtures.js';

/** Exercise AIT-254's real coordinator/storage path around a failing media lane. */
export const assertNoFailureDiagnostic = (t, runSample, lane = 'candidate') => assertFailureDiagnostic(t, runSample, lane, true);

export async function assertFailureDiagnostic(t, runSample, lane = 'candidate', succeeds = false) {
  const directory = await mkdtemp(join(tmpdir(), 'qualification-error-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const budgetPath = join(directory, 'budget.sqlite'), outputDirectory = join(directory, 'evidence'), path = join(directory, 'input.wav');
  initializeQualificationBudget({ path: budgetPath });
  const wav = Buffer.alloc(46);
  wav.write('RIFF'); wav.writeUInt32LE(38, 4); wav.write('WAVEfmt ', 8); wav.writeUInt32LE(16, 16);
  wav.writeUInt16LE(1, 20); wav.writeUInt16LE(1, 22); wav.writeUInt32LE(16000, 24); wav.writeUInt16LE(2, 32);
  wav.writeUInt16LE(16, 34); wav.write('data', 36); wav.writeUInt32LE(2, 40);
  await writeFile(path, wav);
  const plan = { runId: 'media-error', corpus: [{ reference: 'Wien', utterancePath: path, bargeInPath: path }],
    checks: Object.fromEntries(PRELIVE_CHECKS.map(key => [key, { verified: true, reference: 'offline fixture',
      ...(key === 'ttsFinalFlag' ? { spelling: 'isFinal' } : {}) }])),
    ceilingChecks: [{ provider: 'fixture', model: 'fixture', accountRef: 'fixture', endpoint: 'https://fixture.invalid',
      operation: 'stream', maxMicro: 100, request: {} }] };
  const host = { verifyCeiling: async value => ({ ...value, verified: true, reference: 'offline fixture', expiresAt: Date.now() + 60000 }),
    verifyReceipt: async () => true, async reconcile() {},
    async runSample(input) {
      if (input.lane === lane && !succeeds) return runSample(input);
      if (input.lane === lane) await runSample(input);
      else [{ kind: 'capture', captureAt: 1, voiced: true, durationMs: 4 }, { kind: 'playback-start', firstAudioAt: 10 },
        { kind: 'capture', captureAt: 810, voiced: true, durationMs: 64 }, { kind: 'playback-stop', stoppedAt: 910 }].forEach(input.onTiming);
      return { hypothesis: 'Wien', entities: [{ expected: 'Wien', actual: 'Wien' }], ttsConfig: { model: 'fixture', voiceId: 'fixture', voiceSettings: fixtureVoiceSettings },
        ttsPCM: new Uint8Array([0, 32]), ttsFormat: { encoding: 'pcm_s16le', sampleRateHz: 16000, channels: 1 } };
    } };
  if (succeeds) {
    await runLiveQualification({ operatorApproved: true, plan, host, budgetPath, outputDirectory });
    await assert.rejects(readFile(join(outputDirectory, 'failure.json')), { code: 'ENOENT' });
    const observations = JSON.parse(await readFile(join(outputDirectory, 'observations.json')));
    assert.equal(observations[lane][0].trace.filter(e => e.kind === 'post-measurement').length, 3);
    return;
  }
  await assert.rejects(runLiveQualification({ operatorApproved: true, plan, host, budgetPath, outputDirectory }));
  const failurePath = join(outputDirectory, 'failure.json'), record = JSON.parse(await readFile(failurePath));
  assert.equal(record.phase, 'runSample'); assert.equal(record.lane, lane); assert.equal(record.sample, 1);
  assert.equal((await stat(failurePath)).mode & 0o777, 0o600);
  assert.match(record.message, /^Error sha256:[a-f0-9]{64}$/u);
  assert.doesNotMatch(JSON.stringify(record), /hypothesis|ttsPCM|stack|cause/u);
}
