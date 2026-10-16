import WebSocket from 'ws';
import { PluginError } from '@inspr/aithema-core/invocation';
import { TTS_WIRE_CHARACTERS } from '../../elevenlabs/src/components.js';

// Carry the full component wire bound plus 16 KiB envelope headroom. Retain at
// most two maximum messages: the eager reader normally leaves near one queued,
// with room for one coalesced arrival. Relay/player bounds are independent.
// Outbound bufferedAmount keeps its 256,000 B cap. No socket/error/URL logging.
const MAX_PAYLOAD_BYTES = TTS_WIRE_CHARACTERS + 16_384;
const MAX_BACKLOG_BYTES = 2 * MAX_PAYLOAD_BYTES;
export function connectQualificationSocket({ url, headers, signal }) {
  return new Promise((resolve, reject) => {
    let socket, open = false, ended = false, failure, queuedBytes = 0, wake, requestId;
    const queue = [], stopped = Promise.withResolvers();
    const notify = () => { wake?.(); wake = undefined; };
    const fail = () => { failure = new PluginError('provider'); reject(failure); socket?.terminate(); };
    const abort = () => { failure = new PluginError('cancelled'); socket?.terminate(); reject(failure); notify(); };
    if (signal?.aborted) { reject(new PluginError('cancelled')); return; }
    try { socket = new WebSocket(url, { headers, followRedirects: false, maxPayload: MAX_PAYLOAD_BYTES, handshakeTimeout: 15_000 }); }
    catch { reject(new PluginError('provider')); return; }
    signal?.addEventListener('abort', abort, { once: true });
    socket.on('error', fail);
    // Retain only the documented provider request-id, never all upgrade headers.
    socket.once('upgrade', response => {
      const value = response.headers['request-id'];
      if (typeof value === 'string' && /^[A-Za-z0-9_-]{1,128}$/u.test(value)) requestId = value;
    });
    socket.on('close', () => { ended = true; signal?.removeEventListener('abort', abort); stopped.resolve(); notify();
      if (!open) reject(new PluginError('provider')); });
    socket.on('message', (bytes, binary) => {
      if (binary || (queuedBytes += bytes.length) > MAX_BACKLOG_BYTES) { fail(); return; }
      queue.push(bytes); notify();
    });
    socket.once('open', () => {
      open = true;
      resolve({
        requestId: requestId ?? null,
        send(wire) { return new Promise((sent, refused) => {
          if (signal?.aborted || socket.readyState !== WebSocket.OPEN || socket.bufferedAmount > 256_000) { refused(new PluginError('unavailable')); return; }
          socket.send(wire, error => error ? refused(new PluginError('provider')) : sent());
        }); },
        async close() {
          socket.terminate(); await stopped.promise;
        },
        events: {
          [Symbol.asyncIterator]() { return this; },
          async next() {
            while (!ended && !failure && !queue.length) await new Promise(resolve => { wake = resolve; });
            if (failure) throw failure;
            if (!queue.length) return { done: true };
            const bytes = queue.shift(); queuedBytes -= bytes.length;
            return { value: bytes.toString('utf8'), done: false };
          },
          async return() { socket.terminate(); await stopped.promise; return { done: true }; },
        },
      });
    });
  });
}
