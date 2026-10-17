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
    const geometry = await page.$eval('aithema-session', c => {
      const r = c.shadowRoot, shell = r.querySelector('.composer-shell'), composer = r.querySelector('form.composer');
      return { shellHeight: shell.getBoundingClientRect().height, composerHeight: composer.getBoundingClientRect().height,
        barMinHeight: getComputedStyle(r.querySelector('.composer-out__bar')).minHeight, usedUp: shell.hasAttribute('data-used-up'), visible: composer.checkVisibility({ visibilityProperty: true }) };
    });
    assert.equal(geometry.barMinHeight, 'auto', 'normal composers reserve no host-limit action rows');
    assert.equal(geometry.usedUp, false); assert.equal(geometry.visible, true);
    checks.push({ head: evidenceCommit, locale, theme, width, ...geometry });
    t.diagnostic(`AIT-297 normal ${locale}/${theme}/${width}: ${JSON.stringify(geometry)}`);
    if (evidence) await page.screenshot({ path: join(evidence, `ait-297-${locale}-${theme}-${width}-normal-composer.png`), fullPage: false, captureBeyondViewport: false });
  }
  if (evidence) await writeFile(join(evidence, 'ait-297-normal-composer-checks.json'), JSON.stringify({ head: evidenceCommit, checks }, null, 2));
}
