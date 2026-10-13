import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Duplex } from 'node:stream';

// Actual SMTP dialogue over a Duplex: no listener, DNS or network connection.
function smtpSink(messages, commands, failure = {}) {
  let buffer = '', data = false, content = '';
  const socket = new Duplex({ read() {}, write(bytes, encoding, done) {
    buffer += bytes.toString();
    while (buffer.includes('\r\n')) {
      const end = buffer.indexOf('\r\n'), line = buffer.slice(0, end); buffer = buffer.slice(end + 2);
      if (data) {
        if (line === '.') { messages.push(content); content = ''; data = false;
          socket.push(failure.command === 'END-DATA' ? `${failure.code} temporary failure visitor@example.test\r\n` : '250 accepted\r\n'); }
        else content += line + '\r\n';
      } else {
        commands.push(line.split(' ')[0]);
        if (/^EHLO/u.test(line)) socket.push('250-sink\r\n250 PIPELINING\r\n');
        else if (line.split(' ')[0] === failure.command) socket.push(`${failure.code} temporary failure visitor@example.test\r\n`);
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
  const plugin = createSmtpMail({ config: smtpConfig(values), publicOrigin: 'https://public.example.test',
    lookup: async () => [{ address: '127.0.0.1', family: 4 }],
    getSocket: (options, cb) => cb(null, { connection: smtpSink(messages, commands) }) });
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
  assert.throws(() => smtpConfig({ ...values, AITHEMA_MAIL_TRANSPORT: 'console' }, { production: true }), /SMTP|production/iu);
  let options;
  const plugin = createSmtpMail({ config: smtpConfig({ ...values, SMTP_PORT: '587', SMTP_ALLOW_PLAINTEXT_LOCAL_RELAY: 'false', SMTP_USER: 'test-user' }), publicOrigin: 'https://public.example.test', resolveSecret: ref => { assert.equal(ref, 'SMTP_PASS'); return 'synthetic-secret-do-not-log'; }, createTransport: opts => { options = opts; return { async sendMail() { throw new Error('synthetic-secret-do-not-log visitor@example.test'); }, close() {} }; } });
  await assert.rejects(() => plugin.requestVerification({ address: 'visitor@example.test', token: 'opaque', locale: 'en', expiresAt: Date.now() + 1_800_000 }), error => error.message === 'Confirmation delivery failed');
  assert.equal(options.requireTLS, true); assert.equal(options.ignoreTLS, false); assert.equal(options.logger, false); assert.equal(options.debug, false);
  assert.equal(options.tls.rejectUnauthorized, true);
  assert.equal(options.auth.pass, 'synthetic-secret-do-not-log'); plugin.close();
});

const effect = { address: 'visitor@example.test', token: 'opaque', locale: 'en', expiresAt: Date.now() + 1_800_000 };
for (const [code, command] of [[451, 'MAIL'], [452, 'RCPT'], [451, 'END-DATA']]) {
  test(`AIT-166 SMTP stub ${code} at ${command} is temporary, sanitized and never hot-retried`, async t => {
    const { smtpConfig, createSmtpMail } = await import('../src/index.js');
    const messages = [], commands = [], logs = []; let connections = 0;
    t.mock.method(console, 'warn', line => logs.push(JSON.parse(line)));
    const plugin = createSmtpMail({ config: smtpConfig(values), publicOrigin: 'https://public.example.test',
      lookup: async () => [{ address: '127.0.0.1', family: 4 }],
      getSocket: (options, cb) => { connections++; cb(null, { connection: smtpSink(messages, commands, { code, command }) }); } });
    t.after(() => plugin.close());
    await assert.rejects(() => plugin.requestVerification(effect), error => {
      assert.equal(error.message, 'Confirmation delivery failed');
      assert.equal(error.temporary, true);
      assert.equal(error.cause, undefined, 'SMTP reply must not escape through a cause');
      return true;
    });
    await new Promise(resolve => setTimeout(resolve, 100));
    assert.equal(connections, 1); assert.equal(commands.filter(c => c === 'MAIL').length, 1);
    assert.deepEqual(logs, [{ event: 'mail-delivery-failed', temporary: true }]);
    assert.doesNotMatch(JSON.stringify(logs), /@|opaque|token/iu);
  });
}

test('AIT-166 SMTP pool never requeues after a connection closes before its greeting', async t => {
  const { smtpConfig, createSmtpMail } = await import('../src/index.js');
  let connections = 0;
  const plugin = createSmtpMail({ config: smtpConfig(values), publicOrigin: 'https://public.example.test',
    lookup: async () => [{ address: '127.0.0.1', family: 4 }],
    getSocket: (options, cb) => {
      connections++;
      const socket = new Duplex({ read() {}, write(bytes, encoding, done) { done(); } });
      socket.setTimeout = () => socket;
      cb(null, { connection: socket });
      setImmediate(() => socket.destroy());
    } });
  t.after(() => plugin.close());
  await assert.rejects(() => plugin.requestVerification(effect), /Confirmation delivery failed/u);
  assert.equal(connections, 1, 'one reservation must not reconnect and hot-retry');
});
for (const host of ['10.attacker.example', '127.attacker.example', '192.168.attacker.example', '172.16.attacker.example', 'relay.local', 'relay']) {
  test(`C1 fix1 plaintext refuses public DNS addresses for ${host}`, async () => {
    const { smtpConfig, createSmtpMail } = await import('../src/index.js');
    let connected = false, resolved = false;
    const plugin = createSmtpMail({ config: smtpConfig({ ...values, SMTP_HOST: host }), publicOrigin: 'https://public.example.test',
      lookup: async (name, options) => { resolved = true; assert.equal(name, host); assert.equal(options.all, true); return [{ address: '203.0.113.42', family: 4 }]; },
      createTransport: () => { connected = true; return { async sendMail() {}, close() {} }; },
    });
    try { await assert.rejects(() => plugin.requestVerification(effect), /Confirmation delivery failed/u); }
    finally { plugin.close(); }
    assert.equal(resolved, true); assert.equal(connected, false);
  });
}

for (const addresses of [
  [{ address: '10.0.0.1', family: 4 }, { address: '203.0.113.42', family: 4 }],
  [{ address: '::1', family: 6 }, { address: '2001:db8::1', family: 6 }],
  [{ address: 'fe80::1', family: 6 }],
  [{ address: '100.64.0.1', family: 4 }],
  [{ address: '10.attacker.example', family: 4 }],
  [],
]) test(`C1 fix1 plaintext requires every resolved address to be private: ${JSON.stringify(addresses)}`, async () => {
  const { smtpConfig, createSmtpMail } = await import('../src/index.js');
  let connected = false;
  const plugin = createSmtpMail({ config: smtpConfig(values), publicOrigin: 'https://public.example.test', lookup: async () => addresses,
    createTransport: () => { connected = true; return { async sendMail() {}, close() {} }; },
  });
  try { await assert.rejects(() => plugin.requestVerification(effect), /Confirmation delivery failed/u); }
  finally { plugin.close(); }
  assert.equal(connected, false);
});

for (const ip of ['127.0.0.1', '10.0.0.1', '172.16.0.1', '172.31.255.255', '192.168.0.1', 'fc00::1', 'fdff::1', '::1']) {
  test(`C1 fix1 plaintext pins the verified IP ${ip} without a second DNS lookup`, async () => {
    const { smtpConfig, createSmtpMail } = await import('../src/index.js');
    let lookups = 0, transportOptions;
    const plugin = createSmtpMail({ config: smtpConfig({ ...values, SMTP_HOST: 'relay.private.test' }), publicOrigin: 'https://public.example.test',
      lookup: async () => { lookups++; return [{ address: lookups === 1 ? ip : '203.0.113.42', family: ip.includes(':') ? 6 : 4 }]; },
      createTransport: options => { transportOptions = options; return { async sendMail() {}, close() {} }; },
    });
    try { await plugin.requestVerification(effect); await plugin.requestVerification(effect); }
    finally { plugin.close(); }
    assert.equal(lookups, 1); assert.equal(transportOptions.host, ip);
    assert.equal(transportOptions.ignoreTLS, true); assert.equal(transportOptions.port, 25);
  });
}

test('C1 fix1 plaintext requires opt-in on port 25; other connections verify TLS certificates', async () => {
  const { smtpConfig, createSmtpMail } = await import('../src/index.js');
  assert.throws(() => smtpConfig({ ...values, SMTP_PORT: '587' }), /port 25/u);
  for (const [port, secure, requireTLS] of [['25', false, true], ['587', false, true], ['465', true, false]]) {
    let options;
    const plugin = createSmtpMail({ config: smtpConfig({ ...values, SMTP_PORT: port, SMTP_ALLOW_PLAINTEXT_LOCAL_RELAY: 'false' }),
      publicOrigin: 'https://public.example.test', createTransport: opts => { options = opts; return { async sendMail() {}, close() {} }; },
    });
    await plugin.requestVerification(effect); plugin.close();
    assert.equal(options.secure, secure); assert.equal(options.requireTLS, requireTLS);
    assert.equal(options.ignoreTLS, false); assert.equal(options.tls.rejectUnauthorized, true);
  }
});
