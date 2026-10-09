#!/usr/bin/env node
import { SQLiteStorage, createHandlers, createMemoryConsentLedger } from '../src/index.js';
import { listen } from '../src/http.js';
const storage = new SQLiteStorage(process.env.AITHEMA_DB ?? ':memory:');
const handlers = createHandlers({ storage, consent: createMemoryConsentLedger() });
await handlers.resume();
const { server, url } = await listen(handlers.handle, { port: Number(process.env.PORT ?? 3000) });
console.log(`Aithema reset slice 1 — mock reasoning: ${url}`);
process.send?.({ url });
async function close() {
  server.close(); await handlers.close(); server.closeAllConnections(); storage.close();
}
process.once('SIGTERM', () => void close());
process.once('SIGINT', () => void close());
