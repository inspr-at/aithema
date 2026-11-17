import { mockConsent } from './consent-helpers.js';
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { browserForFile } from './shared-browser.js';
import { samePaint } from './png-pixels.js';
import { en } from '../../packages/ui/src/i18n/en.js';
import { de } from '../../packages/ui/src/i18n/de.js';
import {
  content, waitForShadow, shadowFocus, startDemo, stopDemo, preparePage,
  inShadow, box, until, uploadChooser, startTyping, sendTurn, revealed,
} from './demo-helpers.js';

// Delay arithmetic, Retry-After, cancellation, and the no-early-POST contract
// run with controlled clocks in packages/ui/test/uploads.test.js. Keep every
// real-browser upload/retention/paint assertion, without sleeping 5+10 seconds
// for each exhaustion. Only the upload retry timer uses this test clock.
async function fastUploadBackoff(page) {
  await page.evaluate(() => {
    const schedule = window.setTimeout.bind(window);
    window.uploadBackoffDelays = [];
    window.setTimeout = (callback, delay, ...args) => {
      if (new Error().stack.includes('#waitForUploadRetry')) {
        window.uploadBackoffDelays.push(delay);
        return schedule(callback, 0, ...args);
      }
      return schedule(callback, delay, ...args);
    };
  });
}

// Computed decoration can still be clipped by the scrolling reason slot. Compare the
// actual action pixels with the underline removed, while preserving geometry and focus.
async function uploadActionPaint(page, state) {
  await inShadow(page, async c => {
    c.uploadPaintFocus = c.shadowRoot.activeElement;
    c.uploadPaintFocus?.blur(); document.activeElement?.blur();
    await document.fonts.ready;
    await Promise.all(c.shadowRoot.getAnimations().filter(a => a.effect?.getComputedTiming().endTime !== Infinity).map(a => a.finished.catch(() => {})));
  });
  await page.mouse.move(-1, -1);
  try {
    const clips = await inShadow(page, c => [...c.shadowRoot.querySelectorAll('.composer-reason button')].map(button => {
      const rect = button.getBoundingClientRect(), reason = button.closest('.composer-reason').getBoundingClientRect();
      return { x: Math.floor(rect.left), y: Math.floor(rect.top), width: Math.ceil(rect.right) - Math.floor(rect.left),
        height: Math.ceil(Math.min(reason.bottom, rect.bottom + 4)) - Math.floor(rect.top), name: button.textContent };
    }));
    const painted = [];
    for (let i = 0; i < clips.length; i++) {
      const { name, ...clip } = clips[i];
      const underlined = Buffer.from(await page.screenshot({ clip }));
      await inShadow(page, (c, i) => { c.shadowRoot.querySelectorAll('.composer-reason button')[i].style.textDecorationLine = 'none'; }, i);
      let plain;
      try { plain = Buffer.from(await page.screenshot({ clip })); }
      finally { await inShadow(page, (c, i) => { c.shadowRoot.querySelectorAll('.composer-reason button')[i].style.removeProperty('text-decoration-line'); }, i); }
      assert.equal(samePaint(underlined, plain), false, `${state}: ${name} underline is visibly painted inside the reason slot`);
      painted.push(name);
    }
    return painted;
  } finally {
    await inShadow(page, c => { c.uploadPaintFocus?.focus({ preventScroll: true }); delete c.uploadPaintFocus; });
  }
}

async function uploadReasonLineStarts(page, state) {
  const lines = await inShadow(page, c => {
    const reason = c.shadowRoot.querySelector('.composer-reason');
    const walker = document.createTreeWalker(reason, NodeFilter.SHOW_TEXT), glyphs = [];
    while (walker.nextNode()) {
      const text = walker.currentNode;
      for (let i = 0; i < text.length; i++) {
        if (/\s/u.test(text.data[i])) continue;
        const range = document.createRange(); range.setStart(text, i); range.setEnd(text, i + 1);
        for (const rect of range.getClientRects()) if (rect.width && rect.height)
          glyphs.push({ glyph: text.data[i], top: rect.top, left: rect.left });
      }
    }
    const lines = [];
    for (const glyph of glyphs.sort((a, b) => a.top - b.top || a.left - b.left)) {
      const line = lines.find(line => Math.abs(line.top - glyph.top) < 2);
      if (!line) lines.push(glyph);
      else if (glyph.left < line.left) Object.assign(line, glyph);
    }
    return lines;
  });
  assert.ok(lines.length > 0, `${state}: reason has rendered line boxes`);
  for (const line of lines) assert.notEqual(line.glyph, '·', `${state}: no line box starts with a separator: ${JSON.stringify(lines)}`);
  return lines;
}

// Verify the real accessibility tree as well as the DOM and painted action style at every state shot.
async function uploadActions(page, expected, state) {
  const actions = await inShadow(page, c => [...c.shadowRoot.querySelectorAll('.composer-reason button')].map(button => {
    const style = getComputedStyle(button);
    return { tag: button.tagName, className: button.className, text: button.textContent,
      decoration: { line: style.textDecorationLine, style: style.textDecorationStyle,
        thickness: style.textDecorationThickness, offset: style.textUnderlineOffset } };
  }));
  assert.deepEqual(actions.map(a => a.text), expected, `${state}: exactly the expected actions`);
  for (const action of actions) {
    assert.equal(action.tag, 'BUTTON', `${state}: native button element`);
    assert.match(action.className, /(?:^| )consent-action(?: |$)/u, `${state}: shared reason-line action class`);
    assert.deepEqual(action.decoration, { line: 'underline', style: 'solid', thickness: 'auto', offset: '3px' },
      `${state}: same computed underline at every width, locale and paint`);
  }
  const cdp = await page.createCDPSession();
  try {
    const { result } = await cdp.send('Runtime.evaluate', { expression: 'document.querySelector("aithema-session").shadowRoot.querySelector(".composer-reason")' });
    const { node } = await cdp.send('DOM.describeNode', { objectId: result.objectId });
    const { nodes } = await cdp.send('Accessibility.getFullAXTree');
    await cdp.send('Runtime.releaseObject', { objectId: result.objectId });
    const root = nodes.find(n => n.backendDOMNodeId === node.backendNodeId), byId = new Map(nodes.map(n => [n.nodeId, n]));
    const hiddenHint = await inShadow(page, c => { const reason = c.shadowRoot.querySelector('.composer-reason');
      return reason.hasAttribute('data-shortcut') && getComputedStyle(reason).visibility === 'hidden'; });
    if (hiddenHint) {
      assert.deepEqual(expected, [], `${state}: only an idle shortcut may leave the accessibility tree`);
      assert.equal(root?.ignored, true, `${state}: the hidden touch shortcut is omitted from the accessibility tree`);
    } else assert.equal(root?.role?.value, 'status', `${state}: upload reasons keep their status role`);
    const buttons = [];
    const visit = n => {
      if (n.role?.value === 'button') buttons.push({ role: n.role.value, name: n.name?.value });
      for (const id of n.childIds ?? []) if (byId.has(id)) visit(byId.get(id));
    };
    visit(root);
    assert.deepEqual(buttons, expected.map(name => ({ role: 'button', name })), `${state}: exact accessible names and roles`);
    return { state, actions, accessible: buttons, role: root.role.value, paintedUnderlines: await uploadActionPaint(page, state) };
  } finally { await cdp.detach(); }
}

