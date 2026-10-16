// AIT-260: one page, in-place states; screenshots only in the remote evidence matrix.
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { startChild } from '../helpers.js';
import { browserForFile } from './shared-browser.js';
import { fullMatrix } from './matrix-coverage.js';
import { captureEvidence, evidenceBrowserArgs, evidenceCommit, shadow, until } from './start2-display-helpers.js';

export async function hostChromeCheck(t) {
  const directory = await mkdtemp(join(tmpdir(), 'aithema-host-chrome-'));
  const demo = await startChild(new URL('../fixtures/no-provider-server.js', import.meta.url), join(directory, 'session.sqlite'), {
    AITHEMA_VOICE_MODE: 'off', AITHEMA_IMAGE_MODE: 'off', AITHEMA_HTML_MODE: 'off',
  });
  const browser = await browserForFile(fullMatrix ? { args: evidenceBrowserArgs } : {}), page = await browser.newPage();
  t.after(async () => { await browser.close(); await demo.kill(); });
  const errors = []; page.on('pageerror', e => errors.push(e.message));
  await page.emulateMediaFeatures([{ name: 'prefers-reduced-motion', value: 'reduce' }]);
  await page.setRequestInterception(true);
  page.on('request', request => new URL(request.url()).pathname.endsWith('/features')
    ? request.respond({ status: 200, contentType: 'application/json', body: '{}' }) : request.continue());
  await page.goto(demo.url, { waitUntil: 'domcontentloaded' });
  await until(page, () => document.querySelector('aithema-session')?.session?.id);
  await shadow(page, c => { window.chromeSeed = c.session; });
  const evidence = fullMatrix && join(process.env.AITHEMA_EVIDENCE_DIR, 'ait260-host-chrome');
  if (evidence) await mkdir(evidence, { recursive: true });
  const checks = [];
  const settle = () => shadow(page, async c => {
    await document.fonts.ready;
    await new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)));
    await Promise.all(c.shadowRoot.getAnimations({ subtree: true }).filter(a => a.playState === 'running' && Number.isFinite(a.effect.getComputedTiming().endTime)).map(a => a.finished.catch(() => {})));
  });
  const shot = async label => {
    if (!evidence) return;
    await shadow(page, c => { c.shadowRoot.activeElement?.blur(); document.activeElement?.blur(); });
    await page.mouse.move(-1, -1); await settle();
    const { png } = await captureEvidence(page);
    await writeFile(join(evidence, `${label}.png`), png);
  };
  for (const locale of ['de', 'en']) for (const width of fullMatrix ? [1440, 1024, 390] : [1440, 390]) {
    await page.setViewport({ width, height: width < 600 ? 844 : 1000 });
    for (const theme of fullMatrix ? ['light', 'dark'] : ['light']) {
      await page.select('#theme', theme);
      const heights = [];
      for (const voice of [false, true]) {
        await shadow(page, async (c, { locale, voice }) => {
          const { [locale]: copy } = await import(`/packages/ui/src/i18n/${locale}.js`);
          const session = structuredClone(window.chromeSeed); session.locale = locale; session.transcript = []; session.uploads = [];
          session.featureMatrix.best = { text: { available: true }, analysis: { available: true }, voice: { available: voice, reason: voice ? null : 'not configured' } };
          c.querySelectorAll('[slot="legal"], [slot="brand"]').forEach(n => n.remove());
          const brand = document.createElement('h1'); brand.slot = 'brand'; brand.textContent = '  START\n  Studio  ';
          const legal = document.createElement('nav'); legal.slot = 'legal'; legal.style.cssText = 'display:flex;gap:8px';
          for (const [href, text] of [['/imprint', locale === 'de' ? 'Impressum' : 'Imprint'], ['/privacy', locale === 'de' ? 'Datenschutz' : 'Privacy']]) {
            const a = document.createElement('a'); a.href = href; a.textContent = text; a.style.color = 'inherit'; legal.append(a);
          }
          c.append(brand, legal);
          c.style.setProperty('--aithema-font', 'ui-sans-serif,-apple-system,"Segoe UI Variable Text","Segoe UI",system-ui,sans-serif');
          c.style.setProperty('--aithema-display', 'Georgia,"Iowan Old Style","Palatino Linotype",serif');
          c.setAttribute('motion', 'off');
          c.configure({ copy, session, voiceClients: voice ? { offered: {} } : {}, host: { version: { version: '261017010000.0.0', version_scheme: 'inspr-calver-3', commit: 'abcdef1234' } } });
          document.documentElement.lang = locale; scrollTo(0, 0);
        }, { locale, voice });
        await settle();
        const label = `${locale}-${theme}-${width}-${voice ? 'voice' : 'no-voice'}`;
        for (const stage of ['entrance', 'ready', 'conversation']) {
          if (stage === 'ready') await shadow(page, c => c.receive({ seq: c.session.seq + 1, type: 'settings.changed', data: { processingPreset: 'best', settings: { ...c.session.settings, origin: 'chosen', revision: 1 } } }));
          if (stage === 'conversation') await shadow(page, c => {
            c.receive({ seq: c.session.seq + 1, type: 'turn.final', data: { id: 'u', role: 'user', content: 'We need a simple project portal.' } });
            c.receive({ seq: c.session.seq + 1, type: 'turn.final', data: { id: 'a', role: 'assistant', content: 'Which details should the portal show?', inputRevision: 1 } });
          });
          await settle();
          const metrics = await shadow(page, (c, voice) => {
            const r = c.shadowRoot, brand = c.querySelector('[slot="brand"]'), legal = c.querySelector('[slot="legal"]');
            const visible = n => n.checkVisibility({ checkVisibilityCSS: true });
            const footer = r.querySelector('.display-foot').getBoundingClientRect(), links = [...legal.querySelectorAll('a')];
            const absent = '.audio-rail, .pause, .voice-start, .voice-input, .voice-output, .ai-notice__voice, .ready__mode[data-mode="voice"], [data-ready="microphone"], [data-ready="speaker"], .voice-repeat, .voice-read-text, .voice-reply-actions';
            const content = r.querySelector('.workspace');
            const timer = r.querySelector('.connection-timer');
            return { height: r.querySelector('.band').getBoundingClientRect().height, h1: document.querySelectorAll('h1').length + r.querySelectorAll('h1').length,
              brand: visible(brand), brandHeight: brand.getBoundingClientRect().height, brandLabel: r.querySelector('.host-version__label').textContent,
              product: r.querySelector('.display-version').textContent, noVoice: !r.querySelector(absent),
              voice: Boolean(r.querySelector('.voice-start') && r.querySelector('.pause')),
              claim: /synthetische Stimme|synthetic voice|Text lesen|Read text/u.test(content.textContent),
              legal: links.every(n => { const b = n.getBoundingClientRect(); return visible(n) && b.left >= 0 && b.right <= innerWidth && b.top >= footer.top && b.bottom <= footer.bottom; }),
              timerPopup: Boolean(timer.closest('.footer-info .footer-popup')),
              footerOverflow: r.querySelector('.display-foot__row').scrollWidth > r.querySelector('.display-foot__row').clientWidth,
            };
          }, voice);
          heights.push(metrics.height);
          assert.equal(metrics.h1, 1, `${label}/${stage}: one page h1`); assert.equal(metrics.brand, true); assert.ok(metrics.brandHeight <= 44, `${label}/${stage}: brand uses existing wordmark typography`);
          assert.equal(metrics.brandLabel, 'START Studio'); assert.equal(metrics.product, 'Aithema 2026.10');
          assert.equal(metrics.legal, true, `${label}/${stage}: legal links visible in bar`);
          assert.equal(metrics.footerOverflow, false, `${label}/${stage}: footer fits`);
          assert.equal(metrics.timerPopup, width < 600);
          if (voice) assert.equal(metrics.voice, true); else { assert.equal(metrics.noVoice, true); assert.equal(metrics.claim, false); }
          // One activation/tab from the conversation or entrance; no popup prerequisite.
          await shadow(page, c => c.querySelector('[slot="legal"] a').focus());
          assert.equal(await shadow(page, c => document.activeElement === c.querySelector('[slot="legal"] a')), true);
          await page.keyboard.press('Tab');
          assert.equal(await shadow(page, c => document.activeElement === c.querySelectorAll('[slot="legal"] a')[1]), true);
          await page.evaluate(() => {
            window.legalClicked = null;
            document.querySelector('[slot="legal"]').addEventListener('click', e => { e.preventDefault(); window.legalClicked = e.target.getAttribute('href'); }, { once: true });
          });
          await page.click('[slot="legal"] a');
          assert.equal(await page.evaluate(() => window.legalClicked), '/imprint');
          checks.push({ label, stage, ...metrics });
          if (stage !== 'ready') await shot(`${label}-${stage}`);
        }
        // Popup metadata and the relocated phone timer are visible on activation.
        await page.click('aithema-session >>> .ai-notice'); await settle();
        assert.equal(await shadow(page, c => c.shadowRoot.querySelector('.host-version').checkVisibility({ checkVisibilityCSS: true })), true);
        if (width < 600) assert.equal(await shadow(page, c => c.shadowRoot.querySelector('.connection-timer').checkVisibility({ checkVisibilityCSS: true })), true);
        // Keep the popup open while every interactive control is blurred for evidence.
        if (evidence) {
          await shadow(page, c => { c.shadowRoot.activeElement?.blur(); document.activeElement?.blur(); });
          await page.mouse.move(-1, -1); await settle();
          const { png } = await captureEvidence(page); await writeFile(join(evidence, `${label}-popup.png`), png);
        }
      }
      assert.equal(new Set(heights).size, 1, `${locale}/${theme}/${width}: header difference 0 px across voice and stages`);
    }
  }
  assert.deepEqual(errors, []);
  if (evidence) await writeFile(join(evidence, 'checks.json'), JSON.stringify({ head: evidenceCommit, checks }, null, 2));
}
