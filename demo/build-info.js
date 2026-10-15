import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { readFileSync } from 'node:fs';
let releaseInfo;
try { releaseInfo = JSON.parse(readFileSync(new URL('../release/runtime.json', import.meta.url))); }
catch (error) {
  if (error.code !== 'ENOENT') throw error;
  releaseInfo = JSON.parse(readFileSync(new URL('../release/version.json', import.meta.url)));
}

/** Existing placeholder version, source SHA and source date. Archives can supply the two source facts. */
export function buildInfo(values = process.env) {
  let commit = releaseInfo.source?.commit ?? values.AITHEMA_COMMIT ?? null, date = releaseInfo.date ?? values.AITHEMA_BUILD_DATE ?? null;
  try {
    const ref = typeof commit === 'string' && /^[a-f0-9]{7,40}$/u.test(commit) ? commit : 'HEAD';
    const source = execFileSync('git', ['-C', fileURLToPath(new URL('..', import.meta.url)), 'show', '-s', '--format=%H%n%cI', ref],
      { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'], timeout: 1000, maxBuffer: 4096 }).trim().split('\n');
    commit ??= source[0]; date ??= source[1];
  } catch { /* An archive uses its supplied build metadata; missing facts are never invented. */ }
  return { version: releaseInfo.version, version_scheme: releaseInfo.version_scheme, release_channel: releaseInfo.release_channel, release_sequence: releaseInfo.release_sequence, product: 'Aithema 2026.10', commit, date };
}
