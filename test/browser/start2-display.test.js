// AIT-131 evidence: the real reference page and component, with deterministic display snapshots and local voice.
// No provider calls, microphone, wallet writes or voice lifecycle work. Run only on the remote browser runner.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { constants } from 'node:fs';
import { access, mkdir, mkdtemp, writeFile, readFile } from 'node:fs/promises';
import { homedir, tmpdir } from 'node:os';
import { delimiter, join } from 'node:path';
import { inflateSync } from 'node:zlib';
import puppeteer from 'puppeteer-core';
import { startChild } from '../helpers.js';
import { de } from '../../packages/ui/src/i18n/de.js';
import { en } from '../../packages/ui/src/i18n/en.js';

async function browserPath() {
  const paths = process.env.CHROME_PATH ? [process.env.CHROME_PATH] : [
    '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome', '/opt/google/chrome/chrome',
    ...(process.env.PATH ?? '').split(delimiter).flatMap(dir => ['google-chrome', 'chromium', 'chromium-browser'].map(name => join(dir, name)))];
  for (const path of paths) { try { await access(path, constants.X_OK); return path; } catch { /* remote runner */ } }
  throw new Error('No browser available on the remote test runner');
}
const shadow = (page, fn, ...args) => page.$eval('aithema-session', fn, ...args);
const until = (page, fn, arg) => page.waitForFunction(fn, { polling: 50, timeout: 30_000 }, arg);
const settle = () => new Promise(resolve => setTimeout(resolve, 120));
const boxes = (page, selectors) => shadow(page, (c, selectors) => selectors.map(selector => {
  const r = c.shadowRoot.querySelector(selector).getBoundingClientRect(); return [r.x, r.y, r.width, r.height];
}), selectors);
// Dissolve transforms intentionally drift the painted controls. Offset geometry
// checks the actual layout underneath that animation.
const layoutBoxes = (page, selectors) => shadow(page, (c, selectors) => selectors.map(selector => {
  const n = c.shadowRoot.querySelector(selector); return [n.offsetLeft, n.offsetTop, n.offsetWidth, n.offsetHeight];
}), selectors);
const sameBoxes = (before, after, context) => before.forEach((box, i) => box.forEach((value, n) =>
  assert.ok(Math.abs(value - after[i][n]) <= .5, `${context}: ${i}/${n} shifted ${value} → ${after[i][n]}`)));

// A rendered 1x1 Chrome PNG, independent of its RGB/RGBA colour type and scanline filter.
function pixelRgb(png) {
  const chunks = [];
  for (let offset = 8; offset < png.length;) {
    const length = png.readUInt32BE(offset), name = png.toString('ascii', offset + 4, offset + 8), data = png.subarray(offset + 8, offset + 8 + length);
    if (name === 'IHDR') { assert.equal(data.readUInt32BE(0), 1); assert.equal(data.readUInt32BE(4), 1); }
    if (name === 'IDAT') chunks.push(data);
    offset += length + 12;
  }
  return [...inflateSync(Buffer.concat(chunks)).subarray(1, 4)];
}
const freezeReveal = page => shadow(page, c => {
  globalThis.displayRevealTimeline = c.shadowRoot.querySelector('.band').getAnimations({ subtree: true })
    .filter(animation => animation.animationName !== 'aithema-prism-turn');
  for (const animation of globalThis.displayRevealTimeline) { animation.pause(); animation.currentTime = 0; }
});
const seekReveal = (page, ms) => page.evaluate(ms => {
  for (const animation of globalThis.displayRevealTimeline) animation.currentTime = ms;
}, ms);

const evidenceCommit = process.env.GITHUB_SHA ?? process.env.AITHEMA_COMMIT ?? /([a-f0-9]{10})-\d+\/src$/u.exec(process.cwd())?.[1] ?? 'd886da3';
const content = {
  de: {
    first: 'Soll die Website eine geschätzte Lieferzeit anzeigen, die sich nach dem Backlog richtet? Bitte mit Ja oder Nein antworten.',
    answer: 'Ja.', reply: 'Danke, dann notiere ich: Die Website zeigt eine geschätzte Lieferzeit, die sich nach dem Backlog richtet.\n\nSollen Kundinnen und Kunden auf der Website Motiv, Farbe und Größe selbst wählen können?',
    summary: 'Die Person stickt Polster selbst in Handarbeit, etwa zehn pro Woche, und möchte eine Website dazu. Kundinnen und Kunden sollen sofort online bezahlen können. Bestellungen werden nie gestoppt; sie laufen in einen Backlog, längere Wartezeiten werden akzeptiert. Auf die Ja-oder-Nein-Frage bestätigt die Person nun eindeutig: Die Website soll eine geschätzte Lieferzeit anzeigen, die sich nach dem Backlog richtet. Der Konfigurator für Motiv, Farbe und Größe bleibt unklar, da die früheren Zustimmungen auf Entweder-oder-Fragen erfolgten.',
    signals: ['Die Person stickt die Polster selbst.', 'Kapazität: etwa zehn Polster pro Woche.', 'Sofortige Online-Bezahlung gewünscht.', 'Keine Bestellbegrenzung: Bestellungen laufen in einen Backlog.', 'Längere Wartezeiten werden akzeptiert.', 'Geschätzte Lieferzeit nach Backlog soll angezeigt werden.', 'Konfigurator für Motiv, Farbe und Größe nicht eindeutig bestätigt.'],
    questions: ['Können Kundinnen und Kunden Motiv, Farbe und Größe selbst wählen?', 'Wie soll die geschätzte Lieferzeit berechnet werden?'],
    recent: ['Website für Stickpolster', 'Buchhaltung automatisieren', 'Termine per Telefon'],
  },
  en: {
    first: 'Should the website show an estimated delivery time based on the backlog? Please answer yes or no.',
    answer: 'Yes.', reply: 'Thank you. I will note that the website shows an estimated delivery time based on the backlog.\n\nShould customers be able to choose the design, colour and size on the website?',
    summary: 'The person embroiders cushions by hand, about ten a week, and would like a website for them. Customers should be able to pay online immediately. Orders are never stopped; they join a backlog, and longer waiting times are accepted. In response to the yes-or-no question, the person has now clearly confirmed that the website should display an estimated delivery time based on the backlog. The configurator for design, colour and size remains unclear because earlier confirmations followed either-or questions.',
    signals: ['The person embroiders the cushions by hand.', 'Capacity: about ten cushions a week.', 'Immediate online payment is wanted.', 'No order limit: orders join a backlog.', 'Longer waiting times are accepted.', 'Estimated delivery time should follow the backlog.', 'A configurator for design, colour and size has not been clearly confirmed.'],
    questions: ['Can customers choose the design, colour and size themselves?', 'How should estimated delivery time be calculated?'],
    recent: ['Cushion website', 'Automate accounting', 'Phone appointments'],
  },
};

