// One Chrome process per test file; each former launch gets a fresh context.
// The profile outlives individual fixtures, including fixtures that remove their
// own directories. Context isolation preserves cookies/storage and tab ownership.
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
  const context = await (await launch).createBrowserContext();
  // mbp2606 Chrome 155 SIGSEGVs on createBrowserContext after disposing a context.
  // Close every fixture page now (including its connections/timers); release the
  // empty, isolated contexts together when the file-owned Chrome process closes.
  // Cleanup is idempotent because nested tests may register the same fixture.
  let closing;
  context.close = () => closing ??= (async () => {
    await Promise.all((await context.pages()).map(page => page.close()));
  })();
  return context;
}
