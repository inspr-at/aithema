import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import packageInfo from '../package.json' with { type: 'json' };

/** Existing placeholder version, source SHA and source date. Archives can supply the two source facts. */
export function buildInfo(values = process.env) {
  let commit = values.AITHEMA_COMMIT ?? null, date = values.AITHEMA_BUILD_DATE ?? null;
  try {
    const ref = typeof commit === 'string' && /^[a-f0-9]{7,40}$/u.test(commit) ? commit : 'HEAD';
    const source = execFileSync('git', ['-C', fileURLToPath(new URL('..', import.meta.url)), 'show', '-s', '--format=%H%n%cI', ref],
      { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'], timeout: 1000, maxBuffer: 4096 }).trim().split('\n');
    commit ??= source[0]; date ??= source[1];
  } catch { /* An archive uses its supplied build metadata; missing facts are never invented. */ }
  return { version: packageInfo.version, product: 'Aithema 2026.10', commit, date };
}
