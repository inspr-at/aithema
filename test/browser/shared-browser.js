// One Chrome process per test file, with fixture-owned pages and storage reset.
// Run only through remote-browser.sh or CI.
import { after } from 'node:test';
import { mkdtemp, rm } from 'node:fs/promises';
import { homedir, tmpdir } from 'node:os';
import { join } from 'node:path';
import puppeteer from './launch.js';
import { browserPath } from './start2-display-helpers.js';

let launch, directory, resetPage, crashed = false;
const fixtures = [];
after(async () => {
  // Finish every fixture reset before closing the file-owned protocol connection.
  // Fixture hooks and the file hook can both request the same idempotent close.
  try { for (const fixture of fixtures) await fixture.close(); }
  finally {
    try { if (launch) await (await launch).close(); }
    finally { if (directory) await rm(directory, { recursive: true, force: true }); }
  }
});

export async function browserForFile() {
  if (launch) {
    const previous = await launch.catch(() => null);
    if (!previous?.connected || crashed) {
      if (previous?.connected) await previous.close();
      launch = undefined; resetPage = undefined; crashed = false;
      if (directory) await rm(directory, { recursive: true, force: true });
      directory = undefined;
    }
  }
  launch ??= (async () => {
    directory = await mkdtemp(join(tmpdir(), 'aithema-shared-chrome-'));
    const browser = await puppeteer.launch({ executablePath: await browserPath(), headless: true, pipe: true,
      userDataDir: join(directory, 'chrome'), env: { PATH: process.env.PATH, HOME: homedir() },
      args: process.platform === 'linux' ? ['--no-sandbox'] : [] });
    // Storage commands need a page target's storage partition.
    resetPage = await browser.newPage();
    return browser;
  })();
  const browser = await launch, context = browser.defaultBrowserContext(), pages = [];
  // mbp2606 Chrome 155 SIGSEGVs when a second incognito context is created.
  // Reuse the default context, resetting cookies and every visited frame origin
  // between fixtures. Each former launch owns fresh pages; tests stay serial.
  const cleanupPage = resetPage, origins = new Set();
  let closing;
  const fixture = {
    browser: () => browser,
    cookies: () => context.cookies(),
    setCookie: (...cookies) => context.setCookie(...cookies),
    async newPage() {
      const page = await context.newPage(); pages.push(page);
      page.on('error', () => { crashed = true; });
      page.on('framenavigated', frame => {
        if (/^https?:/u.test(frame.url())) origins.add(new URL(frame.url()).origin);
      });
      return page;
    },
    close: () => closing ??= (async () => {
      try {
        if (!browser.connected) return;
        // Keep historical origins even after a frame navigates away or closes.
        for (const page of pages.filter(page => !page.isClosed())) for (const frame of page.frames()) {
          if (/^https?:/u.test(frame.url())) origins.add(new URL(frame.url()).origin);
        }
        // Close pages first so an unload handler cannot write storage after reset.
        await Promise.all(pages.filter(page => !page.isClosed()).map(page => page.close()));
        const session = await cleanupPage.createCDPSession();
        try {
          for (const origin of origins) await session.send('Storage.clearDataForOrigin', { origin, storageTypes: 'all' });
        } finally { await session.detach(); }
        const cookies = await context.cookies();
        if (cookies.length) await context.deleteCookie(...cookies);
        await context.clearPermissionOverrides();
      } catch (error) {
        // Chrome can exit while closing the final page. File teardown closes the
        // process and removes its profile, which also clears all fixture storage.
        // A live connection must still report every storage/protocol failure.
        if (browser.connected) throw error;
      }
    })(),
  };
  fixtures.push(fixture);
  return fixture;
}
