import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { en } from '../../packages/ui/src/i18n/en.js';
import { de } from '../../packages/ui/src/i18n/de.js';
import { browserForFile } from './shared-browser.js';
import { startDemo, stopDemo, preparePage, waitForShadow, startTyping, inShadow } from './demo-helpers.js';

export function uploadFollowupCheck() {
  for (const width of [390, 1440]) for (const locale of ['en', 'de']) {
    const theme = locale === 'en' ? 'light' : 'dark', copy = { en, de }[locale];
    test(`AIT-561: ${width}/${locale}/${theme} specific capacity and final failures`, { timeout: 120000 }, async t => {
      const directory = await mkdtemp(join(tmpdir(), 'aithema-upload-followup-'));
      const demo = await startDemo(directory), browser = await browserForFile(), page = await browser.newPage();
      t.after(async () => { await page.close(); await stopDemo(demo.child); await rm(directory, { recursive: true, force: true }); });
      await preparePage(page, [locale]); await page.setViewport({ width, height: width === 390 ? 844 : 900 });
      await page.emulateMediaFeatures([{ name: 'prefers-color-scheme', value: theme }, { name: 'prefers-reduced-motion', value: 'reduce' }]);
      await page.goto(demo.url, { waitUntil: 'domcontentloaded' }); await waitForShadow(page, '.composer textarea');
      for (const scenario of ['count', 'bytes', 'purpose', 'ownership']) await t.test(scenario, async () => {
        await inShadow(page, async (c, { scenario, locale }) => {
          const session = structuredClone(c.session); session.id = crypto.randomUUID(); session.seq = 0; session.locale = locale;
          session.uploads = []; session.transcript = [{ id: 'established', role: 'user', content: 'Project documents', at: new Date().toISOString() }];
          session.settings.voice = 'off'; session.settings.origin = 'chosen';
          session.featureMatrix = { best: Object.fromEntries(['text', 'analysis', 'uploads', 'imageInput'].map(key => [key, { available: true }])) };
          window.followupPosts = []; window.followupScenario = scenario;
          window.fetch = async (url, options = {}) => {
            if (String(url).endsWith('/uploads')) {
              const limits = { maxFilesPerRequest: 2, ...(scenario === 'bytes' ? { maxSessionBytes: 50 } : {}) };
              if (options.method !== 'POST') return Response.json({ limits });
              const files = options.body.getAll('files'); window.followupPosts.push(files.map(file => file.name));
              if (scenario === 'purpose' || scenario === 'ownership') return Response.json(scenario === 'purpose'
                ? { error: 'conversation-paused', reason: 'purpose' } : { error: 'not-owner' }, { status: scenario === 'purpose' ? 409 : 403 });
              // Match the pre-fix server capacity boundary after the first batches.
              return Response.json({ error: 'size-limit' }, { status: 413 });
            }
            if (/\/events(?:\?|$)/u.test(String(url))) return new Response(new ReadableStream({ start(controller) { options.signal?.addEventListener('abort', () => controller.close(), { once: true }); } }));
            return Response.json(session);
          };
          const { [locale]: copy } = await import(`/packages/ui/src/i18n/${locale}.js`);
          c.configure({ session, copy, entrance: 'choice', sessionToken: 'fixture', voiceClient: {} });
        }, { scenario, locale });
        await startTyping(page);
        const boxes = () => inShadow(page, c => Object.fromEntries(['.composer', '.send', 'textarea'].map(selector => {
          const r = c.shadowRoot.querySelector(selector).getBoundingClientRect(); return [selector, { x: r.x, y: r.y, width: r.width, height: r.height }];
        })));
        const settle = () => page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))));
        await settle(); const before = await boxes();
        await inShadow(page, c => {
          const transfer = new DataTransfer(), count = window.followupScenario === 'count' ? 9 : window.followupScenario === 'bytes' ? 2 : 4;
          for (let i = 0; i < count; i++) transfer.items.add(new File(['%PDF-' + 'x'.repeat(25)], `document-${i}.pdf`, { type: 'application/pdf' }));
          const input = c.shadowRoot.querySelector('.attach-input'); input.files = transfer.files; input.dispatchEvent(new Event('change'));
        });
        await page.waitForFunction(() => !document.querySelector('aithema-session').shadowRoot.querySelector('.composer').hasAttribute('aria-busy'));
        await settle(); const after = await boxes();
        const result = await inShadow(page, c => ({ posts: window.followupPosts, notice: c.shadowRoot.querySelector('.composer-reason').textContent }));
        const evidence = process.env.AITHEMA_EVIDENCE_DIR, prefix = `ait561-${scenario}-${width}-${locale}-${theme}`;
        if (evidence) { await mkdir(evidence, { recursive: true }); await page.screenshot({ path: join(evidence, `${prefix}.png`) }); await writeFile(join(evidence, `${prefix}.json`), JSON.stringify({ before, after, result }, null, 2)); }
        if (scenario === 'count' || scenario === 'bytes') {
          assert.deepEqual(result.posts, []);
          assert.equal(result.notice, scenario === 'count' ? copy.uploads.tooMany.replace('{files}', '8') : copy.uploads.sessionFull.replace('{size}', '50 B'));
        } else {
          assert.equal(result.posts.length, 1);
          const failure = scenario === 'purpose' ? copy.purposePaused : copy.uploads.failed;
          assert.equal(result.notice.split(failure).length - 1, 1);
          for (let i = 0; i < 4; i++) assert.equal(result.notice.split(`document-${i}.pdf`).length - 1, 1);
        }
        for (const selector of Object.keys(before)) {
          assert.ok(before[selector].width > 0 && before[selector].height > 0 && after[selector].width > 0 && after[selector].height > 0, `${selector} visible`);
          assert.deepEqual(after[selector], before[selector], `${selector}: 0 px layout shift`);
        }
      });
    });
  }
}
