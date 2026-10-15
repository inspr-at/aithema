// Measurement-only preload: reproduce the old launch path and flags exactly.
// Never used by the browser suite or by CI's shard runner.
import assert from 'node:assert/strict';
import { hostname } from 'node:os';

assert.match(hostname(), /mbp2606/iu);
// fork() inherits --import, but fixture servers deliberately omit CHROME_PATH.
// Leave those server processes alone, including their dependency loading.
if (process.env.CHROME_PATH === '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome') {
  const { default: puppeteer } = await import('puppeteer-core');
  const { default: testBrowser } = await import('../browser/launch.js');
  testBrowser.launch = puppeteer.launch.bind(puppeteer);
}
