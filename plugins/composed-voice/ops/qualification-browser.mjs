import { guardBrowserProcessGroup } from './qualification-browser-watchdog.mjs';

/** Capture the process before CDP setup, so even a hung launch is supervised. */
export async function launchLocalBrowser(options, lifetime) {
  const [{ default: puppeteer }, { ChromeLauncher }] = await Promise.all([
    import('puppeteer-core'), import('puppeteer-core/internal/node/ChromeLauncher.js'),
  ]);
  class QualificationLauncher extends ChromeLauncher {
    capture(child) {
      lifetime.registerProcessGroup(guardBrowserProcessGroup(child.nodeProcess.pid, lifetime));
    }
    async createCdpSocketConnection(child, settings) {
      this.capture(child); return super.createCdpSocketConnection(child, settings);
    }
    async createCdpPipeConnection(child, settings) {
      this.capture(child); return super.createCdpPipeConnection(child, settings);
    }
  }
  return new QualificationLauncher(puppeteer).launch(options);
}