test('AIT-131 r2 demo account stays in the band and opens below its control inside the viewport', { timeout: 120_000 }, async t => {
  const directory = await mkdtemp(join(tmpdir(), 'aithema-account-band-'));
  const demo = await startChild(new URL('../fixtures/no-provider-server.js', import.meta.url), join(directory, 'session.sqlite'), {
    AITHEMA_VOICE_MODE: 'off', AITHEMA_IMAGE_MODE: 'off', AITHEMA_HTML_MODE: 'off', AITHEMA_COMMIT: evidenceCommit,
  });
  const browser = await puppeteer.launch({ executablePath: await browserPath(), headless: true, userDataDir: join(directory, 'chrome'),
    env: { PATH: process.env.PATH, HOME: homedir() }, args: process.platform === 'linux' && process.env.CI ? ['--no-sandbox'] : [] });
  t.after(async () => { await browser.close(); await demo.kill(); });
  const page = await browser.newPage(), evidence = process.env.AITHEMA_EVIDENCE_DIR, files = [], checks = [];
  if (evidence) await mkdir(evidence, { recursive: true });
  await page.goto(demo.url, { waitUntil: 'domcontentloaded' });
  await until(page, () => document.querySelector('aithema-session')?.session?.id && !document.querySelector('#demo-account').hidden);
  await shadow(page, c => { globalThis.accountSeed = c.session; });
  for (const locale of ['de', 'en']) for (const theme of ['light', 'dark']) for (const width of [1440, 390]) for (const folded of [false, true]) {
    const height = width === 390 ? 844 : 900;
    await page.setViewport({ width, height }); await page.select('#theme', theme);
    await page.evaluate(async ({ locale, folded }) => {
      const { en } = await import('/packages/ui/src/i18n/en.js'), { de } = await import('/packages/ui/src/i18n/de.js');
      const { paintUtilities } = await import('/demo/page-preferences.js');
      const copy = { en, de }[locale], c = document.querySelector('aithema-session'), s = structuredClone(globalThis.accountSeed);
      s.locale = locale; s.settings.origin = 'chosen'; s.transcript = [{ id: 'account-source', role: 'user', content: locale === 'de' ? 'Eine Website für unsere Bäckerei.' : 'A website for our bakery.' }];
      c.configure({ copy, session: s, host: { library: true } });
      document.documentElement.lang = locale; document.querySelector('#locale').value = locale; paintUtilities(copy);
      for (const [selector, value] of [['#demo-account-label', copy.host.slots.account], ['#demo-account-note', copy.host.slots.accountNote], ['#demo-account-source', copy.host.slots.source]]) document.querySelector(selector).textContent = value;
      document.querySelector('#demo-account').open = false;
      if (folded) c.shadowRoot.querySelector('.fold').click();
      window.scrollTo(0, 0);
    }, { locale, folded });
    await page.mouse.move(0, 300); await settle();
    const control = await page.evaluate(() => {
      const root = document.querySelector('aithema-session').shadowRoot, account = document.querySelector('#demo-account'), summary = account.querySelector('summary'), label = account.querySelector('#demo-account-label');
      const rect = n => { const b = n.getBoundingClientRect(); return { left: b.left, top: b.top, right: b.right, bottom: b.bottom, width: b.width, height: b.height }; };
      const slot = root.querySelector('slot[name="account"]'), wrap = slot.parentElement;
      return { box: rect(summary), band: rect(root.querySelector('.band')), gear: rect(root.querySelector('.settings-open')), name: summary.getAttribute('aria-label'), title: summary.title,
        inRightGroup: wrap.parentElement.classList.contains('header-actions'), beforeGear: wrap.nextElementSibling.classList.contains('settings-open'),
        label: getComputedStyle(label).display !== 'none', icon: rect(account.querySelector('.utility-icon svg')), chevron: rect(account.querySelector('.utility-chevron svg')) };
    });
    const context = `${width}/${theme}/${locale}/${folded}: ${JSON.stringify(control)}`;
    assert.equal(control.inRightGroup, true, context); assert.equal(control.beforeGear, true, context);
    assert.ok(control.box.top >= control.band.top && control.box.bottom <= control.band.bottom, context);
    assert.ok(control.box.left >= 0 && control.box.right <= control.gear.left + .5 && control.gear.right <= width + .5, context);
    assert.equal(control.icon.width, 16); assert.equal(control.icon.height, 16); assert.equal(control.label, width >= 600);
    assert.equal(control.name, { de, en }[locale].host.slots.account); assert.equal(control.title, control.name);
    if (control.label) { assert.equal(control.chevron.width, 10); assert.equal(control.chevron.height, 10); }
    const shot = async suffix => {
      if (!evidence) return;
      const name = `r2-demo-account-${folded ? 'folded' : 'unfolded'}-${suffix}-${width}-${theme}-${locale}.png`;
      await page.screenshot({ path: join(evidence, name) }); files.push(name);
    };
    await shot('closed');
    const before = await boxes(page, ['.band', '.band-orb', '.host-account', '.settings-open']);
    await page.click('#demo-account summary'); await settle();
    const panel = await page.$eval('#demo-account', account => {
      const b = account.querySelector('div').getBoundingClientRect(), control = account.querySelector('summary').getBoundingClientRect();
      return { open: account.open, left: b.left, top: b.top, right: b.right, bottom: b.bottom, controlBottom: control.bottom };
    });
    assert.equal(panel.open, true); assert.ok(panel.left >= 0 && panel.right <= width + .5 && panel.top >= panel.controlBottom + 5.5 && panel.bottom <= height, JSON.stringify(panel));
    sameBoxes(before, await boxes(page, ['.band', '.band-orb', '.host-account', '.settings-open']), 'account disclosure changes no band layout');
    await shot('open'); await page.keyboard.press('Escape'); assert.equal(await page.$eval('#demo-account', n => n.open), false);
    checks.push({ width, theme, locale, folded, control, panel });
  }
  if (evidence) await writeFile(join(evidence, 'r2-demo-account-evidence.json'), JSON.stringify({ ticket: 'AIT-131', commit: evidenceCommit, files, checks }, null, 2));
});

