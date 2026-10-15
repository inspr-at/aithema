import puppeteer, { TimeoutError } from 'puppeteer-core';
import { ChromeLauncher } from 'puppeteer-core/internal/node/ChromeLauncher.js';
import { mkdtemp, mkdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { browserPath } from '../../scripts/install-test-browser.js';
import { watchMemoryGuard } from '../../scripts/memory-guard.js';

export const crashReportingArgs = ['--disable-breakpad', '--disable-crash-reporter', '--disable-crashpad-for-testing'];
export const launchTimeout = 60_000;

// Puppeteer 25.13 starts closeBrowser without awaiting it on launch failure.
// Keep the process handle so retry cannot race that cleanup. These two hooks
// also attach the memory guard before either transport starts responding.
class TestLauncher extends ChromeLauncher {
  capture(process) {
    this.process = process;
    this.watch(process.nodeProcess, this.run);
  }
  async createCdpSocketConnection(process, options) {
    this.capture(process);
    return super.createCdpSocketConnection(process, options);
  }
  async createCdpPipeConnection(process, options) {
    this.capture(process);
    return super.createCdpPipeConnection(process, options);
  }
  async waitForPageTarget(browser, timeout) {
    this.initialPage = true;
    clearTimeout(this.timer);
    return super.waitForPageTarget(browser, timeout);
  }
  async cleanUserDataDir() {
    await rm(this.profile, { recursive: true, force: true });
  }
  async closeBrowser(process, connection) {
    if (!this.started) return process.close();
    return super.closeBrowser(process, connection);
  }
}

export default {
  async launch(options = {}) {
    const timeout = options.timeout ?? launchTimeout;
    const executablePath = options.executablePath ?? await browserPath();
    const run = /\/ci\.noindex\/(aithema-runs\/[^/ ]+)/u.exec(options.userDataDir ?? process.cwd())?.[1];
    const parent = options.userDataDir ?? tmpdir();
    await mkdir(parent, { recursive: true });
    for (let attempt = 0; attempt < 2; attempt++) {
      const launcher = new TestLauncher(puppeteer);
      launcher.profile = await mkdtemp(join(parent, 'aithema-launch-'));
      launcher.watch = watchMemoryGuard();
      launcher.run = run;
      const controller = new AbortController();
      const abort = () => controller.abort(options.signal.reason);
      options.signal?.addEventListener('abort', abort, { once: true });
      if (options.signal?.aborted) abort();
      // Pipe startup otherwise waits for protocolTimeout rather than timeout.
      let pipeTimedOut = false;
      if (options.pipe && timeout > 0) launcher.timer = setTimeout(() => {
        pipeTimedOut = true;
        controller.abort(new TimeoutError(`Browser pipe startup exceeded ${timeout} ms`));
      }, timeout);
      try {
        const browser = await launcher.launch({ ...options, timeout, executablePath,
          signal: controller.signal, userDataDir: launcher.profile,
          args: [...(options.args ?? []), ...crashReportingArgs, ...(process.platform === 'darwin' ? ['--enable-gpu'] : [])],
        });
        launcher.started = true;
        browser.once('disconnected', () => options.signal?.removeEventListener('abort', abort));
        if (run && !browser.process().spawnargs.some(arg => arg.startsWith('--user-data-dir=') && arg.includes(`/ci.noindex/${run}/`))) {
          await browser.close();
          throw new Error('Browser profile must be inside the OPS memory guard run path');
        }
        return browser;
      } catch (cause) {
        clearTimeout(launcher.timer);
        const timedOut = !launcher.initialPage && !options.signal?.aborted
          && (pipeTimedOut || cause instanceof TimeoutError);
        await launcher.process?.close();
        await rm(launcher.profile, { recursive: true, force: true });
        if (!timedOut) throw cause;
        if (attempt === 1) throw new Error(`infra: browser launch timed out after two attempts (${timeout} ms per attempt)`, { cause });
        console.error('infra: browser launch (retry 1/1)');
      } finally {
        clearTimeout(launcher.timer);
        if (!launcher.started) options.signal?.removeEventListener('abort', abort);
      }
    }
  },
};
