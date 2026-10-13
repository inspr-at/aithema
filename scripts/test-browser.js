import { spawn } from 'node:child_process';
import { repositoryRoot, selectBrowserTests } from './browser-shards.js';

const { files, nodeArgs } = selectBrowserTests(process.argv.slice(2));
console.log(`Browser test files (${files.length}):\n${files.join('\n')}`);
// Puppeteer may retain protocol timers after browser/host cleanup. Exit workers
// only after every test and its cleanup hooks finish, keeping shards bounded.
const child = spawn(process.execPath, ['--test', '--test-force-exit', '--test-concurrency=1', ...nodeArgs, ...files], {
  cwd: repositoryRoot,
  stdio: 'inherit',
});
child.on('error', error => { console.error(error); process.exitCode = 1; });
child.on('exit', (code, signal) => {
  if (signal) process.kill(process.pid, signal);
  else process.exitCode = code;
});
