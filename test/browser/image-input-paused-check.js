import assert from 'node:assert/strict';
import { test } from 'node:test';
import { readFile, mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { PluginRegistry } from '../../packages/core/src/index.js';
import { SQLiteStorage, createHandlers, createPluginRuntime } from '../../packages/server/src/index.js';
import { listen } from '../../packages/server/src/http.js';
import { createOpenRouterReasoning } from '../../plugins/openrouter/src/index.js';
import { createImageInput } from '../../plugins/image-input/src/index.js';
import { qualifyStartBinding } from '../../demo/processing-consent.js';
import { testToken } from '../helpers.js';
import { browserForFile } from './shared-browser.js';
import { en } from '../../packages/ui/src/i18n/en.js';

export function pausedImageInputCheck() {
  test('AIT-556 r3: real server retains paused image refusal on drop and paste', { timeout: 90000 }, async t => {
    const storage = new SQLiteStorage(), providerCalls = [];
    const binding = qualifyStartBinding({ plugin: 'openrouter', model: 'anthropic/fixture', effort: 'none',
      endpoint: 'https://example.test/chat', accountRef: 'fixture', secretRef: 'fixture', maxMicro: 1000000,
      maxTokens: 1000, rates: { inputMicro: 1, outputMicro: 1 }, imageInput: { maxImages: 4, maxTokensPerImage: 1600 } });
    const reasoning = createOpenRouterReasoning({ binding, prices: { 'anthropic/fixture': { prompt: .000001, completion: .000001 } },
      resolveSecret: () => 'fixture', fetchImpl: async (...args) => { providerCalls.push(args); assert.fail('Paused image input must never dispatch'); } });
    const registry = new PluginRegistry().register(reasoning).register(createImageInput());
    const presets = { best: { plugins: ['openrouter', 'image-input'], bindings: { reaction: binding, understanding: binding },
      policy: { endpoints: [binding.endpoint] }, imageInput: { plugin: 'image-input' } } };
    const consent = { coverage({ scope, consentRevision }) { const now = Date.now();
      return { covered: true, ...scope, scope, consentRevision, checkedAt: now, expiresAt: now + 60000 }; } };
    const runtime = createPluginRuntime({ storage, registry, presets, consent });
    const handlers = createHandlers({ storage, reasoning, pluginRuntime: runtime, consent });
    const requests = [];
    const { server, url } = await listen(async request => {
      const path = new URL(request.url).pathname;
      if (path.startsWith('/api/')) { requests.push({ path, method: request.method }); return handlers.handle(request); }
      if (path === '/') return new Response('<!doctype html><html lang="en"><body><aithema-session></aithema-session></body></html>', { headers: { 'content-type': 'text/html' } });
      if (!/^\/packages\/(?:ui|core)\/src\/[a-z0-9/.-]+\.(?:js|json)$/u.test(path)) return new Response(null, { status: 404 });
      try { return new Response(await readFile(new URL('../..' + path, import.meta.url)), { headers: { 'content-type': path.endsWith('.json') ? 'application/json' : 'text/javascript' } }); }
      catch { return new Response(null, { status: 404 }); }
    });
    const browser = await browserForFile(), page = await browser.newPage();
    t.after(async () => { await page.close(); server.close(); server.closeAllConnections(); await handlers.close(); storage.close(); });
    await page.setViewport({ width: 1440, height: 900 });
    await page.emulateMediaFeatures([{ name: 'prefers-reduced-motion', value: 'reduce' }]);
    await page.goto(url);
    const facts = [];
    for (const entrance of ['drop', 'paste']) {
      const session = storage.create({ ownerToken: testToken, demo: true });
      storage.pause(session.id, true);
      const result = await page.evaluate(async ({ id, token, entrance }) => {
        await import('/packages/ui/src/session-element.js');
        const { en } = await import('/packages/ui/src/i18n/en.js');
        const response = await fetch(`/api/sessions/${id}`, { headers: { 'x-aithema-session-token': token } });
        if (!response.ok) throw new Error(`Snapshot status ${response.status}`);
        const session = await response.json(), c = document.querySelector('aithema-session');
        c.configure({ session, copy: en, sessionToken: token });
        const transfer = new DataTransfer(); transfer.items.add(new File(['pixels'], `${entrance}.png`, { type: 'image/png' }));
        const event = entrance === 'drop' ? new DragEvent('drop', { bubbles: true, cancelable: true, dataTransfer: transfer })
          : new ClipboardEvent('paste', { bubbles: true, cancelable: true, clipboardData: transfer });
        c.shadowRoot.querySelector(entrance === 'drop' ? '.conversation' : 'textarea').dispatchEvent(event);
        return { imageInput: session.featureMatrix.best.imageInput, handled: event.defaultPrevented };
      }, { id: session.id, token: testToken, entrance });
      assert.deepEqual(result.imageInput, { available: false, reason: 'session paused', unpaused: { available: true, reason: null } });
      assert.equal(result.handled, true, `${entrance} is handled while paused`);
      // A full pause hides feedback in AIT-510. Resume through the real route
      // to expose the retained refusal without replacing any feature verdict.
      await page.evaluate(async ({ id, token }) => {
        const response = await fetch(`/api/sessions/${id}/pause`, { method: 'POST', headers: {
          'x-aithema-session-token': token, 'content-type': 'application/json' }, body: JSON.stringify({ paused: false }) });
        if (!response.ok) throw new Error(`Resume status ${response.status}`);
        const body = await response.json(), c = document.querySelector('aithema-session');
        c.receive(body.event ?? body);
      }, { id: session.id, token: testToken });
      const expected = `${entrance}.png: ${en.imageRefusals.paused}`;
      await page.waitForFunction(expected => document.querySelector('aithema-session').shadowRoot.querySelector('.composer-reason .image-refusal')?.textContent === expected, {}, expected);
      const refusal = await page.$eval('aithema-session', c => c.shadowRoot.querySelector('.composer-reason .image-refusal').textContent);
      assert.equal(refusal, expected);
      facts.push({ entrance, ...result, refusal });
      if (process.env.AITHEMA_EVIDENCE_DIR) {
        await mkdir(process.env.AITHEMA_EVIDENCE_DIR, { recursive: true });
        await page.screenshot({ path: join(process.env.AITHEMA_EVIDENCE_DIR, `ait556-r3-paused-${entrance}.png`) });
      }
    }
    assert.deepEqual(providerCalls, []);
    assert.equal(requests.some(r => r.method === 'POST' && r.path.endsWith('/uploads')), false);
    assert.equal(storage.db.prepare('SELECT COUNT(*) AS n FROM budget_attempts').get().n, 0);
    if (process.env.AITHEMA_EVIDENCE_DIR) await writeFile(join(process.env.AITHEMA_EVIDENCE_DIR, 'ait556-r3-paused-real-server.json'), JSON.stringify({ facts, requests, providerCalls: 0 }, null, 2));
  });
}
