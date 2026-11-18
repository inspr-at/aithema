// RC25 findings 7–13, promoted to RC26. Each entrance gets a fresh document.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { browserForFile } from './shared-browser.js';
import { startChild } from '../helpers.js';
import { fixture } from './combined-entrance-check.js';

const html = fixture
  .replace(
    "import '/packages/ui/src/session-element.js';",
    `import '/packages/ui/src/session-element.js';
import { AudioRail } from '/packages/ui/src/audio-rail.js';
const render = AudioRail.prototype.render;
AudioRail.prototype.render = function () { globalThis.lookRail = this; return render.call(this); };`,
  )
  .replace('analysis:allowed}};mount(session);', 'analysis:allowed,images:allowed}};mount(session);')
  .replace('analysis:allowed};return Response.json(s)', 'analysis:allowed,images:allowed};return Response.json(s)')
  .replace("entrance:'combined'", "entrance:new URL(location.href).searchParams.get('entrance')||'combined'");
const settle = (page) =>
  page.evaluate(async () => {
    await document.fonts.ready;
    await Promise.all(
      c.shadowRoot
        .getAnimations({ subtree: true })
        .filter((a) => a.playState === 'running' && Number.isFinite(a.effect.getComputedTiming().endTime))
        .map((a) => a.finished.catch(() => {})),
    );
    await new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve)));
  });
const boxes = (page, selectors) =>
  page.evaluate(
    (selectors) =>
      selectors.map((s) => {
        const b = c.shadowRoot.querySelector(s).getBoundingClientRect();
        return [b.x, b.y, b.width, b.height];
      }),
    selectors,
  );
const positive = (values) => values.forEach((b) => assert.ok(b[2] > 0 && b[3] > 0, `positive box ${b}`));
const stable = (a, b) => {
  positive(a);
  positive(b);
  assert.deepEqual(b, a, 'exact 0 px layout shift');
};
const intersects = (a, b) => a[0] < b[0] + b[2] && a[0] + a[2] > b[0] && a[1] < b[1] + b[3] && a[1] + a[3] > b[1];

