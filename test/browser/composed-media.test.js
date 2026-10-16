import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir, homedir } from 'node:os';
import { join } from 'node:path';
import puppeteer from './launch.js';
import { browserPath } from '../../scripts/install-test-browser.js';
import { startChild } from '../helpers.js';

test('AIT-160: fake-device AudioWorklet PCM, authenticated relay, physical player, holds and recovery', { timeout: 90_000 }, async t => {
  const directory = await mkdtemp(join(tmpdir(), 'composed-browser-'));
  const fixture = await startChild(new URL('../fixtures/composed-media-server.js', import.meta.url), join(directory, 'unused.sqlite'));
  let browser;
  t.after(async () => { await browser?.close(); await fixture.kill(); await rm(directory, { recursive: true, force: true }); });
  browser = await puppeteer.launch({ executablePath: await browserPath(), headless: true, userDataDir: join(directory, 'chrome'),
    env: { PATH: process.env.PATH, HOME: homedir() }, args: ['--use-fake-device-for-media-stream', '--use-fake-ui-for-media-stream',
      '--autoplay-policy=no-user-gesture-required', ...(process.platform === 'linux' && process.env.CI ? ['--no-sandbox'] : [])] });
  const context = browser.defaultBrowserContext(); await context.overridePermissions(fixture.url, ['microphone']);
  const page = await browser.newPage(), problems = [], external = [];
  await page.setViewport({ width: 1100, height: 760 });
  await page.emulateMediaFeatures([{ name: 'prefers-reduced-motion', value: 'reduce' }]);
  page.on('pageerror', error => problems.push(error.message));
  await page.setRequestInterception(true);
  page.on('request', request => {
    if (!request.url().startsWith(fixture.url) && !request.url().startsWith('data:')) { external.push(request.url()); void request.abort(); }
    else void request.continue();
  });
  await page.goto(fixture.url);
  await page.evaluate(async () => {
    const { createComposedBrowserMedia } = await import('/plugins/composed-voice/src/client.js');
    const { createNetworkRelayClient } = await import('/plugins/composed-voice/src/network-client.js');
    const { createPCMCapture, createPCMPlayer } = await import('/plugins/composed-voice/src/browser-audio.js');
    window.timings = []; window.failures = []; window.events = [];
    const onTiming = event => window.timings.push(event);
    window.player = createPCMPlayer({ onTiming });
    const physical = createPCMCapture({ AudioContext: class extends AudioContext { constructor() { super({ sampleRate: 48000 }); } }, onTiming, onFault: error => window.failures.push(error.message) });
    window.captureStops = 0; window.captures = 0;
    const capture = async options => {
      const recording = await physical(options); window.captures++;
      return { stop() { window.captureStops++; recording.stop(); } };
    };
    const grant = () => fetch('/grant').then(response => response.json());
    const media = createComposedBrowserMedia({ capture, player: window.player,
      openRelay: createNetworkRelayClient({ headers: { 'x-owner': 'fixture-owner' } }), control: { recover: grant } });
    window.session = await media.connect(await grant());
    void (async () => { for await (const event of window.session.events) window.events.push(event); })();
  });
  await page.waitForFunction(() => window.timings.some(event => event.kind === 'playback-start'));
  const physical = await page.evaluate(async () => ({ stats: await fetch('/stats').then(r => r.json()),
    timings: window.timings, failures: window.failures }));
  assert.ok(physical.stats.packets >= 4); assert.equal(physical.stats.maxPacket, 1280);
  assert.ok(physical.timings.some(e => e.kind === 'capture' && Number.isFinite(e.captureFrame) && e.contextSampleRate === 48000));
  assert.ok(physical.timings.some(e => e.kind === 'playback-scheduled' && e.format === 'pcm_s16le' && e.sampleRateHz === 24000));
  assert.deepEqual(physical.failures, []);
  const immediate = await page.evaluate(async () => {
    const bytes = new Uint8Array(48_000);
    const a = window.player.play(bytes, { format: 'pcm_s16le', sampleRateHz: 24000, channels: 1 });
    const b = window.player.play(new Uint8Array(96_000), { format: 'pcm_f32le', sampleRateHz: 24000, channels: 1 });
    const scheduled = window.timings.filter(e => e.kind === 'playback-scheduled').slice(-2);
    const before = window.timings.length, pending = window.session.interrupt();
    const stoppedSynchronously = window.timings.slice(before).some(e => e.kind === 'playback-stop');
    await pending; await Promise.all([a, b]); return { scheduled, stoppedSynchronously };
  });
  assert.equal(immediate.stoppedSynchronously, true);
  assert.ok(immediate.scheduled[1].contextStart >= immediate.scheduled[0].contextStart + 1);
  const pause = await page.evaluate(async () => {
    const before = window.captureStops, pending = window.session.pause();
    const stoppedSynchronously = window.captureStops > before; await pending;
    await window.session.resume(); return { stoppedSynchronously, captures: window.captures };
  });
  assert.equal(pause.stoppedSynchronously, true); assert.equal(pause.captures, 2);
  await page.evaluate(() => fetch('/drop'));
  await page.waitForFunction(() => window.captures === 3);
  assert.equal(await page.evaluate(() => window.events.filter(e => e.type === 'recovered').length), 2);
  await page.evaluate(async () => {
    await window.session.setInput(false); await window.session.setOutput(false);
    await fetch('/drop');
  });
  await page.waitForFunction(() => window.events.filter(e => e.type === 'recovered').length === 3);
  assert.equal(await page.evaluate(() => window.captures), 3);
  await page.evaluate(async () => { await window.session.close(); await window.player.close(); });
  const latePermission = await page.evaluate(async () => {
    const { createPCMCapture } = await import('/plugins/composed-voice/src/browser-audio.js');
    const stream = await navigator.mediaDevices.getUserMedia({ audio: true }), permission = Promise.withResolvers(), controller = new AbortController();
    const pending = createPCMCapture({ mediaDevices: { getUserMedia: () => permission.promise } })({ signal: controller.signal, onAudio() {} });
    controller.abort(); permission.resolve(stream);
    try { await pending; return false; } catch (error) { return error.name === 'AbortError' && stream.getTracks().every(track => track.readyState === 'ended'); }
  });
  assert.equal(latePermission, true);
  // Headless-shell needs the fake permission UI for capture. An enforced
  // Permissions-Policy denial exercises the browser's real NotAllowedError path.
  await page.goto(fixture.url + '/denied');
  const permission = await page.evaluate(async () => {
    const { createPCMCapture } = await import('/plugins/composed-voice/src/browser-audio.js');
    try { const unexpected = await createPCMCapture()({ onAudio() {} }); unexpected.stop(); return 'unexpected-grant'; } catch (error) { return error.name; }
  });
  assert.equal(permission, 'NotAllowedError'); assert.deepEqual(external, []); assert.deepEqual(problems, []);
  const evidence = process.env.AITHEMA_EVIDENCE_DIR;
  if (evidence) {
    await mkdir(evidence, { recursive: true });
    const report = { physical, immediate, pause, permission, latePermission, external, problems };
    await writeFile(join(evidence, 'ait-160-physical-media.json'), JSON.stringify(report, null, 2));
    await page.evaluate(report => { document.querySelector('#proof').textContent = JSON.stringify({ packets: report.physical.stats.packets,
      packetBytes: report.physical.stats.maxPacket, format: 'PCM16 mono 16 kHz capture / PCM16 + Float32 24 kHz playback',
      synchronousBargeInStop: report.immediate.stoppedSynchronously, pause: report.pause, permissionDenial: report.permission,
      recovery: 'fresh generation; channel holds preserved', providerCalls: 0 }, null, 2); }, report);
    await page.evaluate(() => document.fonts.ready);
    await page.screenshot({ path: join(evidence, 'ait-160-physical-media.png'), fullPage: false });
  }
});
