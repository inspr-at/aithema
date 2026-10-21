// Subprocess isolation lets the parent observe a stuck hook without leaking its
// server/socket into the unit worker. No browser or provider is started here.
import { createServer } from 'node:http';
import { connect } from 'node:net';
import { once } from 'node:events';
import { test } from 'node:test';
import { closeConsentFixture } from './consent-teardown.js';

test('AIT-364: cross-tab single-item consent withdrawal removes HTML and images', async t => {
  const server = createServer();
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const accepted = once(server, 'connection');
  const socket = connect(server.address().port, '127.0.0.1');
  await once(socket, 'connect');
  await accepted;
  const browser = {
    close: () => process.argv[2] === 'browser-hang' ? new Promise(() => {}) : Promise.resolve(),
    browser: () => ({ process: () => ({ kill: signal => console.log(`owned Chrome terminated: ${signal}`) }) }),
  };
  if (process.argv[2] === 'server-hang') {
    const close = server.close.bind(server);
    server.close = () => close(); // Close the listener but deliberately lose its completion callback.
  }
  t.after(() => closeConsentFixture({ browser, server, streams: new Set() }, { timeout: 25 }));
  // Leave an accepted TCP connection with no HTTP headers, as Chrome can do
  // while the shared browser remains alive after this fixture's pages close.
  console.log('forced teardown probe reached');
});