for (const [width, locale, theme] of [[400, 'de', 'light'], [1440, 'de', 'light'], [390, 'en', 'dark']])
  test(`AIT-219: ${width} ${locale} ${theme} retained-file retry, refusal, discard and toast above question card`,
  { timeout: 120_000 }, async t => {
    const directory = await mkdtemp(join(tmpdir(), 'aithema-browser-upload-retry-'));
    const demo = await startDemo(directory); let browser;
    t.after(async () => {
      try { await browser?.close(); }
      finally { await stopDemo(demo.child); await rm(directory, { recursive: true, force: true }); }
    });
    const paths = Array.from({ length: 4 }, (_, i) => join(directory, `large-${i}.txt`));
    for (const path of paths) await writeFile(path, Buffer.alloc(11 * 1024 * 1024, 97));
    browser = await browserForFile();
    const page = await browser.newPage(); await preparePage(page, locale === 'de' ? ['de-DE', 'de'] : ['en-US', 'en']);
    await page.setViewport({ width, height: 900 });
    await page.emulateMediaFeatures([{ name: 'prefers-reduced-motion', value: 'reduce' }, { name: 'prefers-color-scheme', value: theme }]);
    const problems = []; page.on('pageerror', error => problems.push(error.message));
    await page.goto(demo.url, { waitUntil: 'domcontentloaded' }); await waitForShadow(page, '.composer textarea');
    await mockConsent(page); await startTyping(page);
    await fastUploadBackoff(page);
    await sendTurn(page, locale === 'de' ? 'Wir sind eine Bäckerei und wollen eine Vorbestell-App. Betrieb: gehostet; Daten: öffentlich; Systeme: API; Reichweite: international' : `We are a bakery and want a preorder app. ${content}`);
    await waitForShadow(page, 'aside .notice[data-current]'); await revealed(page);
    // Keep the real route/extractors for accepted requests. Fail limits discovery and inject one
    // deterministic busy response, since fast extraction can otherwise free the first reservation.
    await page.evaluate(() => {
      const original = window.fetch.bind(window);
      window.uploadAttempts = []; window.exhaustedAttempts = 0;
      window.fetch = async (url, options = {}) => {
        if (/\/uploads$/u.test(String(url))) {
          if (!options.method) return new Response(null, { status: 503 });
          if (options.method === 'POST') {
            window.uploadAttempts.push({ files: options.body.getAll('files').map(f => ({ name: f.name, size: f.size })), id: options.body.get('clientEventId') });
            if (window.failUploads || window.uploadAttempts.length === 4) {
              if (window.failUploads) window.exhaustedAttempts++;
              else window.forcedBusy = true;
              if (window.holdUploadResponse) await window.holdUploadResponse;
              return Response.json({ error: 'upload-rate-limit' }, { status: 429, headers: { 'Retry-After': '1' } });
            }
          }
        }
        // Let each real extractor finish before sending the next fixture batch.
        // Otherwise its accepted event changes inputRevision during multipart
        // parsing and the route correctly refuses the next request with 429.
        if (/\/uploads$/u.test(String(url)) && options.method === 'POST') {
          const c = document.querySelector('aithema-session');
          while (c.session.uploads.some(upload => upload.state === 'pending')) await new Promise(resolve => setTimeout(resolve, 10));
        }
        const response = await original(url, options);
        if (/\/uploads$/u.test(String(url)) && options.method === 'POST') {
          const body = await response.clone().json();
          (window.uploadResponses ??= []).push({ status: response.status, error: body.error, reason: body.reason });
        }
        return response;
      };
    });
    const controls = ['.composer', 'textarea', '.attach', '.send'];
    const settle = () => inShadow(page, async c => {
      await document.fonts.ready;
      await Promise.all(c.shadowRoot.getAnimations().filter(a => a.effect?.getComputedTiming().endTime !== Infinity).map(a => a.finished.catch(() => {})));
    });
    const geometry = () => Promise.all(controls.map(selector => box(page, selector)));
    const sameControls = async (before, label) => {
      await settle(); const after = await geometry();
      controls.forEach((selector, i) => assert.deepEqual(after[i], before[i], `${label} ${selector}: 0 px movement`));
    };
    const actionRecords = [];
    const copy = locale === 'de' ? de : en;
    const retryActions = [copy.uploads.tryAgain, copy.uploads.discard];
    const shot = async (name, expected = []) => {
      const record = await uploadActions(page, expected, name);
      if (name === 'busy-exhausted' || name === 'resumed') {
        record.lineStarts = await uploadReasonLineStarts(page, name);
        t.diagnostic(`PASS AIT-219 round 9 ${width} ${locale.toUpperCase()} ${name}: no line box starts with ·; first glyphs ${record.lineStarts.map(line => line.glyph).join(', ')}.`);
      }
      actionRecords.push(record);
      if (!process.env.AITHEMA_EVIDENCE_DIR) return;
      await inShadow(page, c => {
        c.evidenceFocus = c.shadowRoot.activeElement;
        c.evidenceFocus?.blur(); document.activeElement?.blur();
      });
      await page.mouse.move(-1, -1); await settle();
      await mkdir(process.env.AITHEMA_EVIDENCE_DIR, { recursive: true });
      try {
        await page.screenshot({ path: join(process.env.AITHEMA_EVIDENCE_DIR, `ait-219-${locale}-${theme}-${width}-${name}.png`), fullPage: false });
      } finally {
        await inShadow(page, c => { c.evidenceFocus?.focus({ preventScroll: true }); delete c.evidenceFocus; });
      }
    };
    // Pin the repository's Chrome baseline font stacks; no screenshot-only typography.
    await inShadow(page, c => {
      c.style.setProperty('--aithema-font', 'ui-sans-serif,-apple-system,"Segoe UI Variable Text","Segoe UI",system-ui,sans-serif');
      c.style.setProperty('--aithema-display', 'Georgia,"Iowan Old Style","Palatino Linotype",serif');
    });
    const toastGeometry = async () => {
      await settle();
      const rectangles = await inShadow(page, c => {
        const rect = selector => c.shadowRoot.querySelector(selector).getBoundingClientRect().toJSON();
        return { toast: rect('.status__label'), dock: rect('.composer-dock'), card: c.shadowRoot.querySelector('.qcard').hidden ? null : rect('.qcard'), composer: rect('.composer'), attach: rect('.attach'), send: rect('.send') };
      });
      assert.equal((rectangles.card ?? rectangles.dock).top - rectangles.toast.bottom, 8, 'toast bottom = topmost docked element top − 8 px');
      for (const key of ['composer', 'attach', 'send', ...(rectangles.card ? ['card'] : [])]) {
        const a = rectangles.toast, b = rectangles[key];
        assert.equal(a.left < b.right && a.right > b.left && a.top < b.bottom && a.bottom > b.top, false, `toast does not intersect ${key}`);
      }
      return rectangles;
    };
    await settle(); const baseline = await geometry();
    const chooser = await uploadChooser(page); await chooser.accept(paths);
    await until(page, () => window.forcedBusy || window.uploadAttempts.length
      && document.querySelector('aithema-session').shadowRoot.querySelector('.attach').getAttribute('aria-disabled') === 'false');
    assert.equal(await page.evaluate(() => Boolean(window.forcedBusy)), true, JSON.stringify(await inShadow(page, c => ({
      attempts: window.uploadAttempts, responses: window.uploadResponses,
      notice: c.shadowRoot.querySelector('.composer-reason').textContent, uploads: c.session.uploads.map(({ state, reason }) => ({ state, reason })),
    }))));
    assert.notEqual(await inShadow(page, c => c.shadowRoot.querySelector('.composer-reason').textContent), de.uploads.busy);
    await sameControls(baseline, 'waiting for retry'); const toast = await toastGeometry();
    await until(page, () => {
      const c = document.querySelector('aithema-session');
      return c.session.uploads.length === 4 && c.session.uploads.every(u => u.state === 'accepted')
        && c.shadowRoot.querySelector('.attach').getAttribute('aria-disabled') === 'false';
    });
    assert.ok((await page.evaluate(() => window.uploadAttempts)).every(attempt => attempt.files.length === 1), 'fallback batches stay below 21 MiB');
    await sameControls(baseline, 'four files accepted'); if (width === 400) await shot('four-accepted');
    await page.evaluate(() => { window.failUploads = true; });
    const retryChooser = await uploadChooser(page); await retryChooser.accept(paths.slice(0, 2));
    const exhausted = locale === 'de' ? '2 Dateien nicht hochgeladen: Der Server ist gerade ausgelastet\u00a0· Erneut versuchen\u00a0· Verwerfen'
      : '2 files not uploaded: the server is busy right now\u00a0· Try again\u00a0· Discard';
    await until(page, words => document.querySelector('aithema-session').shadowRoot.querySelector('.composer-reason').textContent === words, exhausted);
    assert.equal(await page.evaluate(() => window.exhaustedAttempts), 3);
    assert.equal(await inShadow(page, c => c.shadowRoot.querySelector('.attach').getAttribute('aria-disabled')), 'false');
    const failedAttempts = await page.evaluate(() => window.uploadAttempts.slice(-3));
    assert.ok(failedAttempts.every(a => JSON.stringify(a.files) === JSON.stringify(failedAttempts[0].files)), 'all three attempts send the same first batch');
    await inShadow(page, c => c.shadowRoot.querySelector('.upload-retry').focus({ preventScroll: true }));
    await sameControls(baseline, 'busy after three attempts'); await shot('busy-exhausted', retryActions);
    assert.equal(await shadowFocus(page), 'consent-action upload-retry', 'mid-sequence evidence restores focus');
    const actionVisible = await inShadow(page, c => {
      const r = c.shadowRoot, outer = r.querySelector('.composer-reason').getBoundingClientRect();
      return ['.upload-retry', '.upload-discard'].every(selector => {
        const inner = r.querySelector(selector).getBoundingClientRect();
        return inner.top >= outer.top && inner.bottom <= outer.bottom;
      });
    });
    assert.equal(actionVisible, true, 'both actions are visible inside the fixed reason slot');
    assert.equal(await inShadow(page, c => c.shadowRoot.querySelector('.upload-discard').textContent), locale === 'de' ? 'Verwerfen' : 'Discard');
    // A live refusal suppresses retry immediately; resuming only restores the manual action.
    const beforePause = await page.evaluate(() => window.uploadAttempts.length);
    await inShadow(page, c => c.shadowRoot.querySelector('.pause').click());
    await until(page, () => document.querySelector('aithema-session').session.paused);
    const refusal = copy.uploads.unavailable.replace('{reason}', copy.reasons['session paused']);
    assert.equal(await inShadow(page, c => c.shadowRoot.querySelector('.composer-reason').textContent), `${refusal}\u00a0· ${copy.uploads.discard}`);
    await sameControls(baseline, 'paused refusal');
    if (width === 400) await shot('retry-refused', [copy.uploads.discard]);
    await shot('paused', [copy.uploads.discard]);
    await inShadow(page, c => c.shadowRoot.querySelector('.pause').click());
    await until(page, () => !document.querySelector('aithema-session').session.paused);
    await until(page, words => document.querySelector('aithema-session').shadowRoot.querySelector('.composer-reason').textContent === words, exhausted);
    await sameControls(baseline, 'resumed with kept files');
    await shot('resumed', retryActions);
    assert.equal(await page.evaluate(() => window.uploadAttempts.length), beforePause, 'pause and resume never upload automatically');
    await inShadow(page, c => c.shadowRoot.querySelector('.upload-retry').focus({ preventScroll: true }));
    await page.evaluate(() => { window.failUploads = false; });
    const retryStart = await page.evaluate(() => window.uploadAttempts.length);
    await page.keyboard.press('Enter');
    await until(page, () => {
      const c = document.querySelector('aithema-session');
      return c.session.uploads.length === 6 && c.session.uploads.every(u => u.state === 'accepted')
        && c.shadowRoot.querySelector('.attach').getAttribute('aria-disabled') === 'false';
    });
    const resent = await page.evaluate(start => window.uploadAttempts.slice(start).flatMap(a => a.files), retryStart);
    assert.deepEqual(resent, paths.slice(0, 2).map(path => ({ name: path.split('/').at(-1), size: 11 * 1024 * 1024 })), 'Try again sends exactly the retained files, names, sizes and count');
    await sameControls(baseline, 'manual retry succeeds');
    // Read-only duplicate-bubble diagnosis: each durable turn has exactly one DOM row.
    const transcript = await inShadow(page, c => ({
      turns: c.session.transcript.map(({ id, role, content }) => ({ id, role, content })),
      rows: [...c.shadowRoot.querySelectorAll('ol > .turn:not(.partial)')].map(row => ({ id: row.dataset.id, content: row.querySelector('.turn-text').textContent })),
    }));
    for (const turn of transcript.turns) assert.equal(transcript.rows.filter(row => row.id === turn.id).length, 1, `one rendered row for turn ${turn.id}`);
    // Isolate the card fixture after real uploads settle. Its question must not consume a real journal sequence.
    await inShadow(page, async c => {
      const { inputRevision } = await import('/packages/core/src/session.js');
      const { en } = await import('/packages/ui/src/i18n/en.js'), { de } = await import('/packages/ui/src/i18n/de.js');
      const session = c.session, german = session.locale === 'de';
      session.transcript.push({ id: 'ait219-question', role: 'assistant',
        content: german ? 'Wer nutzt die App?' : 'Who will use the app?',
        question_short: german ? 'Wer nutzt die App?' : 'Who will use the app?',
        options: [{ text: german ? 'Unsere Kundschaft' : 'Our customers' }], inputRevision: inputRevision(session) });
      const original = window.fetch.bind(window);
      window.fetch = async (url, options = {}) => {
        const path = new URL(url, location.href).pathname;
        if (path.endsWith('/events')) return new Response(new ReadableStream({ start(controller) {
          options.signal?.addEventListener('abort', () => controller.close(), { once: true });
        } }));
        if (/^\/api\/sessions\/[^/]+$/u.test(path)) return Response.json(c.session);
        return original(url, options);
      };
      c.configure({ copy: german ? de : en, session });
      window.failUploads = true;
      // Hold the real pending-upload UI while measuring its toast. Fast retry
      // clocks can otherwise exhaust all attempts before the next CDP poll.
      window.holdUploadResponse = new Promise(resolve => { window.releaseUploadResponse = resolve; });
    });
    await settle();
    assert.equal(await inShadow(page, c => c.shadowRoot.querySelector('.qcard').hidden), false);
    const cardControls = await geometry();
    const cardChooser = await uploadChooser(page); await cardChooser.accept(paths.slice(0, 1));
    await until(page, () => document.querySelector('aithema-session').shadowRoot.querySelector('.status__label').parentNode.matches('.composer-dock'));
    const questionToast = await toastGeometry(); await shot('question-toast');
    await sameControls(cardControls, 'toast with question card');
    await page.evaluate(() => window.releaseUploadResponse());
    await waitForShadow(page, '.upload-retry');
    if (process.env.AITHEMA_EVIDENCE_DIR) await writeFile(join(process.env.AITHEMA_EVIDENCE_DIR, `ait-219-${locale}-${theme}-${width}-assertions.json`), JSON.stringify({ width, locale, theme, exhausted, refusal, baseline, toast, questionToast, resent, transcript, actionRecords }, null, 2));
    assert.ok((await page.evaluate(() => window.uploadBackoffDelays)).includes(5000), 'production upload backoff reached the controlled clock');
    assert.ok((await page.evaluate(() => window.uploadBackoffDelays)).includes(10000), 'production second retry reached the controlled clock');
    assert.deepEqual(problems, []);
    t.diagnostic(`PASS ${width} ${locale.toUpperCase()} ${theme}: four real 11 MiB files accepted; exhaustion after failure 3; Try again sent the same 2 files (names/sizes/count), succeeded; 0 px movement; paused offers Discard only; resume restores retry with no upload; every shot has exact accessible button names/roles and shared computed underlines; toast gap 8 px above dock and question card, no card/composer/button intersection; one DOM row per turn.`);
  });

