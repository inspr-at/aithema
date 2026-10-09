import { spawn } from 'node:child_process';
import { constants } from 'node:fs';
import { access, stat, readdir, open } from 'node:fs/promises';
import { join, isAbsolute, delimiter } from 'node:path';
import { PluginError, MAX_IMAGE_BYTES } from '@inspr/aithema-core';

// One slot for the server process, shared by every factory/bind instance.
let occupied = false;
const waiting = [];
export function acquireSlot(signal) {
  return new Promise((resolve, reject) => {
    const abort = () => {
      const index = waiting.indexOf(start);
      if (index >= 0) waiting.splice(index, 1);
      signal.removeEventListener('abort', abort); reject(signal.reason);
    };
    const start = () => {
      signal.removeEventListener('abort', abort);
      occupied = true;
      let released = false;
      resolve(() => {
        if (released) return;
        released = true; occupied = false; waiting.shift()?.();
      });
    };
    if (signal.aborted) { reject(signal.reason); return; }
    if (!occupied) start();
    else { waiting.push(start); signal.addEventListener('abort', abort, { once: true }); }
  });
}

// Minimal environment: no API keys, tokens, NODE_OPTIONS or server secrets inherited.
export function cliEnvironment(codexHome) {
  return { PATH: process.env.PATH ?? '', HOME: process.env.HOME ?? codexHome, CODEX_HOME: codexHome,
    TMPDIR: process.env.TMPDIR ?? '/tmp', LANG: 'C.UTF-8' };
}
export async function executablePath(binaryPath, path = process.env.PATH ?? '') {
  const candidates = isAbsolute(binaryPath) ? [binaryPath] : path.split(delimiter).filter(isAbsolute).map(dir => join(dir, binaryPath));
  for (const candidate of candidates) {
    try { await access(candidate, constants.X_OK); if ((await stat(candidate)).isFile()) return candidate; } catch { /* next PATH entry */ }
  }
  throw new PluginError('unavailable');
}

export function runCodex({ binaryPath, args, directory, env, brief, signal, spawnImpl = spawn }) {
  signal.throwIfAborted();
  return new Promise((resolve, reject) => {
    let child, failure;
    try { child = spawnImpl(binaryPath, args, { cwd: directory, env, detached: true, shell: false,
      stdio: ['pipe', 'ignore', 'ignore'] }); }
    catch { reject(new PluginError('unavailable')); return; }
    // SIGKILL also handles CLI/tool descendants that ignore SIGTERM. Never kill only the leader.
    const killGroup = () => {
      if (child.pid !== undefined) {
        try { process.kill(-child.pid, 'SIGKILL'); }
        catch (error) { if (error.code !== 'ESRCH') failure ??= new PluginError('unavailable'); }
      }
    };
    const abort = () => { failure ??= signal.reason; killGroup(); };
    signal.addEventListener('abort', abort, { once: true });
    child.once('error', () => { failure ??= new PluginError('unavailable'); killGroup(); });
    // Kill any surviving descendants even when the leader exits successfully.
    child.once('exit', killGroup);
    child.once('close', (code, exitSignal) => {
      signal.removeEventListener('abort', abort);
      if (failure) reject(failure);
      else if (code !== 0 || exitSignal) reject(new PluginError('provider'));
      else resolve();
    });
    child.stdin.on('error', error => {
      // Early exit may close stdin; the exit code/output check remains authoritative.
      if (error.code !== 'EPIPE' && error.code !== 'ERR_STREAM_DESTROYED') {
        failure ??= new PluginError('provider'); killGroup();
      }
    });
    if (signal.aborted) abort();
    else child.stdin.end(brief, 'utf8'); // -i is variadic: the prompt is never an argv element.
  });
}

export async function producedImage(directory, referencePaths, signal) {
  const outputs = []; let entries = 0;
  async function scan(relative = '', depth = 0) {
    signal.throwIfAborted();
    if (depth > 16) throw new PluginError('limit');
    for (const entry of await readdir(join(directory, relative), { withFileTypes: true })) {
      if (++entries > 1024) throw new PluginError('limit');
      const path = relative ? `${relative}/${entry.name}` : entry.name;
      if (referencePaths.has(path)) continue;
      if (entry.isSymbolicLink()) throw new PluginError('invalid-output');
      if (entry.isDirectory()) await scan(path, depth + 1);
      else if (/\.(?:png|webp|jpe?g)$/iu.test(entry.name)) {
        if (!entry.isFile()) throw new PluginError('invalid-output');
        outputs.push(path);
      }
    }
  }
  await scan();
  if (outputs.length !== 1) throw new PluginError('invalid-output');
  const handle = await open(join(directory, outputs[0]), constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    const info = await handle.stat();
    if (!info.isFile() || !info.size) throw new PluginError('invalid-output');
    if (info.size > MAX_IMAGE_BYTES) throw new PluginError('limit');
    const bytes = Buffer.alloc(info.size + 1);
    let size = 0;
    while (size < bytes.length) {
      signal.throwIfAborted();
      const read = await handle.read(bytes, size, bytes.length - size, size);
      if (!read.bytesRead) break;
      size += read.bytesRead;
    }
    if (size !== info.size) throw new PluginError('invalid-output');
    return new Uint8Array(bytes.subarray(0, size));
  } finally { await handle.close(); }
}
