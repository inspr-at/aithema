import { createServer } from 'node:http';
import { once } from 'node:events';
import { PassThrough, Readable } from 'node:stream';

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
      // An early rejection must send its JSON before closing, without buffering/draining an unbounded upload.
      if (body && !incoming.complete) responseHeaders.connection = 'close';
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
