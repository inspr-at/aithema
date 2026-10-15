// One Chrome process per test file, with fixture-owned pages and storage reset.
// Run only through remote-browser.sh or CI.
import { after } from 'node:test';
import { mkdtemp, rm } from 'node:fs/promises';
import { homedir, tmpdir } from 'node:os';
import { join } from 'node:path';
import puppeteer from 'puppeteer-core';
import { browserPath } from './start2-display-helpers.js';

let launch, directory;
after(async () => {
  try { if (launch) await (await launch).close(); }
  finally { if (directory) await rm(directory, { recursive: true, force: true }); }
});

export async function browserForFile() {
  launch ??= (async () => {
    directory = await mkdtemp(join(tmpdir(), 'aithema-shared-chrome-'));
    return puppeteer.launch({ executablePath: await browserPath(), headless: true, pipe: true,
      userDataDir: join(directory, 'chrome'), env: { PATH: process.env.PATH, HOME: homedir() },
      args: process.platform === 'linux' ? ['--no-sandbox'] : [] });
  })();
  const browser = await launch, context = browser.defaultBrowserContext(), pages = [];
  // mbp2606 Chrome 155 SIGSEGVs when a second incognito context is created.
  // Reuse the default context, resetting cookies and every visited frame origin
  // between fixtures. Each former launch owns fresh pages; tests stay serial.
  let closing;
  return {
    browser: () => browser,
    cookies: () => context.cookies(),
    setCookie: (...cookies) => context.setCookie(...cookies),
    async newPage() { const page = await context.newPage(); pages.push(page); return page; },
    close: () => closing ??= (async () => {
      const origins = new Set(pages.flatMap(page => page.frames().map(frame => frame.url()))
        .filter(url => /^https?:/u.test(url)).map(url => new URL(url).origin));
      // Close pages first so an unload handler cannot write storage after reset.
      await Promise.all(pages.filter(page => !page.isClosed()).map(page => page.close()));
      const session = await browser.target().createCDPSession();
      try {
        for (const origin of origins) await session.send('Storage.clearDataForOrigin', { origin, storageTypes: 'all' });
      } finally { await session.detach(); }
      const cookies = await context.cookies();
      if (cookies.length) await context.deleteCookie(...cookies);
      await context.clearPermissionOverrides();
    })(),
  };
}
