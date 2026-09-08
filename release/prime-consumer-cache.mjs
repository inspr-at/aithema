#!/usr/bin/env node
/**
 * Online packument prime for the offline file: consumer proof.
 *
 * `npm ci` stores lockfile tarballs. It does not store registry packuments that
 * `npm install --offline` of a `file:` artifact must read. This helper does one
 * online install of an admitted runtime tarball into an explicit cache. It
 * never primes the implicit global cache and never writes `dist/`.
 */
import { execFileSync, spawnSync } from 'node:child_process';
import { copyFileSync, existsSync, lstatSync, mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, join, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

import { buildRelease } from './build-release.mjs';

const defaultRepoRoot = resolve(fileURLToPath(new URL('..', import.meta.url)));
const NPM_INSTALL = ['install', '--ignore-scripts', '--no-audit', '--no-fund'];

/**
 * @param {string} [cacheDir]
 * @returns {string}
 */
export function resolveExplicitNpmCache(cacheDir = process.env.AITHEMA_NPM_CACHE) {
  if (typeof cacheDir !== 'string' || !cacheDir.trim()) {
    throw new Error(
      'refusing to prime the implicit global npm cache; pass --cache or AITHEMA_NPM_CACHE',
    );
  }
  return resolve(cacheDir);
}

/**
 * @param {string} [outDir]
 * @returns {string}
 */
export function resolvePrimeOutDir(outDir = process.env.AITHEMA_PRIME_OUT) {
  if (typeof outDir !== 'string' || !outDir.trim()) {
    throw new Error('refusing to build into dist/; pass --out-dir or AITHEMA_PRIME_OUT');
  }
  const resolved = resolve(outDir);
  const repoDist = resolve(defaultRepoRoot, 'dist');
  if (resolved === repoDist || resolved.startsWith(`${repoDist}${sep}`)) {
    throw new Error('refusing to write prime/build output into dist/; that coordinate is immutable');
  }
  return resolved;
}

/**
 * @param {string} cacheDir
 * @returns {NodeJS.ProcessEnv}
 */
export function npmEnvForCache(cacheDir) {
  const env = { ...process.env, npm_config_cache: resolveExplicitNpmCache(cacheDir) };
  delete env.npm_config_offline;
  return env;
}

/**
 * @param {object} input
 * @param {string} input.artifactPath
 * @param {string} [input.cacheDir]
 * @param {string} [input.consumerName]
 * @returns {{ cacheDir: string, artifactName: string }}
 */
export function primeConsumerCache({
  artifactPath,
  cacheDir = process.env.AITHEMA_NPM_CACHE,
  consumerName = 'aithema-cache-prime',
}) {
  const cache = resolveExplicitNpmCache(cacheDir);
  if (typeof artifactPath !== 'string' || !existsSync(artifactPath) || !lstatSync(artifactPath).isFile()) {
    throw new Error(`consumer cache prime requires a runtime tarball: ${artifactPath}`);
  }
  mkdirSync(cache, { recursive: true });
  const stage = mkdtempSync(join(tmpdir(), 'aithema-cache-prime-'));
  const artifactName = basename(artifactPath);
  try {
    mkdirSync(join(stage, 'vendor'), { recursive: true });
    copyFileSync(artifactPath, join(stage, 'vendor', artifactName));
    writeFileSync(join(stage, 'package.json'), `${JSON.stringify({
      name: consumerName,
      private: true,
      type: 'module',
      dependencies: {
        '@inspr/aithema-core': `file:./vendor/${artifactName}`,
      },
    }, null, 2)}\n`, 'utf8');
    const install = spawnSync('npm', NPM_INSTALL, {
      cwd: stage,
      encoding: 'utf8',
      timeout: 300_000,
      env: npmEnvForCache(cache),
    });
    if (install.status !== 0) {
      throw new Error(`online consumer cache prime failed:\n${install.stderr || install.stdout}`);
    }
  } finally {
    try {
      execFileSync('trash', [stage], { stdio: 'ignore' });
    } catch {
      // Staging residue is outside dist/; the primed cache is the kept output.
    }
  }
  return { cacheDir: cache, artifactName };
}

/**
 * @param {string} [repoRoot]
 * @param {string} [outDir]
 */
export function buildRuntimeArtifactForPrime(repoRoot = defaultRepoRoot, outDir = process.env.AITHEMA_PRIME_OUT) {
  return buildRelease({ repoRoot, outDir: resolvePrimeOutDir(outDir) });
}

function parseArgs(argv) {
  const options = { build: false };
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === '--artifact') options.artifact = argv[++index];
    else if (arg === '--cache') options.cache = argv[++index];
    else if (arg === '--out-dir') options.outDir = argv[++index];
    else if (arg === '--build') options.build = true;
    else if (arg === '--help' || arg === '-h') options.help = true;
    else if (arg.startsWith('-')) {
      throw new Error(`unknown option: ${arg}`);
    }
  }
  return options;
}

const entry = process.argv[1] ? resolve(process.argv[1]) : '';
if (entry === fileURLToPath(import.meta.url)) {
  const args = parseArgs(process.argv.slice(2));
  if (args.help) {
    process.stdout.write(
      'Usage: node release/prime-consumer-cache.mjs --cache <dir> (--artifact <tgz> | --build --out-dir <path>)\n',
    );
    process.exit(0);
  }
  const cacheDir = resolveExplicitNpmCache(args.cache);
  let artifactPath = args.artifact;
  if (args.build) {
    const built = buildRuntimeArtifactForPrime(defaultRepoRoot, args.outDir);
    artifactPath = built.artifactPath;
  }
  const primed = primeConsumerCache({ artifactPath, cacheDir });
  process.stdout.write(`${JSON.stringify({
    ok: true,
    cache: primed.cacheDir,
    artifact: primed.artifactName,
  }, null, 2)}\n`);
}
