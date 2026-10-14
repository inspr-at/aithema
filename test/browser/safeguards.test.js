// AIT-174 UI contract: accepted safe reply events; providers and SSE are stubbed.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mkdir, mkdtemp, writeFile } from 'node:fs/promises';
import { homedir, tmpdir } from 'node:os';
import { join } from 'node:path';
import puppeteer from 'puppeteer-core';
import { startChild } from '../helpers.js';
import { browserPath, shadow, boxes, evidenceCommit } from './start2-display-helpers.js';
const frame = page => page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))));

test('AIT-174 redirect, subtle question, locked pause and normal reply at 390/1024/1440, L/D, DE/EN: exact 0 px composer shift', { timeout: 90_000 }, async t => {
  const directory = await mkdtemp(join(tmpdir(), 'aithema-safeguards-'));
  const demo = await startChild(new URL('../fixtures/no-provider-server.js', import.meta.url), join(directory, 'session.sqlite'), {
    AITHEMA_VOICE_MODE: 'off', AITHEMA_IMAGE_MODE: 'off', AITHEMA_HTML_MODE: 'off',
  }); t.after(() => demo.kill());
  const browser = await puppeteer.launch({ executablePath: await browserPath(), headless: true, userDataDir: join(directory, 'chrome'),
    env: { PATH: process.env.PATH, HOME: homedir() }, args: process.platform === 'linux' && process.env.CI ? ['--no-sandbox'] : [] });
  t.after(() => browser.close()); const page = await browser.newPage();
  await page.setRequestInterception(true);
  page.on('request', request => { void (async () => {
    const path = new URL(request.url()).pathname;
    if (path.endsWith('/events')) return request.respond({ status: 200, contentType: 'text/event-stream', body: ': stub\n\n' });
    if (/^\/api\/sessions\/[^/]+$/u.test(path) && request.method() === 'GET') {
      const snapshot = await page.evaluate(() => globalThis.safeguardsSeed ? document.querySelector('aithema-session').session : null);
      if (snapshot) return request.respond({ status: 200, contentType: 'application/json', body: JSON.stringify(snapshot) });
    }
    return request.continue();
  })().catch(error => { globalThis.safeguardsInterceptionError = error; }); });
  await page.goto(demo.url, { waitUntil: 'domcontentloaded' });
  await page.waitForFunction(() => document.querySelector('aithema-session')?.session?.id);
  await shadow(page, c => { globalThis.safeguardsSeed = c.session; });
  const evidence = process.env.AITHEMA_EVIDENCE_DIR, files = [], checks = [];
  if (evidence) await mkdir(evidence, { recursive: true });
  for (const locale of ['de', 'en']) for (const theme of ['light', 'dark']) for (const width of [390, 1024, 1440]) {
    await t.test(`${locale}/${theme}/${width}`, async () => {
      const label = `${locale}-${theme}-${width}`;
      await page.setViewport({ width, height: width === 390 ? 844 : 900 }); await page.select('#theme', theme);
      await page.evaluate(async locale => {
        const { en } = await import('/packages/ui/src/i18n/en.js'), { de } = await import('/packages/ui/src/i18n/de.js');
        const { inputRevision } = await import('/packages/core/src/session.js');
        const { paintUtilities } = await import('/demo/page-preferences.js');
        const c = document.querySelector('aithema-session'), session = structuredClone(globalThis.safeguardsSeed), copy = { en, de }[locale];
        session.locale = locale; session.seq = 1; session.inputRevision = 1; session.settings.origin = 'chosen'; session.paused = false; delete session.pauseReason;
        session.featureMatrix.best = { text: { available: true }, analysis: { available: true }, voice: { available: false } };
        session.transcript = [{ id: 'project', role: 'user', content: locale === 'de' ? 'Wir möchten unsere Abläufe verbessern und ein Produkt entwickeln.' : 'We want to improve our processes and develop a product.' },
          { id: 'normal', role: 'assistant', content: locale === 'de' ? 'Was sollte sich für Ihr Unternehmen als Erstes verbessern?' : 'What should improve first for your company?', inputRevision: inputRevision(session), question_short: null, options: [] }];
        c.configure({ copy, session }); globalThis.safeguardsCopy = copy;
        document.documentElement.lang = locale; document.querySelector('#locale').value = locale; paintUtilities(copy);
        c.shadowRoot.querySelector('.send').scrollIntoView({ block: 'end', behavior: 'instant' });
      }, locale); await frame(page); await page.mouse.move(0, 0);
      const baseline = await boxes(page, ['.composer', 'textarea', '.attach', '.send']);
      const shot = async state => { if (evidence) {
        const file = `ait-174-${label}-${state}.png`; await page.screenshot({ path: join(evidence, file), fullPage: false }); files.push(file);
      } };

      await page.evaluate(async () => {
        const { inputRevision } = await import('/packages/core/src/session.js'), c = document.querySelector('aithema-session');
        c.receive({ seq: c.session.seq + 1, type: 'turn.final', data: { id: 'vague', role: 'user', content: c.session.locale === 'de' ? 'Das ist noch unklar.' : 'That is still unclear.' } });
        c.receive({ seq: c.session.seq + 1, type: 'turn.final', data: { id: 'direction', role: 'assistant', content: c.session.locale === 'de'
          ? 'Geht es Ihnen eher um eine neue Lösung, um Ihre Abläufe, oder um beides?'
          : 'Is this more about a new solution, about how you work, or both?', question_short: null, options: [], inputRevision: inputRevision(c.session) } });
      }); await frame(page);
      assert.deepEqual(await boxes(page, ['.composer', 'textarea', '.attach', '.send']), baseline, `${label} subtle question: 0 px shift`);
      assert.equal(await shadow(page, c => Boolean(c.shadowRoot.querySelector('.qcard:not([hidden])'))), false);

      await page.evaluate(async () => {
        const { inputRevision } = await import('/packages/core/src/session.js'), c = document.querySelector('aithema-session');
        c.receive({ seq: c.session.seq + 1, type: 'turn.final', data: { id: 'off', role: 'user', content: c.session.locale === 'de' ? 'Ein Rezept für Gemüsesuppe bitte.' : 'A vegetable soup recipe please.' } });
        c.receive({ seq: c.session.seq + 1, type: 'turn.final', data: { id: 'redirect', role: 'assistant', content: globalThis.safeguardsCopy.purposeRedirect,
          question_short: null, options: [], inputRevision: inputRevision(c.session) } });
      }); await frame(page);
      assert.deepEqual(await boxes(page, ['.composer', 'textarea', '.attach', '.send']), baseline, `${label} redirect: 0 px shift`);
      const redirect = await shadow(page, c => ({ text: c.shadowRoot.querySelector('.transcript-shell').textContent, card: Boolean(c.shadowRoot.querySelector('.qcard:not([hidden])')) }));
      assert.match(redirect.text, /Augmentoring/u); assert.equal(redirect.card, false); assert.doesNotMatch(redirect.text, /scope|```|AITHEMA_CANARY_/u);
      const overview = await shadow(page, c => c.shadowRoot.querySelector('.analysis-content').textContent);
      await shadow(page, c => c.receive({ seq: c.session.seq + 1, type: 'session.paused', data: { paused: true, reason: 'purpose' } })); await frame(page);
      assert.deepEqual(await boxes(page, ['.composer', 'textarea', '.attach', '.send']), baseline, `${label} pause: 0 px shift`);
      const pause = await shadow(page, c => {
        const root = c.shadowRoot, copy = root.querySelector('.purpose-pause-copy');
        return { text: copy.textContent, shown: !copy.hidden, height: copy.clientHeight, scroll: copy.scrollHeight,
          railOverflow: root.querySelector('.voice-state').textContent.includes('Augmentoring'),
          callDisabled: root.querySelector('.voice-start').disabled,
          visibleControls: [...root.querySelectorAll('.audio-rail button')].filter(button => getComputedStyle(button).visibility === 'visible' && button.getClientRects().length).map(button => button.className).sort(),
          callTooltip: root.querySelector('.voice-start').title,
          callDescription: root.querySelector('.voice-start').getAttribute('aria-description'),
          callIcon: root.querySelector('.voice-start svg').outerHTML,
          channelsDisabled: ['.voice-output', '.voice-input'].every(selector => root.querySelector(selector).disabled),
          visiblePlay: [...root.querySelectorAll('.audio-rail svg')].some(svg => svg.querySelector('path[d="M8 5v14l11-7z"]') && getComputedStyle(svg).visibility === 'visible' && getComputedStyle(svg).display !== 'none'),
          outsidePause: [...root.querySelectorAll('*')].filter(n => !n.closest('.composer-shell') && !n.closest('style') && n.childNodes.length && getComputedStyle(n).visibility === 'visible' && n.getClientRects().length)
            .flatMap(n => [...n.childNodes].filter(child => child.nodeType === Node.TEXT_NODE).map(child => child.textContent)).filter(text => /pausiert|paused/iu.test(text)),
          overview: root.querySelector('.analysis-content').textContent,
          disabled: ['textarea', '.send', '.pause'].every(selector => root.querySelector(selector).disabled) && root.querySelector('.attach').getAttribute('aria-disabled') === 'true',
          overflow: document.documentElement.scrollWidth > innerWidth, label: JSON.stringify(c.session).includes('scope') };
      });
      assert.equal(pause.shown, true);
      assert.equal(pause.text, locale === 'de'
        ? 'Dieses Gespräch ist pausiert. Hier geht es um Vorhaben, bei denen Augmentoring unterstützt: eine Lösung entwickeln oder Abläufe verbessern.'
        : "This conversation is paused. It's for projects Augmentoring can support: building a solution or improving how you work.");
      const action = await shadow(page, c => {
        const button = c.shadowRoot.querySelector('.purpose-new');
        return { text: button?.textContent, shown: button && !button.hidden && button.getBoundingClientRect().width > 0,
          inComposer: Boolean(button?.closest('.composer-shell')), enabled: button && !button.disabled };
      });
      assert.deepEqual(action, { text: locale === 'de' ? 'Neues Gespräch' : 'New conversation', shown: true, inComposer: true, enabled: true });
      assert.equal(pause.railOverflow, false);
      assert.equal(pause.callDisabled, true, `${label}: call button disabled`);
      assert.equal(pause.channelsDisabled, true);
      assert.deepEqual(pause.visibleControls, ['voice-input', 'voice-output', 'voice-start'], `${label}: three idle call controls`);
      assert.match(pause.callIcon, /<rect/u, `${label}: start-call mic icon`);
      assert.equal(pause.visiblePlay, false, `${label}: no play glyph`);
      assert.deepEqual(pause.outsidePause, [], `${label}: no pausiert/paused text outside composer slot`);
      assert.equal(pause.overview, overview, `${label}: overview keeps its last content`);
      assert.equal(pause.callTooltip, locale === 'de' ? 'Dieses Gespräch ist pausiert.' : 'This conversation is paused.');
      assert.equal(pause.callDescription, pause.callTooltip);
      assert.equal(pause.disabled, true); assert.equal(pause.overflow, false); assert.equal(pause.label, false);
      assert.ok(pause.scroll <= pause.height + 1, `${label}: full pause copy fits its reserved composer area`);
      if (locale === 'de' && width === 390) {
        // Linux's wider sans metrics need four lines; reproduce that on macOS too.
        await shadow(page, c => { const copy = c.shadowRoot.querySelector('.purpose-pause-copy'); copy.style.fontFamily = 'Arial, sans-serif'; copy.style.fontSize = '13px'; copy.style.width = '270px'; });
        await frame(page);
        const metrics = await shadow(page, c => {
          const copy = c.shadowRoot.querySelector('.purpose-pause-copy'), action = c.shadowRoot.querySelector('.purpose-new');
          return { height: copy.clientHeight, scroll: copy.scrollHeight, gap: action.getBoundingClientRect().top - copy.getBoundingClientRect().bottom };
        });
        await shadow(page, c => { const copy = c.shadowRoot.querySelector('.purpose-pause-copy'); copy.style.fontFamily = ''; copy.style.fontSize = ''; copy.style.width = ''; });
        await frame(page);
        assert.ok(metrics.scroll <= metrics.height + 1, `${label}: wider font pause copy fits (${metrics.scroll}/${metrics.height})`);
        assert.ok(metrics.gap >= 4, `${label}: pause paragraph and action stay apart (${metrics.gap}px)`);
      }
      if (width !== 1024) await shot('pause');
      checks.push(`${label}: normal, redirect, subtle question without buttons, locked pause with New conversation; no play glyph; call button disabled; no pausiert/paused text anywhere outside composer slot; overview retains last content; 0 px composer shift; no horizontal overflow; pause copy fits`);
    });
  }
  assert.equal(globalThis.safeguardsInterceptionError, undefined);
  if (evidence) await writeFile(join(evidence, 'ait-174-pass-lines.txt'), `commit=${evidenceCommit}\n${checks.join('\n')}\n${files.length} viewport captures\n`);
});
