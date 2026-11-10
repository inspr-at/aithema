// Fixture-only host port: acknowledge an in-place grant without invalidating the conversation.
// Keep the real demo, storage, reducer, routes and free local image implementation.
import assert from 'node:assert/strict';
import { registerHooks } from 'node:module';

const consentURL = new URL('../../demo/mock-consent.js', import.meta.url).href;
const smtpURL = new URL('../../plugins/mail-smtp/src/index.js', import.meta.url).href;
registerHooks({ load(url, context, nextLoad) {
  const result = nextLoad(url, context);
  if (url === consentURL && process.env.AIT470_INPLACE === '1') {
    const source = String(result.source), needle = 'return { ...ledger, describe(';
    assert.ok(source.includes(needle), 'fixture consent port still matches the demo');
    return { ...result, source: source.replace(needle, 'return { ...ledger, conversationUnchanged: () => true, describe(') };
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
  return result;
} });
await import('../../demo/server.js');
