#!/usr/bin/env node
import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { admitRelease, assertReleaseRefMatchesVersion, assertStrictSemVer } from './admit-release.mjs';
import { sha256 } from './lib/digest.mjs';

const defaultRepoRoot = resolve(fileURLToPath(new URL('..', import.meta.url)));

/**
 * @param {string} [ref]
 * @param {string} version
 * @returns {string | null}
 */
export function tagNameFromReleaseRef(ref, version) {
  return assertReleaseRefMatchesVersion(ref, version);
}

/**
 * Admitted runtime + source pair that a tag-gated GitHub Release must retain.
 * @param {string} distRoot
 * @param {string} version
 * @returns {{ name: string, path: string, sha256: string, bytes: Buffer }[]}
 */
export function listAdmittedForgeAssets(distRoot, version) {
  const coordinate = assertStrictSemVer(version);
  const runtimeDir = join(distRoot, `inspr-aithema-core-${coordinate}`);
  const sourceDir = join(distRoot, `inspr-aithema-core-source-${coordinate}`);
  const names = [
    `inspr-aithema-core-${coordinate}.tgz`,
    `inspr-aithema-core-${coordinate}.manifest.json`,
    `inspr-aithema-core-source-${coordinate}.tgz`,
    `inspr-aithema-core-source-${coordinate}.manifest.json`,
  ];
  const dirs = [runtimeDir, runtimeDir, sourceDir, sourceDir];
  return names.map((name, index) => {
    const path = join(dirs[index], name);
    const bytes = readFileSync(path);
    return { name, path, bytes, sha256: `sha256:${sha256(bytes)}` };
  });
}

/**
 * Decide how to retain local admitted bytes as immutable forge assets.
 * Does not talk to the network.
 *
 * @param {object} input
 * @param {string} [input.ref]
 * @param {string} input.version
 * @param {{ name: string, sha256: string }[]} input.localAssets
 * @param {Record<string, string> | null} [input.existingAssetDigests] name -> sha256:
 * @returns {object}
 */
export function planForgeAssetRetention({ ref, version, localAssets, existingAssetDigests = null }) {
  const coordinate = assertStrictSemVer(version);
  const tag = assertReleaseRefMatchesVersion(ref, coordinate);
  if (!tag) {
    return {
      action: 'skip',
      version: coordinate,
      reason: 'forge retention requires an explicit version tag; branch dispatch stays ephemeral',
    };
  }
  if (!Array.isArray(localAssets) || localAssets.length !== 4) {
    throw new Error('forge retention requires the admitted runtime and source artifact/manifest pair');
  }
  if (existingAssetDigests == null) {
    return {
      action: 'create',
      tag,
      version: coordinate,
      assets: localAssets.map((asset) => asset.name),
    };
  }
  const conflicts = [];
  const missing = [];
  const identical = [];
  for (const local of localAssets) {
    const remote = existingAssetDigests[local.name];
    if (remote == null) missing.push(local.name);
    else if (remote !== local.sha256) conflicts.push(local.name);
    else identical.push(local.name);
  }
  if (conflicts.length) {
    return { action: 'conflict', tag, version: coordinate, conflicts };
  }
  if (missing.length) {
    return { action: 'upload-missing', tag, version: coordinate, missing, identical };
  }
  return { action: 'identical', tag, version: coordinate, identical };
}

/**
 * @param {string} [ghToken]
 * @returns {{
 *   viewRelease: (tag: string) => { names: string[] } | null,
 *   downloadAsset: (tag: string, name: string) => Buffer,
 *   createRelease: (input: { tag: string, files: string[], title: string, notes: string }) => void,
 *   uploadAssets: (tag: string, files: string[]) => void,
 * }}
 */
