import puppeteer from 'puppeteer-core';
import { browserPath } from '../../scripts/install-test-browser.js';
import { watchMemoryGuard } from '../../scripts/memory-guard.js';

export const crashReportingArgs = ['--disable-breakpad', '--disable-crash-reporter', '--disable-crashpad-for-testing'];

export default {
  async launch(options = {}) {
    const watch = watchMemoryGuard();
    const browser = await puppeteer.launch({ ...options,
      executablePath: options.executablePath ?? await browserPath(),
      args: [...(options.args ?? []), ...crashReportingArgs],
    });
    const child = browser.process();
    const run = /\/ci\.noindex\/(aithema-runs\/[^/ ]+)/u.exec(options.userDataDir ?? process.cwd())?.[1];
    watch(child, run);
    return browser;
  },
};
