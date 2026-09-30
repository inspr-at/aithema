import { createHash } from 'node:crypto';

export const SBOM_PATH = 'sbom.cdx.json';
const compare = (a, b) => a < b ? -1 : a > b ? 1 : 0;
const algorithms = {
  sha1: ['SHA-1', 20],
  sha256: ['SHA-256', 32],
  sha384: ['SHA-384', 48],
  sha512: ['SHA-512', 64],
};
// Recognized SPDX IDs use the schema's id field. Other lockfile licence text
// remains a named licence, rather than inventing an SPDX identifier.
const spdxIds = new Set([
  '0BSD', 'Apache-2.0', 'AGPL-3.0-only', 'AGPL-3.0-or-later',
  'BSD-2-Clause', 'BSD-3-Clause', 'BSD-4-Clause', 'CC0-1.0', 'ISC',
  'GPL-2.0-only', 'GPL-2.0-or-later', 'GPL-3.0-only', 'GPL-3.0-or-later',
  'LGPL-2.1-only', 'LGPL-2.1-or-later', 'LGPL-3.0-only', 'LGPL-3.0-or-later',
  'MIT', 'MPL-2.0', 'OFL-1.1', 'Unlicense', 'Zlib',
]);

/** Convert lockfile SRI digests to CycloneDX's hexadecimal hashes. */
export function integrityHashes(integrity) {
  if (typeof integrity !== 'string' || !integrity.trim()) {
    throw new Error('lockfile integrity must be a non-empty SRI string');
  }
  const hashes = new Map();
  for (const token of integrity.trim().split(/\s+/)) {
    const match = /^(sha1|sha256|sha384|sha512)-([A-Za-z0-9+/_-]+={0,2})(?:\?[^\s]*)?$/.exec(token);
    if (!match) throw new Error(`unsupported or malformed lockfile integrity: ${token}`);
    const [, algorithm, encoded] = match;
    const [alg, size] = algorithms[algorithm];
    const bytes = Buffer.from(encoded, 'base64');
    const normalized = encoded.replace(/-/g, '+').replace(/_/g, '/').replace(/=+$/, '');
    if (bytes.length !== size || bytes.toString('base64').replace(/=+$/, '') !== normalized) {
      throw new Error(`invalid ${algorithm} lockfile integrity digest`);
    }
    const content = bytes.toString('hex');
    hashes.set(`${alg}:${content}`, { alg, content });
  }
  return [...hashes.entries()].sort(([a], [b]) => compare(a, b)).map(([, hash]) => hash);
}

function requiredText(value, label) {
  if (typeof value !== 'string' || !value.trim()) throw new Error(`${label} must be a non-empty string`);
  return value;
}

function licenses(value, label) {
  const text = requiredText(value, `${label} license`);
  // npm lockfiles carry SPDX identifiers, SPDX expressions, or named licences.
  if (/\b(?:AND|OR|WITH)\b|[()]/.test(text)) return [{ expression: text }];
  if (spdxIds.has(text)) {
    return [{ license: { id: text } }];
  }
  return [{ license: { name: text } }];
}

function component(name, version, license, type, ref) {
  requiredText(name, 'package name');
  requiredText(version, `${name} version`);
  const match = /^(?:(@[^/]+)\/)?([^/]+)$/.exec(name);
  if (!match) throw new Error(`invalid npm package name: ${name}`);
  const [, group, localName] = match;
  const purl = `pkg:npm/${group ? `${encodeURIComponent(group)}/` : ''}${encodeURIComponent(localName)}@${encodeURIComponent(version)}`;
  return {
    type,
    'bom-ref': ref,
    ...(group ? { group } : {}),
    name: localName,
    version,
    purl,
    ...(license === undefined ? {} : { licenses: licenses(license, name) }),
  };
}

/**
 * One offline, deterministic lockfile inventory for runtime and source exports.
 * Includes all locked packages (including dev/optional/platform entries), not
 * the workstation's node_modules. Time uses the existing Git committer epoch.
 * @param {object} pkg
 * @param {object} lock
 * @param {number} epochSeconds
 */
