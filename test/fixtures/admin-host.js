// In-memory grants, accounting and delivery; no provider or external data.
import { SQLiteStorage } from '../../packages/server/src/index.js';
import { createOperatorSessions, createSQLiteOperatorStore } from '../../packages/server/src/operator-session.js';
import { createDemoHost } from '../../demo/host-ports.js';
import { createSpendCap } from '../../packages/server/src/spend-cap.js';

export async function adminFixture({ configured = true, delivery = true, origin = 'https://admin.host.test', name = 'Ada', subject = 'verified-subject' } = {}) {
  const { createAdminHTTP } = await import('../../demo/admin-http.js');
  const storage = new SQLiteStorage();
  let time = Date.parse('2026-10-14T20:00:00Z');
  const now = () => time;
  const host = createDemoHost({ storage, now, demo: false,
    ...(delivery ? { mailPlugin: { id: 'smtp', deliversVerification: true, requestVerification: async () => ({ status: 'sent' }) } } : {}) });
  const store = createSQLiteOperatorStore(storage.db);
  const provider = { label: 'Zitadel', sessionNamespace: 'stub-operator', allows: s => s === subject,
    begin: () => ({ pending: { state: 's'.repeat(43), nonce: 'n'.repeat(43), verifier: 'v'.repeat(64) }, url: origin + '/stub' }),
    complete: async () => ({ subject, name }) };
  const sessions = configured ? createOperatorSessions({ store, provider, publicOrigin: origin, now }) : null;
  const id = 'g'.repeat(43); store.issue(id, provider.sessionNamespace, { name, subject }, time + 8 * 60 * 60_000);
  const cookie = 'aithema-operator=' + id;
  const spendCap = createSpendCap({ storage, account: 'stub-spend', capMicro: 10_000_000 });
  const admin = createAdminHTTP({ host, spendCap, operatorSessions: sessions, publicOrigin: origin });
  const call = (path, input, options = {}) => admin.handle(new Request(origin + path, {
    method: input === undefined ? 'GET' : 'POST',
    headers: { cookie, ...(input === undefined ? {} : { origin, 'content-type': 'application/json' }), ...options.headers },
    ...(input === undefined ? {} : { body: typeof input === 'string' ? input : JSON.stringify(input) }), ...options,
  }));
  return { storage, host, store, sessions, provider, spendCap, admin, cookie, origin, call, now,
    setTime: at => { time = at; }, advance: ms => { time += ms; }, close: () => storage.close() };
}