test('AIT-131 populated canvas regressions and the orb hit area', { timeout: 120_000 }, async t => {
  const directory = await mkdtemp(join(tmpdir(), 'aithema-display-regressions-'));
  const demo = await startChild(new URL('../fixtures/no-provider-server.js', import.meta.url), join(directory, 'session.sqlite'), {
    AITHEMA_VOICE_MODE: 'off', AITHEMA_IMAGE_MODE: 'off', AITHEMA_HTML_MODE: 'off', AITHEMA_COMMIT: evidenceCommit,
  });
  const browser = await puppeteer.launch({ executablePath: await browserPath(), headless: true, userDataDir: join(directory, 'chrome'),
    env: { PATH: process.env.PATH, HOME: homedir() }, args: process.platform === 'linux' && process.env.CI ? ['--no-sandbox'] : [] });
  t.after(async () => { await browser.close(); await demo.kill(); });
  const page = await browser.newPage(); page.setDefaultTimeout(15_000);
  const evidence = process.env.AITHEMA_EVIDENCE_DIR, files = [], checks = [];
  if (evidence) await mkdir(evidence, { recursive: true });
  const draft = copy => `<!doctype html><html lang="${copy.display.locale}"><head><meta charset="utf-8"><title>${copy.layout.canvas}</title>
    <style>body{margin:0;padding:32px;background:#f7f5ef;color:#243b40;font:16px system-ui}h1{font:32px Georgia}input,button{font:inherit;padding:12px;border:1px solid #b4c9c1;border-radius:6px}button{background:#1d6e6a;color:white}p{line-height:1.5}</style></head>
    <body><h1>${copy === de ? 'Ihr Website-Entwurf' : 'Your website draft'}</h1><p>${copy === de ? 'Eine geschätzte Lieferzeit für handgestickte Polster.' : 'Estimated delivery times for hand-embroidered cushions.'}</p>
    <label>${copy === de ? 'Ihr Motiv' : 'Your design'} <input id="design" value="Blumen"></label>
    <p><button id="count">${copy === de ? 'Entwurf ausprobieren' : 'Try the draft'}</button> <output id="value">0</output></p>
    <script>document.querySelector('#count').addEventListener('click',()=>{document.querySelector('#value').textContent=String(Number(document.querySelector('#value').textContent)+1)});</script></body></html>`;
  let copy = de;
  await page.setRequestInterception(true);
  page.on('request', request => {
    const url = new URL(request.url());
    if (url.pathname.endsWith('/concepts/canvas1/html')) return request.respond({ status: 200, contentType: 'application/octet-stream', body: draft(copy) });
    if (url.pathname.endsWith('/features')) return request.respond({ status: 200, contentType: 'application/json', body: JSON.stringify({
      best: Object.fromEntries(['text', 'analysis', 'html', 'images'].map(key => [key, { available: true }])) }) });
    return request.continue();
  });
  await page.goto(demo.url, { waitUntil: 'domcontentloaded' });
  await until(page, () => document.querySelector('aithema-session')?.session?.id);
  await shadow(page, c => { globalThis.regressionSeed = c.session; });
  async function scene(locale, theme, width) {
    copy = { en, de }[locale]; await page.setViewport({ width, height: width === 390 ? 844 : 900 }); await page.select('#theme', theme);
    await page.evaluate(async locale => {
      const { en } = await import('/packages/ui/src/i18n/en.js'), { de } = await import('/packages/ui/src/i18n/de.js');
      const c = document.querySelector('aithema-session'), s = structuredClone(globalThis.regressionSeed);
      s.locale = locale; s.settings.origin = 'chosen'; s.conceptVisualKind = 'html'; s.conceptCost = { maxMicro: 400_000 };
      s.transcript = [{ id: 'source', role: 'user', content: locale === 'de' ? 'Eine Website für meine handgestickten Polster.' : 'A website for my hand-embroidered cushions.' }];
      s.inputRevision = 1; s.concepts = [{ id: 'canvas1', mediaType: 'text/html', turnIds: ['source'], referenceIds: [], archived: false,
        feedback: { vote: 'clear', chips: [] }, provenance: { origin: 'ai-generated', generator: { provider: 'local-demo-fake' } } }];
      s.featureMatrix.best = Object.fromEntries(['text', 'analysis', 'html', 'images'].map(key => [key, { available: true }]));
      c.configure({ copy: { en, de }[locale], session: s }); document.documentElement.lang = locale;
      c.shadowRoot.querySelector('.fold').click();
    }, locale);
    await until(page, () => document.querySelector('aithema-session').shadowRoot.querySelector('.canvas-html').state === 'ready');
    await page.mouse.move(0, 300);
  }
  async function shot(state, locale, theme, width) {
    const name = `${state}-${width}-${theme}-${locale}.png`;
    if (evidence) { await page.screenshot({ path: join(evidence, name), fullPage: true }); files.push(name); }
  }
  const canvasFrame = async () => (await page.$('aithema-session >>> .canvas-html >>> iframe')).contentFrame();
  await t.test('populated canvas keeps interactive state and focus through durable events', async () => {
    await scene('de', 'light', 1440);
    const frame = await canvasFrame(); await frame.click('#count'); await frame.focus('#design'); await frame.type('#design', ' · geändert');
    const before = await frame.$eval('#design', n => n.value);
    await shadow(page, c => { globalThis.canvasFrameBefore = c.shadowRoot.querySelector('.canvas-html').shadowRoot.querySelector('iframe');
      c.receive({ seq: c.session.seq + 1, type: 'session.paused', data: { paused: true } }); });
    await settle();
    assert.equal(await shadow(page, c => c.shadowRoot.querySelector('.canvas-html').shadowRoot.querySelector('iframe') === globalThis.canvasFrameBefore), true);
    assert.equal(await frame.$eval('#value', n => n.textContent), '1'); assert.equal(await frame.$eval('#design', n => n.value), before);
    assert.equal(await frame.evaluate(() => document.activeElement.id), 'design', 'typing focus stays in the same browsing context');
    await shot('folded-populated-state-preserved', 'de', 'light', 1440);
  });
  await t.test('unfold unloads the populated executable iframe', async () => {
    await scene('en', 'light', 1440); await canvasFrame();
    await shadow(page, c => c.shadowRoot.querySelector('.fold-strip').click());
    assert.equal(await shadow(page, c => c.shadowRoot.querySelector('.canvas-html').artifact), null);
    assert.equal(await shadow(page, c => Boolean(c.shadowRoot.querySelector('.canvas-html').shadowRoot.querySelector('iframe'))), false);
  });
  await t.test('populated canvas and every modal frame are redacted on consent or source withdrawal', async () => {
    for (const locale of ['de', 'en']) for (const theme of ['light', 'dark']) for (const width of [390, 1024, 1440]) {
      for (const cause of ['consent', 'source']) for (const folded of [true, false]) {
        await scene(locale, theme, width);
        await shot('folded-populated-canvas', locale, theme, width);
        if (!folded) await shadow(page, c => c.shadowRoot.querySelector('.fold-strip').click());
        await shadow(page, c => c.shadowRoot.querySelector('.concept-tab').click());
        await until(page, () => document.querySelector('aithema-session').shadowRoot.querySelector('.concept-html').state === 'ready');
        await shadow(page, (c, cause) => c.receive({ seq: c.session.seq + 1,
          type: cause === 'consent' ? 'consent.revised' : 'turn.withdrawn', data: cause === 'consent' ? { granted: false } : { turnId: 'source' } }), cause);
        const surfaces = await shadow(page, c => ['.canvas-html', '.concept-html'].map(selector => {
          const n = c.shadowRoot.querySelector(selector); return { bytes: n.artifact, frame: Boolean(n.shadowRoot.querySelector('iframe')) };
        }));
        assert.deepEqual(surfaces, [{ bytes: null, frame: false }, { bytes: null, frame: false }], `${locale}/${theme}/${width}/${cause}/${folded}`);
        await shot(`revocation-${cause}-${folded ? 'folded' : 'unfolded'}`, locale, theme, width);
        checks.push({ locale, theme, width, cause, folded, surfaces });
      }
    }
  });
  await t.test('the reveal orb has a 44px hit area around its 40px visual', async () => {
    for (const locale of ['de', 'en']) for (const theme of ['light', 'dark']) for (const width of [390, 1024, 1440]) {
      await scene(locale, theme, width);
      const visual = (await boxes(page, ['.band-orb .orb__body']))[0];
      const target = await shadow(page, c => {
        const n = c.shadowRoot.querySelector('.band-orb [role="button"]'), r = n.getBoundingClientRect();
        return [r.x, r.y, r.width, r.height];
      });
      assert.equal(visual[2], 40); assert.equal(visual[3], 40); assert.equal(target[2], 44); assert.equal(target[3], 44);
      const bandBefore = await layoutBoxes(page, ['.band-orb', '.band', '.settings-open']);
      // The point is in the target's outer ring, beyond the painted 40px orb.
      await page.mouse.click(target[0] + 1, target[1] + 22);
      assert.equal(await shadow(page, c => c.shadowRoot.querySelector('.band').dataset.aithemaRevealState), 'open');
      await settle(); sameBoxes(bandBefore, await layoutBoxes(page, ['.band-orb', '.band', '.settings-open']), 'orb activation does not shift the band layout');
      await shot('orb-hit-area-open', locale, theme, width);
      checks.push({ locale, theme, width, visual, target });
    }
  });
  await t.test('conversations menu corners stay painted above the second band row at medium widths', async () => {
    for (const width of [600, 680, 768, 900, 1000]) {
      await scene('de', 'light', width);
      await shadow(page, async c => { const { de } = await import('/packages/ui/src/i18n/de.js'); c.configure({ copy: de, session: c.session, host: { library: true } }); });
      await page.click('aithema-session >>> .conversations-toggle'); await settle();
      const menu = await shadow(page, c => {
        const root = c.shadowRoot, n = root.querySelector('.conversations-menu'), b = n.getBoundingClientRect();
        return { left: b.left, right: b.right, top: b.top, bottom: b.bottom,
          corners: [[b.left + 8, b.top + 8], [b.right - 8, b.top + 8], [b.left + 8, b.bottom - 8], [b.right - 8, b.bottom - 8]]
            .map(([x, y]) => { const hit = root.elementFromPoint(x, y); return { painted: n.contains(hit), hit: hit?.className }; }) };
      });
      await shot('conversations-medium', 'de', 'light', width);
      assert.ok(menu.corners.every(n => n.painted), `${width}: ${JSON.stringify(menu)}`);
    }
  });
  if (evidence) await writeFile(join(evidence, 'display-regressions-evidence.json'), JSON.stringify({ ticket: 'AIT-131', commit: evidenceCommit,
    createdAt: new Date().toISOString(), files, checks }, null, 2));
});

