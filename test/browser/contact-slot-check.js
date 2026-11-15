import assert from 'node:assert/strict';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { startChild } from '../helpers.js';
import { browserForFile } from './shared-browser.js';
import { firstPaintMarkupFor } from '../../packages/ui/src/first-paint.js';

export async function contactSlotCheck(t) {
  const directory = await mkdtemp(join(tmpdir(), 'aithema-contact-'));
  const demo = await startChild(new URL('../fixtures/no-provider-server.js', import.meta.url), join(directory, 'sessions.sqlite'));
  const browser = await browserForFile();
  t.after(async () => { await browser.close(); await demo.kill(); await rm(directory, { recursive: true, force: true }); });
  const page = await browser.newPage(), evidence = process.env.AITHEMA_EVIDENCE_DIR, checks = [];
  await page.emulateMediaFeatures([{ name: 'prefers-reduced-motion', value: 'reduce' }]);
  await page.setRequestInterception(true);
  page.on('request', request => {
    const url = new URL(request.url());
    if (url.origin !== demo.url) return void request.abort();
    if (url.pathname !== '/contact-fixture') return void request.continue();
    void request.respond({ status: 200, contentType: 'text/html', body: `<!doctype html><html><head>
      <meta name="viewport" content="width=device-width,initial-scale=1"><link rel="icon" href="data:,">
      <link rel="stylesheet" href="/demo/host.css"></head><body><main class="aithema-shell"></main></body></html>` });
  });
  const settle = () => page.evaluate(async () => {
    await document.fonts.ready;
    await new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)));
  });
  const rects = selectors => page.evaluate(selectors => {
    const c = document.querySelector('aithema-session');
    return selectors.map(selector => {
      const n = c.shadowRoot.querySelector(selector) ?? document.querySelector(selector), b = n.getBoundingClientRect();
      return [b.x, b.y, b.width, b.height];
    });
  }, selectors);
  const positive = (boxes, label) => boxes.forEach(b => assert.ok(b[2] > 0 && b[3] > 0, `${label}: positive box ${b}`));
  const stable = (before, after, label) => {
    positive(before, label); positive(after, label);
    const shift = Math.max(...before.flatMap((b, i) => b.map((n, j) => Math.abs(n - after[i][j]))));
    assert.ok(shift <= .5, `${label}: ${shift}px: ${JSON.stringify(before)} -> ${JSON.stringify(after)}`);
    return shift;
  };
  const visible = selector => page.evaluate(selector => {
    const c = document.querySelector('aithema-session'), n = c.querySelector(selector) ?? c.shadowRoot.querySelector(selector);
    return n.checkVisibility({ checkVisibilityCSS: true }) && !n.closest('[inert]');
  }, selector);
  const capture = async name => {
    if (!evidence) return;
    await mkdir(join(evidence, 'shots'), { recursive: true });
    await page.screenshot({ path: join(evidence, 'shots', `${name}.png`), fullPage: false, captureBeyondViewport: false });
  };
  for (const width of [390, 1024, 1440]) for (const locale of ['en', 'de']) for (const theme of ['light', 'dark']) {
    const name = `${width}-${locale}-${theme}`;
    await page.setViewport({ width, height: width === 390 ? 844 : 1000 });
    await page.goto(`${demo.url}/contact-fixture`, { waitUntil: 'domcontentloaded' });
    await page.evaluate(({ markup, theme, locale }) => {
      document.documentElement.lang = locale; document.documentElement.dataset.theme = theme;
      document.querySelector('.aithema-shell').innerHTML = `<aithema-session theme="${theme}" motion="off">
        <h1 slot="brand">Aithema</h1><section slot="sidebar-contact" id="contact-card"><p>${locale === 'de' ? 'Kontakt aufnehmen' : 'Get in touch'}</p><button type="button" id="contact-open">${locale === 'de' ? 'Kontakt' : 'Contact'}</button></section>
        <button slot="contact-launcher" id="contact-launch" type="button" aria-label="${locale === 'de' ? 'Kontakt' : 'Contact'}">@</button>
      </aithema-session>${markup}`;
      const dialog = document.createElement('dialog'); dialog.id = 'contact-overlay';
      dialog.innerHTML = `<h2>${locale === 'de' ? 'Kontakt' : 'Contact'}</h2><p>${locale === 'de' ? 'Nur eine Demo. Es werden keine Daten gesendet.' : 'A demo only. No data is sent.'}</p><form method="dialog"><button>${locale === 'de' ? 'Schließen' : 'Close'}</button></form>`;
      document.body.append(dialog);
      for (const id of ['contact-open', 'contact-launch']) document.getElementById(id).onclick = () => dialog.showModal();
      const now = Date.now(); Date.now = () => now;
    }, { markup: firstPaintMarkupFor({ contactLauncher: true }), theme, locale });
    await settle();
    const before = await page.evaluate(() => ['.aithema-first-paint', '.aithema-first-paint .audio-rail'].map(s => {
      const b = document.querySelector(s).getBoundingClientRect(); return [b.x, b.y, b.width, b.height];
    }));
    await capture(`${name}-first-paint`);
    await page.evaluate(async locale => {
      await import('/packages/ui/src/session-element.js');
      const { createSession, inputRevision } = await import('/packages/core/src/session.js');
      const { [locale]: copy } = await import(`/packages/ui/src/i18n/${locale}.js`);
      const session = createSession({ demo: true }); session.locale = locale;
      session.featureMatrix = { best: Object.fromEntries(['text', 'analysis', 'visuals', 'html'].map(k => [k, { available: true, reason: null }])) };
      window.fetch = async (url, init = {}) => String(url).endsWith('/events')
        ? new Response(new ReadableStream({ start(controller) { init.signal?.addEventListener('abort', () => controller.close(), { once: true }); } }))
        : Response.json(String(url).endsWith('/features') ? session.featureMatrix : session);
      const c = document.querySelector('aithema-session');
      window.contactFixture = { c, copy, inputRevision };
      c.configure({ copy, session, voiceClient: {}, host: { library: true } });
    }, locale);
    await settle();
    const mounted = await rects(['.band', '.audio-rail']);
    stable(before, mounted, `${name}: first paint`);
    assert.equal(await visible('#contact-launch'), true, `${name}: reachable before input`);
    await capture(`${name}-launcher`);
    // Real keyboard activation, native modal focus trap, and return to the host opener.
    await page.focus('#contact-launch');
    await page.keyboard.press('Enter');
    assert.equal(await page.$eval('#contact-overlay', d => d.open), true);
    await capture(`${name}-overlay`);
    await page.keyboard.press('Escape');
    assert.equal(await page.$eval('#contact-launch', n => n === document.activeElement), true);
    await page.keyboard.press('Tab');
    assert.equal(await page.$eval('aithema-session', c => c.shadowRoot.activeElement?.classList.contains('settings-open')), true, 'Tab continues into Settings');
    await page.evaluate(() => {
      const { c } = window.contactFixture;
      c.receive({ seq: c.session.seq + 1, type: 'turn.final', data: { id: 'contact-u1', role: 'user', content: 'Requirements' } });
      const root = c.shadowRoot; root.querySelector('.workspace').removeAttribute('data-reveal');
      // Long fixture content exercises the scroll owner without model work.
      root.querySelector('.summary').hidden = false;
      root.querySelector('.summary-text').textContent = 'A summary. '.repeat(1000);
    });
    await settle();
    assert.equal(await visible('#contact-open'), true, `${name}: mounted pinned host content`);
    assert.equal(await visible('#contact-launch'), width < 960, `${name}: launcher follows sidebar mode`);
    const frames = ['.band', '.audio-rail', '.understanding', '.understanding > .foot', '.sidebar-contact', '.attach', '.send'];
    const pinned = await rects(frames); positive(pinned, name);
    await capture(`${name}-pinned`);
    await page.evaluate(() => { document.querySelector('aithema-session').shadowRoot.querySelector('.analysis-content').scrollTop = 600; });
    await settle();
    assert.ok(await page.$eval('aithema-session', c => c.shadowRoot.querySelector('.analysis-content').scrollTop > 0));
    const scrolled = await rects(frames); stable(pinned, scrolled, `${name}: analysis scroll`);
    await capture(`${name}-scrolled`);
    // The email ask uses the same analysis-stack cell and must leave contact exposed.
    await page.evaluate(() => {
      const root = document.querySelector('aithema-session').shadowRoot;
      root.querySelector('.workspace').dataset.emailAsk = 'pane';
      root.querySelector('.email-ask-pane').textContent = 'E\u2011Mail';
    });
    await settle(); stable(scrolled, await rects(frames), `${name}: email pane`);
    assert.equal(await visible('#contact-open'), true);
    await capture(`${name}-email-pane`);
    // Fold uses the production controller; enable its existing canvas predicate with a fixture draft.
    await page.evaluate(() => {
      const root = document.querySelector('aithema-session').shadowRoot;
      root.querySelector('.workspace').removeAttribute('data-email-ask');
      root.querySelector('.workspace').setAttribute('data-folded', '');
      root.querySelector('.understanding').hidden = true;
      root.querySelector('.conversation').hidden = true;
      root.querySelector('.fold-view').hidden = false;
    });
    await settle(); assert.equal(await visible('#contact-launch'), true, `${name}: folded launcher`);
    stable(mounted, await rects(['.band', '.audio-rail']), `${name}: folded header`);
    await capture(`${name}-folded`);
    // Empty host content consumes no sidebar row, while the declared launcher keeps its target.
    await page.evaluate(() => {
      const c = document.querySelector('aithema-session'); c.querySelector('[slot="sidebar-contact"]').remove();
      c.shadowRoot.querySelector('.workspace').removeAttribute('data-folded');
      c.shadowRoot.querySelector('.understanding').hidden = false;
      c.shadowRoot.querySelector('.conversation').hidden = false;
      c.shadowRoot.querySelector('.fold-view').hidden = true;
    });
    await settle();
    const empty = await rects(['.sidebar-contact']);
    assert.equal(empty[0][3], 0, `${name}: empty pinned slot consumes zero height`);
    assert.equal(await visible('#contact-launch'), true, `${name}: empty sidebar retains launcher`);
    await capture(`${name}-empty`);
    checks.push({ name, before, mounted, pinned, scrolled, empty, shiftPx: 0 });
    if (evidence) await writeFile(join(evidence, 'contact-rects.json'), JSON.stringify(checks, null, 2) + '\n');
  }
  assert.equal(checks.length, 12);
}
