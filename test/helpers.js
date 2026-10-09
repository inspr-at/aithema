import { mkdir, mkdtemp } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { join } from 'node:path';
import { fork } from 'node:child_process';
import { once } from 'node:events';
import { MOCK_PROCESSING_SCOPE } from '@inspr/aithema-core';

export const testToken = 'test-visitor';
export const mockConsent = { coverage({ consentRevision }) {
  return { covered: true, ...MOCK_PROCESSING_SCOPE, consentRevision, expiresAt: Date.now() + 60_000 };
} };
export function ownedRequest(url, init = {}) {
  return new Request(url, { ...init, headers: { 'x-aithema-session-token': testToken, ...init.headers } });
}
export function sessionFetch(url, init = {}) {
  return fetch(url, { ...init, headers: { 'x-aithema-session-token': testToken, ...init.headers } });
}

export async function temporaryDb() {
  const root = fileURLToPath(new URL('../.data/', import.meta.url));
  await mkdir(root, { recursive: true });
  return join(await mkdtemp(join(root, 'test-')), 'session.sqlite');
}
export async function startChild(file, db, settings = {}) {
  // Explicit environment excludes inherited provider credentials. No live provider calls.
  const child = fork(file, [], { env: { PATH: process.env.PATH, PORT: '0', AITHEMA_DB: db, ...settings }, silent: true });
  child.stdout.resume(); child.stderr.resume();
  const message = await Promise.race([once(child, 'message').then(([value]) => value),
    once(child, 'exit').then(() => { throw new Error('Server child exited before ready'); })]);
  return { child, url: message.url, async kill(signal = 'SIGTERM') {
    if (child.exitCode !== null || child.signalCode !== null) return;
    const exited = once(child, 'exit'); child.kill(signal); await exited;
  } };
}
export async function post(url, value, headers = {}) {
  return sessionFetch(url, { method: 'POST', headers: { 'content-type': 'application/json', ...headers }, body: JSON.stringify(value) });
}
export async function waitForSession(url, predicate) {
  for (let i = 0; i < 200; i++) {
    const session = await sessionFetch(url).then(r => r.json()); if (predicate(session)) return session;
    await new Promise(r => setTimeout(r, 10));
  }
  throw new Error('Session did not reach expected state');
}
export async function readEvents(response, count) {
  const reader = response.body.getReader(), decoder = new TextDecoder(), events = []; let buffer = '';
  try {
    while (events.length < count) {
      const { done, value } = await reader.read(); if (done) break;
      buffer += decoder.decode(value, { stream: true }); let index;
      while ((index = buffer.indexOf('\n\n')) >= 0) {
        const block = buffer.slice(0, index); buffer = buffer.slice(index + 2);
        const data = block.split('\n').find(l => l.startsWith('data:'));
        if (data) events.push(JSON.parse(data.slice(5)));
      }
    }
    return events;
  } finally { await reader.cancel(); }
}
export function unzip(bytes) {
  const data = Buffer.from(bytes), files = {}; let offset = 0;
  while (data.readUInt32LE(offset) === 0x04034b50) {
    const size = data.readUInt32LE(offset + 18), nameSize = data.readUInt16LE(offset + 26), extra = data.readUInt16LE(offset + 28);
    const name = data.subarray(offset + 30, offset + 30 + nameSize).toString(); const start = offset + 30 + nameSize + extra;
    files[name] = data.subarray(start, start + size).toString(); offset = start + size;
  }
  if (data.readUInt32LE(offset) !== 0x02014b50 || data.readUInt32LE(data.length - 22) !== 0x06054b50) throw new Error('Invalid ZIP directory');
  return files;
}
