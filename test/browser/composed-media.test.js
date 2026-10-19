import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir, homedir } from 'node:os';
import { join } from 'node:path';
import puppeteer from './launch.js';
import { browserPath } from '../../scripts/install-test-browser.js';
import { measureGaugeCaptions } from './settings-caption-helpers.js';
import { checkSettingsPolish } from './settings-polish-helpers.js';
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

// AIT-350: the real Settings editor and host tokens, with offline provider/consent
// ports. One page iterates states; no microphone, provider transport or paid Start.
test('AIT-350: Settings provider switch viewports, focus and 0 px geometry', { timeout: 60_000 }, async t => {
  const directory = await mkdtemp(join(tmpdir(), 'grok-settings-ui-'));
  const demo = await startChild(new URL('../fixtures/no-provider-server.js', import.meta.url), join(directory, 'session.sqlite'), {
    AITHEMA_VOICE_MODE: 'off', AITHEMA_IMAGE_MODE: 'off', AITHEMA_HTML_MODE: 'off',
  });
  const browser = await puppeteer.launch({ executablePath: await browserPath(), headless: true, userDataDir: join(directory, 'chrome'),
    env: { PATH: process.env.PATH, HOME: homedir() }, args: chromeSandboxArgs });
  t.after(async () => { await browser.close(); await demo.kill(); await rm(directory, { recursive: true, force: true }); });
  const page = await browser.newPage(), problems = [], checks = [], openMenus = [], regressions = [];
  page.on('pageerror', e => problems.push(e.message));
  await page.emulateMediaFeatures([{ name: 'prefers-reduced-motion', value: 'reduce' }]);
  await page.goto(demo.url, { waitUntil: 'domcontentloaded' });
  await page.waitForFunction(() => document.querySelector('aithema-session')?.session?.id);
  await page.select('#theme', 'light');
  await page.evaluate(async () => {
    const { SettingsDialog } = await import('/packages/ui/src/settings-dialog.js');
    const { de } = await import('/packages/ui/src/i18n/de.js'), { en } = await import('/packages/ui/src/i18n/en.js');
    const c = document.querySelector('aithema-session'), root = c.shadowRoot;
    c.setAttribute('motion', 'off');
    root.querySelector('dialog.settings').remove();
    let dialog, editor;
    window.ait350 = { dialog, root, async reset(locale) {
      editor?.close(); dialog?.remove();
      dialog = document.createElement('dialog'); dialog.className = 'settings'; root.append(dialog); this.dialog = dialog;
      this.session = { ...structuredClone(c.session), locale, processingPreset: 'best', settings: { revision: 0, model: 'mock', effort: 'none', voice: 'elevenlabs', visuals: 'off', origin: 'chosen' } };
      this.status = 'available'; this.active = false; this.fail = false; this.stops = 0; this.starts = 0; this.saves = []; this.selected = [];
      const f = this;
      const publicFacts = (vendor, plugin, countries, processingCountries) => ({ vendor, plugin, qualification: 'unverified', processingLocations: ['unverified'],
        ...(plugin === 'grok-voice' ? { liveQualification: 'unverified', consentItem: { id: 'voice-xai', version: 1 } } : {}),
        capabilities: { sendText: 'native', pause: 'emulated' }, providerProcessing: { vendor, recipientCountries: countries, processingCountries, verification: 'current' } });
      this.catalog = () => ({ processingPreset: 'best', settings: f.session.settings, presets: { best: { offered: true, status: 'available',
        defaults: f.session.settings, models: [{ id: 'mock', label: 'Demo only: sample replies', efforts: ['none'], facts: {} }],
        voices: [{ id: 'elevenlabs', label: 'ElevenLabs', status: 'available', facts: publicFacts('ElevenLabs', 'elevenlabs', ['US'], ['US']) },
          { id: 'grok-voice', label: 'Grok Voice (xAI)', status: f.status, reason: f.status === 'consent' ? 'current processing consent required' : f.status === 'unavailable' ? 'not configured' : null,
            facts: publicFacts('xAI', 'grok-voice', ['US'], null) }],
        // Offline catalog choices make the lowest menu cross the body edge;
        // an empty catalog only renders the short "Off" row and cannot do so.
        visuals: [
          { id: 'codex-imagegen', label: 'Codex image generation', kind: 'images', status: 'available', facts: { vendor: 'OpenAI' } },
          { id: 'claude-html', label: 'Clickable draft', kind: 'html', status: 'available', facts: { vendor: 'Anthropic' } },
          { id: 'fake-images', label: 'Demo only: sample images', kind: 'images', status: 'available', facts: {} },
          { id: 'fake-html', label: 'Demo only: clickable draft', kind: 'html', status: 'available', facts: {} },
        ] } } });
      editor = new SettingsDialog({ dialog, copy: locale === 'de' ? de : en, ports: {
        state: () => ({ session: f.session, voiceActive: f.active }), catalog: async () => f.catalog(),
        endCall: async () => { f.stops++; f.active = false; }, newConversation: () => f.starts++,
        save: async body => { f.saves.push(body); if (f.fail) return { ok: false, error: 'network' };
          f.session.settings = { ...body, revision: f.session.settings.revision + 1, origin: 'chosen' };
          return { ok: true, ack: { processingPreset: 'best', settings: f.session.settings } }; },
        consentDocument: async () => ({ contract: 'offline', items: [{ id: 'voice-xai', version: 1, title: 'Grok Voice (xAI)', recipients: 'xAI', text: 'Speech' }], selected: f.selected, features: { voice: ['voice-xai'] } }),
        saveConsent: async body => { f.selected = body.processing.items; if (f.selected.includes('voice-xai')) f.status = 'available'; },
      } });
      this.editor = editor; editor.open(); await editor.reload();
    }, q(selector) { return dialog.querySelector(selector); },
    choose() { this.q('#settings-select-voice').click(); this.q('[data-value="grok-voice"]').click(); },
    async settle() {
      await document.fonts.ready;
      await new Promise(r => requestAnimationFrame(() => requestAnimationFrame(r)));
      await Promise.all(root.getAnimations({ subtree: true }).filter(a => a.playState === 'running' && Number.isFinite(a.effect.getComputedTiming().endTime)).map(a => a.finished.catch(() => {})));
    },
    geometry() {
      const result = {};
      for (const [name, selector] of Object.entries({ choice: '#settings-select-voice', confirmationSlot: '.voice-switch-slot', detail: '.disclosure summary' })) {
        const b = this.q(selector).getBoundingClientRect(); result[name] = [b.x, b.y, b.width, b.height];
      }
      const disclosure = this.q('.disclosure'), opened = disclosure.open; disclosure.open = true;
      const b = this.q('.disclosure-provider').getBoundingClientRect(); result.detailBody = [b.x, b.y, b.width, b.height]; disclosure.open = opened;
      return result;
    } };
  });
  if (evidence) await mkdir(evidence, { recursive: true });
  const settle = () => page.evaluate(() => window.ait350.settle());
  const shot = async name => {
    await settle();
    await page.evaluate(() => { document.activeElement?.blur(); window.ait350.root.activeElement?.blur(); });
    await page.mouse.move(-10, -10); await settle();
    if (evidence) await page.screenshot({ path: join(evidence, name + '.png'), fullPage: false, captureBeyondViewport: false });
  };
  // Collect all three Tick regressions before asserting, so the committed
  // red-before run demonstrates each defect against the unchanged UI.
  const expectLayout = (condition, detail) => { if (!condition) regressions.push(detail); };
  for (const [locale, width, height, theme] of [
    ['de', 1440, 900, 'light'], ['de', 390, 844, 'light'], ['en', 1440, 900, 'light'],
    ['de', 1440, 900, 'dark'], ['de', 390, 844, 'dark'], ['de', 1024, 1000, 'light'],
    ['de', 1280, 800, 'light'],
  ]) {
    await page.select('#theme', theme);
    assert.equal(await page.$eval('aithema-session', el => el.getAttribute('theme')), theme);
    const prefix = `ait350-${locale}-${width}${width === 1280 ? 'x800' : ''}${theme === 'dark' ? '-dark' : ''}`;
    // At 1024 only the two requested states need PNGs; all assertions still run.
    const capture = state => width === 1280 ? state === 'grok-selected' : width !== 1024 || ['both-options', 'grok-selected'].includes(state);
    const captureState = state => capture(state) ? shot(`${prefix}-${state}`) : settle();
    await page.setViewport({ width, height });
    await page.evaluate(async locale => {
      await window.ait350.reset(locale); await window.ait350.settle();
    }, locale);
    // Width is passed explicitly; page state remains independent of node globals.
    await page.evaluate(width => {
      const f = window.ait350, body = f.q('.settings__body');
      body.scrollTop = width < 600 ? f.q('#settings-select-voice').getBoundingClientRect().top - body.getBoundingClientRect().top + body.scrollTop - 16 : 0;
    }, width);
    await settle();
    const baseline = await page.evaluate(() => window.ait350.geometry());
    const phoneBaseline = width === 390 ? await page.evaluate(() => {
      const f = window.ait350, top = f.q('#settings-select-voice').getBoundingClientRect().top;
      // Measure persistent layout boxes, including the full fields above the
      // choice. Their selected-value text children are replaced on render.
      f.aboveChoice = [...f.dialog.querySelectorAll('.settings__header, .settings__body .settings-field, .settings__body legend, .settings__body .presets, .settings__body .select, .settings__body .effort-area')]
        .filter(node => node.getClientRects().length && node.getBoundingClientRect().bottom <= top);
      f.phoneGeometry = () => {
        const box = node => { const b = node.getBoundingClientRect(); return [b.x, b.y, b.width, b.height]; };
        return { above: f.aboveChoice.flatMap(box), below: box(f.q('[data-select="visuals"]')),
          confirming: !f.q('.voice-switch-confirm').hidden };
      };
      return f.phoneGeometry();
    }) : null;
    let visitorChose = false;
    const measure = async state => {
      await settle(); const current = await page.evaluate(() => window.ait350.geometry());
      const drift = Object.fromEntries(Object.keys(baseline).map(key => [key, Math.max(...baseline[key].map((v, i) => Math.abs(v - current[key][i])))]));
      let phone;
      if (width === 390) {
        // Tick UI QA 2026-10-19, AIT-350 -fix1, point 4: an explicit
        // choice may push content below it; everything above stays fixed.
        phone = await page.evaluate(() => window.ait350.phoneGeometry());
        assert.equal(drift.choice, 0, `${locale}/${width}/${state}: choice stays fixed`);
        assert.deepEqual(phone.above, phoneBaseline.above, `${locale}/${width}/${state}: everything above stays fixed`);
        assert.equal(drift.detail, 0, 'footer disclosure stays fixed');
        assert.deepEqual(current.confirmationSlot.slice(0, 3), baseline.confirmationSlot.slice(0, 3), 'slot origin and width stay fixed');
        if (!phone.confirming) assert.equal(current.confirmationSlot[3], 0, 'no empty phone confirmation slot');
        else assert.ok(visitorChose && current.confirmationSlot[3] > 0, 'confirmation follows the visitor’s own choice');
        assert.deepEqual([phone.below[0], ...phone.below.slice(2)], [phoneBaseline.below[0], ...phoneBaseline.below.slice(2)], 'only the position below may change');
        if (!visitorChose || !phone.confirming) assert.deepEqual(phone.below, phoneBaseline.below, 'content below moves only for an explicitly requested confirmation');
        if (!visitorChose) assert.equal(drift.detailBody, 0, 'popover content stays fixed before the visitor’s choice');
      } else {
        assert.deepEqual(drift, { choice: 0, confirmationSlot: 0, detail: 0, detailBody: 0 }, `${locale}/${width}/${state}`);
      }
      const gaugeCaptions = await page.evaluate(measureGaugeCaptions);
      if (width === 1440 || width === 1280) {
        for (const caption of gaugeCaptions) {
          expectLayout(caption.rendered && !caption.clipped && !caption.detailTextClipped,
            { point: 1, locale, width, height, theme, state, gauge: caption.gauge, clippedPx: caption.clippedPx, detailTextClippedPx: caption.detailTextClippedPx });
        }
      }
      checks.push({ locale, width, height, theme, state, drift, gaugeCaptions,
        ...(phone ? { phone: { aboveDriftPx: Math.max(0, ...phone.above.map((v, i) => Math.abs(v - phoneBaseline.above[i]))),
          slotHeight: current.confirmationSlot[3], belowShiftPx: phone.below[1] - phoneBaseline.below[1], confirming: phone.confirming, visitorChose } } : {}) });
    };
    if (locale === 'de' && (width === 1280 || (width === 1440 && theme === 'dark'))) {
      for (const name of width === 1280 ? ['visuals', 'voice'] : ['visuals']) {
        const selector = `#settings-select-${name}`;
        const before = await page.evaluate(selector => {
          const f = window.ait350, box = node => {
            const b = node.getBoundingClientRect(); return [b.x, b.y, b.width, b.height];
          };
          return { select: box(f.q(selector)), choice: box(f.q('#settings-select-voice')) };
        }, selector);
        const button = await page.evaluateHandle(selector => window.ait350.q(selector), selector);
        await button.asElement().click();
        const filename = `ait350-${locale}-${width}x${height}${theme === 'dark' ? '-dark' : ''}-menu-${name}`;
        await shot(filename);
        // Read the same settled, blurred state that was captured; blur must
        // leave the visitor's menu open and the pointer outside the viewport.
        const observed = await page.evaluate(({ selector, before }) => {
          const f = window.ait350, button = f.q(selector), select = button.closest('.select');
          const menu = f.q('#' + button.getAttribute('aria-controls'));
          const box = node => {
            const b = node.getBoundingClientRect();
            return { x: b.x, y: b.y, width: b.width, height: b.height, top: b.top, bottom: b.bottom, left: b.left, right: b.right };
          };
          const selectBox = box(button), menuBox = box(menu), body = box(f.q('.settings__body'));
          const drift = (node, baseline) => {
            const b = box(node); return Math.max(...[b.x, b.y, b.width, b.height].map((v, i) => Math.abs(v - baseline[i])));
          };
          const menuAbove = select.getAttribute('data-menu-above');
          return { menu: menuBox, select: selectBox, body, dataMenuAbove: menuAbove,
            direction: menuAbove === 'true' ? 'above' : 'below',
            open: !menu.hidden && button.getAttribute('aria-expanded') === 'true' && menuBox.width > 0 && menuBox.height > 0,
            fullyInsideBody: menuBox.left >= body.left && menuBox.right <= body.right && menuBox.top >= body.top && menuBox.bottom <= body.bottom,
            selectDriftPx: drift(button, before.select), choiceDriftPx: drift(f.q('#settings-select-voice'), before.choice) };
        }, { selector, before });
        openMenus.push({ locale, width, height, theme, name, filename: filename + '.png', ...observed });
        assert.equal(observed.open, true, `${filename}: menu remains open after blur`);
        assert.equal(observed.fullyInsideBody, true, `${filename}: menu fully inside Settings body`);
        assert.equal(observed.selectDriftPx, 0, `${filename}: select stays at 0 px`);
        assert.equal(observed.choiceDriftPx, 0, `${filename}: voice choice stays at 0 px`);
        if (name === 'visuals') assert.equal(observed.dataMenuAbove, 'true', `${filename}: lowest menu opens upward`);
        await button.asElement().click();
        await button.dispose();
        await settle();
        assert.equal(await page.evaluate(selector => window.ait350.q('#' + window.ait350.q(selector).getAttribute('aria-controls')).hidden, selector), true,
          `${filename}: menu closed after capture`);
      }
    }
    await page.evaluate(() => window.ait350.q('#settings-select-voice').click());
    await measure('both-options'); await captureState('both-options');
    for (const status of ['consent', 'unavailable']) {
      await page.evaluate(status => { const f = window.ait350; f.status = status; f.editor.setCatalog(f.catalog()); }, status);
      await measure(status); await captureState(status === 'consent' ? 'consent-required' : status);
    }
    visitorChose = true;
    await page.evaluate(() => {
      const f = window.ait350; f.status = 'available'; f.active = true; f.editor.setCatalog(f.catalog());
      f.q('[data-value="grok-voice"]').click();
    });
    await measure('in-call-confirmation');
    assert.ok(await page.evaluate(() => ['#settings-select-voice', '.voice-switch-apply', '.voice-switch-cancel'].every(s => window.ait350.q(s).getBoundingClientRect().height >= 44)), '44 px voice targets');
    await captureState('in-call-confirmation');
    await page.evaluate(() => window.ait350.q('.voice-switch-cancel').click()); await settle();
    assert.equal(await page.evaluate(() => window.ait350.root.activeElement === window.ait350.q('#settings-select-voice')), true);
    await measure('cancel');
    await page.evaluate(() => { const f = window.ait350; f.fail = true; f.choose(); f.q('.voice-switch-apply').click(); });
    await page.waitForFunction(() => window.ait350.q('.save-retry').dataset.visible === 'true');
    await measure('failed-save');
    assert.equal(await page.evaluate(() => window.ait350.session.settings.voice), 'elevenlabs');
    assert.equal(await page.evaluate(() => window.ait350.root.activeElement === window.ait350.q('#settings-select-voice')), true);
    await page.evaluate(() => { window.ait350.fail = false; window.ait350.q('.save-retry').click(); });
    await page.waitForFunction(() => window.ait350.session.settings.voice === 'grok-voice');
    await measure('grok-selected');
    assert.equal(await page.evaluate(() => window.ait350.root.activeElement === window.ait350.q('#settings-select-voice')), true);
    await captureState('grok-selected');
    await page.evaluate(() => window.ait350.q('.disclosure').open = true);
    await measure('provider-processing-detail'); await captureState('provider-processing-detail');
    const disclosure = await page.evaluate(() => {
      const q = selector => window.ait350.q(selector), summary = q('.disclosure summary');
      const range = document.createRange(); range.selectNodeContents(summary.querySelector('span') ?? summary);
      const text = range.getBoundingClientRect(), body = q('.disclosure__body'), geography = q('.disclosure-geography');
      const paragraphRange = document.createRange(); paragraphRange.selectNodeContents(geography);
      const lastLine = paragraphRange.getBoundingClientRect();
      const css = getComputedStyle(body), note = q('[data-text="gaugeNote"]');
      const summaryCss = getComputedStyle(summary), pseudo = getComputedStyle(summary, '::after');
      const chevron = summary.querySelector('svg')?.getBoundingClientRect();
      const chevronInk = summary.querySelector('svg path')?.getBoundingClientRect();
      // Before the fix the chevron is a pseudo-element; account for its normal
      // flex box so the old column-edge positioning is also measured.
      const chevronLeft = chevron?.left ?? summary.getBoundingClientRect().right - parseFloat(summaryCss.paddingRight) -
        parseFloat(pseudo.marginRight) - parseFloat(pseudo.width) - parseFloat(pseudo.borderLeftWidth) - parseFloat(pseudo.borderRightWidth);
      return { paragraphGap: note.getBoundingClientRect().top - lastLine.bottom,
        paragraphGapLimit: parseFloat(css.rowGap) + parseFloat(getComputedStyle(geography).lineHeight),
        textLines: range.getClientRects().length, chevronGap: chevronLeft - text.right,
        chevronInkGap: chevronInk ? chevronInk.left - text.right : chevronLeft - text.right };
    });
    expectLayout(disclosure.paragraphGap <= disclosure.paragraphGapLimit,
      { point: 2, locale, width, height, theme, ...disclosure });
    if (width === 1024) expectLayout(disclosure.textLines === 1 && disclosure.chevronGap >= 6 && disclosure.chevronGap <= 8,
      { point: 3, locale, width, height, theme, ...disclosure });
    if (width === 1024) expectLayout(disclosure.chevronInkGap >= 6 && disclosure.chevronInkGap <= 8,
      { point: 3, locale, width, height, theme, ...disclosure });
    checks.push({ locale, width, height, theme, state: 'disclosure-layout', ...disclosure });
    await page.evaluate(() => window.ait350.q('.disclosure').open = false);
    if (width === 390) {
      await page.evaluate(() => window.ait350.q('[data-gauge="voice"]').scrollIntoView({ block: 'center' }));
      await settle();
      checks.push({ locale, width, height, theme, state: 'grok-selected-vial', gaugeCaptions: await page.evaluate(measureGaugeCaptions) });
      await shot(`${prefix}-grok-selected-vial`);
    }
    assert.deepEqual(await page.evaluate(() => ({ starts: window.ait350.starts, stops: window.ait350.stops })), { starts: 0, stops: 1 });
    checks.push({ locale, width, height, theme, focusReturn: { switch: true, cancel: true, failedSave: true } });
  }
  assert.deepEqual(problems, []);
  assert.equal(openMenus.length, 3, 'three requested open-menu captures');
  if (evidence) await writeFile(join(evidence, 'ait350-checks.json'), JSON.stringify({ capture: 'viewport', motion: 'reduced and settled', blurredBeforeCapture: true, checks, openMenus }, null, 2));
  assert.deepEqual(regressions, [], 'Tick UI QA 2026-10-19, AIT-350 -fix1, points 1–3');
  await checkSettingsPolish(page, { evidence, shot, settle, regression: { checks, openMenus, regressions } });
});

