// Scratch AIT-227 step trace; never records page payloads or environment values.
import { appendFileSync } from 'node:fs';
import { ChromeLauncher } from 'puppeteer-core/internal/node/ChromeLauncher.js';
import { CdpPage } from 'puppeteer-core/internal/cdp/Page.js';
import { CdpBrowser } from 'puppeteer-core/internal/cdp/Browser.js';
const output = process.env.AIT227_TRACE;
let sequence = 0;
function wrap(prototype, name) {
  const original = prototype[name];
  if (!original) return;
  prototype[name] = async function (...args) {
    const id = ++sequence, start = Date.now();
    const caller = new Error().stack.split('\n').find(line => /test\/browser\//u.test(line))?.trim();
    const record = phase => output && appendFileSync(output, JSON.stringify({ epoch: Date.now(), pid: process.pid, id, name, phase, caller, ms: Date.now() - start }) + '\n');
    record('start');
    try { const result = await original.apply(this, args); record('end'); return result; }
    catch (error) { record('error'); throw error; }
  };
}
wrap(ChromeLauncher.prototype, 'launch');
for (const name of ['goto', 'waitForFunction', 'evaluate', 'evaluateHandle', 'screenshot', 'close']) wrap(CdpPage.prototype, name);
for (const name of ['newPage', 'close']) wrap(CdpBrowser.prototype, name);
