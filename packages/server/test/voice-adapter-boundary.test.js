import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readdir, readFile } from 'node:fs/promises';
import { SQLiteStorage } from '../src/storage.js';
import { createVoiceHandlers } from '../src/voice-handlers.js';

test('AIT-102: the generic mount accepts adapter-declared routes without an ElevenLabs facade', async t => {
  const storage = new SQLiteStorage(); let operations = 0;
  const adapter = { callbackRoutes: [{ method: 'POST', path: '/provider-callback/:identity', async handle(request) {
    if (request.method !== 'POST') return Response.json({ error: 'method-not-allowed' }, { status: 405 });
    if (request.headers.get('authorization') !== 'Bearer fixture') return Response.json({ error: 'unauthorized' }, { status: 401 });
    operations++; return Response.json({ accepted: true });
  } }] };
  const handlers = createVoiceHandlers({ storage, runtime: { voiceServerAdapters: () => [adapter] } });
  t.after(async () => { await handlers.close(); storage.close(); });
  const request = (method, authorization) => new Request('https://host.example.test/provider-callback/identity', {
    method, ...(authorization ? { headers: { authorization } } : {}) });
  assert.equal((await handlers.handle(request('GET'))).status, 405);
  assert.equal((await handlers.handle(request('POST'))).status, 401); assert.equal(operations, 0);
  assert.equal((await handlers.handle(request('POST', 'Bearer fixture'))).status, 200); assert.equal(operations, 1);
  assert.equal(await handlers.handle(new Request('https://host.example.test/provider-callback/invalid.identity')), null);
});

test('AIT-102: generic server source has no ElevenLabs facade implementation imports or wiring', async () => {
  const root = new URL('../src/', import.meta.url);
  for (const name of await readdir(root)) {
    if (!name.endsWith('.js')) continue;
    const source = await readFile(new URL(name, root), 'utf8');
    const imports = [...source.matchAll(/(?:import|export)\s[^;]*?from\s+['"]([^'"]+)['"]/gu)].map(match => match[1]);
    for (const path of imports.filter(path => path.includes('plugins/elevenlabs/'))) {
      assert.ok(path.endsWith('/config.js') || path.endsWith('/manifest.js'), `${name} imports facade implementation ${path}`);
    }
  }
  const source = await readFile(new URL('voice-handlers.js', root), 'utf8');
  assert.doesNotMatch(source, /createCompletionsHandler|CUSTOM_LLM_BASE_PATH|\/api\/voice\/|facadeSecretRef|facadeCallId|publicFacadeBaseUrl|firstMessage|secrets\.(?:provision|resolve|revoke)/u);
});
