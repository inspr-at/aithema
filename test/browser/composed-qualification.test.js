import assert from 'node:assert/strict';
import { test } from 'node:test';
import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { once } from 'node:events';
import { createServer, connect } from 'node:net';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir, homedir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { initializeQualificationBudget } from '../../plugins/composed-voice/src/persisted-budget.js';
import { PRELIVE_CHECKS } from '../../plugins/composed-voice/src/live-qualification.js';
import { browserPath } from '../../scripts/install-test-browser.js';
import puppeteer from './launch.js';
import { connect as connectBrowser } from 'puppeteer-core';
import { readBrowserEvidence, combineOutputEvidence } from '../../plugins/composed-voice/ops/qualification-output-probe.mjs';

test('AIT-160 actual Chrome command line: connected output switches and unavailable arguments refuse; clean local passes', { timeout: 90_000 }, async () => {
  for (const flag of ['--disable-audio-output', '-disable-audio-output', 'unavailable', 'clean', 'connected-clean']) {
    const browser = await puppeteer.launch({ headless: true,
      ignoreDefaultArgs: ['--mute-audio', ...(flag === 'unavailable' ? ['--enable-automation'] : [])],
      args: [...(flag.startsWith('-') ? [flag] : []), ...(process.platform === 'linux' && process.env.CI ? ['--no-sandbox'] : [])] });
    let connected;
    try {
      if (flag !== 'clean') connected = await connectBrowser({ browserWSEndpoint: browser.wsEndpoint() });
      if (connected) assert.equal(connected.process(), null);
      const evidence = await readBrowserEvidence(connected ?? browser);
      assert.equal(evidence.browserUser.verified, flag !== 'unavailable');
      assert.equal(evidence.browserUser.pidSource, 'CDP SystemInfo.getProcessInfo');
      assert.equal(evidence.browserUser.pid, browser.process().pid);
      if (flag !== 'unavailable') {
        assert.equal(evidence.browserUser.uid, process.getuid());
        assert.equal(evidence.browserUser.executable, evidence.commandLine.arguments[0]);
      }
      assert.equal(evidence.commandLine.verified, flag !== 'unavailable');
      const output = combineOutputEvidence({ renderingVerified: true, outputLatency: 0.016 }, { verified: true, uid: process.getuid() }, evidence);
      assert.equal(output.verified, ['clean', 'connected-clean'].includes(flag));
      assert.deepEqual(output.refusedOutputFlags, flag.startsWith('-') ? [flag] : []);
      if (flag === 'clean') {
        const mismatched = await readBrowserEvidence({ target: () => browser.target(),
          process: () => ({ pid: browser.process().pid + 1 }) });
        assert.equal(mismatched.browserUser.verified, false, 'Real CDP PID must match local launcher PID');
        assert.equal(combineOutputEvidence({ renderingVerified: true }, { verified: true, uid: process.getuid() }, mismatched).verified, false);
      }
    } finally { await connected?.disconnect(); await browser.close(); }
  }
});

