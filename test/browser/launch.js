import puppeteer, { TimeoutError } from 'puppeteer-core';
import { ChromeLauncher } from 'puppeteer-core/internal/node/ChromeLauncher.js';
import { mkdtemp, mkdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { basename, join, relative, isAbsolute } from 'node:path';
import { browserPath } from '../../scripts/install-test-browser.js';
import { watchMemoryGuard } from '../../scripts/memory-guard.js';

export const crashReportingArgs = ['--disable-breakpad', '--disable-crash-reporter', '--disable-crashpad-for-testing'];
export const launchTimeout = 60_000;
export const navigationTimeout = 30_000;
// Preserve the existing real 60-second credit-hold check while bounding CDP.
const protocolTimeout = 90_000;
const bounded = (value, maximum) => value > 0 ? Math.min(value, maximum) : maximum;
const runDirectory = path => /^(.*\/ci\.noindex\/aithema-runs\/[^/]+)(?:\/|$)/u.exec(path)?.[1];
const inside = (parent, path) => { const child = relative(parent, path); return !child.startsWith('..') && !isAbsolute(child); };

// Bound navigation even when a caller supplies timeout: 0. Include the worker's
// test file because concurrent lane logs otherwise contain identical errors.
export function boundPage(page, file = basename(process.argv[1] ?? 'browser test')) {
  page.setDefaultNavigationTimeout(navigationTimeout);
  const goto = page.goto.bind(page);
  page.goto = async (url, options = {}) => {
    try { return await goto(url, { ...options, timeout: bounded(options.timeout, navigationTimeout) }); }
    catch (cause) { throw new Error(`${file}: page.goto failed: ${cause.message}`, { cause }); }
  };
  return page;
}
function boundContext(context) {
  const newPage = context.newPage.bind(context);
  context.newPage = async (...args) => boundPage(await newPage(...args));
}

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
    return super.waitForPageTarget(browser, timeout);
  }
  async cleanUserDataDir() {
    await rm(this.directory, { recursive: true, force: true });
  }
  async closeBrowser(process, connection) {
    if (!this.started) return process.close();
    return super.closeBrowser(process, connection);
  }
}

export default {
  async launch(options = {}) {
    const timeout = bounded(options.timeout, launchTimeout);
    const executablePath = options.executablePath ?? await browserPath();
    const root = runDirectory(process.cwd()) ?? runDirectory(tmpdir()) ?? runDirectory(options.userDataDir ?? '');
    const run = root?.split('/ci.noindex/')[1];
    const parent = options.userDataDir ?? tmpdir();
    if (root && !inside(root, parent)) throw new Error('Browser directory must be inside its OPS run directory');
    await mkdir(parent, { recursive: true });
    for (let attempt = 0; attempt < 2; attempt++) {
      const launcher = new TestLauncher(puppeteer);
      launcher.directory = await mkdtemp(join(parent, 'aithema-launch-'));
      launcher.profile = join(launcher.directory, 'profile');
      const home = join(launcher.directory, 'home'), temporary = join(launcher.directory, 'tmp');
      const cache = join(launcher.directory, 'cache'), config = join(launcher.directory, 'config');
      await Promise.all([home, temporary, cache, config].map(path => mkdir(path, { recursive: true })));
      launcher.watch = watchMemoryGuard(root ? { logPath: join(root, '../../mem-guard.log') } : undefined);
      launcher.run = run;
      const controller = new AbortController();
      const abort = () => controller.abort(options.signal.reason);
      options.signal?.addEventListener('abort', abort, { once: true });
      if (options.signal?.aborted) abort();
      // Bound the entire startup, including a WebSocket handshake and the
      // initial page. Puppeteer's timeout does not cover every transport step.
      let startupTimedOut = false;
      launcher.timer = setTimeout(() => {
        startupTimedOut = true;
        controller.abort(new TimeoutError(`Timed out after waiting ${timeout} ms for browser startup [${basename(process.argv[1] ?? 'browser test')}]`));
      }, timeout);
      try {
        const browser = await launcher.launch({ ...options, timeout, executablePath,
          protocolTimeout: bounded(options.protocolTimeout, protocolTimeout),
          // Chrome has writable account paths beyond userDataDir. Do not pass
          // the real HOME or inherit a provider's environment by default.
          env: { PATH: process.env.PATH, ...options.env, HOME: home, TMPDIR: temporary,
            XDG_CACHE_HOME: cache, XDG_CONFIG_HOME: config },
          signal: controller.signal, userDataDir: launcher.profile,
          // Nightly selects every width with AITHEMA_FULL_MATRIX=1 and keeps CI=true.
          // Linux runner sandbox policy must match shared-browser.js independently
          // of matrix selection.
          args: [...(process.platform === 'linux' && !options.args?.includes('--no-sandbox') ? ['--no-sandbox'] : []),
            ...(options.args ?? []), ...crashReportingArgs, ...(process.platform === 'darwin' ? ['--enable-gpu'] : [])],
        });
        launcher.started = true;
        browser.once('disconnected', () => options.signal?.removeEventListener('abort', abort));
        if (run && !browser.process().spawnargs.some(arg => arg.startsWith('--user-data-dir=') && arg.includes(`/ci.noindex/${run}/`))) {
          await browser.close();
          throw new Error('Browser profile must be inside the OPS memory guard run path');
        }
        boundContext(browser.defaultBrowserContext());
        const createContext = browser.createBrowserContext.bind(browser);
        browser.createBrowserContext = async (...args) => {
          const context = await createContext(...args); boundContext(context); return context;
        };
        return browser;
      } catch (cause) {
        clearTimeout(launcher.timer);
        const timedOut = !launcher.initialPage && !options.signal?.aborted
          && (startupTimedOut || cause instanceof TimeoutError);
        await launcher.process?.close();
        await rm(launcher.directory, { recursive: true, force: true });
        if (!timedOut) {
          if (options.signal?.aborted) throw cause;
          const reason = startupTimedOut ? controller.signal.reason : cause;
          throw new Error(`${basename(process.argv[1] ?? 'browser test')}: browser launch failed: ${reason.message}`, { cause });
        }
        if (attempt === 1) throw new Error(`infra: browser launch timed out after two attempts (${timeout} ms per attempt) [${basename(process.argv[1] ?? 'browser test')}]`, { cause });
        console.error('infra: browser launch (retry 1/1)');
      } finally {
        clearTimeout(launcher.timer);
        if (!launcher.started) options.signal?.removeEventListener('abort', abort);
      }
    }
  },
};