for (const item of [10, 12, 'email'])
  test(`AIT-541 r2 ${item}: changed visitor states`, { timeout: 300_000 }, async t => {
    const dir = await mkdtemp(join(tmpdir(), 'aithema-look-r2-'));
    const server = await startChild(new URL('../fixtures/no-provider-server.js', import.meta.url), join(dir, 'fixture.sqlite'),
      { AITHEMA_VOICE_MODE: 'off', AITHEMA_IMAGE_MODE: 'off', AITHEMA_HTML_MODE: 'off' });
    const browser = await browserForFile(), records = [];
    t.after(async () => { await browser.close(); await server.kill(); });
    const evidence = process.env.AITHEMA_EVIDENCE_DIR;
    if (evidence) await mkdir(join(evidence, 'look', 'r2'), { recursive: true });
    for (const [locale, theme] of [['en', 'light'], ['de', 'dark']])
      for (const width of item === 12 ? [320, 390, 1024, 1280, 1440] : [390, 1440])
      for (const height of item === 12 && width >= 960 ? [640, 1000] : [1000])
        await t.test(`${locale}/${theme}/${width}x${height}`, async () => {
          const page = await browser.newPage(), label = `item-${item}-${locale}-${theme}-${width}-combined${height === 1000 ? '' : '-compact'}`;
          try {
            await page.setViewport({ width, height });
            await page.emulateMediaFeatures([{ name: 'prefers-color-scheme', value: theme }, { name: 'prefers-reduced-motion', value: 'reduce' }]);
            await page.setRequestInterception(true);
            page.on('request', r => { void (new URL(r.url()).pathname === '/look-r2' ? r.respond({ status: 200, contentType: 'text/html', body: html }) : r.continue()); });
            await page.goto(`${server.url}/look-r2?locale=${locale}&opener`);
            await page.waitForFunction(() => globalThis.ready);
            await page.evaluate(theme => {
              c.setAttribute('theme', theme); c.style.setProperty('--aithema-height', '100dvh');
              c.style.setProperty('--aithema-font', 'ui-sans-serif,-apple-system,"Segoe UI Variable Text","Segoe UI",system-ui,sans-serif');
              c.style.setProperty('--aithema-display', 'Georgia,"Iowan Old Style","Palatino Linotype",serif');
            }, theme);
            const shot = async state => {
              await page.evaluate(() => { c.shadowRoot.activeElement?.blur(); document.activeElement?.blur(); scrollTo(0, 0); });
              await page.mouse.move(-1, -1); await settle(page);
              if (evidence) await page.screenshot({ path: join(evidence, 'look', 'r2', `${label}-${state}.png`), fullPage: false });
            };
            await settle(page);
            if (item === 10) {
              await shot('processing');
              const route = await page.evaluate(() => {
                const n = c.shadowRoot.querySelector('.ready__route'), b = n.getBoundingClientRect();
                return { text: n.textContent, box: [b.x, b.y, b.width, b.height], display: getComputedStyle(n).display };
              });
              records.push({ label, route });
              if (width < 600) { positive([route.box]); assert.ok(route.text.trim()); }
              else assert.equal(route.display, 'none', 'wide full notice owns processing disclosure');
              return;
            }
            await page.evaluate(async () => {
              const { inputRevision } = await import('/packages/core/src/session.js');
              const s = c.session;
              s.transcript = [{ id: 'u', role: 'user', content: 'A website' }, { id: 'a', role: 'assistant', content: 'Which visitors?' }];
              const revision = inputRevision(s); s.transcript[1].inputRevision = revision;
              Object.assign(s.understanding, { inputRevision: revision, readinessAssessed: true, draft: false, summary: 'A website', openQuestions: ['Which visitors?', 'Which languages?'] });
              s.operations = { inputRevision: revision, running: [], failures: [], lastFailure: null };
              s.featureMatrix.best = { text: { available: true }, analysis: { available: true }, voice: { available: true } };
              granted = true; mount(s);
            });
            await settle(page);
            if (item === 12) {
              const pinned = ['.transcript-shell', '.transcript-shell ol', '.transcript-shell .turn:first-child', '.band', 'textarea', '.understanding .head'];
              const before = await boxes(page, pinned);
              const observations = [];
              for (const reason of ['idle', 'spend-deadline']) {
                await page.evaluate(reason => { lookRail.session = null; lookRail.endMessage(reason, { timeLimit: 'call' }); lookRail.render(); }, reason);
                await shot(reason);
                const geometry = await page.evaluate(() => {
                  const root = c.shadowRoot, n = root.querySelector('.voice-state'), short = n.querySelector('.consent-narrow');
                  const rect = n => { const b = n.getBoundingClientRect(); return [b.x, b.y, b.width, b.height]; };
                  return { popup: rect(n), heading: rect(root.querySelector('.understanding .head')),
                    bubbles: [...root.querySelectorAll('.transcript-shell .turn')].map(rect), anchor: rect(root.querySelector('.voice-retry')),
                    band: rect(root.querySelector('.band')), scrollHeight: n.scrollHeight, clientHeight: n.clientHeight,
                    text: short.dataset.copy, short: rect(short), scroll: short.scrollWidth, client: short.clientWidth,
                    ellipsis: getComputedStyle(short).textOverflow };
                });
                const after = await boxes(page, pinned);
                await page.evaluate(() => lookRail.clearMessage()); await settle(page);
                observations.push({ reason, geometry, after, cleared: await boxes(page, pinned) });
              }
              records.push({ label, before, observations });
              for (const { reason, geometry: g, after, cleared } of observations) {
                stable(before, after); stable(before, cleared); positive([g.popup]);
                if (width < 600) {
                  const expected = locale === 'de'
                    ? reason === 'idle' ? 'Nach Stille beendet · weiter per Text' : 'Anrufzeit abgelaufen · weiter per Text'
                    : reason === 'idle' ? 'Ended after silence · continue by text' : 'Call time up · continue by text';
                  assert.equal(g.text, expected);
                  assert.ok(g.scroll <= g.client, 'complete narrow label without clipping');
                  assert.notEqual(g.ellipsis, 'ellipsis');
                  assert.ok(g.short[3] <= 13, 'one visible label line');
                  assert.ok(g.short[0] >= 0 && g.short[0] + g.short[2] <= width, 'whole label inside viewport');
                } else {
                  positive([g.heading, ...g.bubbles, g.anchor]);
                  assert.equal(intersects(g.popup, g.heading), false, 'popup clears overview heading');
                  for (const bubble of g.bubbles) assert.equal(intersects(g.popup, bubble), false, 'popup clears every transcript bubble');
                  assert.ok(g.scrollHeight <= g.clientHeight, 'full desktop message is readable');
                  if (height > 700) assert.ok(g.popup[0] <= g.anchor[0] + g.anchor[2] / 2 && g.popup[0] + g.popup[2] >= g.anchor[0] + g.anchor[2] / 2, 'popup stays under its call control');
                  else assert.ok(g.popup[1] + g.popup[3] <= g.band[1] + g.band[3], 'compact message fits inside existing rail height');
                }
              }
            } else {
              await page.evaluate(async () => {
                const { EmailOffer } = await import('/packages/ui/src/email-offer.js');
                const { [c.session.locale]: copy } = await import('/packages/ui/src/i18n/' + c.session.locale + '.js');
                const row = document.createElement('li'); c.shadowRoot.querySelector('.transcript-shell ol').append(row);
                const email = { canCollect: true, delivery: true, identity: {}, paintNotice() {} };
                globalThis.lookOffer = new EmailOffer({ root: c.shadowRoot, copy, verification: { email,
                  async saveAndConfirm(value) { email.address = value; return { ok: true, sent: true }; },
                  async resend() { return { ok: false, status: 429 }; } }, session: () => c.session, streaming: () => false });
                lookOffer.paintRow(row); row.querySelector('input').value = 'visitor@example.test';
              });
              await settle(page);
              const pinned = ['.email-offer', '.email-offer__message-slot', '.email-offer__send', '.composer'];
              const before = await boxes(page, pinned), observations = [];
              for (const state of ['sent', '429', 'confirmed']) {
                await page.evaluate(async state => {
                  if (state === 'confirmed') { lookOffer.email.identity = { status: 'verified' }; lookOffer.paint(); }
                  else await lookOffer.save();
                }, state);
                await shot(state);
                const message = await page.evaluate(() => {
                  const n = c.shadowRoot.querySelector('.email-offer__message'), text = n.querySelector('.email-offer__message-text'), svg = n.querySelector('svg');
                  return { refused: n.hasAttribute('data-refused'), invalid: c.shadowRoot.querySelector('input').getAttribute('aria-invalid'),
                    indent: text.getBoundingClientRect().left - n.getBoundingClientRect().left, glyph: getComputedStyle(svg).display, text: text.textContent };
                });
                observations.push({ state, message, after: await boxes(page, pinned) });
              }
              records.push({ label, before, observations });
              for (const { state, message, after } of observations) {
                stable(before, after);
                assert.equal(message.refused, state === '429');
                assert.equal(message.indent, state === '429' ? 21 : 0, 'only visible warning glyph reserves indentation');
                assert.equal(message.invalid, state === '429' ? 'false' : null);
              }
            }
          } finally { await page.close(); }
        });
    if (evidence) await writeFile(join(evidence, 'look', 'r2', `item-${item}-geometry.json`), JSON.stringify(records, null, 2));
  });