test('AIT-160 CLI: output-device gate before fake pair through different-port tunnel', { timeout: 120_000 }, async t => {
  const directory = await mkdtemp(join(tmpdir(), 'qualification-tunnel-')), sockets = new Set();
  let target, child;
  const targetFile = join(directory, 'server-port.json'), dispatchFile = join(directory, 'dispatches.json');
  const forwarder = createServer(socket => {
    target ??= JSON.parse(readFileSync(targetFile)).port;
    const upstream = connect({ host: '127.0.0.1', port: target });
    // Match an interactive ssh tunnel: tiny PCM POSTs must not wait for Nagle's
    // delayed ACK cycle on either half of this byte-for-byte TCP forwarder.
    socket.setNoDelay(true); upstream.setNoDelay(true);
    for (const stream of [socket, upstream]) { sockets.add(stream); stream.on('close', () => sockets.delete(stream)); stream.on('error', () => { socket.destroy(); upstream.destroy(); }); }
    socket.pipe(upstream); upstream.pipe(socket);
  });
  t.after(async () => {
    child?.kill('SIGTERM'); for (const socket of sockets) socket.destroy();
    forwarder.close(); await rm(directory, { recursive: true, force: true });
  });
  forwarder.listen(0, '127.0.0.1'); await once(forwarder, 'listening');
  const hostOrigin = `http://127.0.0.1:${forwarder.address().port}`;
  const sentinel = 'SENTINEL_FAKE_KEYS_FILE_NO_PROVIDER';
  const keysFile = join(directory, 'provider.keys');
  await writeFile(keysFile, `ELEVENLABS_API_KEY=${sentinel}\nOPENROUTER_API_KEY=${sentinel}\n`, { mode: 0o600 });
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
  const plan = { runId: 'tunnel-fake-proof', corpus: [{ id: 'one', wavPath, reference: 'Wien', expected: 'Wien' }],
    ceilingChecks: [{ provider: 'fixture', model: 'fixture', operation: 'stream', accountRef: 'offline-fixture',
      endpoint: 'https://fixture.invalid/stream', maxMicro: 100, request: { fixture: true } }],
    checks: Object.fromEntries(PRELIVE_CHECKS.map(key => [key, { verified: true, reference: 'FAKE ONLY; no live qualification',
      ...(key === 'ttsFinalFlag' ? { spelling: 'is_final' } : {}) }])) };
  await writeFile(planPath, JSON.stringify(plan));
  await writeFile(hostPath, `
import { createQualificationHost as template } from ${JSON.stringify(new URL('../../plugins/composed-voice/ops/qualification-host-template.mjs', import.meta.url).href)};
import { browserPath } from ${JSON.stringify(new URL('../../scripts/install-test-browser.js', import.meta.url).href)};
import { startLocalQualificationHost, loadQualificationControl } from ${JSON.stringify(new URL('../../plugins/composed-voice/ops/qualification-server.mjs', import.meta.url).href)};
import { createQualificationServer } from ${JSON.stringify(new URL('../fixtures/composed-qualification-provider.mjs', import.meta.url).href)};
import { writeFile } from 'node:fs/promises';
import { startFakeProductionOrigin } from ${JSON.stringify(new URL('../fixtures/qualification-production-origin.mjs', import.meta.url).href)};
export async function createQualificationHost({ keysFile, sampleTimeoutMs, controlFile, controlCapability }) {
  if (keysFile !== ${JSON.stringify(keysFile)}) throw new Error("CLI keys-file path not forwarded");
  const authenticateRelay = request => request.headers.get('cookie') === 'aithema-visitor=fixture-owner' ? 'fixture-owner' : null;
  const ports = await createQualificationServer({ relayOrigin: ${JSON.stringify(hostOrigin)}, authenticateRelay });
  const control = await loadQualificationControl({ AITHEMA_COMPOSED_QUALIFICATION: '1', AITHEMA_COMPOSED_CONTROL_FILE: controlFile });
  const local = await startLocalQualificationHost({ enabled: true, hostname: '127.0.0.1', relayOrigin: ${JSON.stringify(hostOrigin)},
    ...ports, authenticateRelay, keysFile, control });
  await writeFile(${JSON.stringify(targetFile)}, JSON.stringify({ port: Number(new URL(local.url).port) }));
  const production = await startFakeProductionOrigin(${JSON.stringify(directory)});
  const baselineAuthFile = ${JSON.stringify(join(directory, 'baseline-auth.json'))};
  await writeFile(baselineAuthFile, JSON.stringify({username:production.username,password:production.password}), {mode:0o600});
  let baselineAttemptId;
  const host = template({ binding: {baselineOrigin:production.origin,baselineAuthFile,maxDurationSeconds:10,
      baseline:{plugin:'fixture',model:'fixture',agentId:'fixture-agent',accountRef:'offline-fixture',endpoint:'https://fixture.invalid/stream',microPerMinute:600}},
    consentDecision:{items:['voice-elevenlabs','models-international']}, controlCapability, hostOrigin: ${JSON.stringify(hostOrigin)}, runDirectory: ${JSON.stringify(directory)},
    ownerHeaders: { cookie: 'aithema-visitor=fixture-owner' }, executablePath: await browserPath(), sampleTimeoutMs,
    launchArgs: [...production.launchArgs,...(process.platform === 'linux' && process.env.CI ? ['--no-sandbox'] : [])],
    verifyCeiling: async spec => ({ ...spec, verified: true, reference: 'fake price evidence', expiresAt: Date.now() + 60000 }),
    verifyReceipt: async () => true,
    async reconcile({ snapshot, reconcile }) {
      for (const row of snapshot.records.filter(row => row.state === 'settled' && !row.receipt)) {
        await reconcile({ attemptId: row.attemptId, receiptId: row.attemptId, provider: row.provider, model: row.model,
          operation: row.operation, accountRef: row.accountRef, endpoint: row.endpoint, chargedMicro: 1, estimated: false });
      }
    },
  });
  return { ...host, runSample(input) { return host.runSample({...input,admit(spec) { if(input.lane==='baseline')baselineAttemptId=spec.attemptId;return input.admit(spec); }}); }, async close() {
    try { await host.close(); } finally { await local.close(); await production.close(); await writeFile(${JSON.stringify(dispatchFile)}, JSON.stringify([...ports.dispatches,...production.dispatches.map(()=>baselineAttemptId)])); }
  } };
}
`);
  if (process.platform === 'darwin') {
    for (const [name, args] of [
      ['with-fake-capture', ['--fake-capture-wav', wavPath]],
      ['without-fake-capture', []],
      ['forced-fake-output', ['--fake-capture-wav', wavPath, '--force-fake-output']],
      ['forced-missing-output', ['--fake-capture-wav', wavPath, '--force-missing-output']],
    ]) {
      const reportPath = join(directory, `${name}.json`);
      const probeChild = spawn(process.execPath, [fileURLToPath(new URL('../../plugins/composed-voice/ops/qualification-output-probe.mjs', import.meta.url)),
        '--report', reportPath, '--executable-path', await browserPath(), ...args], {
        env: { PATH: process.env.PATH, HOME: homedir(), TMPDIR: process.env.TMPDIR }, stdio: ['ignore', 'pipe', 'pipe'],
      });
      t.after(() => probeChild.kill('SIGTERM'));
      let probeError = ''; probeChild.stdout.resume(); probeChild.stderr.on('data', bytes => { probeError += bytes; });
      const [probeCode] = await once(probeChild, 'exit');
      const standalone = JSON.parse(await readFile(reportPath)), media = standalone.physicalBrowserMedia;
      console.log(`AIT-160 standalone probe (${name}): ${JSON.stringify(standalone)}`);
      if (process.env.AITHEMA_EVIDENCE_DIR) {
        await mkdir(process.env.AITHEMA_EVIDENCE_DIR, { recursive: true });
        await writeFile(join(process.env.AITHEMA_EVIDENCE_DIR, `ait-160-output-${name}.json`), JSON.stringify(standalone, null, 2));
      }
      assert.equal(probeCode, media.verified ? 0 : 1, probeError);
      assert.equal(media.commandLine.verified, true);
      assert.equal(media.browserUser.verified, true);
      assert.equal(media.browserUser.uid, process.getuid());
      assert.equal(media.osDefaultOutput.uid, process.getuid());
      assert.equal(media.verified, media.renderingVerified && media.osDefaultOutput.verified && media.refusedOutputFlags.length === 0);
      if (name.startsWith('forced-')) {
        assert.equal(media.verified, false, 'Chrome fake/missing output must refuse even when the OS has speakers');
        assert.deepEqual(media.refusedOutputFlags, [name === 'forced-fake-output' ? '--disable-audio-output' : '--fail-audio-stream-creation']);
      }
      if (name === 'forced-missing-output') {
        assert.equal(media.renderingVerified, false);
        assert.ok(media.outputLatency === 0 || ['contextTime', 'performanceTime'].some(key =>
          media.after?.[key] <= media.before?.[key]), 'Measure zero latency or stalled timestamps with output stream creation refused');
      }
    }
  }
  child = spawn(process.execPath, [fileURLToPath(new URL('../../scripts/composed-qualification.js', import.meta.url)),
    '--operator-approved', '--budget', budget, '--plan', planPath, '--host', hostPath, '--out', output, '--keys-file', keysFile],
  { env: { PATH: process.env.PATH, HOME: homedir(), TMPDIR: process.env.TMPDIR,
    ...(process.env.CHROME_PATH ? { CHROME_PATH: process.env.CHROME_PATH } : {}), ...(process.env.CI ? { CI: process.env.CI } : {}) } });
  let stdout = '', stderr = '';
  child.stdout.on('data', bytes => { stdout += bytes; }); child.stderr.on('data', bytes => { stderr += bytes; });
  const [code] = await once(child, 'exit');
  assert.ok(!(stdout + stderr).includes(sentinel), 'Keys must never reach logs/errors');
  const ports = { dispatches: JSON.parse(await readFile(dispatchFile)) };
  assert.notEqual(target, forwarder.address().port);
  const run = createHash('sha256').update('tunnel-fake-proof').digest('hex').slice(0, 24);
  const probe = JSON.parse(await readFile(join(directory, run, 'candidate-physical-browser-media.json'))).physicalBrowserMedia;
  console.log(`AIT-160 output-device probe (${process.platform}, ${homedir()}): ${JSON.stringify(probe)}`);
  if (process.env.AITHEMA_EVIDENCE_DIR) {
    await mkdir(process.env.AITHEMA_EVIDENCE_DIR, { recursive: true });
    await writeFile(join(process.env.AITHEMA_EVIDENCE_DIR, 'ait-160-output-device-probe.json'), JSON.stringify({ physicalBrowserMedia: probe }, null, 2));
  }
  if (!probe.verified) {
    assert.notEqual(code, 0); assert.match(stderr, /null or unverified audio output device/);
    assert.equal(ports.dispatches.length, 0, 'Null device must refuse before any dispatch');
    assert.equal(JSON.parse(await readFile(join(output, 'budget-final.json'))).records.length, 0);
    return;
  }
  assert.equal(code, 0, `${stderr}\nFixture dispatches: ${JSON.stringify(ports.dispatches)}`); assert.match(stdout, /tunnel-fake-proof/);
  const report = JSON.parse(await readFile(join(output, 'report.json'))), observations = JSON.parse(await readFile(join(output, 'observations.json')));
  assert.equal(report.candidate.wer, 0); assert.equal(report.baseline.wer, 0); assert.equal(report.candidate.qualified, false);
  assert.equal(report.budget.records.length, 5); assert.equal(ports.dispatches.length, 5);
  assert.deepEqual(new Set(report.budget.records.map(row => row.attemptId)), new Set(ports.dispatches));
  assert.equal(report.budget.records.filter(row => row.retryOf).length, 1);
  assert.ok(report.budget.records.every(row => row.state === 'settled' && row.receipt && row.dispatchedAt));
  for (const lane of ['candidate', 'baseline']) {
    const { trace, speechEndAt, firstAudioAt, bargeInAt, stoppedAt, physicalBrowserMedia } = observations[lane][0];
    assert.equal(physicalBrowserMedia.verified, true);
    assert.equal(physicalBrowserMedia.renderingVerified, true);
    assert.equal(physicalBrowserMedia.osDefaultOutput.verified, true);
    assert.ok(['', 'default'].includes(physicalBrowserMedia.sinkId));
    assert.ok(physicalBrowserMedia.outputLatency > 0);
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

import { startFakeProductionOrigin } from '../fixtures/qualification-production-origin.mjs';
import { runProductionBaseline } from '../../plugins/composed-voice/ops/qualification-production-baseline.mjs';
import { createQualificationMediaProbe } from '../../plugins/composed-voice/src/live-qualification.js';

test('AIT-160 production baseline: injected probe captures PCM and final utterance; CDP auth stays on its origin', { timeout: 60_000 }, async t => {
  const directory = await mkdtemp(join(tmpdir(), 'qualification-production-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  // Same corpus WAV timeline as the CLI fixture above (0..0.5 s speech,
  // silence until 1.8 s, then barge-in), not asserted quality thresholds.
  const rate = 48000, frames = rate * 4, wav = Buffer.alloc(44 + frames * 2), wavPath = join(directory, 'corpus.wav');
  wav.write('RIFF'); wav.writeUInt32LE(wav.length - 8, 4); wav.write('WAVEfmt ', 8); wav.writeUInt32LE(16, 16);
  wav.writeUInt16LE(1, 20); wav.writeUInt16LE(1, 22); wav.writeUInt32LE(rate, 24); wav.writeUInt32LE(rate * 2, 28);
  wav.writeUInt16LE(2, 32); wav.writeUInt16LE(16, 34); wav.write('data', 36); wav.writeUInt32LE(frames * 2, 40);
  for (let i = 0; i < frames; i++) wav.writeInt16LE(i < rate * .5 || i >= rate * 1.8 ? Math.round(Math.sin(i * 2 * Math.PI * 440 / rate) * 12000) : 0, 44 + i * 2);
  await writeFile(wavPath, wav);
  for (const mediaElement of [false, true]) await t.test(mediaElement ? 'WebRTC media element' : 'Web Audio output', async () => {
    const production = await startFakeProductionOrigin(directory, { mediaElement });
    const browser = await puppeteer.launch({ headless: true, ignoreDefaultArgs: ['--mute-audio'],
      args: [...production.launchArgs, ...(process.platform === 'linux' ? ['--no-sandbox'] : []),
        // Test-only fake renderer makes this hermetic on CI hosts with no audio
        // hardware. The real launcher refuses this flag before admission.
        '--disable-audio-output', '--disable-features=AudioServiceSandbox', '--use-fake-device-for-media-stream', `--use-file-for-fake-audio-capture=${wavPath}`,
        '--use-fake-ui-for-media-stream', '--autoplay-policy=no-user-gesture-required'] });
    const page = await browser.newPage(), logs = [], reports = [], identities = [], probe = createQualificationMediaProbe();
    page.on('console', message => logs.push(message.text())); page.on('pageerror', error => logs.push(error.message));
    const abort = new AbortController(); let watchdog;
    const expired = new Promise((_, reject) => abort.signal.addEventListener('abort', () => reject(abort.signal.reason), { once: true }));
    expired.catch(() => {});
    let result;
    try {
      await browser.defaultBrowserContext().overridePermissions(production.origin, ['microphone']);
      result = await runProductionBaseline({ page, binding: { baselineOrigin: production.origin, maxDurationSeconds: 8,
        baseline: { plugin: 'elevenlabs', model: 'fake-agent', agentId: 'fake-agent', accountRef: 'fixture-account', endpoint: 'https://api.elevenlabs.io', microPerMinute: 600 } },
        item: { id: 'fake-corpus' }, runId: 'production-fixture', auth: { username: production.username, password: production.password },
        consentDecision: { items: ['voice-elevenlabs', 'models-international'] }, onTiming: probe.onTiming,
        bounded: value => Promise.race([value, expired]), abort: reason => abort.abort(reason),
        preflight: async () => ({ fixtureOnly: true, verified: false }), recordIdentity: async identity => identities.push(identity),
        boundConversation: async deadline => { watchdog = setTimeout(() => abort.abort(new Error('fixture duration watchdog')), deadline - Date.now()); },
        admit: async spec => {
          assert.equal(production.dispatches.length, 0, 'durable admission precedes production conversation');
          // Source: binding 600 micro/min * 8 s / 60 = 80 micro.
          assert.equal(spec.maxMicro, 80);
          return { attempt: { async consume() { assert.equal(production.dispatches.length, 0); } }, report: async terminal => reports.push(terminal) };
        },
      });
      const evidence = probe.evidence();
      assert.ok(evidence.speechEndAt < evidence.firstAudioAt && evidence.firstAudioAt <= evidence.bargeInAt && evidence.bargeInAt <= evidence.stoppedAt);
      assert.equal(result.hypothesis, 'Wien', 'later final barge-in phrase is excluded');
      assert.ok(result.ttsPCM.byteLength > 0); assert.equal(result.ttsFormat.encoding, 'pcm_f32le');
      assert.equal(result.baselineSession.visitorSessionId, 'production-visitor');
      assert.equal(result.baselineSession.providerSessionId, 'conv_production');
      assert.equal(production.dispatches.length, 1); assert.ok(production.stopped >= 1);
      assert.equal(reports.length, 1); assert.equal(reports[0].outcome, 'uncertain'); assert.equal(reports[0].chargedMicro, undefined);
      assert.ok(production.requests.length > 0);
      assert.ok(production.requests.every(request => !request.authorization), 'other origin never receives cached/preemptive basic auth');
      assert.doesNotMatch(JSON.stringify({ evidence, identities, result, logs, requests: production.requests }), /SYNTHETIC_BASIC_AUTH_SENTINEL|fixture-operator|x-aithema-qualification-control|LOOPBACK_OWNER|API_KEY/);
      if (process.env.AITHEMA_EVIDENCE_DIR) {
        await mkdir(process.env.AITHEMA_EVIDENCE_DIR, { recursive: true });
        await writeFile(join(process.env.AITHEMA_EVIDENCE_DIR, `ait-160-production-${mediaElement ? 'webrtc' : 'web-audio'}.json`),
          JSON.stringify({ fixtureOnly: true, evidence, baselineSession: result.baselineSession, pcmBytes: result.ttsPCM.byteLength,
            format: result.ttsFormat, reports, otherOriginRequests: production.requests }, null, 2));
      }
    } catch (error) {
      error.message += `; fixture logs: ${JSON.stringify(logs)}; probe: ${JSON.stringify(await page.evaluate(() => window.qualificationBaselineProbe?.diagnostics()).catch(() => null))}`; throw error;
    } finally { clearTimeout(watchdog); await browser.close(); await production.close(); }
  });
});
