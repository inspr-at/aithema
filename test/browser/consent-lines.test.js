// Tick C1: isolated consent verdicts; viewport evidence, remote browser only.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mkdir, mkdtemp, writeFile, appendFile } from 'node:fs/promises';
import { homedir, tmpdir } from 'node:os';
import { join } from 'node:path';
import puppeteer from 'puppeteer-core';
import { startChild } from '../helpers.js';
import { CONSENT_ITEMS } from '../../demo/processing-consent.js';
import { browserPath, shadow, until, boxes, evidenceCommit } from './start2-display-helpers.js';

const features = { html: ['drafts-anthropic'], voice: ['voice-elevenlabs'], analysis: ['models-international'] };
const places = { html: '.concept-activity-text', voice: '.voice-state', analysis: '.notice' };
const words = {
  de: { html: 'Entwürfe brauchen Ihre Einwilligung', voice: 'Sprache braucht Ihre Einwilligung', analysis: 'Der Überblick braucht Ihre Einwilligung', action: 'Einwilligen…' },
  en: { html: 'Drafts need your consent', voice: 'Voice needs your consent', analysis: 'The overview needs your consent', action: 'Give consent…' },
};
const frame = page => page.evaluate(async () => { await document.fonts.ready; await new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))); });
async function record(t, page, label, values) {
  const line = `PASS C1 ${evidenceCommit} ${label}: ${JSON.stringify(values)}`;
  t.diagnostic(line);
  if (!process.env.AITHEMA_EVIDENCE_DIR) return;
  const dir = join(process.env.AITHEMA_EVIDENCE_DIR, 'C1'); await mkdir(dir, { recursive: true });
  await page.screenshot({ path: join(dir, label + '.png'), fullPage: false, captureBeyondViewport: false });
  await writeFile(join(dir, label + '.json'), JSON.stringify({ head: evidenceCommit, viewportOnly: true, label, ...values, pass: true }, null, 2));
  await appendFile(join(dir, 'pass-lines.txt'), line + '\n');
}
async function fixture(t) {
  const directory = await mkdtemp(join(tmpdir(), 'aithema-consent-lines-'));
  const demo = await startChild(new URL('../fixtures/no-provider-server.js', import.meta.url), join(directory, 'session.sqlite'), {
    AITHEMA_VOICE_MODE: 'off', AITHEMA_IMAGE_MODE: 'off', AITHEMA_HTML_MODE: 'off',
  });
  const browser = await puppeteer.launch({ executablePath: await browserPath(), headless: true, userDataDir: join(directory, 'chrome'),
    env: { PATH: process.env.PATH, HOME: homedir() }, args: process.platform === 'linux' && process.env.CI ? ['--no-sandbox'] : [] });
  t.after(async () => { await browser.close(); await demo.kill(); });
  const page = await browser.newPage();
  await page.emulateMediaFeatures([{ name: 'prefers-reduced-motion', value: 'reduce' }]);
  await page.setRequestInterception(true);
  page.on('request', request => {
    const path = new URL(request.url()).pathname;
    const json = body => request.respond({ status: 200, contentType: 'application/json', body: JSON.stringify(body) });
    if (page.state && path.endsWith('/consent')) {
      if (request.method() === 'GET') return json({ contract: 'fixture-contract', items: CONSENT_ITEMS, features, selected: page.state.selected });
      const body = JSON.parse(request.postData()); page.posts.push(body);
      assert.equal(body.processing.contract, 'fixture-contract');
      page.state.selected = body.processing.items;
      for (const [feature, ids] of Object.entries(features)) if (ids.every(id => page.state.selected.includes(id))) page.state.matrix.best[feature] = { available: true, reason: null };
      return json({ granted: true, event: { seq: ++page.state.seq, type: 'consent.revised', data: { granted: true, consentRevision: 2, conversationUnchanged: true } } });
    }
    if (page.state?.snapshot && request.method() === 'GET' && path === `/api/sessions/${page.state.snapshot.id}`) return json({ ...page.state.snapshot, seq: page.state.seq, featureMatrix: page.state.matrix });
    if (path.endsWith('/features')) return json(page.state ? { featureMatrix: page.state.matrix } : {});
    if (path.endsWith('/retry') && page.state) return json({});
    if (path.endsWith('/events')) return request.continue({ headers: { ...request.headers(), 'last-event-id': '0' } });
    return request.continue();
  });
  await page.goto(demo.url, { waitUntil: 'domcontentloaded' });
  await until(page, () => document.querySelector('aithema-session')?.session?.id);
  await shadow(page, c => { globalThis.consentSeed = structuredClone(c.session); globalThis.documentToken = {}; });
  return page;
}
async function scene(page, locale, theme, width, missing) {
  await page.setViewport({ width, height: width === 390 ? 844 : 900 }); await page.select('#theme', theme);
  page.posts = [];
  page.state = { selected: CONSENT_ITEMS.map(i => i.id).filter(id => !missing.flatMap(f => features[f]).includes(id)),
    seq: 100, matrix: { best: Object.fromEntries(['text', 'analysis', 'voice', 'html'].map(f => [f,
      missing.includes(f) ? { available: false, reason: 'current processing consent required' } : { available: true, reason: null }])) } };
  await page.evaluate(async ({ locale, matrix }) => {
    const { [locale]: copy } = await import(`/packages/ui/src/i18n/${locale}.js`);
    const { paintUtilities } = await import('/demo/page-preferences.js');
    const { manifest } = await import('/plugins/elevenlabs/src/manifest.js');
    const c = document.querySelector('aithema-session'), session = structuredClone(globalThis.consentSeed);
    session.locale = locale; session.seq = 100; session.consentRevision = 1;
    session.settings.origin = 'chosen'; session.settings.voice = 'elevenlabs'; session.conceptVisualKind = 'html';
    session.conceptCost = { maxMicro: 10000 }; session.featureMatrix = matrix;
    session.transcript = [{ id: 'c1-user', role: 'user', content: locale === 'de' ? 'Wir verlieren Zeit beim Schreiben von Angeboten.' : 'We lose time writing quotes.' }];
    c.configure({ copy, session, host: { library: true }, voicePresentation: manifest.presentation, voiceClient: { manifest } });
    document.documentElement.lang = locale; document.querySelector('#locale').value = locale; paintUtilities(copy);
    globalThis.c1Nodes = [...c.shadowRoot.querySelectorAll('.concept-activity-text, .voice-state, .notice, textarea')];
    globalThis.c1Document = globalThis.documentToken;
    scrollTo(0, 0);
  }, { locale, matrix: page.state.matrix });
  page.state.snapshot = await shadow(page, c => structuredClone(c.session));
  await frame(page);
}
const geometry = ['.band', '.concept-bar', '.understanding', '.notice', '.composer'];
for (const locale of ['de', 'en']) test(`AIT-197 C1 ${locale}: each consent, focused Settings and in-place save, 390/1440 L/D`, { timeout: 120_000 }, async t => {
  const page = await fixture(t);
  for (const theme of ['light', 'dark']) for (const width of [390, 1440]) for (const feature of Object.keys(features)) {
    const label = `${locale}-${theme}-${width}-${feature}`;
    await scene(page, locale, theme, width, [feature]);
    const selector = places[feature], expected = `${words[locale][feature]} · ${words[locale].action}`;
    const state = await shadow(page, (c, { selector, expected }) => {
      const r = c.shadowRoot, line = r.querySelector(selector);
      return { text: line.textContent, lines: [...r.querySelectorAll('[data-consent-feature]')].filter(n => n.textContent === expected).length,
        action: line.querySelector('button')?.textContent, placeholder: r.querySelector('.notice').textContent,
        italic: getComputedStyle(line).fontStyle };
    }, { selector, expected });
    assert.equal(state.text, expected, label); assert.equal(state.lines, 1, label + ': once in its own place');
    assert.equal(state.action, words[locale].action); assert.equal(state.italic, 'normal');
    if (feature === 'analysis') assert.equal(state.placeholder, expected, 'blocked overview never promises the placeholder');
    if (feature === 'analysis') {
      await shadow(page, c => c.shadowRoot.querySelector('.notice').scrollIntoView({ block: 'center' })); await frame(page);
    }
    const before = await boxes(page, geometry);
    await record(t, page, label + '-missing', { feature, item: features[feature][0], ...state });
    await page.locator(`aithema-session >>> ${selector} button`).click();
    const item = features[feature][0];
    try {
      await until(page, item => {
        const r = document.querySelector('aithema-session').shadowRoot;
        return r.querySelector('dialog.settings').open && r.activeElement?.matches(`input[value="${item}"]`);
      }, item);
    } catch (error) {
      t.diagnostic(JSON.stringify(await shadow(page, c => ({ open: c.shadowRoot.querySelector('dialog.settings').open, focused: c.shadowRoot.activeElement?.outerHTML, status: c.shadowRoot.querySelector('.consent-status').textContent }))));
      throw error;
    }
    const focused = await shadow(page, c => c.shadowRoot.activeElement.value);
    assert.equal(focused, item);
    await record(t, page, label + '-settings', { focused, item });
    await page.keyboard.press('Space');
    await page.locator('aithema-session >>> .consent-save').click();
    await until(page, () => !document.querySelector('aithema-session').shadowRoot.querySelector('dialog.settings').open);
    await until(page, feature => document.querySelector('aithema-session').session.featureMatrix.best[feature].available, feature);
    await frame(page);
    const after = await boxes(page, geometry);
    assert.deepEqual(after, before, label + ': save shifts 0 px');
    assert.equal(page.posts.length, 1); assert.deepEqual([...page.posts[0].processing.items].sort(), CONSENT_ITEMS.map(i => i.id).sort(), 'preserves other grants');
    const saved = await shadow(page, c => ({ sameDocument: globalThis.documentToken === globalThis.c1Document,
      sameNodes: globalThis.c1Nodes.every(n => n.isConnected), consentLines: c.shadowRoot.querySelectorAll('[data-consent-feature]').length,
      overview: c.shadowRoot.querySelector('.notice').textContent }));
    assert.equal(saved.sameDocument, true); assert.equal(saved.sameNodes, true); assert.equal(saved.consentLines, 0);
    const copyEmpty = await page.evaluate(async locale => (await import(`/packages/ui/src/i18n/${locale}.js`))[locale].empty, locale);
    assert.equal(saved.overview, copyEmpty, 'merely waiting overview retains today’s placeholder');
    await record(t, page, label + '-saved', { ...saved, shiftPx: 0 });
  }
});
test('AIT-197 C1: all three refusals have one action each; stage survives a paused reload', async t => {
  const page = await fixture(t); await scene(page, 'de', 'light', 390, Object.keys(features));
  assert.equal(await shadow(page, c => c.shadowRoot.querySelectorAll('[data-consent-feature]').length), 3);
  await shadow(page, async c => {
    const { de: copy } = await import('/packages/ui/src/i18n/de.js');
    const session = structuredClone(c.session); session.paused = true; session.pauseReason = 'purpose';
    session.featureMatrix.best.html = { available: false, reason: 'session paused', unpaused: { available: false, reason: 'current processing consent required' } };
    c.configure({ session, copy });
  });
  assert.equal(await shadow(page, c => c.shadowRoot.querySelector('.concept-activity-text').textContent), 'Entwürfe brauchen Ihre Einwilligung · Einwilligen…');
});
