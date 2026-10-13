import { createServer, request } from 'node:http';
import { createConnection } from 'node:net';
import { mkdir, chmod, lstat, unlink } from 'node:fs/promises';
import { dirname, isAbsolute } from 'node:path';
import { userInfo } from 'node:os';

export const CAP_RECOVERY = 'Investigate provider receipts, reconcile confirmed and unresolved liabilities, and fix the overrun cause. '
  + 'OPS then performs an approved, audited maintenance recovery, preserving historical evidence and carrying confirmed and unresolved liabilities forward. '
  + 'Restarting or raising the deployment cap cannot clear a historical reservation breach; there is no routine reset command.';

/** Dedicated local transport. It is never mounted on the public host listener. */
export async function listenAdmin({ host, spendCap, socketPath }) {
  if (!host?.visitorCredits || !isAbsolute(socketPath)) throw new TypeError('Invalid admin socket');
  if (Buffer.byteLength(socketPath) > (process.platform === 'linux' ? 107 : 103)) {
    throw new TypeError('Admin socket path is too long; set AITHEMA_ADMIN_SOCKET to a shorter absolute path');
  }
  const account = userInfo(), directory = dirname(socketPath);
  await mkdir(directory, { recursive: true, mode: 0o700 });
  const dir = await lstat(directory);
  if (!dir.isDirectory() || dir.isSymbolicLink() || dir.uid !== account.uid) throw new Error('Admin directory must belong to the service account');
  await chmod(directory, 0o700);
  let previous;
  try { previous = await lstat(socketPath); } catch (error) { if (error.code !== 'ENOENT') throw error; }
  if (previous) {
    if (!previous.isSocket() || previous.uid !== account.uid) throw new Error('Admin socket path is not an owned socket');
    const active = await new Promise((resolve, reject) => {
      const connection = createConnection(socketPath);
      connection.setTimeout(1000, () => { connection.destroy(); reject(new Error('Admin socket is busy')); });
      connection.once('connect', () => { connection.destroy(); resolve(true); });
      connection.once('error', error => ['ECONNREFUSED', 'ENOENT'].includes(error.code) ? resolve(false) : reject(error));
    });
    if (active) throw new Error('Admin socket is already in use');
    await unlink(socketPath);
  }
  const actor = `ops-cli:${account.username}`;
  const server = createServer({ maxHeaderSize: 2048 }, async (req, res) => {
    const send = (body, status = 200) => { res.writeHead(status, { 'content-type': 'application/json', 'cache-control': 'no-store' }); res.end(JSON.stringify(body)); };
    try {
      const url = new URL(req.url, 'http://localhost');
      if (url.pathname === '/settings' && req.method === 'GET') return send(host.visitorCredits.settings());
      if (url.pathname === '/audit' && req.method === 'GET') {
        if ([...url.searchParams.keys()].some(key => !['after', 'limit'].includes(key))) throw new TypeError('Invalid audit page');
        const items = host.visitorCredits.audit({ after: Number(url.searchParams.get('after') ?? 0), limit: Number(url.searchParams.get('limit') ?? 100) });
        return send({ items, nextAfter: items.at(-1)?.id ?? Number(url.searchParams.get('after') ?? 0) });
      }
      if (url.pathname === '/provider-cap' && req.method === 'GET') {
        if (!spendCap) return send({ available: false, capMicro: null, confirmedMicro: null, reservedMicro: null,
          uncertainMicro: null, remainingMicro: null, breached: null, recovery: CAP_RECOVERY });
        const cap = spendCap.snapshot();
        return send({ available: true, capMicro: cap.capMicro, confirmedMicro: cap.spentMicro, reservedMicro: cap.reservedMicro,
          uncertainMicro: cap.uncertainMicro, remainingMicro: Math.max(0, cap.capMicro - cap.spentMicro - cap.reservedMicro - cap.uncertainMicro),
          breached: cap.breached, recovery: CAP_RECOVERY });
      }
      if (['/set-allowances', '/set-confirmation'].includes(url.pathname) && req.method === 'POST') {
        let size = 0; const chunks = [];
        for await (const chunk of req) { size += chunk.length; if (size > 16_384) { send({ error: 'body-too-large' }, 413); req.destroy(); return; } chunks.push(chunk); }
        const input = JSON.parse(Buffer.concat(chunks).toString('utf8'));
        if (url.pathname === '/set-confirmation' && (Object.keys(input).some(k => !['baseRevision', 'confirmationEnabled'].includes(k)) || typeof input.confirmationEnabled !== 'boolean')) throw new TypeError('Invalid confirmation policy');
        return send(host.visitorCredits.saveSettings(input, { actor, source: 'ops-cli' }));
      }
      return send({ error: 'not-found' }, 404);
    } catch (error) {
      if (error.status === 409) return send({ error: 'stale-credit-settings', current: error.current }, 409);
      if (error instanceof TypeError || error instanceof SyntaxError) return send({ error: 'invalid-admin-command' }, 400);
      return send({ error: 'host-settings-unavailable' }, 503);
    }
  });
  server.requestTimeout = 10_000; server.headersTimeout = 5000; server.keepAliveTimeout = 1000;
  await new Promise((resolve, reject) => { server.once('error', reject); server.listen(socketPath, resolve); });
  try { await chmod(socketPath, 0o600); }
  catch (error) { server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); throw error; }
  return { socketPath, async close() { server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); } };
}

/** Client has no database dependency or direct-storage fallback. */
export function adminRequest(socketPath, command, payload) {
  return new Promise((resolve, reject) => {
    const set = ['set-allowances', 'set-confirmation'].includes(command);
    const query = command === 'audit' && payload ? `?${new URLSearchParams(payload)}` : '';
    const bytes = set ? Buffer.from(JSON.stringify(payload)) : null;
    const req = request({ socketPath, path: `/${command}${query}`, method: set ? 'POST' : 'GET',
      headers: bytes ? { 'content-type': 'application/json', 'content-length': bytes.length } : {} }, res => {
      const chunks = []; let size = 0;
      res.on('data', chunk => { size += chunk.length; if (size > 2_000_000) { req.destroy(new Error('Admin response too large')); return; } chunks.push(chunk); });
      res.once('error', reject);
      res.once('end', () => { try { resolve({ status: res.statusCode, body: JSON.parse(Buffer.concat(chunks).toString('utf8')) }); } catch (error) { reject(error); } });
    });
    req.setTimeout(5000, () => req.destroy(new Error('Admin request timed out; reload settings before retrying a save')));
    req.once('error', reject); req.end(bytes);
  });
}
