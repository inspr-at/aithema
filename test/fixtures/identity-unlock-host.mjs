// Fixture-only host port: acknowledge an in-place grant without invalidating the conversation.
// Keep the real demo, storage, reducer, routes and free local image implementation.
import assert from 'node:assert/strict';
import { registerHooks } from 'node:module';

const consentURL = new URL('../../demo/mock-consent.js', import.meta.url).href;
registerHooks({ load(url, context, nextLoad) {
  const result = nextLoad(url, context);
  if (url !== consentURL) return result;
  const source = String(result.source), needle = 'return { ...ledger, describe(';
  assert.ok(source.includes(needle), 'fixture consent port still matches the demo');
  return { ...result, source: source.replace(needle, 'return { ...ledger, conversationUnchanged: () => true, describe(') };
} });
await import('../../demo/server.js');
