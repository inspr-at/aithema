// Conversation-scoped identity with host tiers, independently of visitor email storage.
import { SQLiteStorage, createHandlers } from '../../packages/server/src/index.js';
import { mockConsent } from '../helpers.js';

export async function confirmationHost(t) {
  const storage = new SQLiteStorage(), deliveries = [];
  const allowancesMicro = { anonymous: 100_000_000, emailGiven: 100_000_000, emailConfirmed: 1_000_000_000 };
  const host = {
    demo: true,
    identity: {
      deliversVerification: true,
      async requestVerification(effect) { deliveries.push(effect); return { status: 'sent' }; },
      async verify({ address, revision, token }) {
        return { verified: token === 'fixture-confirmation', address, revision };
      },
    },
    creditTiers(ownerToken, { sessionId }) {
      const current = storage.hostState(sessionId)?.identity?.status === 'verified' ? 'emailConfirmed' : 'anonymous';
      return { current, next: current === 'anonymous' ? 'emailConfirmed' : null, canConfirm: true, allowancesMicro };
    },
  };
  const handlers = createHandlers({ storage, consent: mockConsent, host });
  t.after(async () => { await handlers.close(); storage.close(); });
  const request = async (path, body) => {
    const response = await handlers.handle(new Request(`http://local${path}`, {
      method: body === undefined ? 'GET' : path === '/api/visitor/email' ? 'PUT' : 'POST',
      headers: { 'x-aithema-session-token': 'confirmation-owner', 'content-type': 'application/json' },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    }));
    return { ok: response.ok, status: response.status, body: await response.json() };
  };
  const session = (await request('/api/sessions', {})).body;
  const calls = [];
  const call = async (path, body) => {
    calls.push({ path, body });
    return request(path.startsWith('/api/') ? path : `/api/sessions/${session.id}/${path}`, body);
  };
  const tiers = () => host.creditTiers('confirmation-owner', { sessionId: session.id });
  return { session, call, calls, deliveries, tiers };
}
