import assert from 'node:assert/strict';
import { mkdir, mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { startChild } from '../helpers.js';
import { fixture } from './combined-entrance-check.js';
import { welcome } from './combined-image-opener-check.js';
import { browserForFile } from './shared-browser.js';

const hostCopy = {
  de: {
    title: 'Bereit', missing: 'Beim ersten Senden erforderlich', change: 'Ändern',
    route: 'Ihre Gesprächsdaten und die Inhalte, die Sie im Gespräch teilen, werden für Ihre Anfrage von den empfohlenen Anbietern verarbeitet.',
  },
  en: {
    title: 'Ready', missing: 'Required when you first send', change: 'Settings',
    route: 'Your conversation data is processed by the host’s recommended providers to assist with your request.',
  },
};
const cases = [664, 740, 844].flatMap(height => ['de', 'en'].flatMap(locale =>
  (height === 844 ? ['light'] : ['light', 'dark']).map(theme => ({ height, locale, theme }))));
// The longer German summary on the bound release wrapped to another row.
for (const theme of ['light', 'dark']) cases.push({ height: 740, locale: 'de', theme, longCard: true });
const epsilon = .5;
const bottom = box => box.y + box.height;
const controls = ['mic', 'send', 'field'];
const positive = (name, box) => assert.ok(box?.width > 0 && box?.height > 0, `${name} has a positive box: ${JSON.stringify(box)}`);
const close = (actual, expected, label) => assert.ok(Math.abs(actual - expected) <= epsilon, `${label}: ${actual} vs ${expected} px`);

async function openHost(page, url, { height, locale, theme, longCard }) {
  await page.setViewport({ width: 390, height, hasTouch: true });
  await page.emulateMediaFeatures([{ name: 'prefers-color-scheme', value: theme }, { name: 'prefers-reduced-motion', value: 'reduce' }]);
  await page.setRequestInterception(true);
  page.on('request', request => {
    const path = new URL(request.url()).pathname;
    void (path === '/combined-fixture' ? request.respond({ contentType: 'text/html', body: fixture }) : request.continue());
  });
  await page.goto(`${url}/combined-fixture?locale=${locale}&passiveDenied`);
  await page.waitForFunction(() => globalThis.ready && c.shadowRoot.querySelector('.composer-status').textContent.length > 0);
  await page.evaluate(async ({ locale, text, words, longCard }) => {
    const base = (await import(`/packages/ui/src/i18n/${locale}.js`))[locale];
    const { title, missing, change, route } = words;
    // Hosts supply their strings via configure(copy); the normal readiness
    // render owns the card, its wrapping, and the processing line.
    globalThis.fixtureCopy = { ...base, ready: { ...base.ready, title, missing, change },
      chooser: { ...base.chooser, summary: { ...base.chooser.summary, best: route } },
      ...(longCard && { uploadsSupported: 'Unterstützt: PDF, Office, Text, PNG, JPEG, WebP, GIF.' }),
      featureConsent: { ...base.featureConsent, text: `${base.featureConsent.text} `.repeat(4).trim() } };
    const snapshot = structuredClone(c.session);
    snapshot.opener = { text, locale };
    snapshot.visualsBound = true;
    snapshot.conceptVisualKind = 'image';
    snapshot.featureMatrix.best.imageInput = { available: true };
    snapshot.featureMatrix.best.images = { available: true };
    c.style.setProperty('--aithema-height', `${innerHeight}px`);
    mount(snapshot);
  }, { locale, text: welcome[locale], longCard,
    words: longCard ? { ...hostCopy[locale], title: 'Vor dem Gespräch', change: 'Einstellungen' } : hostCopy[locale] });
}

async function measure(page) {
  await page.evaluate(async () => {
    await document.fonts.ready;
    await new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(() => requestAnimationFrame(resolve))));
  });
  return page.$eval('aithema-session', host => {
    const root = host.shadowRoot, workspace = root.querySelector('.workspace'), scroll = root.querySelector('.conversation-scroll');
    const read = selector => {
      const node = root.querySelector(selector);
      if (!node?.checkVisibility({ visibilityProperty: true })) return null;
      const { x, y, width, height } = node.getBoundingClientRect();
      return { x, y, width, height };
    };
    return {
      stage: workspace.dataset.stage, entrance: workspace.dataset.entrance, layout: workspace.dataset.conceptLayout,
      keyboard: workspace.hasAttribute('data-phone-keyboard'),
      phoneBudget: Object.fromEntries(['height', 'band', 'footer', 'dock', 'bottom'].map(name =>
        [name, workspace.style.getPropertyValue(`--phone-${name}`)])),
      card: read('.ready'), route: read('.ready__route'), conversation: read('.conversation'), scroll: read('.conversation-scroll'),
      opener: read('[data-host-opener]'), band: read('.band'), footer: read('.display-foot'), backdrop: read('.phone-dock-backdrop'),
      dock: read('.composer-dock'), shell: read('.composer-shell'), slot: read('.concept-phone-slot'),
      access: read('.concept-phone-slot .concept-access'), preview: read('.concept-phone-slot .concept-preview'),
      mic: read('.composer-mic'), send: read('.send'), field: read('textarea'),
      feedback: read('.composer-feedback'), reason: read('.composer-reason'),
      scrollTop: scroll.scrollTop, scrollHeight: scroll.scrollHeight, clientHeight: scroll.clientHeight,
      pageTop: window.scrollY, fade: getComputedStyle(scroll).maskImage,
      clamp: workspace.style.getPropertyValue('--opener-lines'),
    };
  });
}

