// AIT-364 owns an HTTP/SSE fixture, but its Chrome process is shared by the file.
import { browserStep } from '../browser/browser-step.js';

export async function closeConsentFixture({ browser, server, streams }, { timeout = 10_000 } = {}) {
  try {
    await browserStep('AIT-364 consent teardown: browser pages and storage', () => browser.close(), timeout);
  } catch (error) {
    // A stuck shared-fixture close would otherwise be awaited again by the file
    // hook. Terminate this file's owned Chrome so its pending CDP work settles.
    browser.browser().process()?.kill('SIGKILL');
    throw error;
  } finally {
    for (const stream of streams) stream.end();
    await browserStep('AIT-364 consent teardown: HTTP server', () => new Promise((resolve, reject) => {
      server.close(error => error ? reject(error) : resolve());
      // close() drains HTTP requests, but an accepted speculative connection
      // with no request headers can survive it while shared Chrome stays alive.
      // Stop accepting first, then destroy connections, including these sockets.
      server.closeAllConnections();
    }), timeout);
  }
}
