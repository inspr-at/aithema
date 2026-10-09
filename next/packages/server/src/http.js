import { createServer } from 'node:http';
import { once } from 'node:events';
import { Readable } from 'node:stream';

export function httpAdapter(handle) {
  return async (incoming, outgoing) => {
    const controller = new AbortController();
    incoming.once('aborted', () => controller.abort());
    outgoing.once('close', () => controller.abort());
    try {
      const headers = new Headers();
      for (let i = 0; i < incoming.rawHeaders.length; i += 2) headers.append(incoming.rawHeaders[i], incoming.rawHeaders[i + 1]);
      const request = new Request(`http://localhost${incoming.url}`, { method: incoming.method, headers,
        signal: controller.signal, ...(['GET', 'HEAD'].includes(incoming.method) ? {} : {
          body: Readable.toWeb(incoming), duplex: 'half',
        }) });
      const response = await handle(request);
      outgoing.writeHead(response.status, Object.fromEntries(response.headers));
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
      if (!outgoing.headersSent) outgoing.writeHead(500, { 'content-type': 'application/json' });
      outgoing.end('{"error":"server-error"}');
    }
  };
}
export async function listen(handle, { port = 0, hostname = '127.0.0.1' } = {}) {
  const server = createServer(httpAdapter(handle));
  server.listen(port, hostname);
  await once(server, 'listening');
  return { server, url: `http://${hostname}:${server.address().port}` };
}
