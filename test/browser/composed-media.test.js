import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir, homedir } from 'node:os';
import { join } from 'node:path';
import puppeteer from './launch.js';
import { browserPath } from '../../scripts/install-test-browser.js';
import { startChild } from '../helpers.js';

const chromeSandboxArgs = process.platform === 'linux' && process.env.CI ? ['--no-sandbox'] : [];
const evidence = process.env.AITHEMA_EVIDENCE_DIR;

test('AIT-160: fake-device AudioWorklet PCM, authenticated relay, physical player, holds and recovery', { timeout: 90_000 }, async t => {
  const directory = await mkdtemp(join(tmpdir(), 'composed-browser-'));
  const fixture = await startChild(new URL('../fixtures/composed-media-server.js', import.meta.url), join(directory, 'unused.sqlite'));
  let browser;
  t.after(async () => { await browser?.close(); await fixture.kill(); await rm(directory, { recursive: true, force: true }); });
  browser = await puppeteer.launch({ executablePath: await browserPath(), headless: true, userDataDir: join(directory, 'chrome'),
    env: { PATH: process.env.PATH, HOME: homedir() }, args: ['--use-fake-device-for-media-stream', '--use-fake-ui-for-media-stream',
      '--autoplay-policy=no-user-gesture-required', ...chromeSandboxArgs] });
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
  // Reuse the physical device/page for the supported Grok start factory.
  await page.evaluate(async () => {
    const { createGrokVoiceClient } = await import('/plugins/grok-voice/src/client.js');
    const { createNetworkRelayClient } = await import('/packages/server/src/composed/network-client.js');
    let transport;
    const receipt = async () => {
      const mediaGrant = await fetch('/grant').then(response => response.json());
      return { callId: mediaGrant.callId, providerSessionId: mediaGrant.providerSessionId,
        epoch: mediaGrant.opaque.epoch, mediaGrant };
    };
    const control = { start: receipt, recover: receipt };
    for (const name of ['close', 'pause', 'resume', 'heartbeat']) control[name] = () => transport.command(name);
    const open = createNetworkRelayClient({ headers: { 'x-owner': 'fixture-owner' } });
    window.grokClient = createGrokVoiceClient({ control,
      async openRelay(...args) { transport = await open(...args); return transport; },
      audio: { onTiming: event => window.timings.push({ ...event, grok: true }) } });
    window.grokSession = await window.grokClient.start({ callId: 'browser-call' });
  });
  await page.waitForFunction(() => window.timings.some(event => event.grok && event.kind === 'playback-start'));
  const grok = await page.evaluate(async () => {
    await window.grokSession.setInput(false); await window.grokSession.setOutput(false);
    await window.grokSession.close();
    return { capture: window.timings.some(event => event.grok && event.kind === 'capture'),
      playback: window.timings.some(event => event.grok && event.kind === 'playback-scheduled' && event.format === 'pcm_s16le'),
      stopped: window.timings.some(event => event.grok && event.kind === 'playback-stop' && event.origin === 'teardown') };
  });
  assert.deepEqual(grok, { capture: true, playback: true, stopped: true });
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
  if (evidence) {
    await mkdir(evidence, { recursive: true });
    const report = { physical, immediate, pause, permission, latePermission, grok, external, problems };
    await writeFile(join(evidence, 'ait-160-physical-media.json'), JSON.stringify(report, null, 2));
    await page.evaluate(report => { document.querySelector('#proof').textContent = JSON.stringify({ packets: report.physical.stats.packets,
      packetBytes: report.physical.stats.maxPacket, format: 'PCM16 mono 16 kHz capture / PCM16 + Float32 24 kHz playback',
      synchronousBargeInStop: report.immediate.stoppedSynchronously, pause: report.pause, permissionDenial: report.permission,
      recovery: 'fresh generation; channel holds preserved', providerCalls: 0 }, null, 2); }, report);
    await page.evaluate(() => document.fonts.ready);
    await page.evaluate(() => document.activeElement?.blur());
    await page.mouse.move(-10, -10);
    await page.screenshot({ path: join(evidence, 'ait-160-physical-media.png'), fullPage: false });
  }
});

