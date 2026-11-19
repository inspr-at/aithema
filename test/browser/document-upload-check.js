import assert from 'node:assert/strict';
import { uploadFollowupCheck, heldUploadCheck } from './upload-followup-check.js';
import { mixedUploadCheck } from './mixed-upload-check.js';
import { test } from 'node:test';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { browserForFile } from './shared-browser.js';
import { startDemo, stopDemo, preparePage, waitForShadow, startTyping, inShadow } from './demo-helpers.js';

const limits = {
  en: 'Up to 8 files, 20 MB each: PDF, Word, Excel, PowerPoint, text, Markdown, CSV, JSON or XML. The original file is not stored.',
  de: 'Bis zu 8 Dateien, je höchstens 20 MB: PDF, Word, Excel, PowerPoint, Text, Markdown, CSV, JSON oder XML. Die Originaldatei wird nicht aufbewahrt.',
};
const limitsWithImages = {
  en: 'Up to 8 files, 20 MB each: PDF, Word, Excel, PowerPoint, text, Markdown, CSV, JSON, XML, PNG, JPEG, WebP or GIF. Original documents are not stored; normalized images are kept until withdrawn or erased.',
  de: 'Bis zu 8 Dateien, je höchstens 20 MB: PDF, Word, Excel, PowerPoint, Text, Markdown, CSV, JSON, XML, PNG, JPEG, WebP oder GIF. Originaldokumente werden nicht aufbewahrt; normalisierte Bilder bleiben bis zum Zurückziehen oder Löschen gespeichert.',
};
const accept = '.pdf,.docx,.xlsx,.pptx,.txt,.md,.csv,.json,.xml';
export function documentUploadCheck() {
  mixedUploadCheck();
  uploadFollowupCheck();
  heldUploadCheck();
  for (const entrance of ['choice', 'combined']) for (const width of [390, 1440]) for (const locale of ['en', 'de']) {
    const theme = locale === 'en' ? 'light' : 'dark';
    test(`AIT-556: ${entrance}/${width}/${locale}/${theme} current binding preserves document uploads`, { timeout: 90000 }, async t => {
      const directory = await mkdtemp(join(tmpdir(), 'aithema-document-upload-'));
      const demo = await startDemo(directory), browser = await browserForFile();
      const page = await browser.newPage();
      t.after(async () => { await page.close(); await stopDemo(demo.child); await rm(directory, { recursive: true, force: true }); });
      await preparePage(page, [locale]); await page.setViewport({ width, height: width === 390 ? 844 : 900 });
      await page.emulateMediaFeatures([{ name: 'prefers-color-scheme', value: theme }, { name: 'prefers-reduced-motion', value: 'reduce' }]);
      await page.goto(demo.url, { waitUntil: 'domcontentloaded' }); await waitForShadow(page, '.composer textarea');
      await inShadow(page, async (c, entrance) => {
        window.documentUploadEntrance = entrance; window.documentImageReason = 'image normalizer not configured'; window.documentUploadPosts = [];
        const session = c.session;
        session.settings.origin = 'chosen'; session.settings.voice = 'off';
        session.inputRevision = 1;
        session.transcript = [{ id: 'document-input', role: 'user', content: 'Project documents', at: new Date(0).toISOString() },
          { id: 'document-reply', role: 'assistant', content: 'Which document should we clarify?', at: new Date(1).toISOString() }];
        session.featureMatrix.best = Object.fromEntries(['text', 'analysis', 'uploads'].map(key => [key, { available: true }]));
        session.featureMatrix.best.imageInput = { available: false, reason: window.documentImageReason };
        window.documentSnapshot = session;
        const nativeFetch = window.fetch.bind(window);
        window.fetch = async (url, options = {}) => {
          if (String(url).endsWith('/uploads')) {
            if (options.method === 'POST') window.documentUploadPosts.push(options.body.getAll('files').map(file => file.name));
            return Response.json({ uploads: [] });
          }
          if (String(url).endsWith(`/api/sessions/${session.id}`)) {
            const snapshot = c.session;
            snapshot.featureMatrix.best.imageInput = { available: !window.documentImageReason, reason: window.documentImageReason };
            return Response.json(snapshot);
          }
          if (/\/events(?:\?|$)/u.test(String(url))) return new Response(new ReadableStream({ start(controller) { options.signal?.addEventListener('abort', () => controller.close(), { once: true }); } }));
          return nativeFetch(url, options);
        };
        const { [session.locale]: copy } = await import(`/packages/ui/src/i18n/${session.locale}.js`);
        c.configure({ entrance, session, copy, sessionToken: 'fixture', voiceClient: {} });
      }, entrance);
      await startTyping(page);
      const evidence = process.env.AITHEMA_EVIDENCE_DIR, prefix = `ait556-${entrance}-${width}-${locale}-${theme}`;
      if (evidence) await mkdir(evidence, { recursive: true });
      const shot = async state => {
        await inShadow(page, c => c.shadowRoot.activeElement?.blur()); await page.mouse.move(0, 0);
        await page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))));
        if (evidence) await page.screenshot({ path: join(evidence, `${prefix}-${state}.png`) });
      };
      const facts = () => inShadow(page, c => ({
        title: c.shadowRoot.querySelector('.attach').title,
        description: c.shadowRoot.querySelector('#attach-limits').textContent,
        accept: c.shadowRoot.querySelector('.attach-input').accept,
        retention: /normalized images|normalisierte Bilder/u.test(c.shadowRoot.textContent),
      }));
      const boxes = () => inShadow(page, c => Object.fromEntries(['.band', '.audio-rail', '.composer', '.send', 'textarea', ...(window.innerWidth === 1440 ? ['.understanding'] : [])].map(selector => {
        const r = c.shadowRoot.querySelector(selector).getBoundingClientRect();
        return [selector, { x: r.x, y: r.y, w: r.width, h: r.height }];
      })));
      await shot('1-2-help-picker');
      await t.test('1-2 exact main title, description and picker', async () => {
        assert.deepEqual(await facts(), { title: limits[locale], description: limits[locale], accept, retention: false });
      });
      for (const [index, name] of [[3, 'x.heic'], [4, 'x.png']]) await t.test(`${index} ${name} exact main refusal and zero movement`, async () => {
        const before = await boxes();
        await inShadow(page, (c, name) => {
          const transfer = new DataTransfer(); transfer.items.add(new File(['fixture'], name, { type: 'image/png' }));
          const input = c.shadowRoot.querySelector('.attach-input'); input.files = transfer.files; input.dispatchEvent(new Event('change'));
        }, name);
        await page.waitForFunction(() => !document.querySelector('aithema-session').shadowRoot.querySelector('.composer').hasAttribute('aria-busy'));
        await shot(`${index}-${name}`);
        const after = await boxes(), result = await inShadow(page, c => ({
          refusal: c.shadowRoot.querySelector('.composer-reason').textContent,
          imageRefusal: c.shadowRoot.querySelector('.image-refusals')?.textContent ?? null,
        }));
        if (evidence) await writeFile(join(evidence, `${prefix}-${index}.json`), JSON.stringify({ before, after, result, facts: await facts() }, null, 2));
        assert.equal(result.refusal, locale === 'en' ? `Not attached: ${name} (file type not accepted).` : `Nicht angehängt: ${name} (Dateityp wird nicht angenommen).`);
        assert.equal(result.imageRefusal, null); assert.equal((await facts()).retention, false);
        assert.deepEqual(after, before, '0 px layout shift');
        assert.deepEqual(await page.evaluate(() => window.documentUploadPosts), []);
      });
      await t.test('current binding switches image-capable to text-only and back', async () => {
        for (const reason of [null, 'image input not supported', null, 'current processing consent required']) {
          await inShadow(page, (c, reason) => {
            window.documentImageReason = reason;
            c.receive({ sessionId: c.session.id, seq: c.session.seq + 1, type: 'settings.changed',
              data: { processingPreset: 'best', settings: { ...c.session.settings, model: reason ? 'text-only' : 'vision', revision: (c.session.settings.revision ?? 0) + 1 } } });
          }, reason);
          await page.waitForFunction(reason => document.querySelector('aithema-session').session.featureMatrix.best.imageInput.reason === reason, {}, reason);
          const f = await facts(), image = reason !== 'image input not supported';
          assert.equal(f.accept, accept + (image ? ',.png,.jpg,.jpeg,.webp,.gif' : ''));
          assert.equal(f.retention, image);
          assert.equal(f.title, f.description);
          if (!image) assert.equal(f.title, limits[locale]);
          if (image) {
            assert.equal(f.title, limitsWithImages[locale]);
            assert.equal(f.description, limitsWithImages[locale]);
          }
        }
        await shot('binding-restored');
      });
    });
  }
}