for (const [width, source, target, theme] of [[1440, 'de', 'en', 'light'], [390, 'en', 'de', 'dark']])
  test(`AIT-219 round 7: ${width} ${source} to ${target} ${theme} keeps the complete retained-file line`,
  { timeout: 120_000 }, async t => {
    const directory = await mkdtemp(join(tmpdir(), 'aithema-browser-retry-locale-'));
    const demo = await startDemo(directory); let browser;
    t.after(async () => {
      try { await browser?.close(); }
      finally { await stopDemo(demo.child); await rm(directory, { recursive: true, force: true }); }
    });
    const paths = [join(directory, 'brief.txt'), join(directory, 'notes.txt')];
    for (const path of paths) await writeFile(path, 'Retained locale-switch fixture.');
    browser = await browserForFile();
    const page = await browser.newPage(); await preparePage(page, source === 'de' ? ['de-DE', 'de'] : ['en-US', 'en']);
    await page.setViewport({ width, height: 900 });
    await page.emulateMediaFeatures([{ name: 'prefers-reduced-motion', value: 'reduce' }, { name: 'prefers-color-scheme', value: theme }]);
    const problems = []; page.on('pageerror', error => problems.push(error.message));
    await page.goto(demo.url, { waitUntil: 'domcontentloaded' }); await waitForShadow(page, '.composer textarea');
    await mockConsent(page); await startTyping(page);
    await fastUploadBackoff(page);
    await page.evaluate(() => {
      const original = window.fetch.bind(window); window.retryAttempts = [];
      window.fetch = async (url, options = {}) => {
        if (/\/uploads$/u.test(String(url)) && options.method === 'POST') {
          window.retryAttempts.push(options.body.getAll('files').map(f => ({ name: f.name, size: f.size })));
          return Response.json({ error: 'upload-rate-limit' }, { status: 429 });
        }
        return original(url, options);
      };
      const c = document.querySelector('aithema-session');
      c.style.setProperty('--aithema-font', 'ui-sans-serif,-apple-system,"Segoe UI Variable Text","Segoe UI",system-ui,sans-serif');
      c.style.setProperty('--aithema-display', 'Georgia,"Iowan Old Style","Palatino Linotype",serif');
    });
    const settle = () => inShadow(page, async c => {
      await document.fonts.ready;
      await Promise.all(c.shadowRoot.getAnimations().filter(a => a.effect?.getComputedTiming().endTime !== Infinity).map(a => a.finished.catch(() => {})));
    });
    const controls = ['.composer', 'textarea', '.attach', '.send'];
    const geometry = () => Promise.all(controls.map(selector => box(page, selector)));
    const line = () => inShadow(page, c => c.shadowRoot.querySelector('.composer-reason').textContent);
    const records = [];
    for (const count of [1, 2]) {
      assert.equal(await inShadow(page, (c, locale) => c.changeLocale(locale), source), true);
      const shortcut = await line();
      await settle(); const baseline = await geometry();
      const attempts = await page.evaluate(() => window.retryAttempts.length);
      const chooser = await uploadChooser(page); await chooser.accept(paths.slice(0, count));
      await waitForShadow(page, '.upload-retry');
      assert.equal(await page.evaluate(() => window.retryAttempts.length) - attempts, 3, 'exhaust exactly three attempts');
      const busy = locale => locale === 'de'
        ? `${count} ${count === 1 ? 'Datei' : 'Dateien'} nicht hochgeladen: Der Server ist gerade ausgelastet\u00a0· Erneut versuchen\u00a0· Verwerfen`
        : `${count} ${count === 1 ? 'file' : 'files'} not uploaded: the server is busy right now\u00a0· Try again\u00a0· Discard`;
      assert.equal(await line(), busy(source));
      // A refused retry must not leave a stale flag after resume and a locale change.
      await inShadow(page, c => c.shadowRoot.querySelector('.pause').click());
      await until(page, () => document.querySelector('aithema-session').session.paused);
      await uploadActions(page, [(source === 'de' ? de : en).uploads.discard], 'locale fixture paused');
      await inShadow(page, c => c.shadowRoot.querySelector('.pause').click());
      await until(page, () => !document.querySelector('aithema-session').session.paused);
      for (const locale of [target, source, target]) {
        assert.equal(await inShadow(page, (c, locale) => c.changeLocale(locale), locale), true);
        assert.equal(await line(), busy(locale));
        const copy = locale === 'de' ? de : en;
        await uploadActions(page, [copy.uploads.tryAgain, copy.uploads.discard], `locale repaint ${locale}`);
        await settle(); const after = await geometry();
        controls.forEach((selector, i) => assert.deepEqual(after[i], baseline[i], `${count} file(s), ${locale}, ${selector}: 0 px movement`));
      }
      assert.equal(await page.evaluate(() => window.retryAttempts.length) - attempts, 3, 'locale changes never resend files');
      const shot = `ait-219-r7-${width}-${source}-to-${target}-${theme}-${count}-file.png`;
      const copy = target === 'de' ? de : en;
      const actions = await uploadActions(page, [copy.uploads.tryAgain, copy.uploads.discard], shot);
      if (process.env.AITHEMA_EVIDENCE_DIR) {
        await inShadow(page, c => { c.evidenceFocus = c.shadowRoot.activeElement; c.evidenceFocus?.blur(); document.activeElement?.blur(); });
        await page.mouse.move(-1, -1); await settle();
        await mkdir(process.env.AITHEMA_EVIDENCE_DIR, { recursive: true });
        try { await page.screenshot({ path: join(process.env.AITHEMA_EVIDENCE_DIR, shot), fullPage: false }); }
        finally { await inShadow(page, c => { c.evidenceFocus?.focus({ preventScroll: true }); delete c.evidenceFocus; }); }
      }
      records.push({ count, line: await line(), baseline, after: await geometry(), actions, shot });
      await inShadow(page, c => c.shadowRoot.querySelector('.upload-discard').click());
      assert.equal(await inShadow(page, (c, locale) => c.changeLocale(locale), source), true);
      assert.equal(await line(), shortcut, 'discard leaves no retry fragment after a locale change');
      assert.equal(await inShadow(page, c => c.shadowRoot.querySelector('.upload-retry') === null && c.shadowRoot.querySelector('.upload-discard') === null), true);
      t.diagnostic(`PASS ${width} ${source.toUpperCase()}→${target.toUpperCase()} ${theme}, ${count} file(s): exact full retry line; 0 px movement; three attempts, no resend; exact accessible buttons and shared computed underlines; discard removes the line.`);
    }
    if (process.env.AITHEMA_EVIDENCE_DIR) await writeFile(join(process.env.AITHEMA_EVIDENCE_DIR, `ait-219-r7-${width}-${source}-to-${target}-${theme}-assertions.json`), JSON.stringify({ width, source, target, theme, records }, null, 2));
    assert.ok((await page.evaluate(() => window.uploadBackoffDelays)).includes(5000), 'production upload backoff reached the controlled clock');
    assert.ok((await page.evaluate(() => window.uploadBackoffDelays)).includes(10000), 'production second retry reached the controlled clock');
    assert.deepEqual(problems, []);
  });