function sameControls(initial, next, state) {
  assert.equal(next.keyboard, false, `${state}: keyboard down`);
  for (const key of controls) {
    positive(`${state}/${key}`, next[key]);
    for (const axis of ['x', 'y', 'width', 'height']) close(next[key][axis], initial[key][axis], `${state}/${key}/${axis}`);
  }
}

async function firstSendAndConcept(page, record, ready) {
  await page.type('aithema-session >>> textarea', 'Ein Rechnungssystem.');
  await page.click('aithema-session >>> .send');
  await page.waitForFunction(() => trace.includes('consent'));
  const consent = await record('first-send-consent');
  await page.evaluate(() => { failSend = true; grant(); });
  await page.waitForFunction(() => c.shadowRoot.querySelector('.composer-reason').hasAttribute('data-send-failed'));
  const failed = await record('feedback');
  await page.evaluate(() => {
    c.receive({ seq: c.session.seq + 1, type: 'turn.final', data: { id: 'host:opener', role: 'assistant', origin: 'host', content: c.session.opener.text } });
    failSend = false;
  });
  await page.click('aithema-session >>> .send');
  await page.waitForFunction(() => sent.length === 1 && c.shadowRoot.querySelector('.workspace').dataset.stage === 'live');
  const live = await record('first-send');
  await page.evaluate(async () => {
    const canvas = document.createElement('canvas'); canvas.width = 56; canvas.height = 32;
    const context = canvas.getContext('2d'); context.fillStyle = '#14918c'; context.fillRect(0, 0, 56, 32);
    const image = await new Promise(resolve => canvas.toBlob(resolve, 'image/png'));
    const fetchSession = globalThis.fetch;
    globalThis.fetch = (url, options) => new URL(url, location.href).pathname.endsWith('/first-concept/image')
      ? Promise.resolve(new Response(image, { headers: { 'content-type': 'image/png' } })) : fetchSession(url, options);
    const session = c.session, firstTurn = session.transcript.find(turn => turn.role === 'user');
    c.receive({ seq: session.seq + 1, type: 'concept.state', data: { intent: session.conceptIntent, status: { phase: 'ready' },
      artifact: { id: 'first-concept', mediaType: 'image/png', width: 56, height: 32, turnIds: [firstTurn.id], referenceIds: [],
        archived: false, feedback: { vote: 'clear', chips: [] }, provenance: { origin: 'ai-generated', generator: { provider: 'fixture' } } } } });
  });
  await page.waitForFunction(() => c.shadowRoot.querySelector('.concept-phone-slot .concept-preview img[data-on]')?.naturalWidth > 0);
  const concept = await record('first-concept');

  positive('long consent feedback', consent.reason);
  positive('send failure feedback', failed.reason);
  assert.equal(await page.$eval('aithema-session', host => host.shadowRoot.querySelector('.composer-reason').hasAttribute('data-send-failed')), false);
  positive('first concept access', concept.access);
  positive('first concept preview', concept.preview);
  for (const [name, boxes] of Object.entries({ consent, failed, live, concept })) sameControls(ready, boxes, name);
  close(live.scroll.height, concept.scroll.height, 'conversation height when the first concept appears');
}

