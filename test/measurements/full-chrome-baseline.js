// Measurement-only preload: select full Chrome through the shared launch path.
// Never used by the browser suite or by CI's shard runner.
import assert from 'node:assert/strict';
import { hostname } from 'node:os';

assert.match(hostname(), /mbp2606/iu);
// fork() inherits --import, but fixture servers deliberately omit CHROME_PATH.
// Leave those server processes alone, including their dependency loading.
if (process.env.CHROME_PATH === '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome') {
  const { default: testBrowser } = await import('../browser/launch.js');
  const launch = testBrowser.launch.bind(testBrowser);
  testBrowser.launch = options => launch({ ...options, executablePath: process.env.CHROME_PATH });
}
