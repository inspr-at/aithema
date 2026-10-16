// Scratch AIT-227 step trace; never records page payloads or environment values.
import { appendFileSync } from 'node:fs';
import { ChromeLauncher } from 'puppeteer-core/internal/node/ChromeLauncher.js';
import { CdpPage } from 'puppeteer-core/internal/cdp/Page.js';
import { Server } from 'node:http';
import childProcess from 'node:child_process';
import { syncBuiltinESMExports } from 'node:module';
import { CdpBrowser } from 'puppeteer-core/internal/cdp/Browser.js';
const output = process.env.AITHEMA_BROWSER_TRACE;
let sequence = 0;
function wrap(prototype, name) {
  const original = prototype[name];
  if (!original) return;
  prototype[name] = async function (...args) {
    const id = ++sequence, start = Date.now();
    const caller = new Error().stack.split('\n').find(line => /test\/browser\//u.test(line))?.trim();
    const record = (phase, extra = {}) => output && appendFileSync(output, JSON.stringify({ epoch: Date.now(), pid: process.pid, file: process.argv[1], id, name, phase, caller, ms: Date.now() - start, ...extra }) + '\n');
    record('start');
    try { const result = await original.apply(this, args); record('end', name === 'launch' ? { browserPid: result.process()?.pid } : {}); return result; }
    catch (error) { record('error'); throw error; }
  };
}
wrap(ChromeLauncher.prototype, 'launch');
for (const name of ['goto', 'waitForFunction', 'waitForNavigation', 'waitForResponse', 'evaluate', 'evaluateHandle', 'screenshot', 'click', '$eval', '$$eval', 'setViewport', 'close']) wrap(CdpPage.prototype, name);
for (const name of ['newPage', 'close']) wrap(CdpBrowser.prototype, name);

// Server readiness has no browser protocol command to trace. Preserve listen's
// synchronous return value and only observe its completion event.
const listen = Server.prototype.listen;
Server.prototype.listen = function (...args) {
  const id = ++sequence, epoch = Date.now();
  const record = phase => output && appendFileSync(output, JSON.stringify({ epoch: Date.now(), pid: process.pid, file: process.argv[1], id, name: 'server.listen', phase, ms: Date.now()-epoch })+'\n');
  record('start'); this.once('listening',()=>record('end')); this.once('error',()=>record('error'));
  return listen.apply(this,args);
};
const fork = childProcess.fork;
childProcess.fork = function (...args) {
  const id = ++sequence, epoch = Date.now(), child = fork.apply(this,args);
  const record = phase => output && appendFileSync(output, JSON.stringify({ epoch: Date.now(), pid: process.pid, file: process.argv[1], id, name: 'server.fork.ready', phase, ms: Date.now()-epoch })+'\n');
  record('start'); child.once('message',()=>record('end')); child.once('error',()=>record('error'));
  return child;
};
syncBuiltinESMExports();
