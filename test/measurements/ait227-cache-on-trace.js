// Scratch controlled diagnostic: HOME/profile remain isolated, restore only the
// Darwin Metal disk cache. Never use in a normal browser-suite invocation.
import './ait227-trace.js';
import { appendFileSync } from 'node:fs';
import { ChromeLauncher } from 'puppeteer-core/internal/node/ChromeLauncher.js';
import { CdpPage } from 'puppeteer-core/internal/cdp/Page.js';
const output = process.env.AITHEMA_BROWSER_TRACE;
const record = (name, value) => output && appendFileSync(output, JSON.stringify({
  epoch: Date.now(), pid: process.pid, file: process.argv[1], id: `${name}-${Date.now()}`,
  name, phase: 'snapshot', value,
}) + '\n');
const launch = ChromeLauncher.prototype.launch;
ChromeLauncher.prototype.launch = function (options) {
  return launch.call(this, { ...options, args: options.args.filter(arg => arg !== '--disable-metal-shader-cache') });
};
const installed = new WeakSet(), goto = CdpPage.prototype.goto;
CdpPage.prototype.goto = async function (...args) {
  if (!installed.has(this)) {
    installed.add(this);
    await this.exposeFunction('__ait227ReportInput', value => record('input', value));
    await this.evaluateOnNewDocument(() => {
      window.__ait227Input = [];
      for (const type of ['pointerdown', 'mousedown', 'mouseup', 'click', 'submit']) document.addEventListener(type, event => {
        if (!event.target.closest?.('form[data-confirm]')) return;
        const button = document.querySelector('button[type=submit]'), r = button?.getBoundingClientRect();
        const value = { type, trusted: event.isTrusted, target: event.target.tagName,
          x: event.clientX, y: event.clientY, focused: document.hasFocus(), active: document.activeElement?.tagName,
          busy: document.querySelector('.confirm-card')?.dataset.busy ?? null,
          button: r && { x:r.x, y:r.y, width:r.width, height:r.height }, path: location.pathname };
        window.__ait227Input.push(value);
        void window.__ait227ReportInput(value).catch(() => {});
        window.__ait227Input = window.__ait227Input.slice(-30);
      }, true);
    });
    this.on('request', request => record('request', { method: request.method(), path: (/^https?:/u.test(request.url()) ? new URL(request.url()).pathname : new URL(request.url()).protocol) }));
    this.on('requestfailed', request => record('requestfailed', { method: request.method(), path: (/^https?:/u.test(request.url()) ? new URL(request.url()).pathname : new URL(request.url()).protocol), error: request.failure()?.errorText }));
  }
  return goto.apply(this,args);
};
for (const name of ['createCdpSocketConnection', 'createCdpPipeConnection']) {
  const connect = ChromeLauncher.prototype[name];
  ChromeLauncher.prototype[name] = function (process, options) {
    record('chrome-process', { pid: process.nodeProcess.pid });
    return connect.call(this, process, options);
  };
}
