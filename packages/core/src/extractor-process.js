// Gen-2 runtime/extract.js lifecycle, shared by PDF, Office and text plugins.
import { fork, execFile } from 'node:child_process';
import { readFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { createRequire } from 'node:module';
import { promisify } from 'node:util';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import { PluginError } from './invocation.js';
import { normalizeExtractorLimits, extractorLifetime, sniffDocument, unreadable, extractionResult } from './extractor.js';

const corePath = dirname(fileURLToPath(import.meta.url));
const offlineURL = new URL('./extractor-offline.js', import.meta.url);
const execute = promisify(execFile);
let pageBytes;
async function residentBytes(pid) {
  if (process.platform === 'linux') {
    // statm uses the host's actual page size (not necessarily 4096).
    pageBytes ??= execute('getconf', ['PAGESIZE'], { timeout: 1000, maxBuffer: 1024 }).then(({ stdout }) => {
      const value = Number(stdout.trim());
      if (!Number.isSafeInteger(value) || value < 1) throw new Error('Invalid page size');
      return value;
    });
    const [statm, size] = await Promise.all([readFile(`/proc/${pid}/statm`, 'utf8'), pageBytes]);
    const pages = Number(statm.trim().split(/\s+/u)[1]);
    if (!Number.isSafeInteger(pages) || pages < 0) throw new Error('Invalid RSS');
    return pages * size;
  }
  if (process.platform === 'darwin') {
    const { stdout } = await execute('/bin/ps', ['-o', 'rss=', '-p', String(pid)], { timeout: 1000, maxBuffer: 1024 });
    const kib = Number(stdout.trim());
    if (!stdout.trim() || !Number.isSafeInteger(kib) || kib < 0) throw new Error('Invalid RSS');
    return kib * 1024;
  }
  throw new Error('RSS monitoring unavailable');
}
const live = new Set(), waiting = [];
let occupied = false;
let deniedNetworkAttempts = 0;
export const activeExtractorProcessCount = () => live.size;
export const queuedExtractorProcessCount = () => waiting.length;
export const extractorNetworkAttemptCount = () => deniedNetworkAttempts;

function acquire({ signal, deadlineAt }) {
  return new Promise((resolveSlot, reject) => {
    let timer;
    const cleanup = () => { clearTimeout(timer); signal.removeEventListener('abort', abort); };
    const refuse = code => {
      const index = waiting.indexOf(start);
      if (index >= 0) waiting.splice(index, 1);
      cleanup(); reject(new PluginError(code));
    };
    const abort = () => refuse('cancelled');
    const start = () => {
      cleanup();
      if (signal.aborted) { reject(new PluginError('cancelled')); next(); return; }
      if (Date.now() >= deadlineAt) { reject(new PluginError('deadline')); next(); return; }
      occupied = true; resolveSlot();
    };
    if (signal.aborted) { reject(new PluginError('cancelled')); return; }
    if (Date.now() >= deadlineAt) { reject(new PluginError('deadline')); return; }
    if (!occupied) { start(); return; }
    waiting.push(start);
    signal.addEventListener('abort', abort, { once: true });
    timer = setTimeout(() => refuse('deadline'), Math.max(1, deadlineAt - Date.now()));
  });
}
function next() { occupied = false; waiting.shift()?.(); }

export async function runExtractorProcess(workerURL, bytes, mediaType, limits, lifetime, parserURL = workerURL, dependencies = {}) {
  await acquire(lifetime);
  let child;
  try {
    extractorLifetime(lifetime, limits);
    const workerPath = fileURLToPath(workerURL);
    child = fork(workerPath, [], { stdio: ['ignore', 'ignore', 'ignore', 'ipc'], serialization: 'advanced',
      // No inherited credentials, NODE_OPTIONS, preload hooks or shell environment.
      env: { NODE_NO_WARNINGS: '1' }, execArgv: [`--max-old-space-size=${limits.maxHeapMb}`, '--permission',
        `--allow-fs-read=${resolve(corePath, '..')}`, `--allow-fs-read=${dirname(workerPath)}`,
        `--allow-fs-read=${dirname(fileURLToPath(parserURL))}`,
        // Node checks package metadata through installation aliases before resolving symlinks.
        ...['@inspr/aithema-core', ...Object.keys(dependencies)].flatMap(name => createRequire(parserURL).resolve.paths(name)
          .map(path => resolve(path, name)).filter(existsSync)).map(path => `--allow-fs-read=${path}`),
        ...Object.values(dependencies).map(url => `--allow-fs-read=${dirname(fileURLToPath(url))}`), '--import', offlineURL.href] });
  } catch (error) { next(); throw error; }
  live.add(child);
  return new Promise((resolveResult, reject) => {
    let response, failure, timer, watchdog, settled = false;
    const kill = () => { if (!child.killed) child.kill('SIGKILL'); };
    const abort = () => { failure = new PluginError('cancelled'); kill(); };
    const deadline = () => { failure = new PluginError('deadline'); kill(); };
    lifetime.signal.addEventListener('abort', abort, { once: true });
    timer = setTimeout(deadline, Math.max(1, lifetime.deadlineAt - Date.now()));
    const sample = async () => {
      if (settled || child.killed || child.pid === undefined) return;
      try {
        const rss = await residentBytes(child.pid);
        if (!settled && !response && !failure && rss > limits.maxRssMb * 1024 * 1024) {
          response = { reason: 'limit' }; kill();
        }
      } catch {
        // A process may exit while sampled. Otherwise fail closed if monitoring fails.
        if (!settled && !child.killed && child.exitCode === null && child.signalCode === null) {
          failure ??= new PluginError('unavailable'); kill();
        }
      }
    };
    watchdog = setInterval(sample, 25);
    void sample();
    child.on('message', message => {
      if (message?.type === 'network-denied') { deniedNetworkAttempts++; return; }
      if (message?.type !== 'result' || response || failure) return;
      response = message.result;
      kill();
    });
    // Reap before resolving, rejecting or freeing the slot: cancellation acknowledgement
    // guarantees no parser remains alive and queued work cannot overlap a dying child.
    const finish = (code, signal) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer); clearInterval(watchdog); lifetime.signal.removeEventListener('abort', abort);
      live.delete(child); next();
      if (failure) reject(failure);
      else resolveResult(response ?? { reason: signal || code !== 0 ? 'limit' : 'malformed' });
    };
    child.on('error', () => {
      failure ??= new PluginError('unavailable');
      if (child.pid === undefined) finish();
      else kill();
    });
    child.once('close', finish);
    if (lifetime.signal.aborted) { abort(); return; }
    if (Date.now() >= lifetime.deadlineAt) { deadline(); return; }
    child.send({ type: 'extract', bytes, mediaType, limits }, error => {
      if (error) { failure ??= new PluginError('unavailable'); kill(); }
    });
  });
}
export function createProcessExtractor({ manifest, workerURL, parserURL, dependencies, limits: overrides }) {
  const limits = normalizeExtractorLimits(overrides);
  return { manifest, limits, async health(options) {
    extractorLifetime(options, limits);
    return { available: true };
  }, async extract(bytes, metadata = {}, options = {}) {
    void metadata; // Neither declared media type nor filename selects a parser.
    const requested = normalizeExtractorLimits(options.limits);
    const effective = normalizeExtractorLimits(Object.fromEntries(Object.entries(limits)
      .map(([key, ceiling]) => [key, Math.min(ceiling, requested[key])])));
    const lifetime = extractorLifetime(options, effective), detected = sniffDocument(bytes, effective);
    if (detected.reason) return unreadable(detected.mediaType, effective, detected.reason);
    if (!manifest.models.some(model => model.formats.includes(detected.mediaType))) return unreadable(detected.mediaType, effective, 'unsupported');
    // Snapshot bytes: callers may mutate their buffer while the operation waits for a slot.
    const input = Uint8Array.from(bytes);
    const raw = await runExtractorProcess(workerURL, input, detected.mediaType, effective, lifetime, parserURL, dependencies);
    extractorLifetime(lifetime, effective);
    return extractionResult(raw, detected.mediaType, effective);
  } };
}
export function serveExtractor(parse) {
  let received = false;
  // Async parsers can exit on parent loss; CPU-bound code still needs group cleanup by the host.
  process.on('disconnect', () => process.exit(1));
  process.on('message', async message => {
    if (received || message?.type !== 'extract') return;
    received = true;
    try {
      const result = await parse(message.bytes, message.mediaType, normalizeExtractorLimits(message.limits));
      process.send?.({ type: 'result', result });
    } catch (error) { process.send?.({ type: 'result', result: { reason: error.reason ?? 'malformed' } }); }
  });
}
