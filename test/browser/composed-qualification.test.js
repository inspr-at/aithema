import assert from 'node:assert/strict';
import { test } from 'node:test';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { createServer, connect } from 'node:net';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir, homedir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { startLocalQualificationHost, qualificationSettings } from '../../plugins/composed-voice/ops/qualification-server.mjs';
import { createQualificationServer } from '../fixtures/composed-qualification-provider.mjs';
import { initializeQualificationBudget } from '../../plugins/composed-voice/src/persisted-budget.js';
import { PRELIVE_CHECKS } from '../../plugins/composed-voice/src/live-qualification.js';

test('AIT-160 CLI: fake pair through different-port tunnel, admitted retry and browser device clocks', { timeout: 120_000 }, async t => {
  const directory = await mkdtemp(join(tmpdir(), 'qualification-tunnel-')), sockets = new Set();
  let local, target, child;
  const forwarder = createServer(socket => {
    const upstream = connect({ host: '127.0.0.1', port: target });
    for (const stream of [socket, upstream]) { sockets.add(stream); stream.on('close', () => sockets.delete(stream)); stream.on('error', () => { socket.destroy(); upstream.destroy(); }); }
    socket.pipe(upstream); upstream.pipe(socket);
  });
  t.after(async () => {
    child?.kill('SIGTERM'); await local?.close(); for (const socket of sockets) socket.destroy();
    forwarder.close(); await rm(directory, { recursive: true, force: true });
  });
  forwarder.listen(0, '127.0.0.1'); await once(forwarder, 'listening');
  const hostOrigin = `http://127.0.0.1:${forwarder.address().port}`;
  const authenticateRelay = request => request.headers.get('cookie') === 'aithema-visitor=fixture-owner' ? 'fixture-owner' : null;
  const ports = await createQualificationServer({ relayOrigin: hostOrigin, authenticateRelay });
  local = await startLocalQualificationHost({ ...qualificationSettings({ AITHEMA_COMPOSED_QUALIFICATION: '1',
    AITHEMA_LISTEN_HOST: '127.0.0.1', AITHEMA_COMPOSED_RELAY_ORIGIN: hostOrigin }), ...ports, authenticateRelay });
  target = Number(new URL(local.url).port);
  assert.notEqual(target, forwarder.address().port);
  assert.equal((await fetch(`${hostOrigin}/composed/qualification`)).status, 401);
  assert.equal((await fetch(`${hostOrigin}/composed/relay`, { method: 'POST', headers: { origin: 'https://fixture.invalid' } })).status, 403);

  // Fake microphone uses a real WAV: utterance, endpointing silence, barge-in.
  const wavPath = join(directory, 'corpus.wav'), rate = 48000, frames = rate * 4, wav = Buffer.alloc(44 + frames * 2);
  wav.write('RIFF'); wav.writeUInt32LE(wav.length - 8, 4); wav.write('WAVEfmt ', 8); wav.writeUInt32LE(16, 16);
  wav.writeUInt16LE(1, 20); wav.writeUInt16LE(1, 22); wav.writeUInt32LE(rate, 24); wav.writeUInt32LE(rate * 2, 28);
  wav.writeUInt16LE(2, 32); wav.writeUInt16LE(16, 34); wav.write('data', 36); wav.writeUInt32LE(frames * 2, 40);
  for (let i = 0; i < frames; i++) {
    const voiced = i < rate * 0.5 || i >= rate * 1.8;
    wav.writeInt16LE(voiced ? Math.round(Math.sin(i * 2 * Math.PI * 440 / rate) * 12_000) : 0, 44 + i * 2);
  }
  await writeFile(wavPath, wav);
  const planPath = join(directory, 'plan.json'), hostPath = join(directory, 'host.mjs'), budget = join(directory, 'qualification.sqlite'), output = join(directory, 'evidence');
  initializeQualificationBudget({ path: budget });
  const plan = { runId: 'tunnel-fake-proof', corpus: [{ id: 'one', wavPath, reference: 'Wien' }],
    ceilingChecks: [{ provider: 'fixture', model: 'fixture', operation: 'stream', accountRef: 'offline-fixture',
      endpoint: 'https://fixture.invalid/stream', maxMicro: 100, request: { fixture: true } }],
    checks: Object.fromEntries(PRELIVE_CHECKS.map(key => [key, { verified: true, reference: 'FAKE ONLY; no live qualification',
      ...(key === 'ttsFinalFlag' ? { spelling: 'is_final' } : {}) }])) };
  await writeFile(planPath, JSON.stringify(plan));
  await writeFile(hostPath, `
import { createQualificationHost as template } from ${JSON.stringify(new URL('../../plugins/composed-voice/ops/qualification-host-template.mjs', import.meta.url).href)};
import launcher from ${JSON.stringify(new URL('./launch.js', import.meta.url).href)};
import { browserPath } from ${JSON.stringify(new URL('../../scripts/install-test-browser.js', import.meta.url).href)};
export async function createQualificationHost() {
  return template({ hostOrigin: ${JSON.stringify(hostOrigin)}, runDirectory: ${JSON.stringify(directory)},
    ownerHeaders: { cookie: 'aithema-visitor=fixture-owner' }, executablePath: await browserPath(), launchBrowser: launcher.launch,
    launchArgs: process.platform === 'linux' && process.env.CI ? ['--no-sandbox'] : [],
    verifyCeiling: async spec => ({ ...spec, verified: true, reference: 'fake price evidence', expiresAt: Date.now() + 60000 }),
    verifyReceipt: async () => true,
    async reconcile({ snapshot, reconcile }) {
      for (const row of snapshot.records.filter(row => row.state === 'settled' && !row.receipt)) {
        await reconcile({ attemptId: row.attemptId, receiptId: row.attemptId, provider: row.provider, model: row.model,
          operation: row.operation, accountRef: row.accountRef, endpoint: row.endpoint, chargedMicro: 1, estimated: false });
      }
    },
  });
}
`);
  child = spawn(process.execPath, [fileURLToPath(new URL('../../scripts/composed-qualification.js', import.meta.url)),
    '--operator-approved', '--budget', budget, '--plan', planPath, '--host', hostPath, '--out', output],
  { env: { PATH: process.env.PATH, HOME: homedir(), TMPDIR: process.env.TMPDIR,
    ...(process.env.CHROME_PATH ? { CHROME_PATH: process.env.CHROME_PATH } : {}), ...(process.env.CI ? { CI: process.env.CI } : {}) } });
  let stdout = '', stderr = '';
  child.stdout.on('data', bytes => { stdout += bytes; }); child.stderr.on('data', bytes => { stderr += bytes; });
  const [code] = await once(child, 'exit');
  assert.equal(code, 0, `${stderr}\nFixture dispatches: ${JSON.stringify(ports.dispatches)}`); assert.match(stdout, /tunnel-fake-proof/);
  const report = JSON.parse(await readFile(join(output, 'report.json'))), observations = JSON.parse(await readFile(join(output, 'observations.json')));
  assert.equal(report.candidate.wer, 0); assert.equal(report.baseline.wer, 0); assert.equal(report.candidate.qualified, false);
  assert.equal(report.budget.records.length, 8); assert.equal(ports.dispatches.length, 8);
  assert.deepEqual(new Set(report.budget.records.map(row => row.attemptId)), new Set(ports.dispatches));
  assert.equal(report.budget.records.filter(row => row.retryOf).length, 2);
  assert.ok(report.budget.records.every(row => row.state === 'settled' && row.receipt && row.dispatchedAt));
  for (const lane of ['candidate', 'baseline']) {
    const { trace, speechEndAt, firstAudioAt, bargeInAt, stoppedAt } = observations[lane][0];
    assert.ok(speechEndAt < firstAudioAt && firstAudioAt <= bargeInAt && bargeInAt <= stoppedAt);
    assert.ok(trace.some(event => event.kind === 'capture' && Number.isFinite(event.captureFrame) && event.contextSampleRate === 16000));
    assert.ok(trace.some(event => event.kind === 'playback-start' && event.outputTimestamp.contextTime > 0 && event.outputTimestamp.performanceTime > 0));
    assert.ok(trace.some(event => event.kind === 'playback-stop' && event.outputTimestamp));
  }
  assert.equal(JSON.parse(await readFile(join(output, 'blind.json'))).length, 2);
  if (process.env.AITHEMA_EVIDENCE_DIR) {
    await mkdir(process.env.AITHEMA_EVIDENCE_DIR, { recursive: true });
    await writeFile(join(process.env.AITHEMA_EVIDENCE_DIR, 'ait-160-tunnel-cli.json'), JSON.stringify({
      fixtureOnly: true, bindPort: target, browserOrigin: hostOrigin, report, observations, dispatches: ports.dispatches,
    }, null, 2));
  }
});
