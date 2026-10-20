// Evidence only: capture the unmodified main component, with no AIT-411 code.
import { test } from 'node:test';
import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { de } from '../src/i18n/de.js';
import { en } from '../src/i18n/en.js';
import { setup, tick } from './host-surface-helpers.js';
for (const copy of [de, en]) test(`AIT-411 independent main DOM ${copy.display.locale}`, async t => {
  const fixture = setup(t, { copy, host: { credits: true, verification: true } });
  await tick(10);
  const dom = ['.host-credits', '.composer-out', '.transcript-shell'].map(selector => fixture.root.querySelector(selector).outerHTML.replaceAll(fixture.c.session.id, '<session>'));
  console.log('AIT411_BASELINE ' + JSON.stringify({ locale: copy.display.locale, dom }));
  if (process.env.AITHEMA_EVIDENCE_DIR) {
    await mkdir(process.env.AITHEMA_EVIDENCE_DIR, { recursive: true });
    await writeFile(join(process.env.AITHEMA_EVIDENCE_DIR, `ait411-rc13-${copy.display.locale}.json`), JSON.stringify(dom, null, 2) + '\n');
  }
});
