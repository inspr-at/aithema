import { PluginError } from '@inspr/aithema-core/invocation';
import { voxtralEndpoints } from './configuration.js';

const FRAME_BYTES = 256_000, QUEUE_BYTES = 512_000, QUEUE_FRAMES = 16;

/** Server-only ws-compatible constructor and fetch ports. The host owns network
 * dependencies; neither a global WebSocket nor global fetch is selected here.
 * maxPayload bounds ws reassembly before our own queue ever sees the message. */
export function createVoxtralTransports({ endpoint, WebSocket, fetchImpl } = {}) {
  const targets = voxtralEndpoints(endpoint);
  return Object.freeze({
    async connect({ url, headers, signal } = {}) {
      if (url !== targets.stt) throw new PluginError('not-admitted');
      if (typeof WebSocket !== 'function') throw new PluginError('unavailable');
      if (signal?.aborted) throw new PluginError(signal.reason?.name === 'TimeoutError' ? 'deadline' : 'cancelled');
      const socket = new WebSocket(url, { headers, maxPayload: FRAME_BYTES, perMessageDeflate: false, followRedirects: false });
      const opening = Promise.withResolvers();
      let queue = [], queuedBytes = 0, waiter, failure, closed = false, opened = false, sendPending;
      const wake = () => { const pending = waiter; waiter = undefined; pending?.(); };
      const close = (error, peerClosed = false) => {
        if (closed) return;
        closed = true; failure = error;
        if (!peerClosed || error) { queue = []; queuedBytes = 0; }
        signal?.removeEventListener('abort', abort);
        socket.off('open', onOpen); socket.off('message', onMessage); socket.off('close', onClose);
        socket.off('unexpected-response', onResponse);
        sendPending?.reject(error ?? new PluginError('provider', 'stt-socket-closed'));
        // Keep the error listener until ws closes: terminating an opening socket
        // can emit an asynchronous error, which must not become unhandled.
        if (peerClosed) socket.off('error', onError);
        else {
          socket.once('close', () => socket.off('error', onError));
          if (typeof socket.terminate === 'function') socket.terminate(); else socket.close();
        }
        if (!opened) opening.reject(error ?? new PluginError('provider', 'stt-socket-closed'));
        wake();
      };
      const abort = () => close(new PluginError(signal.reason?.name === 'TimeoutError' ? 'deadline' : 'cancelled'));
      const onOpen = () => { if (!closed) { opened = true; opening.resolve(); } };
      const onError = () => close(new PluginError('provider', 'stt-transport-failed'));
      const onClose = () => close(undefined, true);
      const onResponse = (_request, response) => {
        const status = response?.statusCode; response?.destroy?.();
        close(new PluginError([401, 403].includes(status) ? 'auth' : status === 429 ? 'rate-limit' : 'provider',
          'stt-handshake-rejected'));
      };
      const onMessage = (data, binary) => {
        if (closed) return;
        if (binary || !(typeof data === 'string' || data instanceof Uint8Array)) return close(new PluginError('invalid-output'));
        const size = typeof data === 'string' ? Buffer.byteLength(data) : data.byteLength;
        if (size > FRAME_BYTES || queue.length >= QUEUE_FRAMES || queuedBytes + size > QUEUE_BYTES) return close(new PluginError('limit'));
        const wire = typeof data === 'string' ? data : Buffer.from(data).toString('utf8');
        queue.push({ wire, size }); queuedBytes += size; wake();
      };
      socket.on('open', onOpen); socket.on('message', onMessage); socket.on('error', onError); socket.on('close', onClose); socket.on('unexpected-response', onResponse);
      signal?.addEventListener('abort', abort, { once: true });
      if (signal?.aborted) abort();
      await opening.promise;
      return Object.freeze({
        events: { [Symbol.asyncIterator]() { return this; }, async next() {
          if (waiter) throw new PluginError('limit');
          while (!closed && !queue.length) await new Promise(resolve => { waiter = resolve; });
          if (failure) throw failure;
          if (closed && !queue.length) return { done: true };
          const item = queue.shift(); queuedBytes -= item.size;
          return { done: false, value: item.wire };
        }, async return() { close(); return { done: true }; } },
        async send(wire) {
          if (failure) throw failure;
          if (closed) throw new PluginError('unavailable');
          if (sendPending || typeof wire !== 'string' || Buffer.byteLength(wire) > FRAME_BYTES || socket.bufferedAmount > QUEUE_BYTES - Buffer.byteLength(wire)) {
            close(new PluginError('limit')); throw failure;
          }
          const pending = Promise.withResolvers(); sendPending = pending;
          try {
            socket.send(wire, error => {
              if (error) { onError(); pending.reject(failure); } else pending.resolve();
            });
            await pending.promise;
            if (failure) throw failure;
          } finally { sendPending = undefined; }
        },
        close() { close(); },
      });
    },
    async fetchImpl(url, options) {
      if (url !== targets.tts || options?.method !== 'POST' || options.redirect !== 'error') throw new PluginError('not-admitted');
      if (typeof fetchImpl !== 'function') throw new PluginError('unavailable');
      return fetchImpl(url, options);
    },
  });
}
