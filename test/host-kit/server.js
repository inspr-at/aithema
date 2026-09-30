import { createServer } from 'node:http';
import { errorResponse, HostError } from './protocol.js';

/**
 * Loopback only, ephemeral port only, and no outbound sockets. Authorization
 * uses Bearer JWTs; fixture person sessions use a separate opaque cookie.
 * Intake writes additionally send X-Live-Grant, Idempotency-Key and X-Aithema-Intake.
 * Returns { server, url, close }; callers must await close() in test teardown.
 */
export async function serveHost(host) {
  const server = createServer(async (req, res) => {
    try {
      const chunks = [];
      let length = 0;
      for await (const chunk of req) {
        length += chunk.length;
        if (length > 1024 * 1024) throw new HostError(413, 'Request exceeds 1 MiB');
        chunks.push(chunk);
      }
      const auth = req.headers.authorization;
      if (auth !== undefined && !/^Bearer [A-Za-z0-9_.-]+$/.test(auth)) throw new HostError(401, 'Invalid bearer authorization');
      const cookies = (req.headers.cookie ?? '').split(';').map((cookie) => cookie.trim());
      const people = cookies.filter((cookie) => cookie.startsWith('host_person='));
      if (people.length > 1) throw new HostError(400, 'Duplicate person session');
      let bytes;
      try { bytes = new TextDecoder('utf-8', { fatal: true }).decode(Buffer.concat(chunks)); }
      catch { throw new HostError(400, 'Invalid UTF-8 request'); }
      const response = host.request({ method: req.method, path: req.url,
        ...(auth === undefined ? {} : { token: auth.slice(7) }),
        person: people[0]?.slice('host_person='.length),
        opKey: req.headers['idempotency-key'], liveGrant: req.headers['x-live-grant'],
        intakeMetadata: req.headers['x-aithema-intake'],
        ...(bytes === '' ? {} : { body: bytes }),
      });
      res.writeHead(response.status, { 'content-type': 'application/json; charset=utf-8', ...response.headers });
      res.end(JSON.stringify(response.body));
    } catch (error) {
      // Unexpected programming errors are visible as 500, not false successes.
      const response = error instanceof HostError ? errorResponse(error) : { status: 500, body: { message: 'Mock host internal error' } };
      if (!res.headersSent) res.writeHead(response.status, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' });
      res.end(JSON.stringify(response.body));
    }
  });
  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {
      server.off('error', reject);
      resolve();
    });
  });
  const address = server.address();
  return { server, url: `http://127.0.0.1:${address.port}`,
    close: () => new Promise((resolve, reject) => server.close((error) => error ? reject(error) : resolve())),
  };
}
