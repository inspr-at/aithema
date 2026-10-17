// Shared by AIT-297's head check and the separately committed origin/main probe.
import assert from 'node:assert/strict';
import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { fixture } from './visitor-credit-tiers-helpers.js';
import { evidenceCommit, settleEvidenceFrame } from './start2-display-helpers.js';

export async function normalComposerEvidence(page, t) {
  const checks = [], evidence = process.env.AITHEMA_EVIDENCE_DIR;
  if (evidence) await mkdir(evidence, { recursive: true });
  for (const locale of ['de', 'en']) for (const theme of ['light', 'dark']) for (const width of [320, 360]) {
    await page.setViewport({ width, height: 844 });
    await page.emulateMediaFeatures([{ name: 'prefers-reduced-motion', value: 'reduce' }, { name: 'prefers-color-scheme', value: theme }]);
    await fixture(page, locale);
    await page.$eval('aithema-session', (c, { theme, locale }) => {
      c.setAttribute('theme', theme); document.documentElement.dataset.theme = theme; document.documentElement.lang = locale;
      c.style.setProperty('--aithema-font', 'ui-sans-serif,-apple-system,"Segoe UI Variable Text","Segoe UI",system-ui,sans-serif');
    }, { theme, locale });
    await settleEvidenceFrame(page);
    const measure = c => {
      const r = c.shadowRoot, shell = r.querySelector('.composer-shell'), composer = r.querySelector('form.composer');
      return { shellHeight: shell.getBoundingClientRect().height, composerHeight: composer.getBoundingClientRect().height,
        barMinHeight: getComputedStyle(r.querySelector('.composer-out__bar')).minHeight, usedUp: shell.hasAttribute('data-used-up'), visible: composer.checkVisibility({ visibilityProperty: true }),
        boxes: ['.composer-shell', 'form.composer', 'form.composer textarea', '.composer-actions', '.question-card'].map(selector => {
          const b = r.querySelector(selector).getBoundingClientRect(); return [b.x, b.y, b.width, b.height];
        }) };
    };
    const geometry = await page.$eval('aithema-session', measure);
    // Main 19f77faa: these are the only normal-composer title style differences.
    // Every other host-styles change targets data-host-limit. Apply main's
    // block title without a sizer in the same browser/font/fixture for comparison.
    await page.$eval('aithema-session', c => {
      const baseline = document.createElement('style'); baseline.id = 'ait297-main-normal-title';
      baseline.textContent = '.composer-out__title{display:block}.composer-out__title::before{content:none}';
      c.shadowRoot.append(baseline);
    });
    await settleEvidenceFrame(page);
    const mainGeometry = await page.$eval('aithema-session', measure);
    await page.$eval('aithema-session', c => c.shadowRoot.querySelector('#ait297-main-normal-title').remove());
    await settleEvidenceFrame(page);
    assert.deepEqual(geometry, mainGeometry, `${locale}/${theme}/${width}: normal composer geometry equals main title layout`);
    assert.equal(geometry.barMinHeight, 'auto', 'normal composers reserve no host-limit action rows');
    assert.equal(geometry.usedUp, false); assert.equal(geometry.visible, true);
    checks.push({ head: evidenceCommit, locale, theme, width, mainTitleBaseline: '19f77faa', mainGeometry, ...geometry });
    t.diagnostic(`AIT-297 normal ${locale}/${theme}/${width}: ${JSON.stringify(geometry)}`);
    if (evidence) await page.screenshot({ path: join(evidence, `ait-297-${locale}-${theme}-${width}-normal-composer.png`), fullPage: false, captureBeyondViewport: false });
  }
  if (evidence) await writeFile(join(evidence, 'ait-297-normal-composer-checks.json'), JSON.stringify({ head: evidenceCommit, checks }, null, 2));
}