// One browser/page serves all eight states; metadata is measured in-place.
test('AIT-349: interrupted bubble viewport matrix and metadata stays at 0 px', { timeout: 60_000 }, async t => {
  const directory = await mkdtemp(join(tmpdir(), 'grok-interrupted-ui-'));
  const demo = await startChild(new URL('../fixtures/no-provider-server.js', import.meta.url), join(directory, 'session.sqlite'), {
    AITHEMA_VOICE_MODE: 'off', AITHEMA_IMAGE_MODE: 'off', AITHEMA_HTML_MODE: 'off',
  });
  const browser = await puppeteer.launch({ executablePath: await browserPath(), headless: true, userDataDir: join(directory, 'chrome'),
    env: { PATH: process.env.PATH, HOME: homedir() }, args: chromeSandboxArgs });
  t.after(async () => { await browser.close(); await demo.kill(); await rm(directory, { recursive: true, force: true }); });
  const page = await browser.newPage(), checks = [], problems = [];
  page.on('pageerror', error => problems.push(error.message));
  await page.emulateMediaFeatures([{ name: 'prefers-reduced-motion', value: 'reduce' }]);
  await page.setRequestInterception(true);
  page.on('request', request => new URL(request.url()).pathname.endsWith('/features')
    ? request.respond({ status: 200, contentType: 'application/json', body: '{}' }) : request.continue());
  await page.goto(demo.url, { waitUntil: 'domcontentloaded' });
  await page.waitForFunction(() => document.querySelector('aithema-session')?.session?.id);
  await page.evaluate(() => { window.ait349Seed = structuredClone(document.querySelector('aithema-session').session); });
  if (evidence) await mkdir(evidence, { recursive: true });
  for (const width of [1440, 390]) for (const theme of ['light', 'dark']) for (const locale of ['de', 'en']) {
    await page.setViewport({ width, height: width === 390 ? 844 : 900 }); await page.select('#theme', theme);
    const result = await page.evaluate(async locale => {
      const { [locale]: copy } = await import(`/packages/ui/src/i18n/${locale}.js`);
      const c = document.querySelector('aithema-session'), session = structuredClone(window.ait349Seed);
      session.locale = locale;
      const content = locale === 'de' ? 'Die vollständige Antwort bleibt im Protokoll. Die Wiedergabe wurde unterbrochen, und auch dieser letzte Satz bleibt erhalten.'
        : 'The complete generated reply stays in the transcript. Playback was interrupted, and this final sentence remains in full.';
      session.transcript = [{ id: 'marker-person', role: 'user', content: locale === 'de' ? 'Bitte erklären Sie das.' : 'Please explain.' },
        { id: 'marker-reply', role: 'assistant', content }];
      c.configure({ copy, session }); document.documentElement.lang = locale;
      const root = c.shadowRoot, row = root.querySelector('[data-id="marker-reply"]'), meta = row.querySelector('strong');
      const selectors = ['.band', '.composer', '.send', 'textarea'];
      const boxes = () => [row, meta, row.querySelector('.turn-text'), ...selectors.map(s => root.querySelector(s))].map(node => {
        const r = node.getBoundingClientRect(); return [r.x, r.y, r.width, r.height];
      });
      await document.fonts.ready; await new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)));
      const before = boxes();
      c.receive({ seq: c.session.seq + 1, type: 'voice.interrupted', data: { id: 'marker-reply', interruption: { heardLength: 'unknown' } } });
      const marker = row.querySelector('.voice-interruption');
      root.activeElement?.blur(); document.activeElement?.blur();
      await new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)));
      await Promise.all(root.getAnimations().filter(a => Number.isFinite(a.effect.getComputedTiming().endTime)).map(a => a.finished));
      const after = boxes(), tip = marker?.querySelector('[role="tooltip"]');
      return { before, after, sameNode: row === root.querySelector('[data-id="marker-reply"]'),
        fullText: row.querySelector('.turn-text').textContent === content, label: marker?.getAttribute('aria-label'),
        description: tip?.textContent, expectedLabel: copy.voiceInterrupted, expectedDescription: copy.voiceInterruptedDescription,
        describedBy: marker?.getAttribute('aria-describedby') === tip?.id, icon: Boolean(marker?.querySelector('svg')), font: getComputedStyle(meta).fontFamily };
    }, locale);
    assert.equal(result.fullText, true); assert.equal(result.sameNode, true); assert.equal(result.icon, true);
    assert.equal(result.label, locale === 'de' ? 'Unterbrochen' : 'Interrupted');
    assert.equal(result.description, result.expectedDescription); assert.equal(result.describedBy, true);
    assert.deepEqual(result.after, result.before, `${width}/${theme}/${locale}: metadata, bubble and controls shift 0 px`);
    // Blur and put the pointer outside the viewport before every capture.
    await page.mouse.move(-10, -10);
    const tooltip = width === 1440 && theme === 'light' && locale === 'en';
    if (tooltip) {
      // Keep pointer outside; open the exact hover style without a focus ring.
      await page.evaluate(() => { document.querySelector('aithema-session').shadowRoot.querySelector('.voice-interruption-tooltip').style.display = 'block'; });
    }
    if (evidence) await page.screenshot({ path: join(evidence, `ait349-${width}-${theme}-${locale}-interrupted.png`), fullPage: false, captureBeyondViewport: false });
    checks.push({ width, theme, locale, movementPx: 0, tooltip, ...result });
  }
  assert.deepEqual(problems, []);
  if (evidence) await writeFile(join(evidence, 'ait349-checks.json'), JSON.stringify({ ticket: 'AIT-349', capture: 'viewport',
    reducedMotion: true, qualification: 'not yet qualified in live use', providerCalls: 0, checks, problems }, null, 2));
});