// AIT-348 uses the real composer/rail with the supported Grok browser factory.
// Media/transport are synthetic; this fixture has no provider ports or credentials.
test('AIT-348: Grok DE light lifecycle viewports and typed composer keep controls at 0 px', { timeout: 60_000 }, async t => {
  const directory = await mkdtemp(join(tmpdir(), 'grok-lifecycle-ui-'));
  const demo = await startChild(new URL('../fixtures/no-provider-server.js', import.meta.url), join(directory, 'session.sqlite'), {
    AITHEMA_VOICE_MODE: 'off', AITHEMA_IMAGE_MODE: 'off', AITHEMA_HTML_MODE: 'off',
  });
  const browser = await puppeteer.launch({ executablePath: await browserPath(), headless: true, userDataDir: join(directory, 'chrome'),
    env: { PATH: process.env.PATH, HOME: homedir() }, args: chromeSandboxArgs });
  t.after(async () => { await browser.close(); await demo.kill(); await rm(directory, { recursive: true, force: true }); });
  const page = await browser.newPage(), problems = [], sent = [], checks = [];
  page.on('pageerror', error => problems.push(error.message));
  await page.emulateMediaFeatures([{ name: 'prefers-reduced-motion', value: 'reduce' }]);
  await page.setRequestInterception(true);
  page.on('request', async request => {
    const path = new URL(request.url()).pathname;
    if (/^\/(?:packages\/server\/src\/composed|plugins\/grok-voice\/src)\/[a-z-]+\.js$/u.test(path)) {
      return request.respond({ status: 200, contentType: 'text/javascript', body: await readFile(new URL('../..' + path, import.meta.url), 'utf8') });
    }
    if (path.endsWith('/features')) return request.respond({ status: 200, contentType: 'application/json', body: '{}' });
    if (path.endsWith('/turns') && request.method() === 'POST') {
      const body = JSON.parse(request.postData()); sent.push(body);
      const seq = await page.evaluate(() => document.querySelector('aithema-session').session.seq + 1);
      return request.respond({ status: 200, contentType: 'application/json', body: JSON.stringify({ type: 'turn.final', seq,
        data: { id: 'fixture-typed', role: 'user', content: body.content, at: '2026-10-18T20:00:00Z',
          voiceCallId: body.voiceCallId, voiceProviderId: body.providerSessionId } }) });
    }
    return request.continue();
  });
  await page.goto(demo.url, { waitUntil: 'domcontentloaded' });
  await page.waitForFunction(() => document.querySelector('aithema-session')?.session?.id);
  await page.select('#theme', 'light');
  await page.evaluate(async () => {
    const map = document.createElement('script'); map.type = 'importmap'; map.textContent = JSON.stringify({ imports: {
      '@inspr/aithema-core/invocation': '/packages/core/src/invocation.js',
      '@inspr/aithema-core/live-voice': '/packages/core/src/live-voice.js',
      '@inspr/aithema-core/plugins': '/packages/core/src/plugins.js',
      '@inspr/aithema-core/voice-lifecycle-controller': '/packages/core/src/voice-lifecycle-controller.js',
      '@inspr/aithema-server/composed-voice/client': '/packages/server/src/composed/client.js',
      '@inspr/aithema-server/composed-voice/network-client': '/packages/server/src/composed/network-client.js',
      '@inspr/aithema-server/composed-voice/browser-audio': '/packages/server/src/composed/browser-audio.js',
    } }); document.head.append(map);
    const { AudioRail } = await import('/packages/ui/src/audio-rail.js');
    const render = AudioRail.prototype.render;
    AudioRail.prototype.render = function () { window.ait348Rail = this; return render.call(this); };
    const { createGrokVoiceClient, manifest } = await import('/plugins/grok-voice/src/client.js');
    const { de: copy } = await import('/packages/ui/src/i18n/de.js');
    const c = document.querySelector('aithema-session'), session = structuredClone(c.session);
    session.locale = 'de'; session.settings.origin = 'chosen'; session.settings.voice = 'grok-voice';
    session.engine.voice = { id: 'grok-voice', label: 'Grok Voice (xAI)', offered: true };
    session.featureMatrix.best = Object.fromEntries(['text', 'analysis', 'voice', 'uploads', 'images', 'html'].map(key => [key, { available: true, reason: null }]));
    session.transcript = [{ id: 'fixture-user', role: 'user', content: 'Ich möchte eine Website.' }];
    window.ait348Typed = []; const until = Date.now() + 120000;
    const grant = { callId: 'fixture-call', providerSessionId: 'fixture-generation', expiresAt: until,
      opaque: { epoch: 1, spendDeadlineAt: until, browserLivenessDeadlineAt: until } };
    let finish;
    const client = createGrokVoiceClient({ control: {
      start: async () => ({ ...grant, epoch: 1, mediaGrant: grant }), recover() { throw new Error('offline fixture'); },
      pause: async () => ({ acknowledged: true, paused: true }), resume: async () => ({ acknowledged: true, paused: false }),
      heartbeat: async () => ({ acknowledged: true, browserLivenessDeadlineAt: until }), close: async () => { finish?.({ done: true }); },
    }, capture: async () => ({ stop() {}, audioLevel: () => 0 }), player: { play() {}, stop() {}, retry() {}, audioLevel: () => 0 },
    openRelay: async () => ({ frames: { [Symbol.asyncIterator]() { return this; }, next: () => new Promise(resolve => { finish = resolve; }) },
      command(name, text, opts) { if (name === 'sendText') window.ait348Typed.push({ text, opts }); return Promise.resolve({ acknowledged: true }); },
      disconnect() { finish?.({ done: true }); } }) });
    c.configure({ copy, session, voiceClient: client, voicePresentation: manifest.presentation });
    window.ait348Session = await client.start({ callId: grant.callId });
    const rail = window.ait348Rail; rail.session = window.ait348Session; rail.state = 'listening'; rail.render();
    window.ait348State = state => {
      rail.session = state === 'failure-mic' ? null : window.ait348Session;
      rail.state = state === 'failure-mic' ? 'failed' : state === 'failure-playback' ? 'listening' : state;
      rail.paused = state === 'paused'; rail.playbackBlocked = state === 'failure-playback';
      rail.errorKey = state === 'failure-mic' ? 'voiceMicDenied' : state === 'failure-playback' ? 'voicePlaybackBlocked' : null;
      rail.render(); rail.waveform.baseline();
    };
    document.documentElement.lang = 'de'; scrollTo(0, 0);
  });
  if (evidence) await mkdir(evidence, { recursive: true });
  for (const width of [1440, 390]) {
    await page.setViewport({ width, height: width === 390 ? 844 : 900 });
    await page.evaluate(() => window.ait348State('listening'));
    await page.waitForFunction(() => document.querySelector('aithema-session').shadowRoot.querySelector('.status').hasAttribute('data-connected'));
    let baseline;
    for (const state of ['listening', 'speaking', 'paused', 'recovering', 'failure-mic', 'failure-playback']) {
      const observed = await page.evaluate(async state => {
        const root = document.querySelector('aithema-session').shadowRoot, input = root.querySelector('textarea');
        input.focus({ preventScroll: true }); window.ait348State(state);
        await document.fonts.ready;
        await new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)));
        const focus = root.activeElement === input;
        input.blur();
        await Promise.all(root.getAnimations().filter(a => Number.isFinite(a.effect.getComputedTiming().endTime)).map(a => a.finished));
        const selectors = ['.voice-cell--output', '.voice-cell--pause', '.voice-cell--mic', '.voice-cell--end', 'textarea', '.send'];
        const boxes = Object.fromEntries(selectors.map(selector => {
          const r = root.querySelector(selector).getBoundingClientRect(); return [selector, [r.x, r.y, r.width, r.height]];
        }));
        return { boxes, focus, placeholder: input.placeholder, status: root.querySelector('.voice-state').getAttribute('aria-label'),
          expected: state === 'failure-mic' ? window.ait348Rail.copy.voiceMicDenied : state === 'failure-playback' ? window.ait348Rail.copy.voicePlaybackBlocked : window.ait348Rail.copy.voiceStates[state] };
      }, state);
      baseline ??= observed.boxes;
      assert.deepEqual(observed.boxes, baseline, `${width} ${state}: 0 px control movement`);
      assert.equal(observed.focus, true, `${width} ${state}: composer focus retained`);
      assert.equal(observed.status, observed.expected, `${width} ${state}: existing ElevenLabs copy`);
      checks.push({ width, state, movementPx: 0, ...observed });
      await page.mouse.move(-1, -1);
      if (evidence) await page.screenshot({ path: join(evidence, `ait348-${width}-light-de-${state}.png`), fullPage: false });
    }
  }
  await page.evaluate(() => window.ait348State('listening'));
  await page.evaluate(() => {
    const root = document.querySelector('aithema-session').shadowRoot, input = root.querySelector('textarea');
    input.value = 'Ja, bitte als Text.'; input.dispatchEvent(new Event('input', { bubbles: true }));
    root.querySelector('form').requestSubmit();
  });
  await page.waitForFunction(() => window.ait348Typed.length === 1 && !document.querySelector('aithema-session').shadowRoot.querySelector('textarea').value);
  const typed = await page.evaluate(() => ({ delivery: window.ait348Typed[0],
    composer: document.querySelector('aithema-session').shadowRoot.querySelector('textarea').placeholder,
    persisted: document.querySelector('aithema-session').session.transcript.some(turn => turn.id === 'fixture-typed' && turn.content === 'Ja, bitte als Text.') }));
  assert.equal(typed.delivery.text, 'Ja, bitte als Text.'); assert.equal(sent.length, 1);
  assert.equal(sent[0].voiceCallId, 'fixture-call'); assert.equal(typed.delivery.opts.epoch, 1);
  assert.ok(typed.delivery.opts.deliveryId); assert.equal(typed.persisted, true);
  await page.evaluate(() => { const root = document.querySelector('aithema-session').shadowRoot; root.activeElement?.blur(); });
  await page.mouse.move(-1, -1);
  await page.evaluate(async () => { await document.fonts.ready; await new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))); });
  if (evidence) {
    await page.screenshot({ path: join(evidence, 'ait348-390-light-de-typed-sent.png'), fullPage: false });
    await writeFile(join(evidence, 'ait348-checks.json'), JSON.stringify({ ticket: 'AIT-348', qualification: 'not yet qualified in live use',
      transport: 'synthetic', providerCalls: 0, checks, typed, problems }, null, 2));
  }
  const visibility = await page.evaluate(async () => {
    const rail = window.ait348Rail;
    dispatchEvent(new Event('blur'));
    await new Promise(resolve => setTimeout(resolve, 0));
    const blurredVisibleContinues = !rail.paused;
    Object.defineProperty(document, 'hidden', { configurable: true, value: true });
    document.dispatchEvent(new Event('visibilitychange'));
    await new Promise(resolve => setTimeout(resolve, 0));
    const hiddenHeld = rail.paused && window.ait348Session.audioLevels().input === 0;
    Object.defineProperty(document, 'hidden', { configurable: true, value: false });
    document.dispatchEvent(new Event('visibilitychange'));
    return { blurredVisibleContinues, hiddenHeld, remainsHeldWhenVisible: rail.paused };
  });
  assert.deepEqual(visibility, { blurredVisibleContinues: true, hiddenHeld: true, remainsHeldWhenVisible: true });
  if (evidence) {
    const file = join(evidence, 'ait348-checks.json'), report = JSON.parse(await readFile(file, 'utf8'));
    await writeFile(file, JSON.stringify({ ...report, visibility }, null, 2));
  }
  assert.deepEqual(problems, []);
  await page.evaluate(() => window.ait348Session.close());
});