// AIT-510 image attachment lifecycle and refusal evidence.
// The page uses only injected intake/model fixtures; no provider is contacted.
for (const entrance of ['choice', 'combined']) for (const width of [390, 1024, 1440]) for (const locale of ['en', 'de']) for (const theme of ['light', 'dark']) {
  test(`AIT-510: ${entrance} ${width} ${locale} ${theme} fixed image tiles, refusal reasons, consent and image-only send`, { timeout: 120000 }, async t => {
    const directory = await mkdtemp(join(tmpdir(), 'aithema-image-input-'));
    const demo = await startDemo(directory), browser = await browserForFile();
    t.after(async () => { await browser.close(); await stopDemo(demo.child); await rm(directory, { recursive: true, force: true }); });
    const page = await browser.newPage(); await preparePage(page, [locale]);
    await page.setViewport({ width, height: 900 });
    await page.emulateMediaFeatures([{ name: 'prefers-reduced-motion', value: 'reduce' }, { name: 'prefers-color-scheme', value: theme }]);
    await page.goto(demo.url, { waitUntil: 'domcontentloaded' }); await waitForShadow(page, '.composer textarea');
    await mockConsent(page); await startTyping(page);
    await inShadow(page, async (c, entrance) => {
      window.imageEntrance = entrance;
      window.imageAsks = []; window.imagePosts = []; window.imageSeq = 0; window.imageGranted = true;
      const canvas = document.createElement('canvas'); canvas.width = 1; canvas.height = 1;
      const context = canvas.getContext('2d'); context.fillStyle = 'rgba(224,32,48,0.5)'; context.fillRect(0, 0, 1, 1);
      window.imageFixtureBase64 = canvas.toDataURL('image/png').split(',')[1];
      window.imageFixturePNG = Uint8Array.from(atob(window.imageFixtureBase64), c => c.charCodeAt(0));
      c.addEventListener('aithema-consent', e => { window.imageAsks.push(e.detail); if (window.imageFixtureConsent) e.stopImmediatePropagation(); }, { capture: true });
      const session = structuredClone(c.session);
      session.featureMatrix.best.imageInput = { available: true, reason: null };
      session.featureMatrix.best.images = { available: true, reason: null };
      session.featureMatrix.best.uploads = { available: true, reason: null };
      session.settings.voice = 'off'; session.settings.origin = 'chosen';
      session.featureMatrix.best.voice = { available: false, reason: 'voice off' };
      if (entrance === 'combined') session.emailOffer = { afterMessages: 1 };
      session.inputRevision = 1;
      session.transcript = [{ id: 'existing-input', role: 'user', content: 'A screenshot for the project', at: new Date(0).toISOString() },
        { id: 'existing-reply', role: 'assistant', content: 'Which part should be clarified?', at: new Date(1).toISOString() }];
      const { inputRevision } = await import('/packages/core/src/session.js');
      session.understanding = { ...session.understanding, summary: 'A project screenshot', inputRevision: inputRevision(session), readinessAssessed: true };
      const fetch = window.fetch.bind(window);
      window.fetch = async (url, options = {}) => {
        if (entrance === 'combined' && String(url).endsWith('/credits')) return Response.json({
          tiers: { current: 'anonymous', next: 'emailGiven', delta: 6_000_000, canConfirm: true },
          exhausted: false, balance: { owner: { limitMicro: 12_000_000, availableMicro: 12_000_000, committedMicro: 0, reservedMicro: 0 } },
          emailOffer: { offered: true, open: true, at: 'existing-reply', nextTier: 'emailGiven', deltaMicro: 6_000_000, revision: 1 } });
        if (entrance === 'combined' && String(url).endsWith('/identity')) return Response.json({ identity: c.session.identity,
          delivery: true, privacyDocumentConfigured: true, visitorEmail: { canSave: true, canDelete: true } });
        if (entrance === 'combined' && String(url).endsWith('/visitor/email')) return Response.json({ visitor: { address: null, tier: 'anonymous', limitMicro: 12_000_000 },
          notice: { version: 'fixture-notice', deliveryEnabled: true }, privacyDocumentConfigured: true });
        if (/\/events(?:\?|$)/u.test(String(url))) return new Response(new ReadableStream({ start(controller) { options.signal?.addEventListener('abort', () => controller.close(), { once: true }); } }));
        if (String(url).endsWith(`/api/sessions/${session.id}`)) {
          const snapshot = c.session; snapshot.featureMatrix.best.imageInput = { available: window.imageGranted, reason: window.imageGranted ? null : 'current processing consent required' };
          return Response.json(snapshot);
        }
        if (String(url).endsWith('/consent')) return Response.json({ consentRevision: c.session.consentRevision, selected: window.imageGranted ? ['images', 'image-input'] : ['images'], features: { images: ['images'], imageInput: ['image-input'] } });
        if (/\/uploads\/[^/]+\/withdraw$/u.test(String(url))) {
          const id = String(url).split('/').at(-2), image = c.session.uploads.find(u => u.id === id);
          return Response.json({ event: { sessionId: c.session.id, seq: c.session.seq + 1, type: 'upload.state', data: { ...image, state: 'staged-discarded', erased: true } } });
        }
        if (/\/uploads$/u.test(String(url))) {
          if (options.method !== 'POST') return Response.json({ uploads: c.session.uploads });
          const files = options.body.getAll('files');
          return Response.json({ events: files.map((file, index) => ({ sessionId: c.session.id, seq: c.session.seq + index + 1, type: 'upload.state', data: {
            id: `fixture-${++window.imageSeq}`, filename: file.name, kind: 'image', state: 'staged-pending', bytes: file.size, mediaType: 'image/png', at: new Date(0).toISOString() } })) }, { status: 202 });
        }
        if (/\/uploads\/[^/]+\/image$/u.test(String(url))) {
          (window.imageOwnerHeaders ??= []).push(new Headers(options.headers).get('x-aithema-session-token'));
          if (window.imageDelay) await window.imageDelay;
          return new Response(window.imageFixturePNG, { headers: { 'content-type': 'image/png' } }); }
        if (/\/turns$/u.test(String(url)) && options.method === 'POST') {
          const body = JSON.parse(options.body); window.imagePosts.push(body);
          if (window.imageSendDelay) await window.imageSendDelay;
          return Response.json({ sessionId: c.session.id, seq: c.session.seq + 1, type: 'turn.final', data: { id: body.clientEventId, role: 'user', content: body.content, attachments: body.attachments, at: new Date(0).toISOString() } });
        }
        return fetch(url, options);
      };
      const { [session.locale]: copy } = await import(`/packages/ui/src/i18n/${session.locale}.js`);
      c.configure({ entrance: window.imageEntrance, session, copy, sessionToken: 'fixture', voiceClient: {},
        ...(window.imageEntrance === 'combined' ? { host: { credits: true, verification: { delivery: true, privacyDocumentConfigured: true } } } : {}) });
    }, entrance);
    await startTyping(page);
    if (entrance === 'combined') assert.equal(await inShadow(page, c => getComputedStyle(c.shadowRoot.querySelector('.attach')).display), 'none');
    const choose = async () => {
      if (width === 390 && entrance === 'choice') {
        const path = join(directory, 'fixture.png');
        await writeFile(path, Buffer.from(await page.evaluate(() => window.imageFixtureBase64), 'base64'));
        const chooser = await uploadChooser(page); await chooser.accept([path]); return;
      }
      await inShadow(page, (c, width) => {
      const transfer = new DataTransfer(); transfer.items.add(new File([window.imageFixturePNG], 'fixture.png', { type: 'image/png' }));
      if (width === 1024) c.shadowRoot.querySelector('.conversation').dispatchEvent(new DragEvent('drop', { bubbles: true, dataTransfer: transfer }));
      else c.shadowRoot.querySelector('textarea').dispatchEvent(new ClipboardEvent('paste', { bubbles: true, clipboardData: transfer }));
      }, width);
    };
    const boxes = () => inShadow(page, c => Object.fromEntries(['.band', '.audio-rail', ...(window.imageEntrance === 'combined' ? ['.composer-mic'] : ['.attach']), '.send', '.composer', ...(window.innerWidth >= 1024 ? ['.understanding', '.understanding .foot'] : [])].map(selector => {
      const r = c.shadowRoot.querySelector(selector).getBoundingClientRect(); return [selector, { x: r.x, y: r.y, w: r.width, h: r.height, bottom: r.bottom }];
    })));
    // Compare decode events only after the requested viewport's layout is active.
    const resize = async height => {
      await page.setViewport({ width, height });
      await page.waitForFunction(height => {
        const workspace = document.querySelector('aithema-session').shadowRoot.querySelector('.workspace');
        return workspace.hasAttribute('data-phone-short') === (window.innerWidth <= 600 && height <= 620)
          // Both 620 and 568 are short. Wait for the viewport owner's height,
          // not just the unchanged boolean, before measuring its reading pane.
          && (window.innerWidth > 600 || parseFloat(workspace.style.getPropertyValue('--phone-height')) === height);
      }, {}, height);
    };
    const evidence = process.env.AITHEMA_EVIDENCE_DIR;
    const prefix = `${entrance === 'combined' ? 'combined-' : ''}${width}-${locale}-${theme}`;
    if (evidence) await mkdir(evidence, { recursive: true });
    const shot = async state => { if (evidence && width !== 1024) await page.screenshot({ path: join(evidence, `${prefix}-${state}.png`) }); };
    const clearances = async state => {
      if (entrance !== 'combined') return;
      const layout = await inShadow(page, c => {
        const selectors = ['textarea', '.composer-mic', '.send', '.composer-feedback', '.composer-notice', '.display-foot',
          ...(c.shadowRoot.querySelector('.staged-image') ? ['.staged-images'] : []),
          ...(c.shadowRoot.querySelector('.email-offer') ? ['.email-offer'] : [])];
        return Object.fromEntries(selectors.map(selector => {
          const r = c.shadowRoot.querySelector(selector).getBoundingClientRect();
          // An inline offer can scroll partially out of its reading pane. Keep
          // the full positive box and separately record its actual paint clip.
          const clip = selector === '.email-offer' ? c.shadowRoot.querySelector('.conversation-scroll').getBoundingClientRect() : null;
          return [selector, { x: r.x, y: r.y, w: r.width, h: r.height, right: r.right, bottom: r.bottom,
            ...(clip ? { clip: { x: clip.x, y: clip.y, right: clip.right, bottom: clip.bottom } } : {}) }];
        }));
      });
      if (evidence) await writeFile(join(evidence, `${prefix}-${state}-clearance.json`), JSON.stringify(layout, null, 2));
      for (const [selector, r] of Object.entries(layout)) assert.ok(r.w > 0 && r.h > 0, `${state} ${selector} positive`);
      const entries = Object.entries(layout);
      for (let i = 0; i < entries.length; i++) for (let j = i + 1; j < entries.length; j++) {
        const [a, ar] = entries[i], [b, br] = entries[j];
        const visible = r => r.clip ? { x: Math.max(r.x, r.clip.x), y: Math.max(r.y, r.clip.y),
          right: Math.min(r.right, r.clip.right), bottom: Math.min(r.bottom, r.clip.bottom) } : r;
        const av = visible(ar), bv = visible(br);
        assert.ok(Math.min(av.right, bv.right) - Math.max(av.x, bv.x) <= .5 || Math.min(av.bottom, bv.bottom) - Math.max(av.y, bv.y) <= .5,
          `${state}: ${a} and ${b} do not overlap`);
      }
    };
    if (entrance === 'combined') await waitForShadow(page, '.email-offer');
    await clearances('idle'); await shot('idle');
    const unstaged = await boxes();
    for (const r of Object.values(unstaged)) assert.ok(r.w > 0 && r.h > 0, 'positive frame before staging');
    await choose(); await waitForShadow(page, '.staged-image');
    const before = await boxes(), changes = [];
    if (process.env.AITHEMA_EVIDENCE_DIR) await writeFile(join(process.env.AITHEMA_EVIDENCE_DIR,
      `${entrance}-${width}-${locale}-${theme}-staging-probe.json`), JSON.stringify({ unstaged, before }, null, 2));
    for (const [selector, r] of Object.entries(before)) for (const edge of selector === '.composer' ? ['bottom'] : ['x', 'y', 'w', 'h'])
      assert.ok(Math.abs(r[edge] - unstaged[selector][edge]) <= .5, `${selector}.${edge} fixed while staging`);
    for (const [selector, r] of Object.entries(before)) assert.ok(r.w > 0 && r.h > 0, `${selector} positive before`);
    await clearances('pending'); await shot('pending');
    if (entrance === 'combined' && width === 390) for (const height of [620, 568]) {
      await resize(height);
      await clearances(`short-${height}-pending`); await shot(`short-${height}-pending`);
      const shortBefore = await boxes();
      for (const r of Object.values(shortBefore)) assert.ok(r.w > 0 && r.h > 0, 'positive short-phone baseline');
      await inShadow(page, c => { const image = c.session.uploads.find(u => u.kind === 'image');
        c.receive({ sessionId: c.session.id, seq: c.session.seq + 1, type: 'upload.state', data: { ...image, state: 'staged-refused', reason: 'malformed' } });
      });
      const shortAfter = await boxes();
      if (evidence) await writeFile(join(evidence, `${prefix}-short-${height}-probe.json`), JSON.stringify({ before: shortBefore, after: shortAfter }, null, 2));
      for (const [selector, r] of Object.entries(shortAfter)) {
        assert.ok(r.w > 0 && r.h > 0, `${selector} positive at ${height}`);
        for (const edge of selector === '.composer' ? ['bottom'] : ['x', 'y', 'w', 'h']) assert.ok(Math.abs(r[edge] - shortBefore[selector][edge]) <= .5, `${height} ${selector}.${edge}`);
      }
      const controls = await inShadow(page, c => Object.fromEntries(['textarea', '.composer-mic', '.send', '.image-refusals'].map(selector => {
        const r = c.shadowRoot.querySelector(selector).getBoundingClientRect(); return [selector, { x: r.x, y: r.y, w: r.width, h: r.height, right: r.right, bottom: r.bottom }];
      })));
      for (const [selector, r] of Object.entries(controls)) assert.ok(r.w > 0 && r.h > 0 && r.x >= 0 && r.right <= width && r.y >= 0 && r.bottom <= height, `${selector} visible at ${height}`);
      const list = Object.entries(controls);
      for (let i = 0; i < list.length; i++) for (let j = i + 1; j < list.length; j++) {
        const [a, ar] = list[i], [b, br] = list[j];
        assert.ok(Math.min(ar.right, br.right) - Math.max(ar.x, br.x) <= .5 || Math.min(ar.bottom, br.bottom) - Math.max(ar.y, br.y) <= .5, `${a} and ${b} do not overlap at ${height}`);
      }
      changes.push({ reason: `short-${height}`, before: shortBefore, rects: shortAfter, controls }); await clearances(`short-${height}`); await shot(`short-${height}`);
      await inShadow(page, c => { const image = c.session.uploads.find(u => u.kind === 'image');
        c.receive({ sessionId: c.session.id, seq: c.session.seq + 1, type: 'upload.state', data: { ...image, state: 'staged-pending', reason: undefined } });
        c.shadowRoot.querySelector('.image-refusals button').click();
      });
    }
    if (entrance === 'combined' && width === 390) await resize(900);
    for (const reason of ['unsupported', 'size', 'limit', 'empty', 'malformed', 'dimensions', 'deadline', 'cancelled', 'unavailable', 'session', 'model', 'live-call', 'batch']) {
      await inShadow(page, (c, reason) => { const image = c.session.uploads.find(u => u.kind === 'image');
        c.receive({ sessionId: c.session.id, seq: c.session.seq + 1, type: 'upload.state', data: { ...image, state: 'staged-refused', reason } });
      }, reason);
      await waitForShadow(page, '.image-refusals');
      const after = await boxes();
      for (const [selector, r] of Object.entries(after)) {
        assert.ok(r.w > 0 && r.h > 0, `${selector} positive after ${reason}`);
        for (const edge of selector === '.composer' ? ['bottom'] : ['x', 'y', 'w', 'h']) assert.ok(Math.abs(r[edge] - before[selector][edge]) <= .5, `${selector}.${edge} fixed after ${reason}`);
      }
      changes.push({ reason, rects: after });
      const refusalPaint = await inShadow(page, c => {
        const region = c.shadowRoot.querySelector('.image-refusals'), list = region.querySelector('.image-refusals__list');
        const box = node => { const r = node.getBoundingClientRect(); return { width: r.width, height: r.height, top: r.top, bottom: r.bottom }; };
        return { region: box(region), list: box(list), scrollHeight: region.scrollHeight, clientHeight: region.clientHeight,
          duplicates: [...c.shadowRoot.querySelectorAll('.staged-image__status')].some(status => status.textContent === list.querySelector('.image-refusal').textContent.split(': ').slice(1).join(': ')) };
      });
      assert.ok(refusalPaint.region.width > 0 && refusalPaint.region.height > 0 && refusalPaint.list.width > 0 && refusalPaint.list.height > 0);
      assert.ok(refusalPaint.list.bottom <= refusalPaint.region.bottom + .5, `${reason}: the entire refusal is readable without scrolling`);
      assert.equal(refusalPaint.duplicates, false, `${reason}: refusal is shown once`);
      await shot(reason);
      await inShadow(page, c => c.shadowRoot.querySelector('.image-refusals button').click());
    }
    await inShadow(page, c => { const image = c.session.uploads.find(u => u.kind === 'image');
      c.receive({ sessionId: c.session.id, seq: c.session.seq + 1, type: 'upload.state', data: { ...image, state: 'staged-ready', reason: undefined, digest: 'fixture', w: 1, h: 1 } });
      c.shadowRoot.querySelector('.image-refusals button')?.click();
    });
    await page.waitForFunction(() => document.querySelector('aithema-session').shadowRoot.querySelector('.staged-image .image-thumbnail')?.naturalWidth === 1);
    const thumbnailControls = await inShadow(page, c => {
      const row = c.shadowRoot.querySelector('.staged-image'), box = node => { const r = node.getBoundingClientRect(); return { x: r.x, y: r.y, width: r.width, height: r.height, right: r.right, bottom: r.bottom }; };
      return { preview: box(row.querySelector('.staged-image__preview')), remove: box(row.querySelector('button')), name: row.querySelector('button').getAttribute('aria-label') };
    });
    for (const r of [thumbnailControls.preview, thumbnailControls.remove]) assert.ok(r.width > 0 && r.height > 0);
    assert.ok(thumbnailControls.remove.width >= 44 && thumbnailControls.remove.height >= 44);
    assert.ok(thumbnailControls.remove.x >= thumbnailControls.preview.right || thumbnailControls.remove.y >= thumbnailControls.preview.bottom, 'remove target stays outside the preview');
    assert.ok(thumbnailControls.name.includes('fixture.png'));
    await clearances('ready'); await shot('ready');
    const shortState = async state => {
      if (entrance !== 'combined' || width !== 390) return;
      await resize(568); await clearances(`short-568-${state}`); await shot(`short-568-${state}`); await resize(900);
    };
    await shortState('ready');
    if (width === 390) {
      await resize(530);
      await inShadow(page, c => c.shadowRoot.querySelector('textarea').focus());
      const compact = await boxes(); for (const r of Object.values(compact)) assert.ok(r.w > 0 && r.h > 0);
      await inShadow(page, c => { const image = c.session.uploads.find(u => u.kind === 'image');
        c.receive({ sessionId: c.session.id, seq: c.session.seq + 1, type: 'upload.state', data: { ...image, state: 'staged-refused', reason: 'malformed' } });
      });
      const after = await boxes();
      for (const [selector, r] of Object.entries(after)) {
        assert.ok(r.w > 0 && r.h > 0);
        for (const edge of selector === '.composer' ? ['bottom'] : ['x', 'y', 'w', 'h']) assert.ok(Math.abs(r[edge] - compact[selector][edge]) <= .5, `keyboard ${selector}.${edge}`);
      }
      const visible = await inShadow(page, c => { const el = c.shadowRoot.querySelector('.image-refusals'), r = el.getBoundingClientRect(); return { w: r.width, h: r.height, top: r.top, bottom: r.bottom, clip: getComputedStyle(el.parentElement).clipPath }; });
      assert.ok(visible.w > 0 && visible.h > 0 && visible.top >= 0 && visible.bottom <= 530); assert.equal(visible.clip, 'none');
      changes.push({ reason: 'keyboard-malformed', before: compact, rects: after }); await shot('keyboard');
      await inShadow(page, c => { const image = c.session.uploads.find(u => u.kind === 'image'); c.receive({ sessionId: c.session.id, seq: c.session.seq + 1, type: 'upload.state', data: { ...image, state: 'staged-ready', reason: undefined } }); c.shadowRoot.querySelector('.image-refusals button').click(); });
      await resize(900);
    }
    assert.deepEqual(await page.evaluate(() => window.imageAsks), [], 'both image purposes granted at start: no ask');
    assert.equal(await inShadow(page, c => c.shadowRoot.querySelector('.composer-reason .consent-action') === null), true, 'no consent line');
    // A real document-type refusal must survive image send (AIT-280 / AIT-510).
    await inShadow(page, c => {
      const transfer = new DataTransfer(); transfer.items.add(new File(['fixture'], 'fixture.unknown', { type: 'application/octet-stream' }));
      c.shadowRoot.querySelector('.conversation').dispatchEvent(new DragEvent('drop', { bubbles: true, dataTransfer: transfer }));
    });
    await page.waitForFunction(() => document.querySelector('aithema-session').shadowRoot.querySelector('.composer-reason').textContent.includes('fixture.unknown'));
    const documentNotice = await inShadow(page, c => c.shadowRoot.querySelector('.composer-reason').textContent);
    await inShadow(page, c => {
      window.imageSendDelay = new Promise(resolve => { window.releaseImageSend = resolve; });
      c.shadowRoot.querySelector('.send').click();
    });
    await page.waitForFunction(() => window.imagePosts.length === 1);
    await clearances('sending'); await shot('sending'); await shortState('sending');
    await page.evaluate(() => { window.releaseImageSend(); window.imageSendDelay = null; });
    const post = await page.evaluate(() => window.imagePosts[0]); assert.equal(post.content, ''); assert.equal(post.attachments.length, 1);
    await inShadow(page, async c => {
      const { inputRevision } = await import('/packages/core/src/session.js');
      c.receive({ sessionId: c.session.id, seq: c.session.seq + 1, type: 'understanding.updated', data: {
        ...c.session.understanding, summary: 'A project screenshot', inputRevision: inputRevision(c.session), readinessAssessed: true } });
    });
    await waitForShadow(page, '.turn .image-thumbnail');
    await page.waitForFunction(() => document.querySelector('aithema-session').shadowRoot.querySelector('.turn .image-thumbnail')?.naturalWidth === 1);
    assert.equal(await inShadow(page, c => c.shadowRoot.querySelector('.composer-reason').textContent), documentNotice, 'document notice survives image send');
    await clearances('sent-document-notice'); await shot('sent-document-notice'); await shortState('sent-document-notice');
    await shot('sent');
    const tileBefore = await inShadow(page, c => { const r = c.shadowRoot.querySelector('.turn-image').getBoundingClientRect(); return { w: r.width, h: r.height }; });
    assert.ok(tileBefore.w > 0 && tileBefore.h > 0);
    await inShadow(page, async c => {
      window.imageDelay = new Promise(resolve => { window.releaseImageDelay = resolve; });
      window.imageRevocations = 0; const revoke = URL.revokeObjectURL.bind(URL); URL.revokeObjectURL = url => { window.imageRevocations++; revoke(url); };
      const session = c.session, { [session.locale]: copy } = await import(`/packages/ui/src/i18n/${session.locale}.js`);
      c.configure({ entrance: window.imageEntrance, session, copy, sessionToken: 'fixture', voiceClient: {},
        ...(window.imageEntrance === 'combined' ? { host: { credits: true, verification: { delivery: true, privacyDocumentConfigured: true } } } : {}) });
    });
    const tileReload = await inShadow(page, c => { const r = c.shadowRoot.querySelector('.turn-image').getBoundingClientRect(); return { w: r.width, h: r.height }; });
    assert.ok(tileReload.w > 0 && tileReload.h > 0); assert.deepEqual(tileReload, tileBefore, 'reload reserves the image box before authenticated pixels arrive');
    assert.ok(await page.evaluate(() => window.imageRevocations > 0), 'the old object URL was revoked');
    await page.evaluate(() => { window.releaseImageDelay(); window.imageDelay = null; });
    await waitForShadow(page, '.turn .image-thumbnail');
    await page.waitForFunction(() => document.querySelector('aithema-session').shadowRoot.querySelector('.turn .image-thumbnail')?.naturalWidth === 1);
    await shot('reload');
    assert.ok(await page.evaluate(() => window.imageOwnerHeaders.every(header => header === 'fixture')), 'all thumbnail requests use owner authentication');
    await inShadow(page, c => { const image = c.session.uploads.find(u => u.kind === 'image');
      c.receive({ sessionId: c.session.id, seq: c.session.seq + 1, type: 'upload.state', data: { ...image, state: 'withheld', withdrawn: true } });
    });
    assert.equal(await inShadow(page, c => c.shadowRoot.querySelector('.turn .image-thumbnail')), null, 'withheld pixels are removed');
    const withheldLabel = await inShadow(page, c => c.shadowRoot.querySelector('.turn-image').textContent);
    assert.equal(withheldLabel, locale === 'de' ? 'Bild nicht gesendet' : 'Image not sent');
    await shot('withheld');
    const withheld = await boxes();
    for (const [selector, r] of Object.entries(withheld)) {
      assert.ok(r.w > 0 && r.h > 0, `${selector} positive while withheld`);
      for (const edge of selector === '.composer' ? ['bottom'] : ['x', 'y', 'w', 'h']) assert.ok(Math.abs(r[edge] - before[selector][edge]) <= .5, `${selector}.${edge} fixed while withheld`);
    }
    changes.push({ reason: 'withheld', rects: withheld });
    await inShadow(page, c => {
      const transfer = new DataTransfer(); transfer.items.add(new File(['fixture'], 'fixture.heic', { type: 'image/heic' }));
      c.shadowRoot.querySelector('.conversation').dispatchEvent(new DragEvent('drop', { bubbles: true, dataTransfer: transfer }));
    });
    await page.waitForFunction(() => document.querySelector('aithema-session').shadowRoot.querySelector('.image-refusals')?.textContent.includes('fixture.heic'));
    assert.equal(await page.evaluate(() => window.imageSeq), 1, 'HEIC is refused before upload');
    await clearances('heic'); await shot('heic');
    await inShadow(page, c => c.shadowRoot.querySelector('.image-refusals button').click());

    await inShadow(page, async c => {
      window.imageGranted = false; window.imageFixtureConsent = true; window.imageAsks = [];
      const session = c.session; session.featureMatrix.best.imageInput = { available: false, reason: 'current processing consent required' };
      const { [session.locale]: copy } = await import(`/packages/ui/src/i18n/${session.locale}.js`);
      c.configure({ entrance: window.imageEntrance, session, copy, sessionToken: 'fixture', voiceClient: {},
        ...(window.imageEntrance === 'combined' ? { host: { credits: true, verification: { delivery: true, privacyDocumentConfigured: true } } } : {}) });
    });
    await startTyping(page);
    const consentBefore = await boxes(), attachedBefore = await page.evaluate(() => window.imageSeq);
    for (const r of Object.values(consentBefore)) assert.ok(r.w > 0 && r.h > 0, 'positive frame before consent selection');
    const consentFrame = async state => {
      const current = await boxes();
      for (const [selector, r] of Object.entries(current)) {
        assert.ok(r.w > 0 && r.h > 0, `${selector} positive in ${state}`);
        for (const edge of selector === '.composer' ? ['bottom'] : ['x', 'y', 'w', 'h']) assert.ok(Math.abs(r[edge] - consentBefore[selector][edge]) <= .5, `${selector}.${edge} fixed in ${state}`);
      }
      changes.push({ reason: state, before: consentBefore, rects: current }); await shot(state);
    };
    await choose(); await page.waitForFunction(() => window.imageAsks.length === 1);
    assert.equal(await page.evaluate(() => window.imageSeq), attachedBefore, 'no image POST before consent');
    assert.deepEqual(await page.evaluate(() => window.imageAsks[0].features), ['imageInput']);
    await consentFrame('consent');
    await inShadow(page, c => { window.imageGranted = true;
      c.receive({ sessionId: c.session.id, seq: c.session.seq + 1, type: 'consent.revised', data: { granted: true, conversationUnchanged: true, changed: ['imageInput'], removed: [] } });
    });
    await waitForShadow(page, '.staged-image[data-state="staged-pending"]');
    assert.equal(await page.evaluate(() => window.imageSeq), attachedBefore + 1, 'consent resumes exactly one attach');
    assert.equal(await page.evaluate(() => window.imageAsks.length), 1, 'no repeated consent ask');
    await consentFrame('consent-resumed');
    await inShadow(page, c => c.shadowRoot.querySelector('.staged-image__remove').click());
    await page.waitForFunction(() => !document.querySelector('aithema-session').shadowRoot.querySelector('.staged-image'));
    await shot('discarded');
    const discarded = await boxes();
    for (const [selector, r] of Object.entries(discarded)) {
      assert.ok(r.w > 0 && r.h > 0, `${selector} positive after discard`);
      for (const edge of selector === '.composer' ? ['bottom'] : ['x', 'y', 'w', 'h']) assert.ok(Math.abs(r[edge] - consentBefore[selector][edge]) <= .5, `${selector}.${edge} fixed after discard`);
    }
    changes.push({ reason: 'discarded', before: consentBefore, rects: discarded });
    if (evidence) await writeFile(join(evidence, `${prefix}-rects.json`), JSON.stringify({ unstaged, before, changes, tileBefore, tileReload, after: await boxes() }, null, 2));

  });
}
