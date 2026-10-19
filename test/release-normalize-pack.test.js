import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { packRelease } from '../release/pack.mjs';
import { normalizedDigest } from '../release/normalize.mjs';

test('the complete candidate and release packs of C normalize equally, including server runtime projections', t => {
  const root = new URL('../', import.meta.url), output = mkdtempSync(join(tmpdir(), 'aithema-normalize-packs-'));
  t.after(() => rmSync(output, { recursive: true, force: true }));
  const source = JSON.parse(readFileSync(new URL('release/version.json', root)));
  const candidate = packRelease({ root: fileURLToPath(root), output: join(output, 'candidate') });
  const release = packRelease({ root: fileURLToPath(root), output: join(output, 'release'), ref: `refs/tags/v${source.version}` });
  assert.equal(normalizedDigest(candidate.directory), normalizedDigest(release.directory));
});
