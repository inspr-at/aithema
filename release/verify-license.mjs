#!/usr/bin/env node
import { readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { sha256File } from './lib/digest.mjs';
import { verifyLicenceBoundary } from './lib/licence-boundary.mjs';
import { verifyModelAssets } from './lib/model-assets.mjs';

const repoRoot = resolve(fileURLToPath(new URL('..', import.meta.url)));
const expectedHash = '0d96a4ff68ad6d4b6f1f30f713b18d5184912ba8dd389f86aa7710db079abcb0';
/** Existing CI entrypoint, also callable against an offline fixture tree. */
export function verifyLicenseSurface(root = repoRoot) {
  if (sha256File(join(root, 'LICENSE')) !== expectedHash) {
    throw new Error('LICENSE is not the canonical AGPLv3 text');
  }
  const pkg = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8'));
  if (pkg.license !== 'AGPL-3.0-only') throw new Error('package.json must declare AGPL-3.0-only');
  const readme = readFileSync(join(root, 'README.md'), 'utf8');
  if (!readme.includes('AGPL-3.0-only')) throw new Error('README.md must declare AGPL-3.0-only');
  const notices = JSON.parse(readFileSync(join(root, 'NOTICES.json'), 'utf8'));
  verifyModelAssets(notices, readme);
  verifyLicenceBoundary(root);
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    verifyLicenseSurface();
    console.log('license surface verified: AGPL-3.0-only; model assets and contracts/element boundaries verified');
  } catch (error) {
    console.error(error.message);
    process.exitCode = 1;
  }
}