export async function phoneReadinessCheck(t) {
  const directory = await mkdtemp(join(tmpdir(), 'aithema-readiness-'));
  const server = await startChild(new URL('../fixtures/no-provider-server.js', import.meta.url), join(directory, 'session.sqlite'), {
    AITHEMA_VOICE_MODE: 'off', AITHEMA_IMAGE_MODE: 'off', AITHEMA_HTML_MODE: 'off',
  });
  t.after(() => server.kill());
  const browser = await browserForFile();
  t.after(() => browser.close());
  const evidence = process.env.AITHEMA_EVIDENCE_DIR;
  if (evidence) await mkdir(evidence, { recursive: true });
  for (const item of cases) {
    const name = `390x${item.height}-${item.locale}-${item.theme}${item.longCard ? '-long' : ''}`;
    await t.test(name, async () => {
      const page = await browser.newPage(), problems = [];
      try {
        page.on('pageerror', error => problems.push(error.message));
        await openHost(page, server.url, item);
        const record = async state => {
          const boxes = await measure(page);
          if (evidence) {
            await writeFile(join(evidence, `${name}-${state}.json`), JSON.stringify(boxes, null, 2));
            await page.screenshot({ path: join(evidence, `${name}-${state}.png`), captureBeyondViewport: false });
          }
          return boxes;
        };
        const ready = await record('ready');
        assert.equal(ready.stage, 'ready');
        assert.equal(ready.entrance, 'combined');
        assert.equal(ready.layout, 'image');
        assert.equal(ready.keyboard, false);
        assert.equal(ready.access, null, 'the projected concept access is hidden in the reserved phone slot');
        for (const key of ['card', 'route', 'conversation', 'scroll', 'opener', 'band', 'footer', 'dock', 'shell', 'slot', 'backdrop', 'feedback', ...controls]) positive(key, ready[key]);
        close(ready.slot.height, 44, 'real bound image slot');
        close(ready.scrollTop, 0, 'the entrance starts at its top');
        const cardHeight = item.longCard ? 122 : item.locale === 'de' ? 102 : 85;
        assert.ok(Math.abs(ready.card.height - cardHeight) <= 4, `host card is approximately ${cardHeight} px high: ${ready.card.height}`);
        if (item.height === 740 && item.locale === 'de' && item.theme === 'light' && !item.longCard) await firstSendAndConcept(page, record, ready);
        assert.deepEqual(problems, []);

        const shortfall = Math.max(0, bottom(ready.card) - bottom(ready.scroll));
        const physicalShortfall = Math.max(0, bottom(ready.card) - ready.dock.y);
        if (item.height === 664 && physicalShortfall > epsilon) {
          // The only acceptable overflow is exactly the space the dock occupies.
          close(shortfall, physicalShortfall, 'the card shortfall equals the physical shortfall');
          assert.notEqual(ready.fade, 'none', 'overflow has a bottom fade');
          await page.$eval('aithema-session', host => {
            const scroll = host.shadowRoot.querySelector('.conversation-scroll'); scroll.scrollTop = scroll.scrollHeight;
          });
          const scrolled = await measure(page);
          positive('scrolled/card', scrolled.card); positive('scrolled/conversation', scrolled.scroll);
          assert.ok(bottom(scrolled.card) <= bottom(scrolled.scroll) + epsilon, 'scroll reveals the last line');
          assert.equal(scrolled.fade, 'none', 'the last line has no fade at the end');
        } else {
          close(shortfall, 0, 'the whole card is inside the visible conversation');
          close(physicalShortfall, 0, 'the whole card is above the dock');
          assert.equal(ready.fade, 'none', 'fitting readiness has no fade');
        }
        close(bottom(ready.scroll), ready.dock.y, 'the readiness viewport runs down to the dock top');
      } finally { await page.close(); }
    });
  }
}