export function createGhForgeAdapter(ghToken = process.env.GH_TOKEN) {
  if (!ghToken) {
    throw new Error('forge retention requires GH_TOKEN');
  }
  const env = { ...process.env, GH_TOKEN: ghToken, GH_NO_UPDATE_NOTIFIER: '1' };
  const gh = (args) => execFileSync('gh', args, {
    encoding: 'utf8',
    env,
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  return {
    viewRelease(tag) {
      try {
        const raw = gh(['release', 'view', tag, '--json', 'assets']);
        const parsed = JSON.parse(raw);
        const names = (parsed.assets || []).map((asset) => asset.name).filter(Boolean);
        return { names };
      } catch (error) {
        const message = error instanceof Error ? `${error.message}\n${error.stderr || ''}` : String(error);
        if (/release not found|HTTP 404|Not Found/i.test(message)) return null;
        throw error;
      }
    },
    downloadAsset(tag, name) {
      if (!/^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(name) || name.includes('..')) {
        throw new Error(`refusing to download unexpected forge asset name: ${name}`);
      }
      const dir = mkdtempSync(join(tmpdir(), 'aithema-forge-dl-'));
      try {
        gh(['release', 'download', tag, '--pattern', name, '--dir', dir]);
        return readFileSync(join(dir, name));
      } finally {
        try {
          execFileSync('trash', [dir], { stdio: ['ignore', 'ignore', 'ignore'] });
        } catch {
          // Own download residue; bytes already read.
        }
      }
    },
    createRelease({ tag, files, title, notes }) {
      gh(['release', 'create', tag, ...files, '--verify-tag', '--title', title, '--notes', notes]);
    },
    uploadAssets(tag, files) {
      // No --clobber: a name that already exists must fail rather than replace bytes.
      gh(['release', 'upload', tag, ...files]);
    },
  };
}

/**
 * @param {object} [options]
 */
export function retainForgeAssets({
  repoRoot = defaultRepoRoot,
  version = process.env.RELEASE_VERSION,
  ref = process.env.RELEASE_REF,
  distRoot = join(repoRoot, 'dist'),
  forge,
} = {}) {
  const coordinate = assertStrictSemVer(version);
  const tag = assertReleaseRefMatchesVersion(ref, coordinate);
  admitRelease({ repoRoot, version: coordinate, ref, distRoot });
  const localAssets = listAdmittedForgeAssets(distRoot, coordinate);
  if (!tag) {
    return planForgeAssetRetention({
      ref,
      version: coordinate,
      localAssets,
      existingAssetDigests: null,
    });
  }
  const adapter = forge ?? createGhForgeAdapter();
  const existing = adapter.viewRelease(tag);
  let existingAssetDigests = null;
  if (existing) {
    const expected = new Set(localAssets.map((asset) => asset.name));
    existingAssetDigests = {};
    for (const name of existing.names) {
      if (!expected.has(name)) continue;
      const bytes = adapter.downloadAsset(tag, name);
      existingAssetDigests[name] = `sha256:${sha256(bytes)}`;
    }
  }
  const plan = planForgeAssetRetention({
    ref,
    version: coordinate,
    localAssets,
    existingAssetDigests,
  });
  if (plan.action === 'conflict') {
    throw new Error(
      `refusing to replace non-identical GitHub Release assets for ${plan.tag}: ${plan.conflicts.join(', ')}`,
    );
  }
  const filesFor = (names) => localAssets.filter((asset) => names.includes(asset.name)).map((asset) => asset.path);
  if (plan.action === 'create') {
    adapter.createRelease({
      tag: plan.tag,
      files: filesFor(plan.assets),
      title: `@inspr/aithema-core ${coordinate}`,
      notes: `Immutable admitted coordinate ${coordinate}. Retain these GitHub Release assets; do not treat workflow upload-artifact as publication evidence.`,
    });
  } else if (plan.action === 'upload-missing') {
    adapter.uploadAssets(plan.tag, filesFor(plan.missing));
  }
  return plan;
}

function parseArgs(argv) {
  const options = {};
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === '--help' || arg === '-h') options.help = true;
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
    process.stdout.write('Usage: node release/retain-forge-assets.mjs\n');
    process.exit(0);
  }
  const result = retainForgeAssets();
  process.stdout.write(`${JSON.stringify({ ok: true, ...result }, null, 2)}\n`);
}
