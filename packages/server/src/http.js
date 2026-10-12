import { createServer } from 'node:http';
import { once } from 'node:events';
import { PassThrough, Readable } from 'node:stream';

const DISCARD_BYTES = 65_536, DISCARD_MS = 1_000;
// A small FormData body is sent in several writes. Closing on an early 4xx
// races its final boundary and can turn the refusal into a client-side EPIPE.
// Discard only a bounded declared body, without retaining it, and never let a
// stalled sender or an unbounded upload hold the response indefinitely.
function finishSmallRequest(incoming, body) {
  const length = incoming.headers['content-length'];
  if (!/^\d+$/u.test(length ?? '') || Number(length) > DISCARD_BYTES || incoming.destroyed) return false;
  return new Promise(resolve => {
    const ended = () => done(true), refused = () => done(false);
    const done = complete => {
      clearTimeout(timer);
      incoming.off('end', ended); incoming.off('aborted', refused); incoming.off('error', refused);
      if (!complete) incoming.pause();
      resolve(complete);
    };
    const timer = setTimeout(refused, DISCARD_MS);
    incoming.once('end', ended); incoming.once('aborted', refused); incoming.once('error', refused);
    incoming.unpipe(body); body.destroy(); incoming.resume();
  });
}

export function httpAdapter(handle) {
  return async (incoming, outgoing) => {
    const controller = new AbortController();
    incoming.once('aborted', () => controller.abort());
    outgoing.once('close', () => controller.abort());
    let body;
    try {
      const headers = new Headers();
      for (let i = 0; i < incoming.rawHeaders.length; i += 2) headers.append(incoming.rawHeaders[i], incoming.rawHeaders[i + 1]);
      if (!['GET', 'HEAD'].includes(incoming.method)) {
        // Cancelling Readable.toWeb(incoming) destroys the HTTP request and aborts the handler
        // before it can reply with 413. Cancelling this bounded bridge only unpipes the upload.
        body = new PassThrough({ highWaterMark: 65_536 });
        incoming.once('error', error => body.destroy(error));
        incoming.pipe(body);
      }
      const request = new Request(`http://localhost${incoming.url}`, { method: incoming.method, headers,
        signal: controller.signal, ...(body ? {
          body: Readable.toWeb(body, { strategy: { highWaterMark: 65_536, size: chunk => chunk.byteLength } }), duplex: 'half',
        } : {}) });
      const response = await handle(request);
      const responseHeaders = Object.fromEntries(response.headers);
      // Finish small rejected bodies before responding. A successful streaming
      // response can still own the request body, so it keeps the existing path.
      if (body && !incoming.complete) {
        const finished = response.status >= 400 && await finishSmallRequest(incoming, body);
        if (!finished) responseHeaders.connection = 'close';
      }
      outgoing.writeHead(response.status, responseHeaders);
      if (!response.body) { outgoing.end(); return; }
      const reader = response.body.getReader();
      const cancel = () => { void reader.cancel().catch(() => {}); };
      controller.signal.addEventListener('abort', cancel, { once: true });
      try {
        while (!controller.signal.aborted) {
          const { done, value } = await reader.read();
          if (done) break;
          if (!outgoing.write(value)) await once(outgoing, 'drain', { signal: controller.signal });
        }
      } finally { controller.signal.removeEventListener('abort', cancel); await reader.cancel().catch(() => {}); }
      outgoing.end();
    } catch {
      if (!outgoing.headersSent) outgoing.writeHead(500, { 'content-type': 'application/json', 'connection': 'close' });
      outgoing.end('{"error":"server-error"}');
    } finally {
      if (body) { incoming.unpipe(body); body.destroy(); }
    }
  };
}
export async function listen(handle, { port = 0, hostname = '127.0.0.1' } = {}) {
  const server = createServer(httpAdapter(handle));
  server.listen(port, hostname);
  await once(server, 'listening');
  return { server, url: `http://${hostname}:${server.address().port}` };
}
