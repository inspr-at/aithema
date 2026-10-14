import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mkdir, mkdtemp, writeFile } from 'node:fs/promises';
import { homedir, tmpdir } from 'node:os';
import { join } from 'node:path';
import puppeteer from 'puppeteer-core';
import { startChild } from '../helpers.js';
import { browserPath, shadow, until, settle, layoutBoxes, evidenceCommit } from './start2-display-helpers.js';

test('AIT-154: recovered audio replay, Stop and text fallback retain viewport geometry at 390/1024/1440, L/D, DE/EN', { timeout: 100_000 }, async t => {
  const directory = await mkdtemp(join(tmpdir(), 'aithema-audio-replay-'));
  const demo = await startChild(new URL('../fixtures/no-provider-server.js', import.meta.url), join(directory, 'session.sqlite'), {
    AITHEMA_VOICE_MODE: 'off', AITHEMA_IMAGE_MODE: 'off', AITHEMA_HTML_MODE: 'off',
  });
  const browser = await puppeteer.launch({ executablePath: await browserPath(), headless: true, userDataDir: join(directory, 'chrome'),
    env: { PATH: process.env.PATH, HOME: homedir() }, args: process.platform === 'linux' && process.env.CI ? ['--no-sandbox'] : [] });
  t.after(async () => { await browser.close(); await demo.kill(); });
  const page = await browser.newPage(), files = [], passLines = [], evidence = process.env.AITHEMA_EVIDENCE_DIR;
  await page.emulateMediaFeatures([{ name: 'prefers-reduced-motion', value: 'reduce' }]);
  await page.setRequestInterception(true);
  page.on('request', request => new URL(request.url()).pathname.endsWith('/features')
    ? request.respond({ status: 200, contentType: 'application/json', body: '{}' }) : request.continue());
  await page.goto(demo.url, { waitUntil: 'domcontentloaded' });
  await until(page, () => document.querySelector('aithema-session')?.session?.id);
  await page.evaluate(async () => {
    const { AudioRail } = await import('/packages/ui/src/audio-rail.js'), original = AudioRail.prototype.render;
    AudioRail.prototype.render = function () { window.replayRail = this; return original.call(this); };
    window.replaySeed = document.querySelector('aithema-session').session;
  });
  if (evidence) await mkdir(evidence, { recursive: true });
  for (const locale of ['de', 'en']) for (const theme of ['light', 'dark']) for (const width of [390, 1024, 1440]) {
    await page.setViewport({ width, height: width === 390 ? 844 : 900 }); await page.select('#theme', theme);
    await page.evaluate(async locale => {
      const { [locale]: copy } = await import(`/packages/ui/src/i18n/${locale}.js`);
      const { createElevenLabsClient } = await import('/plugins/elevenlabs/src/client.js');
      const { paintUtilities } = await import('/demo/page-preferences.js');
      const c = document.querySelector('aithema-session'), session = structuredClone(window.replaySeed);
      session.locale = locale; session.settings.origin = 'chosen'; session.settings.voice = 'elevenlabs';
      session.engine.voice = { id: 'elevenlabs', label: 'ElevenLabs', offered: true };
      session.featureMatrix.best = Object.fromEntries(['text', 'analysis', 'voice', 'uploads', 'images', 'html'].map(key => [key, { available: true, reason: null }]));
      window.replayText = locale === 'de' ? 'Ihre Website soll Menschen schnell zur richtigen Leistung führen.' : 'Your website should help people find the right service quickly.';
      session.transcript = [{ id: 'question', role: 'user', content: locale === 'de' ? 'Ich möchte eine Website.' : 'I would like a website.' }];
      let generation = 0; window.replayPersisted = []; window.replayRequests = []; window.replayUnavailable = false;
      const audio = document.createElement('audio'); audio.hidden = true; document.body.append(audio); window.replayAudio = audio;
      const sdk = { async startSession(options) {
        window.replayCallbacks = options;
        const id = options.conversationToken;
        const conversation = { getId: () => id, input: { async setMuted() {} },
          connection: { audioAdapter: { audioElements: [audio] } },
          setVolume({ volume }) { audio.volume = volume; }, async endSession() { audio.pause(); audio.remove(); },
          sendContextualUpdate() {},
          sendUserMessage() { throw new Error('Replay must not invoke a model turn'); } };
        options.onConversationCreated(conversation); options.onConnect({ conversationId: id }); return conversation;
      } };
      const receipt = ({ callId }) => { const providerSessionId = `fixture_${++generation}`; return { callId, providerSessionId,
        credential: { connectionType: 'webrtc', providerSessionId, conversationToken: providerSessionId, ttlMs: 60_000 },
        spendDeadlineAt: Date.now() + 300_000, browserLivenessDeadlineAt: Date.now() + 60_000 }; };
      const control = { start: receipt, recover: receipt, close: async () => ({ closureConfirmed: true }),
        pause: async () => ({ acknowledged: true, paused: true }), resume: async () => ({ acknowledged: true, paused: false }),
        heartbeat: async () => ({ browserLivenessDeadlineAt: Date.now() + 60_000 }),
        async speakText(request) {
          window.replayRequests.push(request); if (window.replayUnavailable) throw Object.assign(new Error(), { code: 'provider' });
          return { kind: 'audio', audio: { format: 'pcm_16000', data: btoa('\0'.repeat(320_000)) } };
        } };
      const client = createElevenLabsClient({ sdk, control, mediaDevices: {}, document,
        persistEvent: async event => { window.replayPersisted.push(event);
          if (event.type === 'final') c.receive({ seq: c.session.seq + 1, type: 'turn.final', data: { id: event.turnId, role: event.role, content: event.text } });
        } });
      c.configure({ copy, session, voiceClient: client, voicePresentation: client.manifest.presentation });
      const rail = window.replayRail; rail.feature = () => ({ available: true });
      await rail.start();
      if (!rail.session) throw new Error(`Replay fixture could not start: ${rail.errorKey}`);
      window.replayCallbacks.onModeChange({ mode: 'speaking' });
      window.replayCallbacks.onMessage({ role: 'agent', message: window.replayText, event_id: 2 });
      await new Promise(resolve => setTimeout(resolve, 20));
      window.replayCallbacks.onDisconnect();
      document.documentElement.lang = locale; document.querySelector('#locale').value = locale; paintUtilities(copy); scrollTo(0, 0);
    }, locale);
    await until(page, () => window.replayRail.notices.recovery && !window.replayRail.notices.button.disabled);
    await settle(); await page.mouse.move(0, 500);
    const selectors = ['.audio-rail', '.voice-repeat', '.voice-read-text', '.transcript-shell', '.voice-cell--output', '.voice-cell--pause', '.voice-cell--mic', '.voice-cell--end', '.voice-notices'];
    const before = await layoutBoxes(page, selectors);
    const capture = async state => {
      await settle();
      assert.equal(await shadow(page, c => c.shadowRoot.querySelector('.turn:not(.user) .turn-text')?.textContent), await page.evaluate(() => window.replayText), `${state}: assistant bubble remains in the thread`);
      const labels = locale === 'de' ? ['Antwort wiederholen', 'Wiederholung stoppen', 'Ganze Antwort lesen'] : ['Replay reply', 'Stop replay', 'Read full reply'];
      await t.test(`${locale}/${theme}/${width}/${state}: label`, async () => {
        assert.equal(await shadow(page, c => c.shadowRoot.querySelector('.voice-repeat').textContent), labels[state === 'playing' ? 1 : state === 'fallback' ? 2 : 0]);
      });
      await t.test(`${locale}/${theme}/${width}/${state}: longest label reservation`, async () => {
        const fits = await shadow(page, (c, labels) => {
          const button = c.shadowRoot.querySelector('.voice-repeat'), style = getComputedStyle(button);
          const canvas = document.createElement('canvas'), context = canvas.getContext('2d'); context.font = style.font;
          const needed = Math.max(...labels.map(label => context.measureText(label).width)) + parseFloat(style.paddingLeft) + parseFloat(style.paddingRight) + 2;
          return button.getBoundingClientRect().width + .5 >= needed;
        }, labels);
        assert.equal(fits, true, 'button reserves the longest label before any switch');
      });
      const alignment = await shadow(page, c => {
        const root = c.shadowRoot, button = root.querySelector('.voice-repeat');
        const textGeometry = node => {
          const range = document.createRange(); range.selectNodeContents(node);
          const box = range.getBoundingClientRect();
          // A zero-height inline box sits on the actual text baseline.
          const marker = document.createElement('i');
          marker.style.cssText = 'display:inline-block;width:0;height:0;padding:0;margin:0;border:0;vertical-align:baseline';
          node.append(marker); const baseline = marker.getBoundingClientRect().top; marker.remove();
          return { centre: (box.top + box.bottom) / 2, baseline };
        };
        const label = textGeometry(root.querySelector('.voice-repeat-label'));
        const notice = textGeometry(root.querySelector('.voice-notice--reply > span'));
        const link = textGeometry(root.querySelector('.voice-read-text'));
        const box = button.getBoundingClientRect(), noticeBox = root.querySelector('.voice-notice--reply > span').getBoundingClientRect();
        const sameRow = noticeBox.right <= box.left && noticeBox.top < box.bottom && noticeBox.bottom > box.top;
        return { centreOffsetPx: label.centre - (box.top + box.bottom) / 2,
          linkBaselineOffsetPx: label.baseline - link.baseline,
          noticeBaselineOffsetPx: sameRow ? label.baseline - notice.baseline : null,
          sameRow, disabled: button.disabled, buttonHeight: box.height };
      });
      await t.test(`${locale}/${theme}/${width}/${state}: text centring and baselines`, () => {
        assert.ok(Math.abs(alignment.centreOffsetPx) <= 1, `label text-box centre within ±1 px: ${JSON.stringify(alignment)}`);
        assert.ok(Math.abs(alignment.linkBaselineOffsetPx) <= 1, `Text lesen baseline within ±1 px: ${JSON.stringify(alignment)}`);
        if (alignment.sameRow) assert.ok(Math.abs(alignment.noticeBaselineOffsetPx) <= 1, `notice baseline within ±1 px: ${JSON.stringify(alignment)}`);
        assert.equal(alignment.sameRow, width !== 390, '390 stacks; desktop shares a row');
        assert.equal(alignment.disabled, state === 'disabled');
        assert.equal(alignment.buttonHeight, 44);
      });
      const after = await layoutBoxes(page, selectors); assert.deepEqual(after, before, `${locale}/${theme}/${width}/${state}: 0 px layout shift`);
      const file = `audio-replay-${state}-${width}-${theme}-${locale}.png`;
      if (evidence) await page.screenshot({ path: join(evidence, file), fullPage: false });
      files.push({ file, state, width, theme, locale, viewport: true });
      passLines.push({ file, shiftPx: 0, ...alignment, pass: true }); t.diagnostic(`PASS ${file}: 0 px shift; alignment ${JSON.stringify(alignment)}`);
    };
    await capture('idle');
    await t.test(`${locale}/${theme}/${width}: text link`, async () => {
      assert.equal(await shadow(page, c => c.shadowRoot.querySelector('.voice-read-text')?.textContent), locale === 'de' ? 'Text lesen' : 'Read text');
      await shadow(page, c => c.shadowRoot.querySelector('.voice-read-text').click());
      assert.equal(await page.evaluate(() => window.replayRail.notices.dialog.open), true);
      assert.equal(await shadow(page, c => c.shadowRoot.querySelector('.voice-reply-text').textContent), await page.evaluate(() => window.replayText));
      assert.equal(await page.evaluate(() => window.replayRequests.length), 0);
      await page.evaluate(() => window.replayRail.notices.dialog.close());
    });
    const persisted = await page.evaluate(() => window.replayPersisted.length);
    await shadow(page, c => c.shadowRoot.querySelector('.voice-repeat').click());
    await until(page, () => window.replayRail.notices.playing && !window.replayAudio.paused);
    assert.equal(await page.evaluate(() => window.replayPersisted.length), persisted, 'replay creates no transcript turn');
    assert.equal(await page.evaluate(() => window.replayRequests.at(-1).turnId), 'fixture_1:assistant:2');
    await capture('playing');
    await shadow(page, c => c.shadowRoot.querySelector('.voice-repeat').click());
    await until(page, () => !window.replayRail.notices.playing && window.replayAudio.paused);
    await capture('interrupted');
    await page.evaluate(() => { window.replayUnavailable = true; });
    await shadow(page, c => c.shadowRoot.querySelector('.voice-repeat').click());
    await until(page, () => window.replayRail.notices.dialog.open);
    assert.equal(await shadow(page, c => c.shadowRoot.querySelector('.voice-reply-text').textContent), await page.evaluate(() => window.replayText));
    await page.evaluate(() => window.replayRail.notices.dialog.close());
    await capture('fallback');
    await page.evaluate(() => {
      window.replayRail.notices.recovery.lastReplyText = null;
      window.replayRail.notices.fallback = false; window.replayRail.render();
    });
    assert.equal(await shadow(page, c => c.shadowRoot.querySelector('.voice-repeat').hidden), false, 'pending reply keeps its disabled button');
    await capture('disabled');
    await page.evaluate(() => { window.replayRail.notices.recovery.lastReplyText = window.replayText; window.replayRail.render(); });
    await shadow(page, c => { c.shadowRoot.querySelector('.turn:not(.user)').remove(); window.replayRail.render(); });
    assert.equal(await shadow(page, c => c.shadowRoot.querySelector('.voice-repeat').hidden), true, 'real recovery without a rendered assistant bubble hides replay');
    await shadow(page, c => {
      const text = window.replayText; c.session.transcript.push({ id: 'old-identical-reply', role: 'assistant', content: text });
      const row = document.createElement('li'); row.className = 'turn'; row.dataset.id = 'old-identical-reply';
      const body = document.createElement('span'); body.className = 'turn-text'; body.textContent = text; row.append(body);
      c.shadowRoot.querySelector('.transcript-shell ol').append(row); window.replayRail.render();
    });
    assert.equal(await shadow(page, c => c.shadowRoot.querySelector('.voice-repeat').hidden), true, 'an older identical bubble cannot stand in for the acknowledged reply');
    assert.equal(await shadow(page, c => c.shadowRoot.querySelector('.voice-read-text').hidden), true);
    await page.evaluate(async () => { window.replayRail.notices.dialog.close(); await window.replayRail.close(); });
  }
  if (evidence) await writeFile(join(evidence, 'audio-replay-evidence.json'), JSON.stringify({ ticket: 'AIT-154', head: evidenceCommit, files, passLines }, null, 2));
});
