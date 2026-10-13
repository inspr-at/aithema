import { spawn } from 'node:child_process';
import { repositoryRoot, selectBrowserTests } from './browser-shards.js';

const { files, nodeArgs } = selectBrowserTests(process.argv.slice(2));
console.log(`Browser test files (${files.length}):\n${files.join('\n')}`);
const child = spawn(process.execPath, ['--test', '--test-concurrency=1', ...nodeArgs, ...files], {
  cwd: repositoryRoot,
  stdio: 'inherit',
});
child.on('error', error => { console.error(error); process.exitCode = 1; });
child.on('exit', (code, signal) => {
  if (signal) process.kill(process.pid, signal);
  else process.exitCode = code;
});
