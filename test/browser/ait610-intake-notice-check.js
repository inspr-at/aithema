// AIT-610 r6 (LEAD 03:0x; gate5c defect b), r7: viewport evidence for TICK.
// 1. r9 (LEAD's r8 pre-decision): a document refused at intake is named with
//    the generic file-type wording, whatever reason the server sends (the r6/r7
//    specific Office reasons and legacy lines are gone).
// 2. A browser that consumed the pending event of an image reconnects after a
//    server restart; the reconnection (GET /uploads) shows the derived 'unavailable'.
// Light theme, 390 and 1440, EN and DE. Screenshots only with AITHEMA_EVIDENCE_DIR.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mkdir, mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { browserForFile } from './shared-browser.js';
import { startDemo, stopDemo, preparePage, waitForShadow, startTyping, inShadow } from './demo-helpers.js';

export function intakeNoticeCheck() {
  for (const width of [390, 1440]) for (const locale of ['en', 'de']) {
    test(`AIT-610 r6: ${width}/${locale}/light intake reasons and the reconnect 'unavailable'`, { timeout: 90000 }, async t => {
      const directory = await mkdtemp(join(tmpdir(), 'aithema-ait610-'));
      const demo = await startDemo(directory), browser = await browserForFile();
      const page = await browser.newPage();
      t.after(async () => { await page.close(); await stopDemo(demo.child); await rm(directory, { recursive: true, force: true }); });
      await preparePage(page, [locale]); await page.setViewport({ width, height: width === 390 ? 844 : 900 });
      await page.emulateMediaFeatures([{ name: 'prefers-color-scheme', value: 'light' }, { name: 'prefers-reduced-motion', value: 'reduce' }]);
      await page.goto(demo.url, { waitUntil: 'domcontentloaded' }); await waitForShadow(page, '.composer textarea');
      await inShadow(page, async c => {
        const session = c.session;
        session.settings.origin = 'chosen'; session.settings.voice = 'off';
        session.inputRevision = 1;
        session.transcript = [{ id: 'intake-input', role: 'user', content: 'Project documents', at: new Date(0).toISOString() },
          { id: 'intake-reply', role: 'assistant', content: 'Which document should we clarify?', at: new Date(1).toISOString() }];
        session.featureMatrix.best = Object.fromEntries(['text', 'analysis', 'uploads', 'imageInput'].map(key => [key, { available: true }]));
        window.intakeReason = 'encrypted'; window.intakeStreams = 0; window.intakeLost = false;
        const nativeFetch = window.fetch.bind(window);
        const derived = uploads => uploads.map(upload => window.intakeLost && upload.kind === 'image' && upload.state === 'staged-pending'
          ? { ...upload, state: 'staged-refused', reason: 'unavailable' } : upload);
        window.fetch = async (url, options = {}) => {
          if (String(url).endsWith('/uploads')) {
            if (options.method === 'POST') return Response.json({ accepted: true, events: [], uploads: [],
              refused: [{ index: 0, name: options.body.getAll('files')[0].name, kind: 'document', reason: window.intakeReason }] }, { status: 202 });
            return Response.json({ uploads: derived(c.session.uploads) });
          }
          if (String(url).endsWith(`/api/sessions/${session.id}`)) return Response.json({ ...c.session, uploads: derived(c.session.uploads) });
          if (/\/events(?:\?|$)/u.test(String(url))) {
            window.intakeStreams++;
            // window.intakeClose() ends the open stream (a server restart).
            return new Response(new ReadableStream({ start(controller) {
              window.intakeClose = () => { try { controller.close(); } catch { /* already closed */ } };
              options.signal?.addEventListener('abort', () => window.intakeClose(), { once: true });
            } }));
          }
          return nativeFetch(url, options);
        };
        const { [session.locale]: copy } = await import(`/packages/ui/src/i18n/${session.locale}.js`);
        c.configure({ entrance: 'choice', session, copy, sessionToken: 'fixture', voiceClient: {} });
      });
      await startTyping(page);
      const { [locale]: copy } = await import(`../../packages/ui/src/i18n/${locale}.js`);
      const evidence = process.env.AITHEMA_EVIDENCE_DIR, prefix = `ait610-r7-${width}-${locale}-light`;
      if (evidence) await mkdir(evidence, { recursive: true });
      const shot = async state => {
        await inShadow(page, c => c.shadowRoot.activeElement?.blur()); await page.mouse.move(0, 0);
        await page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))));
        if (evidence) await page.screenshot({ path: join(evidence, `${prefix}-${state}.png`) });
      };
      for (const [reason, name] of [['unsupported', 'secret.docx'], ['encrypted', 'locked.docx'], ['legacy', 'old-budget.xlsx'], ['malformed', 'cut.pptx']]) {
        const suffix = name.split('.').pop();
        await t.test(`${reason}: ${name} is named with the generic file-type wording`, async () => {
          await inShadow(page, (c, reason, name) => {
            window.intakeReason = reason;
            const transfer = new DataTransfer(); transfer.items.add(new File(['fixture'], name));
            const input = c.shadowRoot.querySelector('.attach-input'); input.files = transfer.files; input.dispatchEvent(new Event('change'));
          }, reason, name);
          await page.waitForFunction(name => document.querySelector('aithema-session').shadowRoot.querySelector('.composer-reason')?.textContent.includes(name), {}, name);
          const notice = await inShadow(page, c => {
            const node = c.shadowRoot.querySelector('.composer-reason'), box = node.getBoundingClientRect();
            return { text: node.textContent, width: box.width, height: box.height };
          });
          assert.ok(notice.width > 0 && notice.height > 0, `a visible notice box ${JSON.stringify(notice)}`);
          const expected = copy.uploads.refused.replace('{list}', copy.uploads.type.replace('{name}', name));
          assert.ok(notice.text.startsWith(expected), notice.text);
          await shot(`intake-generic-${reason}-${suffix}`);
        });
      }
      await t.test("reconnect after the pending event shows 'unavailable'", async () => {
        await inShadow(page, c => {
          c.receive({ sessionId: c.session.id, seq: c.session.seq + 1, type: 'upload.state', data: { id: 'lost-image', kind: 'image', state: 'staged-pending',
            filename: 'photo.png', mediaType: 'image/png', bytes: 2048, expiresAt: Date.now() + 600_000, at: new Date(2).toISOString() } });
        });
        await page.waitForFunction(() => document.querySelector('aithema-session').session.uploads.some(upload => upload.id === 'lost-image'));
        // The server restarts: the stream ends, the image is now derived as lost.
        await page.evaluate(() => { window.intakeLost = true; window.intakeClose(); });
        await page.waitForFunction(() => document.querySelector('aithema-session').session.uploads.find(upload => upload.id === 'lost-image')?.state === 'staged-refused', { timeout: 15000 });
        assert.ok(await page.evaluate(() => window.intakeStreams) >= 2, 'the browser reconnected');
        // The live refusal item (the hidden height reserve renders every reason too).
        const refusal = scope => inShadow(page, (c, scope) => {
          const node = c.shadowRoot.querySelector(`${scope} .image-refusal-item .image-refusal`), box = node?.getBoundingClientRect();
          return { text: node?.textContent ?? '', width: box?.width ?? 0, height: box?.height ?? 0 };
        }, scope);
        let shown = await refusal('.composer-feedback');
        assert.ok(shown.text.includes(copy.imageRefusals.unavailable), shown.text);
        if (!(shown.width > 0 && shown.height > 0)) {
          // r7: when the row does not fit the composer slot (390 DE), UploadNotices
          // moves it behind the visible "more" action into the notices sheet.
          const more = await inShadow(page, c => { const box = c.shadowRoot.querySelector('.upload-notices-more')?.getBoundingClientRect(); return { width: box?.width ?? 0, height: box?.height ?? 0 }; });
          assert.ok(more.width > 0 && more.height > 0, `a visible notices action when the row does not fit ${JSON.stringify(more)}`);
          await shot('reconnect-unavailable-inline');
          await inShadow(page, c => c.shadowRoot.querySelector('.upload-notices-more').click());
          await page.waitForFunction(() => document.querySelector('aithema-session').shadowRoot.querySelector('.upload-notices-sheet')?.open);
          shown = await refusal('.upload-notices-sheet');
        }
        assert.ok(shown.width > 0 && shown.height > 0, `a visible refusal box ${JSON.stringify(shown)}`);
        assert.ok(shown.text.includes(copy.imageRefusals.unavailable), shown.text);
        await shot('reconnect-unavailable');
      });
    });
  }
}
