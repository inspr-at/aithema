#!/usr/bin/env node
import { readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { sha256File } from './lib/digest.mjs';

const repoRoot = resolve(fileURLToPath(new URL('..', import.meta.url)));
const expectedHash = '0d96a4ff68ad6d4b6f1f30f713b18d5184912ba8dd389f86aa7710db079abcb0';
const licensePath = join(repoRoot, 'LICENSE');
const actualHash = sha256File(licensePath);
if (actualHash !== expectedHash) {
  console.error('LICENSE is not the canonical AGPLv3 text');
  process.exit(1);
}

const pkg = JSON.parse(readFileSync(join(repoRoot, 'package.json'), 'utf8'));
if (pkg.license !== 'AGPL-3.0-only') {
  console.error('package.json must declare AGPL-3.0-only');
  process.exit(1);
}

const readme = readFileSync(join(repoRoot, 'README.md'), 'utf8');
if (!readme.includes('AGPL-3.0-only')) {
  console.error('README.md must declare AGPL-3.0-only');
  process.exit(1);
}

console.log('license surface verified: AGPL-3.0-only');
