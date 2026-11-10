import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mkdir, mkdtemp } from 'node:fs/promises';
import { homedir, tmpdir } from 'node:os';
import { join } from 'node:path';
import puppeteer from './launch.js';
import { browserPath } from '../../scripts/install-test-browser.js';
import { startChild } from '../helpers.js';
import { mockConsent } from './consent-helpers.js';
import { startTyping, sendTurn } from './demo-helpers.js';
import { settleEvidenceFrame } from './start2-display-helpers.js';

const shadow = (page, fn, ...args) => page.$eval('aithema-session', fn, ...args);
const until = (page, fn) => page.waitForFunction(fn, { polling: 50, timeout: 30_000 });

test('AIT-463 BC9: email unlock keeps one answered reply, its choices and no Retry', { timeout: 180_000 }, async t => {
  const directory = await mkdtemp(join(tmpdir(), 'aithema-unlock-reply-'));
  // This existing bootstrap refuses every server-side fetch; only mock reasoning
  // and the labelled fake mail outbox are available, with no inherited secrets.
  const demo = await startChild(new URL('../fixtures/no-provider-server.js', import.meta.url), join(directory, 'session.sqlite'), {
    AITHEMA_DEMO_VERIFY: '1', AITHEMA_VOICE_MODE: 'off', AITHEMA_IMAGE_MODE: 'off', AITHEMA_HTML_MODE: 'off',
  });
  t.after(() => demo.kill());
  const browser = await puppeteer.launch({ executablePath: await browserPath(), headless: true,
    userDataDir: join(directory, 'chrome'), env: { PATH: process.env.PATH, HOME: homedir() } });
  t.after(() => browser.close());
  const evidence = process.env.AITHEMA_EVIDENCE_DIR;
  if (evidence) await mkdir(evidence, { recursive: true });
  const cases = ['en', 'de'].flatMap(locale => [390, 1440].map(width => ({ locale, width, path: 'V' })));
  cases.push({ locale: 'en', width: 1440, path: 'P' });

  for (const { locale, width, path } of cases) await t.test(`${path}/${locale}/${width}`, async scene => {
    const context = await browser.createBrowserContext(), page = await context.newPage();
    scene.after(() => context.close());
    try {
      await page.setViewport({ width, height: width === 390 ? 844 : 900 });
      await page.emulateMediaFeatures([{ name: 'prefers-reduced-motion', value: 'reduce' }]);
      const external = [], errors = [];
      page.on('pageerror', error => errors.push(error.message));
      await page.setRequestInterception(true);
      page.on('request', request => {
        if (!['data:', 'about:'].includes(new URL(request.url()).protocol) && new URL(request.url()).origin !== demo.url) {
          external.push(request.url()); void request.abort();
        } else void request.continue();
      });
      await page.evaluateOnNewDocument(locale => {
        if (window !== window.top) return;
        localStorage.setItem('aithema-demo-locale', locale);
        Object.defineProperty(navigator, 'languages', { get: () => [locale] });
        Object.defineProperty(navigator, 'language', { get: () => locale });
        // Like the question-card browser fixture, supply deterministic choices.
        // The mock demo's actual reply text, IDs, revision stamps, journal events,
        // operations and unlock requests are untouched. Decorate both delivery
        // forms so a real snapshot refresh cannot discard the fixture's choices.
        const choices = turn => turn.role === 'assistant' ? { ...turn, question_short: turn.content,
          options: [{ text: locale === 'de' ? 'Unsere Abläufe' : 'Our workflow', likely: true },
            { text: locale === 'de' ? 'Unsere Website' : 'Our website' }] } : turn;
        const originalFetch = window.fetch.bind(window);
        window.ait463RawFetch = originalFetch;
        window.fetch = async (...args) => {
          const response = await originalFetch(...args);
          const pathname = new URL(typeof args[0] === 'string' ? args[0] : args[0].url, location.href).pathname;
          if (response.ok && /^\/api\/sessions\/[^/]+$/u.test(pathname) && (args[1]?.method ?? 'GET') === 'GET') {
            const snapshot = await response.json(); snapshot.transcript = snapshot.transcript.map(choices);
            return new Response(JSON.stringify(snapshot), { status: response.status, headers: response.headers });
          }
          return response;
        };
        void customElements.whenDefined('aithema-session').then(() => {
          const prototype = customElements.get('aithema-session').prototype, receive = prototype.receive;
          prototype.receive = function(event) {
            return receive.call(this, event.type === 'turn.final' ? { ...event, data: choices(event.data) } : event);
          };
        });
      }, locale);
      await page.goto(demo.url, { waitUntil: 'domcontentloaded' });
      await until(page, () => document.querySelector('aithema-session')?.session?.id);
      assert.equal(await shadow(page, c => c.session.locale), locale);
      assert.equal(await shadow(page, c => c.session.identified), false);
      await mockConsent(page);
      await startTyping(page);
      await until(page, () => !document.querySelector('aithema-session').shadowRoot.querySelector('textarea').disabled);
      await sendTurn(page, locale === 'de' ? 'Wir brauchen eine Website. systeme: API' : 'We need a website. systems: API');
      await until(page, () => {
        const c = document.querySelector('aithema-session');
        return c.session.transcript.filter(turn => turn.role === 'assistant').length === 1 &&
          c.session.operations?.running.length === 0 && !c.shadowRoot.querySelector('.qcard').hidden;
      });
      const original = await shadow(page, c => c.session.transcript.find(turn => turn.role === 'assistant'));
      assert.equal(await shadow(page, c => c.shadowRoot.querySelector('.verify-lock').hidden), false);
      const inspect = () => shadow(page, c => {
        const root = c.shadowRoot, visible = node => Boolean(node && node.checkVisibility() && node.getBoundingClientRect().height);
        return { replies: c.session.transcript.filter(turn => turn.role === 'assistant').map(turn => turn.id),
          rows: root.querySelectorAll('ol li.turn:not(.user):not(.partial)').length,
          choices: [...root.querySelectorAll('.qcard .qopt')].filter(visible).map(node => node.textContent.trim()),
          retries: [...root.querySelectorAll('.reaction-failure button, .turn button, .foot button, .overview-retry')]
            .filter(node => visible(node) && /retry|erneut|wiederholen/iu.test(`${node.className} ${node.textContent}`)).map(node => node.className) };
      });
      const before = await inspect();
      assert.deepEqual(before.replies, [original.id]); assert.equal(before.rows, 1);
      assert.equal(before.choices.length, 2); assert.deepEqual(before.retries, []);
      const shot = async state => {
        if (!evidence || path !== 'V') return;
        await settleEvidenceFrame(page);
        await page.screenshot({ path: join(evidence, `ait463-${locale}-${width}-${state}.png`), fullPage: false });
      };
      await shot('before');
      await shadow(page, c => {
        const root = c.shadowRoot;
        root.querySelector('#verify-lock-email').value = 'visitor@example.test';
        root.querySelector('.verify-lock .verify-send').click();
      });
      await until(page, () => document.querySelector('aithema-session').session.identity?.status === 'verification-pending');
      if (path === 'V') {
        // Pending is emitted before asynchronous fake delivery completes. The
        // outbox paints once on opening, so wait for the actual mail first.
        await until(page, async () => {
          const id = document.querySelector('aithema-session').session.id;
          const outbox = await window.ait463RawFetch(`/api/sessions/${id}/demo/outbox`).then(r => r.json());
          return outbox.messages.some(message => message.token);
        });
        await page.$eval('#outbox-open', button => button.click());
        await page.waitForSelector('#outbox-list li button');
        await page.$eval('#outbox-list li button', button => button.click());
        await until(page, () => document.querySelector('aithema-session').session.identified === true);
        await page.$eval('#outbox-close', button => button.click());
      } else {
        // Path P needs no new server: a second conversation of this visitor can
        // confirm the fake outbox token. The tested conversation never confirms;
        // its next owned read/poll projects the visitor-wide verified identity.
        const result = await page.evaluate(async () => {
          const { postJson } = await import('/demo/post-json.js');
          const id = document.querySelector('aithema-session').session.id;
          const outbox = await window.ait463RawFetch(`/api/sessions/${id}/demo/outbox`).then(r => r.json());
          const sibling = await postJson('/api/sessions', {}).then(r => r.json());
          const response = await postJson(`/api/sessions/${sibling.id}/identity/confirm`, { token: outbox.messages.at(-1).token });
          const confirmed = await response.json();
          const projected = await window.ait463RawFetch(`/api/sessions/${id}`).then(r => r.json());
          return { ok: response.ok, confirmed: confirmed.identity.status, projected: projected.identified };
        });
        assert.deepEqual(result, { ok: true, confirmed: 'verified', projected: true });
      }
      await until(page, () => {
        const c = document.querySelector('aithema-session'), session = c.session;
        return session.identified && session.operations?.running.length === 0 && !session.understanding.draft &&
          session.understanding.inputRevision === session.operations.inputRevision;
      });
      await settleEvidenceFrame(page);
      const after = await inspect();
      assert.deepEqual(after.replies, [original.id], 'unlock never adds or replaces an assistant reply');
      assert.equal(after.rows, 1, 'the rendered transcript contains exactly one assistant reply');
      assert.deepEqual(after.choices, before.choices, 'the same answer buttons remain visible');
      assert.deepEqual(after.retries, [], 'no visible Retry in the reply line or footer');
      // Also inspect the unmodified server snapshot, independently of the choice fixture.
      const stored = await page.evaluate(async () => {
        const id = document.querySelector('aithema-session').session.id;
        const session = await window.ait463RawFetch(`/api/sessions/${id}`).then(r => r.json());
        return { replies: session.transcript.filter(turn => turn.role === 'assistant').map(turn => turn.id),
          identified: session.identified, failures: session.operations.failures };
      });
      assert.deepEqual(stored, { replies: [original.id], identified: true, failures: [] });
      await shot('after');
      assert.deepEqual(errors, []); assert.deepEqual(external, []);
    } catch (error) {
      console.error(`Error: AIT-463 ${path}/${locale}/${width}: ${error.stack}`);
      console.error('Error: AIT-463 fixture state', await page.evaluate(() => ({
        outboxOpen: document.querySelector('#outbox')?.open,
        outboxStatus: document.querySelector('#outbox-status')?.textContent,
        outboxRows: document.querySelector('#outbox-list')?.children.length,
        identified: document.querySelector('aithema-session')?.session?.identified,
      })).catch(() => null));
      throw error;
    }
  });
});
