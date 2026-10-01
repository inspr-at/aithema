import { spawn } from 'node:child_process';
import { Socket } from 'node:net';
import { mkdtemp, writeFile, unlink, rmdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

// A separate supervisor is necessary: JS exit handlers do not run on SIGKILL.
// fd 3 is held open ONLY by the service parent, never inherited by inference.
// Its EOF kills inference's detached process group (including descendants).
// The supervisor stays alive long enough to reap and remove its own audio.
let child, directory, stopped = false, cleaned = false;
// Child stdio pipes are sockets on Node's POSIX platforms. Poll nonblocking:
// fs.ReadStream would leave an uncancellable thread-pool read at normal exit.
const lifetime = new Socket({ fd: 3, readable: true, writable: false });
async function clean() {
  if (!directory || cleaned) return;
  cleaned = true;
  await unlink(join(directory, 'utterance.wav'));
  await rmdir(directory);
}
function killGroup() {
  if (!child?.pid) return;
  try { process.kill(-child.pid, 'SIGKILL'); }
  catch (error) { if (error.code !== 'ESRCH') throw error; }
}
function stop() { stopped = true; killGroup(); process.stdin.destroy(); }
lifetime.on('end', stop);
lifetime.on('error', stop);
lifetime.resume();
process.on('SIGTERM', stop);
process.on('SIGINT', stop);

try {
  const chunks = [];
  let size = 0;
  for await (const chunk of process.stdin) {
    size += chunk.length;
    if (size > 2_000_000) throw new Error('Bounded supervisor input exceeded');
    chunks.push(chunk);
  }
  if (stopped) process.exitCode = 1;
  else {
    const request = JSON.parse(Buffer.concat(chunks).toString('utf8'));
    directory = await mkdtemp(join(tmpdir(), 'aithema-whisper-'));
    await writeFile(join(directory, 'utterance.wav'), Buffer.from(request.audio, 'base64'), { mode: 0o600 });
    if (!stopped) {
      child = spawn(request.command, [...request.args, '-m', request.modelPath, '-f', join(directory, 'utterance.wav'),
        '-l', request.language, '-nt', '-np'], { detached: true, shell: false, stdio: ['ignore', 'pipe', 'pipe'] });
      child.stdout.pipe(process.stdout);
      child.stderr.pipe(process.stderr);
      const code = await new Promise((resolve, reject) => {
        child.once('error', reject);
        child.once('close', (code) => resolve(code));
      });
      // A command that exits while leaving descendants is incomplete too.
      killGroup();
      process.exitCode = stopped || code !== 0 ? 1 : 0;
    } else process.exitCode = 1;
  }
} catch {
  killGroup();
  process.exitCode = 1; // never expose paths, raw audio or provider stderr
} finally {
  try { await clean(); } catch { process.exitCode = 1; }
  lifetime.destroy();
}
