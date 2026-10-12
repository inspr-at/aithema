// Test bootstrap: even an accidental server-side provider dispatch fails locally.
import assert from 'node:assert/strict';
globalThis.fetch = async () => assert.fail('This server-start/consent test must never call a provider');
await import('../../demo/server.js');