test('AIT-131 integrated display: real band, reveal, voice and display matrix at 390/1024/1440, both themes and languages',
  { timeout: 360_000 }, async t => {
    const directory = await mkdtemp(join(tmpdir(), 'aithema-display-'));
    const reply = 'anthropic/claude-haiku-5.5', understanding = 'anthropic/claude-opus-5.5';
    const demo = await startChild(new URL('../fixtures/no-provider-server.js', import.meta.url), join(directory, 'session.sqlite'), {
      AITHEMA_PROVIDER: 'openrouter', OPENROUTER_MODEL: understanding, OPENROUTER_SPEECH_MODEL: reply,
      OPENROUTER_API_KEY: 'fixture-not-a-key', AITHEMA_VOICE_MODE: 'off', AITHEMA_IMAGE_MODE: 'off', AITHEMA_HTML_MODE: 'off',
      AITHEMA_OPENROUTER_PRICES: JSON.stringify({ [reply]: { prompt: 1e-6, completion: 5e-6 }, [understanding]: { prompt: 5e-6, completion: 25e-6 } }),
      AITHEMA_COMMIT: evidenceCommit, AITHEMA_BUILD_DATE: '2026-10-12T09:00:00Z',
    });
    const browser = await puppeteer.launch({ executablePath: await browserPath(), headless: true, userDataDir: join(directory, 'chrome'),
      env: { PATH: process.env.PATH, HOME: homedir() }, args: process.platform === 'linux' && process.env.CI ? ['--no-sandbox'] : [] });
    t.after(async () => { await browser.close(); await demo.kill(); });
    const page = await browser.newPage(); page.setDefaultTimeout(30_000);
    const errors = []; page.on('pageerror', error => errors.push(error.message));
    let locale = 'de';
    await page.setRequestInterception(true);
    page.on('request', async request => {
      const url = new URL(request.url());
      if (url.pathname.endsWith('/credits')) return request.respond({ status: 200, contentType: 'application/json', body: JSON.stringify({
        balance: { owner: { availableMicro: 6_550_000, limitMicro: 10_000_000, committedMicro: 3_450_000 } }, limitSlot: null,
      }) });
      if (url.pathname === '/api/library' && request.method() === 'GET') {
        const id = await shadow(page, c => c.session?.id);
        return request.respond({ status: 200, contentType: 'application/json', body: JSON.stringify({ items: content[locale].recent.map((title, i) =>
          ({ id: i === 0 ? id : `recent-${i}`, title, updatedAt: `2026-10-${12 - i}T09:00:00Z` })), total: 3 }) });
      }
      if (url.pathname.endsWith('/features')) return request.respond({ status: 200, contentType: 'application/json', body: JSON.stringify(await shadow(page, c => c.session.featureMatrix)) });
      return request.continue();
    });
    await page.setViewport({ width: 1440, height: 900 }); await page.goto(demo.url, { waitUntil: 'domcontentloaded' });
    await until(page, () => document.querySelector('aithema-session')?.session?.id);
    await page.evaluate(async () => {
      const { voiceEvents } = await import('/packages/core/src/live-voice.js');
      const { manifest } = await import('/plugins/elevenlabs/src/manifest.js');
      globalThis.displaySeed = document.querySelector('aithema-session').session;
      globalThis.displayClient = { manifest, async start({ callId }) {
        const events = voiceEvents(); globalThis.displayVoiceEvents = events; globalThis.displayCallId = callId;
        return { callId, providerSessionId: 'local-evidence', events, async setInput() {}, async setOutput() {}, async updateContext() {},
          async sendText() {}, audioLevels: () => ({ input: .3, output: .65 }),
          async close() { events.end(); return { closureConfirmed: true }; } };
      } };
    });
    const evidence = process.env.AITHEMA_EVIDENCE_DIR, files = [], reveals = [];
    if (evidence) await mkdir(evidence, { recursive: true });
    const shot = async (state, width, theme, preserveFocus = false) => {
      const name = `${state}-${width}-${theme}-${locale}.png`;
      if (!preserveFocus) await shadow(page, c => { const active = c.shadowRoot.activeElement; if (active && !c.shadowRoot.querySelector('.conversations-menu').contains(active)) active.blur(); });
      if (evidence) { await page.screenshot({ path: join(evidence, name), fullPage: width === 390 && !state.startsWith('reveal-') }); files.push(name); }
    };
    async function scene(stage, drafts = 'off') {
      await page.evaluate(async ({ stage, drafts, locale, words, commit }) => {
        const { en } = await import('/packages/ui/src/i18n/en.js'), { de } = await import('/packages/ui/src/i18n/de.js');
        const { inputRevision } = await import('/packages/core/src/session.js');
        const copy = { en, de }[locale], c = document.querySelector('aithema-session'), s = structuredClone(globalThis.displaySeed);
        s.locale = locale; s.settings.origin = stage === 'entrance' ? 'default' : 'chosen'; s.settings.voice = 'elevenlabs';
        s.engine.voice = { id: 'elevenlabs', label: 'ElevenLabs', offered: true };
        s.featureMatrix.best = Object.fromEntries(['text', 'analysis', 'voice', 'uploads', 'images', 'html'].map(key => [key, { available: true, reason: null }]));
        const visuals = drafts === 'off' ? { available: false, reason: 'not configured' } : drafts === 'low' ? { available: false, reason: 'owner credits exhausted' } : { available: true, reason: null };
        s.featureMatrix.best.html = visuals; s.featureMatrix.best.images = visuals;
        s.conceptVisualKind = 'html'; s.conceptCost = drafts === 'off' ? null : { maxMicro: 400_000 };
        if (stage === 'conversation') {
          s.inputRevision = 1; s.openQuestion = { stub: true };
          s.transcript = [{ id: 'a1', role: 'assistant', content: words.first }, { id: 'u1', role: 'user', content: words.answer }, { id: 'a2', role: 'assistant', content: words.reply }];
          for (const turn of s.transcript) if (turn.role === 'assistant') turn.inputRevision = inputRevision(s);
          s.understanding = { ...s.understanding, locale, inputRevision: inputRevision(s), readinessAssessed: true, draft: false, summary: words.summary,
            signals: words.signals, openQuestions: words.questions, progress: { talk: { value: .5 }, build: { value: .2 } } };
        }
        c.configure({ copy, copyForLocale: value => ({ en, de })[value], session: s, voiceClient: globalThis.displayClient,
          host: { library: true, credits: true, locale: () => locale, version: { version: '0.0.0', commit, date: '2026-10-12T09:00:00Z' } } });
        document.documentElement.lang = locale; document.querySelector('#locale').value = locale;
        const { paintUtilities } = await import('/demo/page-preferences.js'); paintUtilities(copy);
        window.scrollTo(0, 0);
      }, { stage, drafts, locale, words: content[locale], commit: evidenceCommit });
      await until(page, () => /655/.test(document.querySelector('aithema-session').shadowRoot.querySelector('.host-credits__text').textContent));
      await page.mouse.move(0, 0); await settle();
    }
    async function revealEvidence(width, theme, copy) {
      const label = `${width}-${theme}-${locale}`, selector = 'aithema-session >>> .band-orb .orb';
      const baseline = await shadow(page, c => [...c.shadowRoot.querySelectorAll('.band [data-reveal]')].map(node => {
        const r = node.getBoundingClientRect(), style = getComputedStyle(node);
        return { box: [r.x, r.y, r.width, r.height], opacity: style.opacity,
          eligible: style.visibility !== 'hidden' && Number(style.opacity) !== 0 && node.getClientRects().length > 0 };
      }));
      const orb = await shadow(page, c => { const r = c.shadowRoot.querySelector('.band-orb .orb').getBoundingClientRect(); return [r.width, r.height]; });
      assert.deepEqual(orb, [44, 44], `${label}: real band orb hit target`);
      assert.deepEqual((await boxes(page, ['.band-orb .orb__body']))[0].slice(2), [40, 40], `${label}: 40px visual`);
      await page.hover(selector); await new Promise(resolve => setTimeout(resolve, 120));
      await page.mouse.move(0, 300); await new Promise(resolve => setTimeout(resolve, 260));
      assert.equal(await shadow(page, c => c.shadowRoot.querySelector('.band').dataset.aithemaRevealState), 'closed', `${label}: quick pass`);
      await page.hover(selector);
      await until(page, () => document.querySelector('aithema-session').shadowRoot.querySelector('.band').dataset.aithemaRevealState === 'open');
      // Finish entry on its real clock. Pausing a completed CSS transition keeps its reversal
      // bookkeeping alive in Chrome and can distort the later exit being measured here.
      await new Promise(resolve => setTimeout(resolve, 2200));
      await shot('reveal-open', width, theme, true);
      const links = await shadow(page, c => [...c.shadowRoot.querySelectorAll('.band .aithema-reveal__link')].map(n => ({ href: n.href, title: n.title,
        right: n.getBoundingClientRect().right, bottom: n.getBoundingClientRect().bottom, opacity: getComputedStyle(n).opacity })));
      assert.deepEqual(links.map(n => n.href), copy.reveal.links.map(link => new URL(link.href).href));
      assert.deepEqual(links.map(n => n.title), copy.reveal.links.map(link => link.subtitle));
      const band = (await boxes(page, ['.band']))[0];
      assert.ok(links.every(n => n.opacity === '1' && n.right <= width + .5 && n.bottom <= band[1] + band[3]), `${label}: reveal links fit the real band`);
      assert.equal(await shadow(page, c => c.shadowRoot.querySelector('.aithema-reveal__version code').textContent), evidenceCommit);
      assert.match(await shadow(page, c => c.shadowRoot.querySelector('.aithema-reveal__version').title), /2026-10-12/);
      assert.equal(await shadow(page, c => c.shadowRoot.querySelector('.aithema-reveal__row').getAttribute('aria-label')), copy.reveal.label);
      const controls = await shadow(page, (c, baseline) => [...c.shadowRoot.querySelectorAll('.band [data-reveal]')].map((n, i) => ({
        name: n.className, inert: n.inert, proxy: Boolean(n.closest('.aithema-reveal__dissolves')), marked: n.hasAttribute('data-aithema-reveal-control'),
        eligible: baseline[i].eligible,
      })), baseline);
      const phase = await shadow(page, c => c.shadowRoot.querySelector('.band').dataset.aithemaRevealState);
      assert.ok(phase === 'open' && controls.every(n => n.eligible ? n.inert && n.marked : !n.marked), `${label}: only visible controls dissolve (${phase}): ${JSON.stringify(controls)}`);
      // Hold only this synchronous exit's cleanup. Its genuine CSS timelines can then be sampled
      // at exact times without screenshot latency advancing them between requested frames.
      await shadow(page, c => {
        const native = window.setTimeout;
        window.setTimeout = fn => { globalThis.displayRevealCleanup = fn; return 0; };
        try { c.shadowRoot.querySelector('.band').dispatchEvent(new MouseEvent('mouseleave')); }
        finally { window.setTimeout = native; }
      });
      await freezeReveal(page);
      const samples = [], point = { x: 2, y: Math.floor(band[1] + band[3] - 10), width: 1, height: 1 };
      for (let ms = 0; ms <= 900; ms += 50) {
        await seekReveal(page, ms);
        const opacities = await shadow(page, c => ({
          glass: Number(getComputedStyle(c.shadowRoot.querySelector('.aithema-reveal__glass')).opacity),
          brand: Number(getComputedStyle(c.shadowRoot.querySelector('.aithema-reveal__row')).opacity),
          controls: [...c.shadowRoot.querySelectorAll('[data-aithema-reveal-control]')].map(n => {
            const style = getComputedStyle(n); return { name: n.className, opacity: Number(style.opacity), visible: style.visibility !== 'hidden' && n.getClientRects().length > 0 };
          }),
          proxies: [...c.shadowRoot.querySelectorAll('.aithema-reveal__proxy')].map(n => Number(getComputedStyle(n).opacity)),
        }));
        if (opacities.brand > .25) assert.ok([...opacities.controls.filter(n => n.visible).map(n => n.opacity), ...opacities.proxies].every(value => value <= .25), `${label}: brand and visible controls do not overlap: ${JSON.stringify({ ms, ...opacities })}`);
        samples.push({ ms, rgb: pixelRgb(Buffer.from(await page.screenshot({ clip: point }))), ...opacities });
        if ([0, 150, 300, 450, 700].includes(ms)) await shot(`reveal-exit-${ms}ms`, width, theme, true);
      }
      for (let channel = 0; channel < 3; channel++) {
        const values = samples.map(sample => sample.rgb[channel]), direction = Math.sign(values.at(-1) - values[0]);
        if (direction === 0) assert.ok(Math.max(...values) - Math.min(...values) <= 2, `${label}: exit colour channel ${channel}`);
        else for (let i = 1; i < values.length; i++) assert.ok((values[i] - values[i - 1]) * direction >= -2, `${label}: monotonic exit colour channel ${channel}`);
      }
      await seekReveal(page, 1600); await page.evaluate(() => { globalThis.displayRevealCleanup(); delete globalThis.displayRevealCleanup; });
      const restored = await shadow(page, c => [...c.shadowRoot.querySelectorAll('.band [data-reveal]')].map(n => {
        const r = n.getBoundingClientRect(); return { box: [r.x, r.y, r.width, r.height], opacity: getComputedStyle(n).opacity, inert: n.inert };
      }));
      sameBoxes(baseline.map(n => n.box), restored.map(n => n.box), `${label}: reveal restores the band`);
      assert.deepEqual(restored.map(n => n.opacity), baseline.map(n => n.opacity));
      assert.ok(restored.every(n => !n.inert));
      await page.mouse.move(0, 300); await shot('reveal-restored', width, theme);
      // Use the actual edge toggle for both modules, including an open reveal.
      await page.click('aithema-session >>> .motion-toggle');
      await shadow(page, c => c.shadowRoot.querySelector('.band-orb .orb').focus());
      await new Promise(resolve => setTimeout(resolve, 250));
      const calm = await shadow(page, c => ({ motion: c.getAttribute('motion'), orb: c.shadowRoot.querySelector('.band-orb .orb').dataset.orbMotion,
        reveal: c.shadowRoot.querySelector('.band').dataset.aithemaRevealMotion,
        duration: getComputedStyle(c.shadowRoot.querySelector('.aithema-reveal__glass')).transitionDuration,
        sparks: Boolean(c.shadowRoot.querySelector('.aithema-reveal__stars')),
        animations: c.shadowRoot.querySelector('.band').getAnimations({ subtree: true }).filter(a => a.playState === 'running').length }));
      assert.deepEqual(calm, { motion: 'off', orb: 'off', reveal: 'off', duration: '0.2s', sparks: false, animations: 0 });
      await shot('reveal-motion-off-open', width, theme, true);
      await page.keyboard.press('Escape'); await new Promise(resolve => setTimeout(resolve, 250));
      assert.equal(await shadow(page, c => c.shadowRoot.querySelector('.band').dataset.aithemaRevealState), 'closed');
      await page.click('aithema-session >>> .motion-toggle');
      reveals.push({ width, theme, locale, links, point, clock: 'paused CSS timelines; exact 50ms rendered-pixel samples', samples });
    }
    async function menuEvidence(width, theme) {
      const selectors = ['.band-orb', '.conversations-toggle', '.settings-open'], before = await boxes(page, selectors);
      await page.click('aithema-session >>> .conversations-toggle');
      await until(page, () => document.querySelector('aithema-session').shadowRoot.querySelectorAll('.conversations-recent button').length === 3);
      const menu = await shadow(page, c => {
        const n = c.shadowRoot.querySelector('.conversations-menu'), b = n.getBoundingClientRect();
        return { left: b.left, right: b.right, top: b.top, bottom: b.bottom,
          painted: [[b.left + 8, b.top + 8], [b.right - 8, b.top + 8], [b.left + 8, b.bottom - 8], [b.right - 8, b.bottom - 8]]
            .every(([x, y]) => n.contains(c.shadowRoot.elementFromPoint(x, y))) };
      });
      assert.ok(menu.left >= 0 && menu.right <= width + .5 && menu.top >= 0 && menu.bottom <= (width === 390 ? 844 : 900), `${width}-${theme}-${locale}: conversations menu fits ${JSON.stringify(menu)}`);
      assert.equal(menu.painted, true, `${width}-${theme}-${locale}: every menu corner is visible ${JSON.stringify(menu)}`);
      sameBoxes(before, await boxes(page, selectors), 'opening the menu keeps the band fixed');
      await shot('conversations-menu-open', width, theme); await page.keyboard.press('Escape');
      assert.equal(await shadow(page, c => c.shadowRoot.querySelector('.conversations-menu').hidden), true);
    }
    await t.test('B1/B2: all band menus share centred chevrons, icon sizes and gaps at every width', async () => {
      for (locale of ['de', 'en']) for (const theme of ['light', 'dark']) for (const width of [320, 321, 390, 400, 600, 680, 768, 900, 1000, 1024, 1440]) {
        await page.setViewport({ width, height: 900 }); await page.select('#theme', theme); await scene('conversation');
        const menus = await page.evaluate(() => {
          const root = document.querySelector('aithema-session').shadowRoot;
          const button = root.querySelector('.conversations-toggle');
          const rect = n => { const b = n.getBoundingClientRect(); return { left: b.left, right: b.right, cy: b.top + b.height / 2, width: b.width, height: b.height }; };
          return [{ host: button, glyph: button.firstElementChild, label: button.querySelector('span'), chevron: button.lastElementChild },
            ...[...document.querySelectorAll('.utility')].map(host => ({ host, glyph: host.querySelector('.utility-icon svg'), label: host.querySelector('.utility-value'), chevron: host.querySelector('.utility-chevron svg') }))]
            .map(({ host, glyph, label, chevron }) => ({ glyph: rect(glyph), label: rect(label), chevron: chevron ? rect(chevron) : null,
              path: chevron?.querySelector('path')?.getAttribute('d'), gap: getComputedStyle(host).gap, bounds: rect(host) }));
        });
        assert.ok(menus.every(n => n.bounds.left >= 0 && n.bounds.right <= width + .5), `${width}/${theme}/${locale}: menus fit`);
        assert.ok(menus.every(n => n.chevron), 'language and appearance use the shared SVG chevron');
        for (const menu of menus.slice(width < 400 ? 1 : 0)) {
          assert.equal(menu.chevron.width, 10); assert.equal(menu.chevron.height, 10);
          assert.ok(Math.abs(menu.chevron.cy - menu.label.cy) <= .5, 'chevron is centred on its label');
          assert.equal(menu.path, menus[1].path); assert.equal(menu.gap, menus[1].gap);
          assert.equal(menu.glyph.width, 16); assert.equal(menu.glyph.height, 16);
        }
        assert.equal(menus[0].glyph.width, 16, 'the conversations icon is visible even at 320');
      }
    });
    await t.test('B3/B4/B8: footer zones stay 24px apart, digits start after 6px, and only the credit number is bold', async () => {
      for (locale of ['de', 'en']) for (const theme of ['light', 'dark']) for (const width of [1440, 1000, 900, 768, 680, 600, 390, 320]) {
        await page.setViewport({ width, height: 900 }); await page.select('#theme', theme); await scene('conversation');
        await until(page, () => document.querySelector('aithema-session').shadowRoot.querySelector('.status').hasAttribute('data-connected'));
        const footer = await shadow(page, c => {
          const root = c.shadowRoot, rect = s => { const b = root.querySelector(s).getBoundingClientRect(); return { left: b.left, right: b.right, top: b.top }; };
          const visible = s => getComputedStyle(root.querySelector(s)).display !== 'none';
          const weight = s => Number(getComputedStyle(root.querySelector(s)).fontWeight);
          const timer = root.querySelector('.connection-timer'), style = getComputedStyle(timer);
          const digits = document.createRange(); digits.selectNodeContents(timer);
          return { zones: ['.ai-notice', '.host-credits', '.footer-right'].map(rect), flag: rect('.engine__flag'), label: rect('.status__label'),
            digits: digits.getBoundingClientRect().left, timer: rect('.connection-timer'), align: style.textAlign, numeric: style.fontVariantNumeric,
            amount: weight('.host-credits__amount'), total: weight('.host-credits__total'), unit: weight('.host-credits__unit'),
            voice: visible('.ai-notice__voice'), short: visible('.ai-notice__short'), connected: visible('.status__label') };
        });
        const context = `${width}/${theme}/${locale}: ${JSON.stringify(footer)}`;
        assert.ok(footer.zones[1].left - footer.zones[0].right >= 23.5 && footer.zones[2].left - footer.zones[1].right >= 23.5, context);
        assert.ok(footer.zones.every(n => n.left >= 0 && n.right <= width + .5 && Math.abs(n.top - footer.zones[0].top) <= .5), context);
        if (footer.connected) { assert.ok(Math.abs(footer.digits - footer.label.right - 6) <= .5, context); assert.ok(Math.abs(footer.label.left - footer.flag.right - 12) <= .5, context); }
        assert.equal(footer.align, 'start'); assert.equal(footer.numeric, 'tabular-nums');
        assert.ok(footer.amount >= 600); assert.equal(footer.total, 400); assert.equal(footer.unit, 400);
        assert.equal(footer.voice, width >= 1000); assert.equal(footer.short, width < 680);
        const before = await boxes(page, ['.connection-timer', '.engine-info', '.ai-notice', '.host-credits']);
        await shadow(page, c => { c.shadowRoot.querySelector('.connection-timer').textContent = '1:00:00'; });
        sameBoxes(before, await boxes(page, ['.connection-timer', '.engine-info', '.ai-notice', '.host-credits']), 'reserve after digits prevents jitter');
        await shot('footer-amended', width, theme);
      }
    });
    await t.test('B5: 320 flag hover has no slide-in label; 390 retains it without moving the credits', async () => {
      for (locale of ['de', 'en']) for (const theme of ['light', 'dark']) for (const width of [320, 390]) {
        await page.setViewport({ width, height: 900 }); await page.select('#theme', theme); await scene('conversation');
        const before = await boxes(page, ['.engine-info', '.host-credits__amount', '.connection-timer']);
        await page.hover('aithema-session >>> .engine-info'); await settle();
        const label = await shadow(page, c => { const n = c.shadowRoot.querySelector('.engine__value'), style = getComputedStyle(n);
          return { displayed: style.display !== 'none', popup: getComputedStyle(c.shadowRoot.querySelector('.engine__detail')).visibility }; });
        assert.equal(label.displayed, width >= 360); assert.equal(label.popup, 'visible');
        sameBoxes(before, await boxes(page, ['.engine-info', '.host-credits__amount', '.connection-timer']), 'flag hover');
        await shot('flag-hover-amended', width, theme);
      }
    });
    await t.test('B6: the hidden stop slot never gets a reveal proxy or stagger', async () => {
      locale = 'de'; await page.setViewport({ width: 1440, height: 900 }); await scene('conversation');
      const before = await shadow(page, c => c.shadowRoot.querySelector('.audio-rail .voice-pause').outerHTML);
      await shadow(page, c => c.shadowRoot.querySelector('.band-orb .orb').click());
      assert.equal(await shadow(page, c => Boolean(c.shadowRoot.querySelector('.aithema-reveal__proxy.voice-pause'))), false);
      assert.equal(await shadow(page, c => c.shadowRoot.querySelector('.audio-rail .voice-pause').outerHTML), before, 'hidden control is untouched');
      await scene('conversation');
    });
    await t.test('B7: status flanks hide together below 24px without removing the waveform box', async () => {
      for (locale of ['de', 'en']) for (const width of [320, 390, 1440]) {
        await page.setViewport({ width, height: 900 }); await page.select('#theme', 'light'); await scene('ready');
        const wave = await shadow(page, c => { const n = c.shadowRoot.querySelector('.voice-wave'), style = getComputedStyle(n), rect = n.getBoundingClientRect();
          return { width: rect.width, height: rect.height, flank: rect.width / 2 - parseFloat(style.getPropertyValue('--voice-label-half')) - 8, visibility: style.visibility }; });
        assert.ok(wave.width > 0 && wave.height === 30, 'visibility keeps the reserved box');
        assert.equal(wave.visibility, wave.width >= 184 && wave.flank >= 24 ? 'visible' : 'hidden', JSON.stringify({ width, locale, ...wave }));
        await shot('band-amended', width, 'light');
      }
    });
    await t.test('r2 menu: icon-only below 400px, whole localized labels from 400px, no ellipsis', async () => {
      for (locale of ['de', 'en']) for (const width of [390, 400, 1440]) {
        await page.setViewport({ width, height: 900 }); await page.select('#theme', 'light'); await scene('ready');
        const menu = await shadow(page, c => {
          const n = c.shadowRoot.querySelector('.conversations-toggle'), label = n.querySelector('span'), style = getComputedStyle(label);
          const rect = n.getBoundingClientRect(), labelRect = label.getBoundingClientRect();
          const range = document.createRange(); range.selectNodeContents(label);
          return { name: n.getAttribute('aria-label'), title: n.title, label: label.textContent, visible: style.display !== 'none',
            overflow: style.textOverflow, icon: n.firstElementChild.getBoundingClientRect().width,
            fits: range.getBoundingClientRect().width <= labelRect.width + .5 && labelRect.right <= rect.right + .5 };
        });
        const name = locale === 'de' ? 'Gespräche' : 'Conversations';
        assert.equal(menu.name, name); assert.equal(menu.title, name); assert.equal(menu.label, name); assert.equal(menu.icon, 16);
        assert.equal(menu.visible, width >= 400); assert.notEqual(menu.overflow, 'ellipsis');
        if (menu.visible) assert.equal(menu.fits, true, `${width}/${locale}: ${JSON.stringify(menu)}`);
        await shot('r2-band', width, 'light');
      }
    });
    await t.test('r2 status: measured hole has no flank pixels beneath the longest consent label and never shifts controls', async () => {
      for (locale of ['de', 'en']) for (const theme of ['light', 'dark']) for (const width of [1440, 1024, 390]) {
        await page.setViewport({ width, height: 900 }); await page.select('#theme', theme); await scene('ready');
        const selectors = ['.band', '.band-orb', '.audio-rail', '.voice-cell--output', '.voice-cell--mic', '.settings-open'];
        const before = await boxes(page, selectors), mic = (await boxes(page, ['.voice-cell--mic']))[0];
        await page.mouse.move(mic[0] + 22, mic[1] + 22);
        await shadow(page, c => c.receive({ seq: c.session.seq + 1, type: 'consent.revised', data: { granted: false } }));
        await until(page, expected => document.querySelector('aithema-session').shadowRoot.querySelector('.voice-state').textContent === expected, { de, en }[locale].consentRequired);
        await settle();
        const label = await shadow(page, c => {
          const n = c.shadowRoot.querySelector('.voice-state'), wave = c.shadowRoot.querySelector('.voice-wave'), b = n.getBoundingClientRect(), w = wave.getBoundingClientRect(), style = getComputedStyle(n);
          return { x: b.x, y: b.y, width: b.width, height: b.height, waveX: w.x, waveWidth: w.width,
            half: parseFloat(getComputedStyle(wave).getPropertyValue('--voice-label-half')),
            lines: (b.height - parseFloat(style.paddingTop) - parseFloat(style.paddingBottom)) / parseFloat(style.lineHeight),
            overflow: style.textOverflow, scrollHeight: n.scrollHeight, clientHeight: n.clientHeight,
            visibility: getComputedStyle(wave).visibility };
        });
        assert.ok(Math.abs(label.half - label.width / 2) <= .5, `${width}/${theme}/${locale}: measured hole ${JSON.stringify(label)}`);
        assert.ok(Math.abs(label.x + label.width / 2 - label.waveX - label.waveWidth / 2) <= .5, 'the hole is centred under the label');
        assert.ok(label.lines <= 2.05, `${width}/${theme}/${locale}: at most two lines ${JSON.stringify(label)}`);
        if (width >= 600) assert.ok(label.width <= label.waveWidth / 2 + .5, 'the wide status label uses at most half the wave');
        assert.notEqual(label.overflow, 'ellipsis'); assert.ok(label.scrollHeight <= label.clientHeight + 1, 'the full consent text stays readable');
        sameBoxes(before, await boxes(page, selectors), 'status and observer preserve every control under the pointer');
        await shot('r2-consent-status', width, theme, true);
        // Hide only the glyphs, retaining the measured label box and mask. This isolates flank
        // paint from text antialiasing when Chrome composites the masked canvas underneath it.
        const clip = { x: Math.ceil(label.x), y: Math.ceil(label.y), width: Math.floor(label.x + label.width) - Math.ceil(label.x), height: Math.floor(label.y + label.height) - Math.ceil(label.y) };
        await shadow(page, c => { c.shadowRoot.querySelector('.voice-state').style.visibility = 'hidden'; });
        const painted = Buffer.from(await page.screenshot({ clip }));
        await shadow(page, c => { c.shadowRoot.querySelector('.voice-wave').style.visibility = 'hidden'; });
        const clear = Buffer.from(await page.screenshot({ clip }));
        await shadow(page, c => {
          c.shadowRoot.querySelector('.voice-wave').style.removeProperty('visibility');
          c.shadowRoot.querySelector('.voice-state').style.removeProperty('visibility');
        });
        if (evidence) {
          for (const [suffix, bytes] of [['painted', painted], ['wave-hidden', clear]]) {
            const name = `r2-consent-pixels-${width}-${theme}-${locale}-${suffix}.png`; await writeFile(join(evidence, name), bytes); files.push(name);
          }
          await writeFile(join(evidence, `r2-consent-geometry-${width}-${theme}-${locale}.json`), JSON.stringify(label, null, 2));
        }
        assert.ok(painted.equals(clear), `${width}/${theme}/${locale}: no flank pixel under the label box`);
      }
    });
    for (locale of ['de', 'en']) for (const theme of ['light', 'dark']) for (const width of [390, 1024, 1440]) {
      await page.setViewport({ width, height: width === 390 ? 844 : 900 });
      await page.select('#theme', theme);
      const copy = { de, en }[locale], label = `${width}-${theme}-${locale}`;
      await scene('entrance');
      assert.equal(await shadow(page, c => c.shadowRoot.querySelector('.workspace').dataset.stage), 'entrance');
      assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true, `${label}: no horizontal overflow`);
      const header = await boxes(page, ['.band-orb', '.conversations-toggle', '.settings-open']);
      assert.ok(Math.abs(header[0][1] + header[0][3] / 2 - header[1][1] - header[1][3] / 2) < .5, `${label}: band orb and menu share the first row`);
      assert.equal(header[1][3], 44); assert.equal(header[2][2], 44); assert.equal(header[2][3], 44);
      const edge = await boxes(page, ['.motion-toggle', '.fold', '.band']);
      assert.equal(edge[0][2], 44); assert.equal(edge[1][2], 44);
      assert.ok(Math.abs(edge[0][0] + 22 - 28) <= .5 && Math.abs(edge[1][0] + 22 - 28) <= .5, `${label}: edge controls share the 14 px column`);
      assert.ok(Math.abs(edge[0][1] + 22 - (edge[2][1] + edge[2][3] / 2 - 3)) <= .5, `${label}: motion control follows the approved band centre`);
      for (const selector of ['#locale', '#theme']) {
        const target = await page.$eval(selector, n => ({ width: n.getBoundingClientRect().width, height: n.getBoundingClientRect().height, title: n.title }));
        assert.ok(target.width >= 44 && target.height >= 44 && target.title, `${label}: ${selector} target and tooltip`);
      }
      if (locale === 'de' && theme === 'light' && width === 390) {
        await page.evaluate(() => localStorage.removeItem('aithema-motion'));
        await page.emulateMediaFeatures([{ name: 'prefers-reduced-motion', value: 'reduce' }]); await scene('entrance');
        assert.equal(await shadow(page, c => c.getAttribute('motion')), 'off', 'system default follows reduced motion');
        await page.emulateMediaFeatures([{ name: 'prefers-reduced-motion', value: 'no-preference' }]);
        await until(page, () => document.querySelector('aithema-session').getAttribute('motion') === 'on');
        assert.equal(await shadow(page, c => c.getAttribute('motion')), 'on');
        await page.click('aithema-session >>> .motion-toggle');
        assert.equal(await page.evaluate(() => localStorage.getItem('aithema-motion')), 'off');
        await page.reload({ waitUntil: 'domcontentloaded' }); await until(page, () => document.querySelector('aithema-session')?.session?.id);
        assert.equal(await shadow(page, c => c.getAttribute('motion')), 'off', 'a stored choice survives a reload');
        // Seed the same deterministic fixture after the reload; it never acquires a microphone.
        await page.evaluate(async () => {
          const { voiceEvents } = await import('/packages/core/src/live-voice.js'), { manifest } = await import('/plugins/elevenlabs/src/manifest.js');
          globalThis.displaySeed = document.querySelector('aithema-session').session;
          globalThis.displayClient = { manifest, async start({ callId }) {
            const events = voiceEvents(); globalThis.displayVoiceEvents = events; globalThis.displayCallId = callId;
            return { callId, providerSessionId: 'local-evidence', events, async setInput() {}, async setOutput() {}, async updateContext() {}, async sendText() {},
              audioLevels: () => ({ input: .3, output: .65 }), async close() { events.end(); return { closureConfirmed: true }; } };
          } };
        });
        await page.click('aithema-session >>> .motion-toggle'); await scene('entrance');
      }
      await shot('entrance', width, theme);
      await scene('ready'); assert.equal(await shadow(page, c => c.shadowRoot.querySelector('.workspace').dataset.stage), 'ready');
      await shot('readiness', width, theme);
      await scene('conversation');
      await revealEvidence(width, theme, copy);
      const bad = await shadow(page, c => ({ sessionRow: Boolean(c.shadowRoot.querySelector('.toolbar .preset-panel')),
        tags: c.shadowRoot.querySelectorAll('.engine-tag').length, text: c.shadowRoot.querySelector('.workspace').textContent }));
      assert.equal(bad.sessionRow, false); assert.equal(bad.tags, 0);
      assert.doesNotMatch(bad.text, /~anthropic\/|anthropic\/claude|openrouter\/|Kosten unbekannt|Cost unavailable/u);
      assert.equal(await shadow(page, c => c.shadowRoot.querySelector('.host-credits__text').textContent), locale === 'de' ? '655 von 1.000 Credits' : '655 of 1,000 Credits');
      assert.equal(await shadow(page, c => c.shadowRoot.querySelector('.host-credits__track i').style.width), '65.5%');
      const pane = await shadow(page, c => { const p = c.shadowRoot.querySelector('.analysis-content'); p.scrollTop = 0;
        return { overflow: p.scrollHeight > p.clientHeight, titleMask: getComputedStyle(c.shadowRoot.querySelector('.understanding > .head')).maskImage }; });
      assert.equal(pane.overflow, true, `${label}: overflowing understanding`); assert.equal(pane.titleMask, 'none');
      await settle();
      assert.equal(await shadow(page, c => c.shadowRoot.querySelector('.analysis-content').hasAttribute('data-bottom')), true);
      await shot('conversation-unscrolled', width, theme);
      await shadow(page, c => { const p = c.shadowRoot.querySelector('.analysis-content'), heading = c.shadowRoot.querySelector('.missing').previousElementSibling;
        p.scrollTop += heading.getBoundingClientRect().top - p.getBoundingClientRect().top - 28; });
      await settle();
      assert.equal(await shadow(page, c => c.shadowRoot.querySelector('.analysis-content').hasAttribute('data-top')), true);
      const heading = await shadow(page, c => { const p = c.shadowRoot.querySelector('.analysis-content').getBoundingClientRect(), h = c.shadowRoot.querySelector('.missing').previousElementSibling.getBoundingClientRect();
        return { top: h.top - p.top, bottom: h.bottom - p.top, height: p.height }; });
      assert.ok(heading.top >= 24 && heading.bottom < heading.height - 40, `${label}: open-items heading stays clear of the fades: ${JSON.stringify(heading)}`);
      await shot('conversation-scrolled', width, theme);
      const stable = ['.turn.user', '.withdraw', '.composer', '.display-foot'], before = await boxes(page, stable);
      await page.hover('aithema-session >>> .turn.user'); sameBoxes(before, await boxes(page, stable), `${label}: withdraw hover`);
      await shadow(page, c => c.shadowRoot.querySelector('.withdraw').focus()); sameBoxes(before, await boxes(page, stable), `${label}: withdraw focus`);
      assert.equal((await boxes(page, ['.withdraw']))[0][2], 44);
      await page.mouse.move(0, 0); await page.evaluate(() => window.scrollTo(0, 0));
      const foldBefore = await boxes(page, ['.fold', '.motion-toggle', '.band']);
      const scrollBefore = await shadow(page, c => [...c.shadowRoot.querySelectorAll('.transcript-shell,.analysis-content')].map(p => p.scrollTop));
      await shadow(page, c => c.shadowRoot.querySelector('.fold').click()); await settle();
      sameBoxes(foldBefore, await boxes(page, ['.fold', '.motion-toggle', '.band']), `${label}: fold control stays fixed`);
      assert.equal(await shadow(page, c => c.shadowRoot.querySelector('.conversation').hidden && c.shadowRoot.querySelector('.understanding').hidden), true);
      assert.equal(await shadow(page, c => c.shadowRoot.querySelector('.fold-question').hidden), false);
      const canvas = (await boxes(page, ['.drafts-canvas']))[0];
      assert.ok(canvas[2] >= width - 2 * Math.max(20, width * .04) - 2, `${label}: full-width canvas`);
      await shot('folded-strip-canvas', width, theme);
      await shadow(page, c => c.shadowRoot.querySelector('.fold-strip').click()); await settle();
      assert.deepEqual(await shadow(page, c => [...c.shadowRoot.querySelectorAll('.transcript-shell,.analysis-content')].map(p => p.scrollTop)), scrollBefore, `${label}: restore pane scroll`);
      const footerStable = ['.display-foot', '.engine-info', '.connection-timer'], footerBefore = await boxes(page, footerStable);
      const timerText = await shadow(page, c => { const timer = c.shadowRoot.querySelector('.connection-timer'), text = timer.textContent; timer.textContent = '1:00:00'; return text; });
      sameBoxes(footerBefore, await boxes(page, footerStable), `${label}: timer hour boundary keeps its width`);
      await shadow(page, (c, text) => { c.shadowRoot.querySelector('.connection-timer').textContent = text; }, timerText);
      for (const [selector, name] of [['.engine-info', 'flag-hover-open'], ['.ai-notice', 'footer-popup-open'], ['.host-credits', 'credits-popup-open']]) {
        await page.hover(`aithema-session >>> ${selector}`); await settle();
        sameBoxes(footerBefore, await boxes(page, footerStable), `${label}: ${name}`);
        const popup = await shadow(page, (c, selector) => {
          const p = c.shadowRoot.querySelector(selector).closest('[data-footer-popup]').querySelector('.footer-popup'), b = p.getBoundingClientRect();
          return { visible: getComputedStyle(p).visibility, left: b.left, right: b.right, top: b.top, bottom: b.bottom, clipped: p.scrollHeight > p.clientHeight + 1, painted: [b.top + 4, b.bottom - 4].every(y => p.contains(c.shadowRoot.elementFromPoint(b.left + b.width / 2, y))) };
        }, selector);
        assert.equal(popup.visible, 'visible'); assert.equal(popup.clipped, false, `${label}: every popup line is readable`); assert.equal(popup.painted, true, `${label}: popup is painted through its whole height`);
        assert.ok(popup.left >= 0 && popup.right <= width + .5 && popup.top >= 0 && popup.bottom <= (width === 390 ? 844 : 900), `${label}: unclipped popup ${JSON.stringify(popup)}`);
        await shot(name, width, theme); await page.mouse.move(0, 0);
      }
      await menuEvidence(width, theme);
      await scene('conversation', 'off');

      assert.equal(await shadow(page, c => c.shadowRoot.querySelector('.concept-activity-text').textContent), copy.display.draftsOff);
      assert.equal(await shadow(page, c => c.shadowRoot.querySelector('.concept-request').hidden), true); await shot('drafts-off', width, theme);
      await scene('conversation', 'on');
      assert.equal(await shadow(page, c => c.shadowRoot.querySelector('.concept-request').textContent), copy.display.draftsOn.replace('{credits}', '40'));
      assert.equal(await shadow(page, c => c.shadowRoot.querySelector('.concept-request').disabled), false); await shot('drafts-on', width, theme);
      await scene('conversation', 'low');
      assert.equal(await shadow(page, c => c.shadowRoot.querySelector('.concept-activity-text').textContent), copy.display.draftsLow);
      assert.equal(await shadow(page, c => c.shadowRoot.querySelector('.concept-request').hidden), true); await shot('drafts-low', width, theme);
      await scene('conversation');
      await shadow(page, c => c.shadowRoot.querySelector('.voice-start').click());
      await until(page, () => document.querySelector('aithema-session').shadowRoot.querySelector('.audio-rail').dataset.call === 'active');
      const status = await shadow(page, c => { const n = c.shadowRoot.querySelector('.voice-state'), style = getComputedStyle(n);
        return { text: n.textContent, background: style.backgroundColor, image: style.backgroundImage, shadow: style.boxShadow, border: style.borderWidth }; });
      assert.deepEqual(status, { text: copy.voiceStates.listening, background: 'rgba(0, 0, 0, 0)', image: 'none', shadow: 'none', border: '0px' }, `${label}: voice status sits directly on the band`);
      await shot('band-voice-listening', width, theme);
      await page.evaluate(() => globalThis.displayVoiceEvents.push({ type: 'speaking', callId: globalThis.displayCallId }));
      await new Promise(resolve => setTimeout(resolve, 700));
      const wave = await shadow(page, c => { const canvas = c.shadowRoot.querySelector('.voice-wave'), box = canvas.getBoundingClientRect(), ratio = Math.min(2,devicePixelRatio);
        return { width: canvas.width / ratio, cssWidth: box.width, stroke: canvas.getContext('2d').lineWidth / ratio }; });
      assert.ok(Math.abs(wave.width - wave.cssWidth) <= .5, `${label}: waveform backing store follows its width`);
      assert.ok(Math.abs(wave.stroke - 1.6) <= 1e-6, `${label}: 1.6 px waveform bars`);
      await shot('voice-rail-live', width, theme);
      await shadow(page, c => c.shadowRoot.querySelector('.voice-close').click());
      await until(page, () => document.querySelector('aithema-session').shadowRoot.querySelector('.audio-rail').dataset.state === 'idle');
    }
    for (locale of ['de', 'en']) for (const theme of ['light', 'dark']) for (const width of [320, 600, 680, 768, 900, 1000]) {
      await page.setViewport({ width, height: 900 }); await page.select('#theme', theme); await scene('conversation');
      const row = await shadow(page, c => {
        const r = c.shadowRoot, items = ['.ai-notice', '.host-credits', '.footer-right'].map(s => {
          const b = r.querySelector(s).getBoundingClientRect(); return { left: b.left, right: b.right, top: b.top, bottom: b.bottom };
        });
        const visible = s => getComputedStyle(r.querySelector(s)).display !== 'none';
        return { items, short: visible('.ai-notice__short'), version: visible('.display-version'), unit: visible('.host-credits__unit') };
      });
      assert.ok(row.items.every(b => b.left >= 0 && b.right <= width + .5), `${width}-${theme}-${locale}: footer fits`);
      assert.ok(row.items.every(b => Math.abs(b.top - row.items[0].top) <= .5), 'one footer line');
      assert.ok(row.items[0].right <= row.items[1].left + .5 && row.items[1].right <= row.items[2].left + .5, 'footer zones never overlap');
      assert.equal(row.short, width < 680); assert.equal(row.version, width >= 680); assert.equal(row.unit, width >= 360);
      await shot('footer-narrow', width, theme);
      for (const [selector, name] of [['.engine-info', 'flag-hover-open'], ['.ai-notice', 'footer-popup-open'], ['.host-credits', 'credits-popup-open']]) {
        await page.hover(`aithema-session >>> ${selector}`); await settle();
        const popup = await shadow(page, (c, selector) => { const p = c.shadowRoot.querySelector(selector).closest('[data-footer-popup]').querySelector('.footer-popup'), b = p.getBoundingClientRect(); return [b.left,b.right,b.top,b.bottom]; }, selector);
        assert.ok(popup[0] >= 0 && popup[1] <= width + .5 && popup[2] >= 0 && popup[3] <= 900, 'narrow popup fits');
        await shot(name, width, theme); await page.mouse.move(0, 0);
      }
      await menuEvidence(width, theme);
    }
    locale = 'de'; await page.setViewport({ width: 1440, height: 900 }); await page.select('#theme', 'light'); await scene('conversation');
    const footer = await boxes(page, ['.display-foot', '.engine-info', '.composer']);
    await page.hover('aithema-session >>> .engine-info'); sameBoxes(footer, await boxes(page, ['.display-foot', '.engine-info', '.composer']), 'footer model hover');
    assert.equal(await shadow(page, c => getComputedStyle(c.shadowRoot.querySelector('.engine__detail')).visibility), 'visible');
    assert.equal(await shadow(page, c => c.shadowRoot.querySelector('.engine__detail').textContent), 'Beste Modelle, international\nAntworten: Claude Haiku 5.5\nEinschätzung: Claude Opus 5.5\nüber OpenRouter · Stimme: ElevenLabs');
    await shot('footer-model-hover-open', 1440, 'light');
    await page.mouse.move(0, 0); await page.click('aithema-session >>> .conversations-toggle');
    await until(page, () => document.querySelector('aithema-session').shadowRoot.querySelectorAll('.conversations-recent button').length === 3);
    assert.deepEqual(await shadow(page, c => [...c.shadowRoot.querySelectorAll('.conversations-menu [role="menuitem"]')].map(n => n.textContent)),
      ['Neues Gespräch', 'Website für Stickpolsterjetzt', 'Buchhaltung automatisieren11. Okt.', 'Termine per Telefon10. Okt.', 'Alle Gespräche verwalten']);
    await shot('conversations-menu-open', 1440, 'light');
    await page.keyboard.press('Escape'); assert.equal(await shadow(page, c => c.shadowRoot.querySelector('.conversations-menu').hidden), true);
    assert.equal(await shadow(page, c => c.shadowRoot.activeElement.className), 'conversations-toggle');
    assert.deepEqual(errors, []);
    if (evidence) {
      await writeFile(join(evidence, 'display-evidence.json'), JSON.stringify({ ticket: 'AIT-131', commit: evidenceCommit, createdAt: new Date().toISOString(), files }, null, 2));
      await writeFile(join(evidence, 'integrated-reveal-evidence.json'), JSON.stringify({ ticket: 'AIT-131', commit: evidenceCommit, createdAt: new Date().toISOString(), reveals }, null, 2));
    }
    // Optional read-only design reference supplied on the remote runner; never committed to the public repo.
    if (evidence) {
      try {
        const html = await readFile('/tmp/aithema-ait-131-approved.html', 'utf8');
        const reference = await browser.newPage();
        for (const theme of ['light', 'dark']) for (const width of [390, 1024, 1440]) {
          await reference.goto('about:blank');
          await reference.setViewport({ width, height: width === 390 ? 844 : 900 });
          await reference.setContent(html);
          await reference.evaluate(theme => { document.body.classList.add('noanno'); document.documentElement.dataset.theme = theme; }, theme);
          await reference.screenshot({ path: join(evidence, `approved-reference-${width}-${theme}-de.png`), fullPage: true });
          await reference.focus('.band .glassorb'); await new Promise(resolve => setTimeout(resolve, 2200));
          await reference.screenshot({ path: join(evidence, `approved-reference-reveal-${width}-${theme}-de.png`), fullPage: true });
        }
        await reference.close();
      } catch (error) { if (error.code !== 'ENOENT') throw error; }
    }
    t.diagnostic(`AIT-131 display matrix: Round-2 state and footer screenshots; ${files.length} files written.`);
  });
