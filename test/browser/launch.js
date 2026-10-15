import puppeteer from 'puppeteer-core';
import { openSync, closeSync, fstatSync, readSync, statSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { browserPath } from '../../scripts/install-test-browser.js';
import { memoryGuardEvent } from '../../scripts/memory-guard.js';

export const crashReportingArgs = ['--disable-breakpad', '--disable-crash-reporter', '--disable-crashpad-for-testing'];
const guardLog = join(homedir(), 'ci.noindex/mem-guard.log');
const logSize = () => { try { return statSync(guardLog).size; } catch { return 0; } };
function appendedLog(offset) {
  let fd;
  try {
    fd = openSync(guardLog, 'r');
    const size = fstatSync(fd).size;
    const start = Math.max(size < offset ? 0 : offset, size - 128 * 1024);
    const bytes = Buffer.alloc(size - start);
    readSync(fd, bytes, 0, bytes.length, start);
    return bytes.toString();
  } catch { return ''; }
  finally { if (fd !== undefined) closeSync(fd); }
}

export default {
  async launch(options = {}) {
    const offset = logSize();
    const browser = await puppeteer.launch({ ...options,
      executablePath: options.executablePath ?? await browserPath(),
      args: [...(options.args ?? []), ...crashReportingArgs],
    });
    const child = browser.process();
    const run = /\/ci\.noindex\/(aithema-runs\/[^/ ]+)/u.exec(options.userDataDir ?? process.cwd())?.[1];
    child.once('exit', (_code, signal) => {
      if (signal !== 'SIGTERM' || !run) return;
      let attempts = 0;
      const check = () => {
        const event = memoryGuardEvent({ signal, pid: child.pid, run, lines: appendedLog(offset) });
        if (event) {
          console.error(`infra: memory guard — browser PID ${child.pid}: ${event}`);
          process.exitCode = 1;
        } else if (++attempts < 5) setTimeout(check, 100);
      };
      check();
    });
    return browser;
  },
};
