import { constants } from 'node:fs';
import { access } from 'node:fs/promises';
import { homedir, hostname } from 'node:os';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { setTimeout as delay } from 'node:timers/promises';
import { computeExecutablePath, install } from '@puppeteer/browsers';

// Match puppeteer-core 25.13.0's supported revision. Never resolve a moving tag.
export const browserBuild = '155.0.8059.39';
export const browserCache = join(homedir(), '.cache', 'aithema-browsers');
export const browserInstall = { browser: 'chrome-headless-shell', buildId: browserBuild, cacheDir: browserCache };
let installation;

async function installPinnedBrowser() {
  for (let attempt = 1; attempt <= 3; attempt++) {
    try { return await install(browserInstall); }
    catch (error) {
      if (attempt === 3) throw error;
      // The installer removes incomplete archives. Retry this exact revision;
      // never substitute a system browser after a truncated network transfer.
      console.error(`Pinned test browser download failed (${attempt}/3); retrying ${browserBuild}`);
      await delay(attempt * 1000);
    }
  }
}

export async function browserPath() {
  // Explicit paths (including mbp2607's refusing stub) must never fall through.
  if (process.env.CHROME_PATH) {
    await access(process.env.CHROME_PATH, constants.X_OK);
    return process.env.CHROME_PATH;
  }
  if (/mbp2607/iu.test(hostname())) throw new Error('Test browser setup is forbidden on mbp2607');
  const executable = computeExecutablePath(browserInstall);
  try { await access(executable, constants.X_OK); }
  catch {
    installation ??= installPinnedBrowser();
    await installation;
    await access(executable, constants.X_OK);
  }
  return executable;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  console.log(`Test browser: ${await browserPath()} (pinned ${browserBuild})`);
}