export function buildSbom(pkg, lock, epochSeconds) {
  if (!Number.isSafeInteger(epochSeconds) || epochSeconds < 0
      || !Number.isFinite(new Date(epochSeconds * 1000).getTime())) {
    throw new Error('SBOM epoch must be valid non-negative integer seconds');
  }
  if (![2, 3].includes(lock?.lockfileVersion) || !lock.packages || !lock.packages['']) {
    throw new Error('SBOM requires an npm v2/v3 lockfile with packages and a root entry');
  }
  const root = lock.packages[''];
  requiredText(pkg.license, 'root package license');
  for (const key of ['name', 'version', 'license']) {
    if (root[key] !== pkg[key] || (key !== 'license' && lock[key] !== pkg[key])) {
      throw new Error(`package.json and package-lock.json disagree on ${key}`);
    }
  }
  for (const key of ['dependencies', 'devDependencies', 'optionalDependencies']) {
    const declared = Object.entries(pkg[key] ?? {}).sort(([a], [b]) => compare(a, b));
    const locked = Object.entries(root[key] ?? {}).sort(([a], [b]) => compare(a, b));
    if (JSON.stringify(declared) !== JSON.stringify(locked)) {
      throw new Error(`package.json and package-lock.json disagree on ${key}`);
    }
  }
  const components = Object.entries(lock.packages).filter(([path]) => path !== '')
    .sort(([a], [b]) => compare(a, b)).map(([path, entry]) => {
      if (!/^node_modules\/(?:@[^/]+\/)?[^/]+(?:\/node_modules\/(?:@[^/]+\/)?[^/]+)*$/.test(path)
          || path.split('/').some((part) => part === '.' || part === '..' || part.includes('\\')) || entry.link) {
        throw new Error(`unsupported lockfile package path or link: ${path}`);
      }
      const name = entry.name ?? path.slice(path.lastIndexOf('node_modules/') + 'node_modules/'.length);
      const item = component(name, entry.version, entry.license, 'library', `npm:${path}`);
      item.hashes = integrityHashes(entry.integrity);
      item.properties = [{ name: 'aithema:lockfile:path', value: path }];
      if (entry.license === undefined) {
        item.properties.push({ name: 'aithema:license-evidence', value: 'Not declared in package-lock.json' });
      }
      if (entry.dev) item.scope = 'excluded';
      if (entry.resolved) {
        const url = new URL(entry.resolved);
        if (!['https:', 'http:'].includes(url.protocol) || url.username || url.password) {
          throw new Error(`unsupported lockfile resolved URL: ${path}`);
        }
        item.externalReferences = [{ type: 'distribution', url: entry.resolved }];
      }
      return item;
    });
  return {
    bomFormat: 'CycloneDX',
    specVersion: '1.6',
    version: 1,
    metadata: {
      timestamp: new Date(epochSeconds * 1000).toISOString(),
      component: component(pkg.name, pkg.version, pkg.license, 'application', 'aithema:root'),
    },
    components,
  };
}

/** Stable JSON bytes, independent of lockfile object key insertion order. */
export function sbomBytes(pkg, lock, epochSeconds) {
  return Buffer.from(`${JSON.stringify(buildSbom(pkg, lock, epochSeconds), null, 2)}\n`, 'utf8');
}

/** Stage a generated artifact, never trusting a committed stale SBOM. */
export function addSbom(files, epochSeconds) {
  for (const path of ['package.json', 'package-lock.json']) {
    if (!files.has(path)) throw new Error(`SBOM input missing from release inventory: ${path}`);
  }
  const pkg = JSON.parse(files.get('package.json').toString('utf8'));
  const lock = JSON.parse(files.get('package-lock.json').toString('utf8'));
  const bytes = sbomBytes(pkg, lock, epochSeconds);
  files.set(SBOM_PATH, bytes);
  return createHash('sha256').update(bytes).digest('hex');
}
