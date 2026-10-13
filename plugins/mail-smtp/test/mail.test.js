import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Duplex } from 'node:stream';

// Actual SMTP dialogue over a Duplex: no listener, DNS or network connection.
function smtpSink(messages, commands) {
  let buffer = '', data = false, content = '';
  const socket = new Duplex({ read() {}, write(bytes, encoding, done) {
    buffer += bytes.toString();
    while (buffer.includes('\r\n')) {
      const end = buffer.indexOf('\r\n'), line = buffer.slice(0, end); buffer = buffer.slice(end + 2);
      if (data) {
        if (line === '.') { messages.push(content); content = ''; data = false; socket.push('250 accepted\r\n'); }
        else content += line + '\r\n';
      } else {
        commands.push(line.split(' ')[0]);
        if (/^EHLO/u.test(line)) socket.push('250-sink\r\n250 PIPELINING\r\n');
        else if (line === 'DATA') { data = true; socket.push('354 send message\r\n'); }
        else if (line === 'QUIT') { socket.push('221 bye\r\n'); socket.push(null); }
        else socket.push('250 ok\r\n');
      }
    }
    done();
  } });
  socket.setTimeout = () => socket;
  setImmediate(() => socket.push('220 sink ESMTP\r\n'));
  return socket;
}
const values = { SMTP_HOST: 'localhost', SMTP_PORT: '25', SMTP_ALLOW_PLAINTEXT_LOCAL_RELAY: 'true', SMTP_FROM: 'sender@example.test', SMTP_FROM_NAME: 'Test Host', SMTP_REPLY_TO: 'reply@example.test' };

test('C1 SMTP sink receives DE/EN headers and multipart text/HTML without remote resources or logs', async t => {
  const { smtpConfig, createSmtpMail } = await import('../src/index.js');
  const messages = [], commands = [], logs = [];
  t.mock.method(console, 'log', (...args) => logs.push(args)); t.mock.method(console, 'error', (...args) => logs.push(args));
  const plugin = createSmtpMail({ config: smtpConfig(values), publicOrigin: 'https://public.example.test', getSocket: (options, cb) => cb(null, { connection: smtpSink(messages, commands) }) });
  t.after(() => plugin.close());
  for (const locale of ['de', 'en']) assert.equal((await plugin.requestVerification({ address: 'visitor@example.test', token: `request.${locale}-opaque-token`, locale, expiresAt: Date.now() + 1_800_000 })).status, 'sent');
  assert.equal(messages.length, 2); assert.equal(commands.includes('AUTH'), false);
  for (const raw of messages) {
    assert.match(raw, /From: Test Host <sender@example.test>/u); assert.match(raw, /Reply-To: reply@example.test/u);
    assert.match(raw, /To: visitor@example.test/u); assert.match(raw, /multipart\/alternative/u); assert.match(raw, /text\/plain/u); assert.match(raw, /text\/html/u);
    const decoded = raw.replace(/=\r\n/gu, '').replace(/=([A-F0-9]{2})/gu, (_, x) => String.fromCharCode(parseInt(x, 16)));
    assert.match(decoded, /https:\/\/public.example.test\/confirm-email\?token=/u);
    assert.doesNotMatch(decoded, /<(?:img|script|link|iframe)|url\(|@import/iu);
  }
  assert.match(messages[1], /Subject: Confirm your email address/u);
  assert.deepEqual(logs, []);
});

test('C1 SMTP config has value-free secret references, safe TLS defaults and missing-config behavior', async () => {
  const { smtpConfig, createSmtpMail } = await import('../src/index.js');
  assert.equal(smtpConfig({}), null);
  const cfg = smtpConfig({ ...values, SMTP_USER: 'test-user', SMTP_PASS: 'synthetic-secret-do-not-log' });
  assert.equal(cfg.secretRef, 'SMTP_PASS'); assert.equal(JSON.stringify(cfg).includes('synthetic-secret-do-not-log'), false);
  assert.throws(() => smtpConfig({ ...values, SMTP_HOST: 'relay.public.example', SMTP_ALLOW_PLAINTEXT_LOCAL_RELAY: 'true' }), /local|private/iu);
  assert.throws(() => smtpConfig({ ...values, AITHEMA_MAIL_TRANSPORT: 'console' }, { production: true }), /SMTP|production/iu);
  let options;
  const plugin = createSmtpMail({ config: smtpConfig({ ...values, SMTP_PORT: '587', SMTP_ALLOW_PLAINTEXT_LOCAL_RELAY: 'false', SMTP_USER: 'test-user' }), publicOrigin: 'https://public.example.test', resolveSecret: ref => { assert.equal(ref, 'SMTP_PASS'); return 'synthetic-secret-do-not-log'; }, createTransport: opts => { options = opts; return { async sendMail() { throw new Error('synthetic-secret-do-not-log visitor@example.test'); }, close() {} }; } });
  await assert.rejects(() => plugin.requestVerification({ address: 'visitor@example.test', token: 'opaque', locale: 'en', expiresAt: Date.now() + 1_800_000 }), error => error.message === 'Confirmation delivery failed');
  assert.equal(options.requireTLS, true); assert.equal(options.ignoreTLS, false); assert.equal(options.logger, false); assert.equal(options.debug, false);
  assert.equal(options.auth.pass, 'synthetic-secret-do-not-log'); plugin.close();
});
