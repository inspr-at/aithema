import { readFile } from 'node:fs/promises';
import { listen } from '../../packages/server/src/http.js';
import { createComposedRelay } from '../../plugins/composed-voice/src/relay.js';
import { createComposedRelayRoute } from '../../plugins/composed-voice/src/network-relay.js';

// Entire fixture is local. Providers and secret resolvers do not exist here.
globalThis.fetch = () => { throw new Error('Fixture cannot contact providers'); };
const relays = new Map(), stats = { packets: 0, bytes: 0, generations: 0, pauses: 0, closes: 0, maxPacket: 0 };
let route;
const imports = {
  '@inspr/aithema-core/invocation': '/packages/core/src/invocation.js',
  '@inspr/aithema-core/live-voice': '/packages/core/src/live-voice.js',
  '@inspr/aithema-core/plugins': '/packages/core/src/plugins.js',
  '@inspr/aithema-core/voice-lifecycle-controller': '/packages/core/src/voice-lifecycle-controller.js',
  '@inspr/aithema-server/composed-voice/client': '/packages/server/src/composed/client.js',
  '@inspr/aithema-server/composed-voice/network-client': '/packages/server/src/composed/network-client.js',
  '@inspr/aithema-server/composed-voice/browser-audio': '/packages/server/src/composed/browser-audio.js',
};
const { server, url } = await listen(async request => {
  const path = new URL(request.url).pathname;
  if (path === '/composed/relay') return route.handle(request);
  if (path === '/grant') {
    const providerSessionId = `browser-${++stats.generations}`, at = Date.now();
    const relay = createComposedRelay({ callId: 'browser-call', providerSessionId, epoch: stats.generations,
      expiresAt: at + 60_000, spendDeadlineAt: at + 120_000, browserLivenessDeadlineAt: at + 60_000 });
    let packets = 0;
    relay.attach({
      receiveAudio(bytes) {
        stats.packets++; packets++; stats.bytes += bytes.length; stats.maxPacket = Math.max(stats.maxPacket, bytes.length);
        if (packets === 4) {
          const tone = new Uint8Array(9600), view = new DataView(tone.buffer);
          for (let i = 0; i < tone.length / 2; i++) view.setInt16(i * 2, Math.round(Math.sin(i / 10) * 4000), true);
          relay.audio({ bytes: tone, format: 'pcm_s16le', sampleRateHz: 24000, channels: 1, playbackRevision: 0, replyId: providerSessionId });
        }
      },
      pause: async () => { stats.pauses++; return { acknowledged: true, paused: true }; },
      resume: async () => ({ acknowledged: true, paused: false }),
      interrupt: async () => { relay.silence({ playbackRevision: 1, reason: 'barge-in' }); },
      heartbeat: async () => ({ acknowledged: true, browserLivenessDeadlineAt: Date.now() + 30_000 }),
      setInput: async () => {}, setOutput: async () => {}, close: async () => { stats.closes++; relay.close(); },
    });
    relays.set(providerSessionId, relay); return Response.json(relay.grant);
  }
  if (path === '/stats') return Response.json(stats);
  if (path === '/drop') { for (const relay of relays.values()) relay.close(); return Response.json({ ok: true }); }
  if (path === '/' || path === '/denied') return new Response('<!doctype html><script type="importmap">' + JSON.stringify({ imports }) + '</script><meta charset="utf-8"><link rel="icon" href="data:,"><style>*{font-family:Arial,sans-serif;animation:none!important;transition:none!important}body{padding:24px;background:#f8fafc;color:#172033}pre{white-space:pre-wrap}</style><h1>AIT-160 · physical media proof</h1><pre id="proof">Awaiting local fake-device evidence</pre>', { headers: { 'content-type': 'text/html', ...(path === '/denied' ? { 'permissions-policy': 'microphone=()' } : {}) } });
  if (!/^\/(?:plugins\/(?:composed-voice|grok-voice)\/src|packages\/(?:core\/src|server\/src\/composed))\/[a-z-]+\.js$/u.test(path)) return new Response(null, { status: 404 });
  try { return new Response(await readFile(new URL('../..' + path, import.meta.url)), { headers: { 'content-type': 'text/javascript' } }); }
  catch { return new Response(null, { status: 404 }); }
}, { hostname: '127.0.0.1', port: 0 });
route = createComposedRelayRoute({ origin: url, authenticate: request => request.headers.get('x-owner') === 'fixture-owner' ? 'fixture-owner' : null,
  authorize: async () => true, connect: grant => relays.get(grant.providerSessionId).connect(grant) });
process.send?.({ url });
process.once('SIGTERM', () => { route.close(); for (const relay of relays.values()) relay.close(); server.close(); server.closeAllConnections(); });
