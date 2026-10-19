import assert from 'node:assert/strict';
import { mkdir } from 'node:fs/promises';
import { join } from 'node:path';

// Reuse the matrix page and its real clients/offline provider ports. The clock
// advances provider lifecycles in one-second steps, without a live provider call.
export async function checkProviderSignals(page, evidence, configs, checks) {
  for (const provider of ['elevenlabs', 'grok-voice']) for (const [width, theme, locale] of configs) {
    await page.setViewport({ width, height: width === 390 ? 844 : 900 }); await page.select('#theme', theme);
    const capabilities = await page.evaluate(async ({ provider, locale }) => {
      const { currentVoiceClient } = await import('/ait377-current-clients.js');
      const { [locale]: copy } = await import(`/packages/ui/src/i18n/${locale}.js`);
      const c = document.querySelector('aithema-session'), session = structuredClone(window.ait377Seed);
      const real = { now: Date.now, setTimeout, clearTimeout, setInterval, clearInterval }, timers = new Map();
      let time = 100_000, next = -1;
      Date.now = () => time;
      const schedule = (fn, ms = 0, interval = false, args = []) => { const id = next--; timers.set(id, { fn, at: time + Math.max(0, ms), interval: interval ? Math.max(1, ms) : 0, args }); return id; };
      window.setTimeout = (fn, ms, ...args) => schedule(fn, ms, false, args);
      window.setInterval = (fn, ms, ...args) => schedule(fn, ms, true, args);
      window.clearTimeout = window.clearInterval = id => { if (!timers.delete(id)) { real.clearTimeout(id); real.clearInterval(id); } };
      const flush = async () => { for (let i = 0; i < 12; i++) await Promise.resolve(); await new Promise(r => real.setTimeout(r, 0)); };
      const clock = {
        async tick(ms) {
          const end = time + ms;
          for (;;) {
            const entry = [...timers].filter(([, t]) => t.at <= end).sort((a, b) => a[1].at - b[1].at)[0];
            if (!entry) break;
            const [id, t] = entry; time = t.at; timers.delete(id);
            if (t.interval) timers.set(id, { ...t, at: time + t.interval });
            t.fn(...t.args); await flush();
          }
          time = end; await flush();
        },
        restore() { Date.now = real.now; Object.assign(window, { setTimeout: real.setTimeout, clearTimeout: real.clearTimeout, setInterval: real.setInterval, clearInterval: real.clearInterval }); timers.clear(); },
      };
      let grant, connect;
      const permission = new Promise(r => { grant = r; }), connection = new Promise(r => { connect = r; });
      const current = currentVoiceClient(provider, { enabled: true, permission, connection });
      session.locale = locale; session.settings.origin = 'chosen'; session.settings.voice = provider;
      session.engine.voice = { id: provider, offered: true };
      session.featureMatrix.best = Object.fromEntries(['text', 'analysis', 'voice', 'uploads', 'images', 'html'].map(k => [k, { available: true }]));
      session.transcript = [{ id: 'fixture-turn', role: 'user', content: locale === 'de' ? 'Ich möchte eine Website.' : 'I would like a website.' }];
      c.style.setProperty('--aithema-font', 'ui-sans-serif,-apple-system,"Segoe UI Variable Text","Segoe UI",system-ui,sans-serif');
      c.configure({ copy, session, voiceClient: current.client, voicePresentation: current.client.manifest.presentation });
      const timer = c.shadowRoot.querySelector('.connection-timer');
      Object.defineProperty(timer, 'textContent', { configurable: true, get: () => '0:00', set() {} });
      document.documentElement.lang = locale; scrollTo(0, 0);
      window.ait383 = { current, clock, grant, connect, start: window.ait377Rail.start() };
      await clock.tick(0);
      return current.client.manifest.liveVoice.capabilities;
    }, { provider, locale });
    assert.equal(capabilities.onMicrophoneState, 'native'); assert.equal(capabilities.replyStarted, 'native');
    assert.equal(capabilities.opener, provider === 'elevenlabs');
    await page.waitForFunction(() => window.ait377Rail.startupPhase === 'microphone');
    let baseline;
    for (const state of ['s1', 's3', 's5']) {
      const result = await page.evaluate(async ({ state, provider }) => {
        const { clock, current } = window.ait383, rail = window.ait377Rail;
        if (state === 's1') await clock.tick(20_000);
        if (state === 's3') { window.ait383.grant(); await clock.tick(0); await clock.tick(29_000); }
        if (state === 's5') {
          window.ait383.connect(); await clock.tick(0); await window.ait383.start;
          if (provider === 'grok-voice') {
            await clock.tick(16_000);
            if (rail.errorKey !== null || rail.replyTimer !== null) throw new Error('Grok must not watch visitor silence');
            await rail.sendText('Eine Frage.');
          }
          await clock.tick(15_000);
        }
        const root = rail.root.getRootNode(), status = root.querySelector('.voice-state');
        rail.waveform.baseline(); root.activeElement?.blur(); document.activeElement?.blur(); await document.fonts.ready;
        await Promise.all(root.querySelector('.band').getAnimations({ subtree: true }).filter(a => Number.isFinite(a.effect.getComputedTiming().endTime)).map(a => a.finished));
        await new Promise(r => requestAnimationFrame(() => requestAnimationFrame(r)));
        const rect = node => { const r = node.getBoundingClientRect(); return [r.x, r.y, r.width, r.height]; };
        return { actualState: rail.state, startupPhase: rail.startupPhase, errorKey: rail.errorKey, noPreGrantDeadline: current.options[0].deadlineAt === undefined,
          elapsedSinceGrantMs: state === 's3' ? 29_000 : null, text: status.getAttribute('aria-label'),
          expected: state === 's1' ? rail.copy.voiceStates.microphone : state === 's3' ? rail.copy.voiceStates.connecting : rail.copy.voiceNoReply,
          boxes: ['.voice-cell--output', '.voice-cell--pause', '.voice-cell--mic', '.voice-cell--end', '.voice-signal'].map(s => rect(root.querySelector(s))) };
      }, { state, provider });
      assert.equal(result.actualState, state === 's5' ? 'listening' : 'connecting');
      assert.equal(result.startupPhase, state === 's1' ? 'microphone' : null);
      assert.equal(result.errorKey, state === 's5' ? 'voiceNoReply' : null);
      assert.equal(result.noPreGrantDeadline, true); assert.equal(result.text, result.expected);
      baseline ??= result.boxes; assert.deepEqual(result.boxes, baseline, 'enabled provider states: movementPx 0');
      const capture = theme !== 'dark' || state === 's5';
      const file = `${provider}/enabled/ait377-${width}-${theme}-${locale}-${state}.png`;
      if (capture && evidence) {
        await page.mouse.move(-10, -10); await mkdir(join(evidence, provider, 'enabled'), { recursive: true });
        await page.screenshot({ path: join(evidence, file), fullPage: false, captureBeyondViewport: false });
      }
      checks.push({ provider, width, theme, locale, state, behaviour: 'AIT-383 enabled real client with offline provider/device ports', capabilitiesDeclared: true,
        ...result, assert: 'S1 no deadline; S3 29 s after grant; S5 opener (ElevenLabs) or visitor turn (Grok); movementPx 0', movementPx: 0, file: capture && evidence ? file : null, pass: true });
    }
    await page.evaluate(async () => {
      const { current, clock } = window.ait383;
      current.audio(); await clock.tick(0);
      if (window.ait377Rail.errorKey !== null || window.ait377Rail.state !== 'speaking') throw new Error('Late audible reply must clear S5');
      await window.ait377Rail.close(); current.end(); clock.restore();
    });
  }
}
