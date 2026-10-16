import { test } from 'node:test';
import assert from 'node:assert/strict';
import { once } from 'node:events';
import { WebSocketServer } from 'ws';
import { TTS_WIRE_CHARACTERS } from '../../elevenlabs/src/components.js';
import { connectQualificationSocket } from '../ops/qualification-live-transport.mjs';

// Assert the transport's receive contract independently of its implementation.
const maxPayload = TTS_WIRE_CHARACTERS + 16_384, maxBacklog = 2 * maxPayload;

async function pair(t) {
  const server = new WebSocketServer({ host: '127.0.0.1', port: 0 });
  t.after(async () => {
    for (const peer of server.clients) peer.terminate();
    await new Promise(resolve => server.close(resolve));
  });
  await once(server, 'listening');
  const connected = once(server, 'connection');
  const socket = await connectQualificationSocket({ url: `ws://127.0.0.1:${server.address().port}`, headers: {} });
  t.after(() => socket.close());
  const [peer] = await connected;
  peer.on('error', () => {});
  return { socket, peer };
}

for (const size of [720_000, 1_048_576]) test(`qualification socket delivers ${size} decoded TTS bytes intact`, { timeout: 10_000 }, async t => {
  const { socket, peer } = await pair(t);
  const audio = Buffer.alloc(size, Buffer.from([0x01, 0x80, 0xfe, 0x7f]));
  const wire = JSON.stringify({ audio: audio.toString('base64'), isFinal: true });
  assert.ok(Buffer.byteLength(wire) > 256_000);
  peer.send(wire);
  const message = await socket.events.next();
  assert.equal(message.done, false);
  assert.equal(message.value, wire);
  assert.deepEqual(Buffer.from(JSON.parse(message.value).audio, 'base64'), audio);
});

test('qualification socket accepts the receive bound including JSON headroom', { timeout: 10_000 }, async t => {
  const { socket, peer } = await pair(t);
  const wire = JSON.stringify({ isFinal: true }).padEnd(maxPayload, ' ');
  peer.send(wire);
  assert.deepEqual(await socket.events.next(), { value: wire, done: false });
});

test('qualification socket rejects a message one byte above the receive bound as provider', { timeout: 10_000 }, async t => {
  const { socket, peer } = await pair(t);
  peer.send('x'.repeat(maxPayload + 1));
  await assert.rejects(socket.events.next(), { name: 'PluginError', code: 'provider' });
});

test('qualification socket rejects unread backlog overflow from individually legal messages as provider', { timeout: 10_000 }, async t => {
  const { socket, peer } = await pair(t), closed = once(peer, 'close');
  // Each message also fits the former payload cap, so only unread accumulation
  // can fail this case. Do not start the reader until the transport closes.
  const wire = 'x'.repeat(128_000);
  for (let bytes = 0; bytes <= maxBacklog; bytes += wire.length) peer.send(wire);
  await closed;
  await assert.rejects(socket.events.next(), { name: 'PluginError', code: 'provider' });
});
