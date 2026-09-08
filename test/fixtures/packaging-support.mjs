import { execFileSync, spawn } from 'node:child_process';
import { cpSync, existsSync, mkdirSync, mkdtempSync, readdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const fixtureRoot = resolve(fileURLToPath(new URL('.', import.meta.url)));
const sourceRoot = resolve(fixtureRoot, '../..');

/**
 * @param {string} path
 */
export function trashTemp(path) {
  execFileSync('trash', [path], { stdio: 'ignore' });
}

/**
 * @param {string} repoRoot
 * @param {string[]} args
 * @returns {string}
 */
export function git(repoRoot, args) {
  return execFileSync('git', args, {
    cwd: repoRoot,
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
  }).trimEnd();
}

/**
 * @param {string} repoRoot
 * @param {string} message
 */
export function commitAll(repoRoot, message) {
  git(repoRoot, ['add', '-A']);
  return git(repoRoot, ['commit', '-m', message]);
}

/**
 * @param {string} [prefix]
 */
export function createTempRepo(prefix = 'aithema-pack-fixture-') {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  git(dir, ['init']);
  git(dir, ['config', 'user.email', 'packaging-fixture@example.invalid']);
  git(dir, ['config', 'user.name', 'Packaging Fixture']);
  return dir;
}

/**
 * @param {string} repoRoot
 * @param {object} [allowlist]
 */
export function seedMinimalPackageTree(repoRoot, allowlist) {
  for (const dir of ['bin', 'lib', 'runtime', 'workspace', 'examples', 'release/lib']) {
    mkdirSync(join(repoRoot, dir), { recursive: true });
  }
  cpSync(join(sourceRoot, 'lib'), join(repoRoot, 'lib'), { recursive: true });
  cpSync(join(sourceRoot, 'runtime'), join(repoRoot, 'runtime'), { recursive: true });
  cpSync(join(sourceRoot, 'workspace'), join(repoRoot, 'workspace'), { recursive: true });
  cpSync(join(sourceRoot, 'examples'), join(repoRoot, 'examples'), { recursive: true });
  cpSync(join(sourceRoot, 'bin'), join(repoRoot, 'bin'), { recursive: true });
  for (const rel of [
    'package.json',
    'package-lock.json',
    'LICENSE',
    'NOTICES.json',
    'README.md',
    'RUNBOOK.md',
    'release/allowlist.json',
    'release/source-allowlist.json',
    'release/publication-inventory.json',
    'release/build-release.mjs',
    'release/build-source.mjs',
    'release/consumer-proof.mjs',
    'release/prime-consumer-cache.mjs',
    'release/verify-license.mjs',
    'release/lib/digest.mjs',
    'release/lib/git.mjs',
    'release/lib/manifest.mjs',
    'release/lib/source-manifest.mjs',
    'release/lib/tarball.mjs',
    'release/lib/tree.mjs',
    'release/lib/provenance.mjs',
    'release/admit-release.mjs',
    'release/retain-forge-assets.mjs',
    '.gitignore',
  ]) {
    const dest = join(repoRoot, rel);
    mkdirSync(dirname(dest), { recursive: true });
    cpSync(join(sourceRoot, rel), dest);
  }
  if (allowlist) {
    writeFileSync(join(repoRoot, 'release/allowlist.json'), `${JSON.stringify(allowlist, null, 2)}\n`, 'utf8');
  }
}

/**
 * @param {string} repoRoot
 */
export function indexTree(repoRoot) {
  return git(repoRoot, ['write-tree']);
}

/**
 * @param {string} repoRoot
 * @param {string} beforeTree
 */
export function assertIndexUnchanged(repoRoot, beforeTree) {
  const afterTree = indexTree(repoRoot);
  if (beforeTree !== afterTree) {
    throw new Error(`git index changed during release build: ${beforeTree} -> ${afterTree}`);
  }
}

/**
 * Names of leftover publication staging directories under an output directory.
 * @param {string} outDir
 * @returns {string[]}
 */
export function stagingResidue(outDir) {
  if (!existsSync(outDir)) return [];
  return readdirSync(outDir).filter((entry) => entry.startsWith('.publish-'));
}

/**
 * @param {number} ms
 */
function delay(ms) {
  return new Promise((resolveDelay) => { setTimeout(resolveDelay, ms); });
}

/**
 * Run several publishers against one release coordinate at the same moment.
 *
 * Each child announces readiness and blocks until the parent releases a shared
 * barrier, so the processes really contend for the coordinate instead of
 * running one after the other.
 *
 * @param {object} input
 * @param {string} input.outDir
 * @param {string} input.version
 * @param {Record<string, string>} input.payloads tag -> artifact bytes
 * @returns {Promise<Record<string, { code: number | null, stdout: string, stderr: string }>>}
 */
export async function runPublishRace({ outDir, version, payloads }) {
  const barrierDir = mkdtempSync(join(tmpdir(), 'aithema-pack-barrier-'));
  const childPath = join(fixtureRoot, 'publish-race-child.mjs');
  const tags = Object.keys(payloads);
  const running = tags.map((tag) => {
    const child = spawn(process.execPath, [childPath], {
      env: {
        ...process.env,
        RACE_OUT_DIR: outDir,
        RACE_BARRIER_DIR: barrierDir,
        RACE_TAG: tag,
        RACE_VERSION: version,
        RACE_PAYLOAD: payloads[tag],
      },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let stdout = '';
    let stderr = '';
    child.stdout.setEncoding('utf8');
    child.stderr.setEncoding('utf8');
    child.stdout.on('data', (chunk) => { stdout += chunk; });
    child.stderr.on('data', (chunk) => { stderr += chunk; });
    const done = new Promise((resolveChild, rejectChild) => {
      child.on('error', rejectChild);
      child.on('close', (code) => { resolveChild({ tag, code, stdout, stderr }); });
    });
    return done;
  });

  const readyDeadline = Date.now() + 30_000;
  while (!tags.every((tag) => existsSync(join(barrierDir, `ready-${tag}`)))) {
    if (Date.now() > readyDeadline) {
      throw new Error('publish race children did not reach the barrier');
    }
    await delay(5);
  }
  writeFileSync(join(barrierDir, 'go'), 'go\n', 'utf8');

  const settled = await Promise.all(running);
  trashTemp(barrierDir);
  return Object.fromEntries(settled.map((entry) => [entry.tag, entry]));
}
