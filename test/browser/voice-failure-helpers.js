import assert from 'node:assert/strict';
import { mkdir, mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import puppeteer from './launch.js';
import { startChild } from '../helpers.js';
import { browserPath, evidenceCommit } from './start2-display-helpers.js';

export async function checkVoiceFailures(t) {
  const directory = await mkdtemp(join(tmpdir(), 'aithema-ait361-'));
  const demo = await startChild(new URL('../fixtures/no-provider-server.js', import.meta.url), join(directory, 'session.sqlite'), {
    AITHEMA_VOICE_MODE: 'off', AITHEMA_IMAGE_MODE: 'off', AITHEMA_HTML_MODE: 'off',
  });
  let browser;
  t.after(async () => { await browser?.close(); await demo.kill(); });
  browser = await puppeteer.launch({ executablePath: await browserPath(), headless: true, userDataDir: join(directory, 'chrome'),
    args: process.platform === 'linux' && process.env.CI ? ['--no-sandbox'] : [] });
  const page = await browser.newPage(), checks = [], problems = [], evidence = process.env.AITHEMA_EVIDENCE_DIR;
  const expect = (pass, entry) => { checks.push({ ...entry, pass }); };
  page.on('pageerror', error => problems.push(error.message));
  await page.emulateMediaFeatures([{ name: 'prefers-reduced-motion', value: 'reduce' }]);
  await page.setRequestInterception(true);
  page.on('request', request => {
    if (!request.url().startsWith(demo.url) && !request.url().startsWith('data:')) return request.abort();
    return new URL(request.url()).pathname.endsWith('/features') ? request.respond({ status: 200, contentType: 'application/json', body: '{}' }) : request.continue();
  });
  await page.goto(demo.url, { waitUntil: 'domcontentloaded' });
  await page.waitForFunction(() => document.querySelector('aithema-session')?.session?.id);
  await page.evaluate(async () => {
    const { AudioRail } = await import('/packages/ui/src/audio-rail.js'), render = AudioRail.prototype.render;
    AudioRail.prototype.render = function () { window.ait361Rail = this; return render.call(this); };
    window.ait361Seed = structuredClone(document.querySelector('aithema-session').session);
  });
  if (evidence) await mkdir(evidence, { recursive: true });
  const configs = [[1440, 'light', 'de'], [1440, 'light', 'en'], [1440, 'dark', 'de'], [1024, 'light', 'de'], [390, 'light', 'de']];
  for (const provider of ['elevenlabs', 'grok-voice']) for (const [width, theme, locale] of configs) {
    await page.setViewport({ width, height: width === 390 ? 844 : 900 }); await page.select('#theme', theme);
    await page.evaluate(async ({ provider, locale }) => {
      const { [locale]: copy } = await import(`/packages/ui/src/i18n/${locale}.js`);
      const { manifest } = await import(`/plugins/${provider}/src/manifest.js`);
      const c = document.querySelector('aithema-session'), session = structuredClone(window.ait361Seed);
      session.locale = locale; session.settings.origin = 'chosen'; session.settings.voice = provider;
      session.engine.voice = { id: provider, offered: true };
      session.featureMatrix.best = Object.fromEntries(['text', 'analysis', 'voice', 'uploads', 'images', 'html'].map(key => [key, { available: true }]));
      session.transcript = [{ id: 'fixture-turn', role: 'user', content: locale === 'de' ? 'Ich möchte eine Website.' : 'I would like a website.' }];
      c.style.setProperty('--aithema-font', 'ui-sans-serif,-apple-system,"Segoe UI Variable Text","Segoe UI",system-ui,sans-serif');
      c.configure({ copy, session, voiceClient: { manifest, async start() { window.ait361Starts++; throw new Error('Offline fixture'); } }, voicePresentation: manifest.presentation });
      const timer = c.shadowRoot.querySelector('.connection-timer');
      Object.defineProperty(timer, 'textContent', { configurable: true, get: () => '0:00', set() {} });
      window.ait361Read = () => {
        const root = c.shadowRoot, rail = window.ait361Rail, pause = root.querySelector('.pause'), status = root.querySelector('.voice-state');
        const rect = node => { const r = node.getBoundingClientRect(); return { left: r.left, top: r.top, right: r.right, bottom: r.bottom, width: r.width, height: r.height }; };
        const css = getComputedStyle(pause), anchor = rail.errorKey === 'voicePlaybackBlocked' ? rail.button('playback')
          : ['voiceMicDenied', 'voiceMicMissing'].includes(rail.errorKey) ? rail.button('start')
          : ['voiceConnectionFailed', 'voiceDeadline', 'voiceConflict'].includes(rail.errorKey) && rail.state === 'failed' ? rail.button('retry') : root.querySelector('.voice-signal');
        return { boxes: ['.voice-cell--output', '.voice-cell--pause', '.voice-cell--mic', '.voice-cell--end', '.voice-signal'].map(s => rect(root.querySelector(s))),
          pause: { disabled: pause.disabled, background: css.backgroundColor, border: css.borderColor, color: getComputedStyle(pause.querySelector('svg')).color,
            cursor: css.cursor, glyph: pause.getAttribute('aria-pressed') },
          callout: rect(status), anchor: rect(anchor), header: rect(root.querySelector('.band')), position: getComputedStyle(status).position,
          narrow: getComputedStyle(status.querySelector('.consent-narrow')).display,
          focus: root.activeElement?.className ?? null, accessibleName: status.getAttribute('aria-label'), text: status.textContent,
          providerLimit: rail.copy.voiceReasonsNarrow.providerLimit, label: rail.copy[rail.errorKey] ?? rail.copy.voiceStates[rail.root.dataset.state],
          calloutFocusable: status.tabIndex >= 0 || Boolean(status.querySelector('button,a,input,[tabindex]')), state: rail.root.dataset.state,
          playbackLabel: rail.button('playback').title, live: Boolean(rail.session) };
      };
      document.documentElement.lang = locale; scrollTo(0, 0);
    }, { provider, locale });
    await page.evaluate(() => document.fonts.ready);
    let baseline, reference;
    const states = ['idle', 'recovering', 'voiceMicDenied', 'voiceMicMissing', 'voiceConnectionFailed', 'voiceDeadline', 'voiceConflict', 'start429', 'voicePlaybackBlocked', 'voiceAdmissionDenied', 'consent', 'waiting', 'voiceRecoveryFailed', 'idle'];
    for (const state of states) {
      await page.evaluate(state => {
        const rail = window.ait361Rail;
        rail.session = ['recovering', 'voicePlaybackBlocked', 'waiting'].includes(state) ? { callId: 'fixture', providerSessionId: 'fixture-provider' } : null;
        rail.state = state === 'recovering' ? 'recovering' : state === 'waiting' ? 'waiting' : ['idle', 'consent'].includes(state) ? 'idle' : state === 'voicePlaybackBlocked' ? 'listening' : 'failed';
        rail.paused = state === 'waiting'; rail.errorKey = state.startsWith('voice') ? state : null;
        rail.playbackBlocked = state === 'voicePlaybackBlocked'; rail.errorReason = state === 'voiceAdmissionDenied' ? 'processing-consent-required' : null;
        rail.feature = () => state === 'consent' ? { available: false, rawReason: 'current processing consent required', reason: rail.copy.featureConsent.voice } : { available: true };
        if (state === 'start429') rail.failure({ status: 429, code: 'limit', retryAfterMs: 5000 });
        rail.render(); rail.waveform.baseline();
      }, state);
      const result = await page.evaluate(() => window.ait361Read()), meta = { provider, width, theme, locale, state };
      baseline ??= result.boxes;
      expect(JSON.stringify(result.boxes) === JSON.stringify(baseline), { ...meta, assert: '0 px cells and status slot across show, anchor change and hide', movementPx: Math.max(...result.boxes.flatMap((r, i) => Object.keys(r).map(k => Math.abs(r[k] - baseline[i][k])))) });
      if (state === 'recovering') reference = result.pause;
      if (['recovering', 'voiceMicDenied', 'voiceMicMissing', 'voiceConnectionFailed', 'voiceDeadline', 'voiceConflict', 'start429'].includes(state)) {
        expect(result.pause.disabled && result.pause.cursor === 'not-allowed', { ...meta, assert: 'disabled Pause attribute and cursor', actual: result.pause });
        expect(['background', 'border', 'color', 'glyph'].every(k => result.pause[k] === reference[k]), { ...meta, assert: 'Pause equals F5 fill, border, icon colour and glyph', actual: result.pause, reference });
      }
      if (state.startsWith('voice') || state === 'start429') {
        expect(result.accessibleName === result.label && !result.calloutFocusable, { ...meta, assert: 'full accessible name and callout takes no focus', actual: result });
        if (width >= 600) {
          const desired = (result.anchor.left + result.anchor.right - result.callout.width) / 2;
          const left = Math.max(16, result.header.left), right = Math.min(width - 16, result.header.right);
          const clamped = Math.max(left, Math.min(desired, right - result.callout.width));
          expect(Math.abs(result.callout.left - clamped) <= 4 && Math.abs(result.callout.top - result.anchor.bottom - 8) <= 1,
            { ...meta, assert: 'anchor centre ±4 px (or clamped), top +8 ±1 px', actual: result.callout, anchor: result.anchor, expectedLeft: clamped });
          expect(result.callout.left >= left && result.callout.right <= right, { ...meta, assert: 'callout inside viewport and header', actual: result.callout });
        } else expect(result.narrow !== 'none' && result.callout.width > result.anchor.width && result.callout.top === result.boxes[4].top + 44,
          { ...meta, assert: 'phone narrow status below controls, no floating callout', actual: result });
      }
      if (state === 'start429') expect(!result.text.includes(result.providerLimit) && !result.accessibleName.includes(result.providerLimit), { ...meta, assert: '429 never providerLimit, full and narrow' });
      if (state === 'voicePlaybackBlocked') expect(result.live && result.playbackLabel === (locale === 'de' ? 'Ton aktivieren' : 'Enable sound'), { ...meta, assert: 'F3 stays live with existing playback label' });
      const shot = ['voiceMicDenied'].includes(state) || width === 1440 && theme === 'light' && locale === 'de' && ['voiceConnectionFailed', 'voicePlaybackBlocked', 'waiting', 'recovering'].includes(state);
      if (shot && evidence) {
        await page.evaluate(async () => {
          const root = document.querySelector('aithema-session').shadowRoot;
          root.activeElement?.blur(); document.activeElement?.blur();
          await Promise.all(root.querySelector('.band').getAnimations({ subtree: true }).filter(a => Number.isFinite(a.effect.getComputedTiming().endTime)).map(a => a.finished));
          await new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)));
        });
        await page.mouse.move(-10, -10);
        const suffix = provider === 'grok-voice' ? '-grok-voice' : '';
        const name = `ait361-${width}-${theme}-${locale}-${state}${suffix}.png`;
        await page.screenshot({ path: join(evidence, name), fullPage: false, captureBeyondViewport: false });
        checks.push({ ...meta, assert: 'settled blurred viewport evidence', file: name, pass: true });
      }
    }
    if (width === 1440 && theme === 'light' && locale === 'de') {
      const before = await page.evaluate(() => {
        const rail = window.ait361Rail; rail.state = 'failed'; rail.failure({ status: 429, code: 'limit', retryAfterMs: 5000 });
        window.ait361Starts = 0; rail.button('retry').focus(); return window.ait361Read();
      });
      await page.evaluate(() => window.ait361Rail.button('retry').click());
      const after = await page.evaluate(() => ({ ...window.ait361Read(), starts: window.ait361Starts }));
      const meta = { provider, width, theme, locale, state: 'retry-after' };
      expect(after.state === 'connecting' && after.starts === 0 && after.accessibleName === after.label, { ...meta, assert: 'F6 mid-wait existing connecting copy', actual: after });
      expect(after.focus === 'voice-close', { ...meta, assert: 'Retry focus stays on end slot', actual: after.focus });
      expect(JSON.stringify(after.boxes) === JSON.stringify(before.boxes), { ...meta, assert: 'Retry to End moves 0 px', movementPx: 0 });
      await page.evaluate(async () => { const root = document.querySelector('aithema-session').shadowRoot; root.activeElement?.blur(); document.activeElement?.blur(); await new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))); });
      await page.mouse.move(-10, -10);
      if (evidence) await page.screenshot({ path: join(evidence, `ait361-1440-light-de-retry-after${provider === 'grok-voice' ? '-grok-voice' : ''}.png`), fullPage: false, captureBeyondViewport: false });
      await page.evaluate(() => window.ait361Rail.close());
    }
  }
  if (evidence) await writeFile(join(evidence, 'ait361-checks.json'), JSON.stringify({ ticket: 'AIT-361', head: evidenceCommit, capture: 'viewport', reducedMotion: true, blurred: true, checks, problems }, null, 2));
  assert.deepEqual(problems, []);
  assert.deepEqual(checks.filter(check => !check.pass), [], 'Tick AIT-361 binding UI assertions');
}
