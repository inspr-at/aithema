// Fixture-only host port: acknowledge an in-place grant without invalidating the conversation.
// Keep the real demo, storage, reducer, routes and free local image implementation.
import assert from 'node:assert/strict';
import { registerHooks } from 'node:module';

const consentURL = new URL('../../demo/mock-consent.js', import.meta.url).href;
const smtpURL = new URL('../../plugins/mail-smtp/src/index.js', import.meta.url).href;
const creditsURL = new URL('../../demo/visitor-credits.js', import.meta.url).href;
const serverURL = new URL('../../demo/server.js', import.meta.url).href;
registerHooks({ load(url, context, nextLoad) {
  const result = nextLoad(url, context);
  if (url === consentURL && process.env.AIT470_INPLACE === '1') {
    const source = String(result.source), needle = 'return { ...ledger, describe(';
    assert.ok(source.includes(needle), 'fixture consent port still matches the demo');
    return { ...result, source: source.replace(needle, 'return { ...ledger, conversationUnchanged: () => true, describe(') };
  }
  if (url === creditsURL && process.env.AIT470_STABLE_TIER === '1') {
    const source = String(result.source), needle = 'row?.address && row.confirmed_at !== null && current.confirmationEnabled && deliveryEnabled';
    assert.ok(source.includes(needle), 'fixture credit tier still matches the demo policy');
    // The reviewed deterministic-fault alternative: confirmation still projects
    // verified identity, but keeps the pre-confirmation allowance and tier.
    return { ...result, source: source.replace(needle, 'false') };
  }
  if (url === smtpURL && process.env.AIT470_SMTP_PORT) {
    const source = String(result.source), needle = 'getSocket, htmlTemplate';
    assert.ok(source.includes(needle), 'fixture SMTP socket injection still matches the plugin');
    // Preserve the qualified port-25 configuration; connect its supported test socket
    // to the ephemeral loopback sink instead of requiring a privileged listener.
    return { ...result, source: `import { connect as fixtureConnect } from 'node:net';\n` + source.replace(needle,
      `getSocket = (options, done) => {
        const socket = fixtureConnect(Number(process.env.AIT470_SMTP_PORT), '127.0.0.1');
        const fail = error => done(error); socket.once('error', fail);
        socket.once('connect', () => { socket.removeListener('error', fail); done(null, { connection: socket }); });
      }, htmlTemplate`) };
  }
  if (url === serverURL && process.env.AIT470_INPLACE) {
    const source = String(result.source), needle = '  const grokResponse = await grokHost?.handle?.(request);';
    assert.ok(source.includes(needle), 'fixture confirmation port still follows the deployment gate');
    // A host's mail page records evidence; only the conversation's unlock poll
    // reduces it. Use the demo's token ledger, without persisting verified identity.
    return { ...result, source: source.replace(needle, `
      if (request.method === 'POST' && new URL(request.url).pathname === '/fixture-confirm-email') {
        const form = await request.formData(), sessionId = form.get('sessionId');
        const ownerToken = ownership.token(request), session = storage.authorize(sessionId, ownerToken);
        const state = storage.hostState(sessionId).identity;
        const verified = host.visitorCredits.verifyToken({ ownerHash: session.ownerHash,
          address: state.address, revision: state.verificationRevision, token: form.get('token') });
        return new Response(verified ? '<h1>Confirmed</h1>' : '<h1>Failed</h1>', {
          status: verified ? 200 : 400, headers: { 'content-type': 'text/html' } });
      }
${needle}`) };
  }
  return result;
} });
await import('../../demo/server.js');
