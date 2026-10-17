import { execFileSync } from 'node:child_process';
import { closeSync, copyFileSync, fstatSync, mkdirSync, mkdtempSync, openSync, readFileSync, readdirSync, readSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';

const errorCodes = new Set(['EACCES', 'EAGAIN', 'EBUSY', 'ECANCELED', 'ECONNRESET', 'EINTEGRITY', 'EMFILE', 'ENFILE', 'ENOENT', 'ENOMEM', 'ENOSPC', 'ENOTCACHED', 'ENOTEMPTY', 'EPERM', 'ETIMEDOUT']);
const signals = new Set(['SIGABRT', 'SIGBUS', 'SIGILL', 'SIGINT', 'SIGKILL', 'SIGPIPE', 'SIGQUIT', 'SIGSEGV', 'SIGTERM', 'SIGTRAP']);
const logEvents = new Set(['argv', 'cache', 'cli', 'code', 'config', 'cwd', 'exit', 'fetch', 'idealTree', 'logfile', 'node', 'npm', 'os', 'packumentCache', 'reify', 'signal', 'stack', 'tar', 'timing', 'title', 'unfinished']);

function safeLogLine(line) {
  const match = /^(\d+) (silly|verbose|info|http|warn|error|timing) ([A-Za-z]+)(?:\s+(.*))?$/u.exec(line);
  if (!match || !logEvents.has(match[3])) return '[details omitted]';
  const [, number, level, event, value = ''] = match;
  // Allow only versions, numeric exits, and known error/signal codes. In
  // particular, never echo argv, URLs, paths, config values, stacks or payloads.
  const safeValue = (event === 'code' && errorCodes.has(value)) ||
    (event === 'signal' && signals.has(value)) ||
    (event === 'exit' && /^-?\d{1,3}$/u.test(value)) ||
    (['node', 'npm'].includes(event) && /^v?\d{1,3}\.\d{1,3}\.\d{1,3}$/u.test(value));
  return `${number} ${level} ${event} ${safeValue ? value : '[details omitted]'}`;
}

function debugTail(cache) {
  let fd;
  try {
    const logs = join(cache, '_logs');
    const latest = readdirSync(logs).filter(name => /^\d{4}-\d{2}-\d{2}T[\d_-]+Z-debug-\d+\.log$/u.test(name)).sort().at(-1);
    if (!latest) return '(no npm debug log)';
    fd = openSync(join(logs, latest), 'r');
    const size = fstatSync(fd).size, start = Math.max(0, size - 16 * 1024);
    const bytes = Buffer.alloc(size - start);
    const count = readSync(fd, bytes, 0, bytes.length, start);
    const lines = bytes.subarray(0, count).toString('utf8').trimEnd().split('\n');
    if (start) lines.shift();
    return lines.slice(-20).map(safeLogLine).join('\n');
  } catch {
    return '(npm debug log unavailable)';
  } finally {
    if (fd !== undefined) closeSync(fd);
  }
}

function seedCache(shared, cache, lock) {
  let seeded = 0;
  for (const pkg of Object.values(lock.packages)) {
    if (pkg.dev || pkg.link || !pkg.integrity) continue;
    // npm's cacache content-v2 stores tarballs by integrity. Pacote can read
    // these directly by digest, so no shared index, logs, tmp files or config
    // need copying. Keep this bounded to production lockfile entries.
    const sri = /^(sha512|sha384|sha256|sha1)-([A-Za-z0-9+/]+={0,2})$/u.exec(pkg.integrity);
    if (!sri) throw new Error('Unsupported locked npm integrity');
    const hex = Buffer.from(sri[2], 'base64').toString('hex');
    const path = join('_cacache', 'content-v2', sri[1], hex.slice(0, 2), hex.slice(2, 4), hex.slice(4));
    const destination = join(cache, path);
    mkdirSync(dirname(destination), { recursive: true });
    try {
      // A real copy: npm must never be able to mutate a shared cache inode.
      copyFileSync(join(shared, path), destination);
      seeded++;
    } catch (error) {
      // Platform-specific optional packages may not be cached. Let offline
      // npm ci decide whether a missing entry is required; never fetch/retry.
      if (error.code !== 'ENOENT') throw error;
    }
  }
  return seeded;
}

export function installPackedOffline(cwd, { run = execFileSync } = {}) {
  const scratch = mkdtempSync(join(tmpdir(), 'aithema-release-install-'));
  const cache = join(scratch, 'cache'), temp = join(scratch, 'tmp');
  let phase = 'cache discovery', seeded = 0;
  const started = Date.now();
  try {
    mkdirSync(cache); mkdirSync(temp);
    // Resolve npm's effective cache, including the remote runner's override.
    // Even logs-max=0 can prune old logs, so isolate this query's logs too.
    const shared = run('npm', ['config', 'get', 'cache', '--offline', '--logs-max=0', '--logs-dir', join(cache, '_logs')], {
      cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'],
    }).trim();
    phase = 'cache seed';
    seeded = seedCache(shared, cache, JSON.parse(readFileSync(join(cwd, 'package-lock.json'), 'utf8')));
    phase = 'npm ci';
    run('npm', ['ci', '--offline', '--ignore-scripts', '--omit=dev', '--no-audit', '--no-fund',
      '--cache', cache, '--logs-dir', join(cache, '_logs'), '--logs-max=1', '--loglevel=verbose'], {
      cwd, env: { ...process.env, TMPDIR: temp }, stdio: ['ignore', 'pipe', 'pipe'],
    });
  } catch (error) {
    // Do not retain the original exec error as a cause: it contains raw child
    // output and command arguments that test reporters would print verbatim.
    throw new Error(`Packed offline install failed during ${phase}: ` +
      `status=${Number.isInteger(error.status) ? error.status : 'null'} ` +
      `signal=${signals.has(error.signal) ? error.signal : 'none'} ` +
      `code=${errorCodes.has(error.code) ? error.code : 'none'} ` +
      `stdout_bytes=${Buffer.byteLength(error.stdout ?? '')} stderr_bytes=${Buffer.byteLength(error.stderr ?? '')} ` +
      `elapsed_ms=${Date.now() - started} seeded=${seeded} node=${process.version} platform=${process.platform}/${process.arch}\n` +
      `npm debug log tail (last 20 lines, values omitted):\n${debugTail(cache)}`);
  } finally {
    // execFileSync has reaped the child, and diagnostics have been captured.
    rmSync(scratch, { recursive: true, force: true });
  }
}
