import { spawn } from 'node:child_process';
import { mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { repositoryRoot, selectBrowserTests } from './browser-shards.js';

const { files, nodeArgs } = selectBrowserTests(process.argv.slice(2));
console.log(`Browser test files (${files.length}):\n${files.join('\n')}`);
// AIT-165's operator matrix retained Puppeteer timers after cleanup on mbp2606.
// Isolate its worker so other files still expose unfinished cleanup or handles.
const operatorFile = 'test/browser/operator-login.test.js';
const timingDirectory = process.env.BROWSER_TIMING_DIR ?? (process.env.AITHEMA_EVIDENCE_DIR && join(process.env.AITHEMA_EVIDENCE_DIR, 'browser-timings'));
if (timingDirectory) mkdirSync(timingDirectory, { recursive: true });
let batchIndex = 0;
for (const batch of [files.filter(file => file !== operatorFile), files.filter(file => file === operatorFile)]) {
  if (!batch.length) continue;
  const forceExit = batch[0] === operatorFile ? ['--test-force-exit'] : [];
  const result = await new Promise(resolve => {
    const reporters = timingDirectory ? ['--test-reporter=spec', '--test-reporter-destination=stdout',
      '--test-reporter=./scripts/browser-timing-reporter.js', `--test-reporter-destination=${join(timingDirectory, `batch-${batchIndex++}.jsonl`)}`] : [];
    const child = spawn(process.execPath, ['--test', ...forceExit, '--test-concurrency=1', ...reporters, ...nodeArgs, ...batch], {
      cwd: repositoryRoot, stdio: 'inherit', env: { ...process.env, BROWSER_TIMING_FILES: JSON.stringify(batch) },
    });
    child.on('error', error => { console.error(error); resolve({ code: 1 }); });
    child.on('exit', (code, signal) => resolve({ code, signal }));
  });
  if (result.signal) { process.kill(process.pid, result.signal); break; }
  if (result.code !== 0) { process.exitCode = result.code ?? 1; break; }
}
