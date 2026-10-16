import { createServer, request } from 'node:http';
import { createConnection } from 'node:net';
import { mkdir, chmod, lstat, unlink } from 'node:fs/promises';
import { dirname, isAbsolute } from 'node:path';
import { userInfo } from 'node:os';
import { NotFoundError } from '@inspr/aithema-server';

import { readAdminSettings, readAdminMailCap, readProviderCap } from './admin-read.js';
export { CAP_RECOVERY } from './admin-read.js';

/** Dedicated local transport. It is never mounted on the public host listener. */
export async function listenAdmin({ host, spendCap, socketPath, reconcileUncertain, eraseSession }) {
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
      if (url.pathname === '/settings' && req.method === 'GET') return send(readAdminSettings(host));
      if (url.pathname === '/mail-cap' && req.method === 'GET') return send(readAdminMailCap(host));
      if (url.pathname === '/audit' && req.method === 'GET') {
        if ([...url.searchParams.keys()].some(key => !['after', 'limit'].includes(key))) throw new TypeError('Invalid audit page');
        const items = host.visitorCredits.audit({ after: Number(url.searchParams.get('after') ?? 0), limit: Number(url.searchParams.get('limit') ?? 100) });
        return send({ items, nextAfter: items.at(-1)?.id ?? Number(url.searchParams.get('after') ?? 0) });
      }
      if (url.pathname === '/provider-cap' && req.method === 'GET') return send(readProviderCap(spendCap));
      if (url.pathname === '/provider-cap-audit' && req.method === 'GET') {
        if (!spendCap) return send({ error: 'provider-cap-unavailable' }, 503);
        if ([...url.searchParams.keys()].some(key => !['after', 'limit'].includes(key))) throw new TypeError('Invalid provider cap audit page');
        const after = Number(url.searchParams.get('after') ?? 0);
        const items = spendCap.audit({ after, limit: Number(url.searchParams.get('limit') ?? 100) });
        return send({ items, nextAfter: items.at(-1)?.id ?? after });
      }
      if (url.pathname === '/erase-session' && req.method === 'POST') {
        let sessionId = null, visitor = null, result = 'erasure-failed';
        try {
          let size = 0; const chunks = [];
          for await (const chunk of req) {
            size += chunk.length;
            if (size > 16_384) { result = 'invalid-admin-command'; send({ error: result }, 413); req.destroy(); return; }
            chunks.push(chunk);
          }
          const input = JSON.parse(Buffer.concat(chunks).toString('utf8'));
          if (typeof input?.sessionId === 'string' && /^[a-zA-Z0-9_-]{1,128}$/u.test(input.sessionId)) sessionId = input.sessionId;
          if (input?.visitor === undefined || typeof input.visitor === 'boolean') visitor = input?.visitor ?? false;
          if (!input || typeof input !== 'object' || Array.isArray(input) || sessionId === null || visitor === null ||
            Object.keys(input).some(key => !['sessionId', 'visitor'].includes(key)) || url.search) throw new TypeError('Invalid erase request');
          if (!eraseSession) { result = 'erasure-unavailable'; return send({ error: result }, 503); }
          const receipt = await eraseSession({ sessionId, visitor });
          result = receipt.result;
          return send(receipt);
        } catch (error) {
          if (error instanceof TypeError || error instanceof SyntaxError) { result = 'invalid-admin-command'; return send({ error: result }, 400); }
          if (error instanceof NotFoundError) { result = 'not-found'; return send({ error: result, message: 'Session not found' }, 404); }
          if (error.status === 409 && ['voice-call-active', 'pending-dispatch'].includes(error.message)) {
            result = error.message; return send({ error: result }, 409);
          }
          result = 'erasure-failed'; return send({ error: result }, 503);
        } finally { host.visitorCredits.auditErasure({ sessionId, visitor, result }, { actor }); }
      }
      if (['/set-allowances', '/set-confirmation', '/set-mail-cap', '/set-mail-ip-cap', '/set-provider-cap', '/reset-provider-cap', '/reconcile-uncertain'].includes(url.pathname) && req.method === 'POST') {
        let size = 0; const chunks = [];
        for await (const chunk of req) { size += chunk.length; if (size > 16_384) { send({ error: 'body-too-large' }, 413); req.destroy(); return; } chunks.push(chunk); }
        const input = JSON.parse(Buffer.concat(chunks).toString('utf8'));
        if (['/set-provider-cap', '/reset-provider-cap'].includes(url.pathname)) {
          if (!spendCap) return send({ error: 'provider-cap-unavailable' }, 503);
          const change = url.pathname === '/reset-provider-cap' ? spendCap.resetSettings : spendCap.saveSettings;
          return send(change(input, { actor, source: 'ops-cli' }));
        }
        if (url.pathname === '/reconcile-uncertain') {
          if (!input || typeof input !== 'object' || Array.isArray(input) || Object.keys(input).some(k => !['apply', 'limit'].includes(k)) ||
            input.apply !== undefined && typeof input.apply !== 'boolean' ||
            input.limit !== undefined && (!Number.isSafeInteger(input.limit) || input.limit < 1 || input.limit > 100)) throw new TypeError('Invalid repair request');
          if (!reconcileUncertain) return send({ error: 'reconciliation-unavailable' }, 503);
          return send(await reconcileUncertain({ apply: input.apply ?? false, limit: input.limit ?? 10 }));
        }
        if (url.pathname === '/set-confirmation' && (Object.keys(input).some(k => !['baseRevision', 'confirmationEnabled'].includes(k)) || typeof input.confirmationEnabled !== 'boolean')) throw new TypeError('Invalid confirmation policy');
        if (url.pathname === '/set-mail-cap' && (!input || typeof input !== 'object' || Array.isArray(input) ||
          Object.keys(input).some(k => !['baseRevision', 'mailCap'].includes(k)) || !input.mailCap)) throw new TypeError('Invalid mail cap policy');
        if (url.pathname === '/set-mail-ip-cap' && (!input || typeof input !== 'object' || Array.isArray(input) ||
          Object.keys(input).some(k => !['baseRevision', 'mailIpCap'].includes(k)) || !input.mailIpCap)) throw new TypeError('Invalid IP mail cap policy');
        if (url.pathname === '/set-allowances' && (Object.hasOwn(input, 'mailCap') || Object.hasOwn(input, 'mailIpCap'))) throw new TypeError('Use the dedicated mail cap command');
        return send(host.visitorCredits.saveSettings(input, { actor, source: 'ops-cli' }));
      }
      return send({ error: 'not-found' }, 404);
    } catch (error) {
      if (error.status === 422) return send({ error: error.message, current: error.current }, 422);
      if (error.status === 409) return send({ error: error.message === 'stale-provider-cap-settings' ? error.message : 'stale-credit-settings', current: error.current }, 409);
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
    const set = ['set-allowances', 'set-confirmation', 'set-mail-cap', 'set-mail-ip-cap', 'set-provider-cap', 'reset-provider-cap', 'reconcile-uncertain', 'erase-session'].includes(command);
    const query = ['audit', 'provider-cap-audit'].includes(command) && payload ? `?${new URLSearchParams(payload)}` : '';
    const bytes = set ? Buffer.from(JSON.stringify(payload)) : null;
    const req = request({ socketPath, path: `/${command}${query}`, method: set ? 'POST' : 'GET',
      headers: bytes ? { 'content-type': 'application/json', 'content-length': bytes.length } : {} }, res => {
      const chunks = []; let size = 0;
      res.on('data', chunk => { size += chunk.length; if (size > 2_000_000) { req.destroy(new Error('Admin response too large')); return; } chunks.push(chunk); });
      res.once('error', reject);
      res.once('end', () => { try { resolve({ status: res.statusCode, body: JSON.parse(Buffer.concat(chunks).toString('utf8')) }); } catch (error) { reject(error); } });
    });
    req.setTimeout(command === 'reconcile-uncertain' ? 120_000 : 5000, () => req.destroy(new Error('Admin request timed out; reload settings before retrying a save')));
    req.once('error', reject); req.end(bytes);
  });
}
