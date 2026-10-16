import WebSocket from 'ws';
import { PluginError } from '@inspr/aithema-core/invocation';

// Same bounded wire size as components.js decode(); bounded retained backlog
// follows relay.js's 256,000-byte queue. No socket/error/URL logging.
export function connectQualificationSocket({ url, headers, signal }) {
  return new Promise((resolve, reject) => {
    let socket, open = false, ended = false, failure, queuedBytes = 0, wake;
    const queue = [], stopped = Promise.withResolvers();
    const notify = () => { wake?.(); wake = undefined; };
    const fail = () => { failure = new PluginError('provider'); reject(failure); socket?.terminate(); };
    const abort = () => { failure = new PluginError('cancelled'); socket?.terminate(); reject(failure); notify(); };
    if (signal?.aborted) { reject(new PluginError('cancelled')); return; }
    try { socket = new WebSocket(url, { headers, followRedirects: false, maxPayload: 256_000, handshakeTimeout: 15_000 }); }
    catch { reject(new PluginError('provider')); return; }
    signal?.addEventListener('abort', abort, { once: true });
    socket.on('error', fail);
    socket.on('close', () => { ended = true; signal?.removeEventListener('abort', abort); stopped.resolve(); notify();
      if (!open) reject(new PluginError('provider')); });
    socket.on('message', (bytes, binary) => {
      if (binary || (queuedBytes += bytes.length) > 256_000) { fail(); return; }
      queue.push(bytes); notify();
    });
    socket.once('open', () => {
      open = true;
      resolve({
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
