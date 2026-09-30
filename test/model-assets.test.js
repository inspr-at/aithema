import { cpSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { it } from 'node:test';
import assert from 'node:assert/strict';

import { validateModelAssets, verifyModelAssets } from '../release/lib/model-assets.mjs';
import { verifyLicenseSurface } from '../release/verify-license.mjs';
import { trashTemp } from './fixtures/packaging-support.mjs';

const asset = { id: 'synthetic-model', kind: 'weights', source: 'https://example.invalid/model', license: 'MIT', sha256: 'ab'.repeat(32), bytes: 123 };
const row = (entry) => `| ${Object.values(entry).map((v) => String(v).replace(/\\/g, '\\\\').replace(/\|/g, '\\|')).join(' | ')} |`;
function readme(rows = ['| none bundled | — | — | — | — | — |']) {
  return `# Fixture\n\n## Provenance\n\n### Model weights and voices\n\n| ID | Kind | Source | License | SHA-256 | Bytes |\n| --- | --- | --- | --- | --- | --- |\n${rows.join('\n')}\n\n## License\n\nAGPL-3.0-only.\n`;
}

it('accepts the explicit empty inventory and a one-to-one weights/voice table in either order', () => {
  assert.equal(verifyModelAssets({ model_assets: [] }, readme()), 0);
  const voice = { ...asset, id: 'synthetic-voice', kind: 'voice', bytes: 0 };
  assert.equal(verifyModelAssets({ model_assets: [asset, voice] }, readme([row(voice), row(asset)])), 2);
});

it('accepts escaped table pipes and inline code formatting without changing values', () => {
  const entry = { ...asset, source: 'https://example.invalid/a|b', license: 'License\\name' };
  assert.equal(verifyModelAssets({ model_assets: [entry] }, readme([row(entry)])), 1);
  assert.equal(verifyModelAssets({ model_assets: [asset] }, readme([row(asset).replace(asset.sha256, `\`${asset.sha256}\``)])), 1);
});

for (const [key, value] of [
  ['id', ''], ['id', ' padded '], ['source', null], ['source', 'line\nbreak'], ['license', ''],
  ['kind', 'code'], ['kind', 'VOICE'], ['sha256', 'ab'], ['sha256', 'AB'.repeat(32)],
  ['sha256', `sha256:${'ab'.repeat(32)}`], ['bytes', -1], ['bytes', 1.5], ['bytes', '123'], ['bytes', Number.MAX_SAFE_INTEGER + 1],
]) {
  it(`rejects invalid ${key}: ${JSON.stringify(value)}`, () => {
    assert.throws(() => validateModelAssets([{ ...asset, [key]: value }]), new RegExp(key));
  });
}

it('rejects a missing array, unknown keys, missing fields, non-object entries and duplicate IDs', () => {
  for (const entries of [undefined, {}, [null], [[asset]], [{ ...asset, extra: true }], [asset, { ...asset }]]) {
    assert.throws(() => validateModelAssets(entries), /model_assets|duplicate/);
  }
  for (const key of Object.keys(asset)) {
    const entry = { ...asset };
    delete entry[key];
    assert.throws(() => validateModelAssets([entry]), /exactly/);
  }
});

it('rejects stale, missing, extra and duplicated rows and none bundled alongside assets', () => {
  for (const rows of [[], [row({ ...asset, bytes: 124 })], [row(asset), row(asset)], [row(asset), '| none bundled | — | — | — | — | — |']]) {
    assert.throws(() => verifyModelAssets({ model_assets: [asset] }, readme(rows)), /match.*1:1/);
  }
  assert.throws(() => verifyModelAssets({ model_assets: [] }, readme([row(asset)])), /match.*1:1/);
  assert.throws(() => verifyModelAssets({ model_assets: [] }, readme([])), /none bundled/);
});

it('requires the table in Provenance, with exact headers and one subsection', () => {
  const valid = readme();
  for (const text of [valid.replace('## Provenance', '## Other'), valid.replace('SHA-256', 'Hash'), valid.replace('| --- |', '| -- |'), valid.replace('### Model weights and voices', '### Other'), valid.replace('## License', '### Model weights and voices\n\n## License')]) {
    assert.throws(() => verifyModelAssets({ model_assets: [] }, text), /README/);
  }
});

it('ignores fake inventory tables in fenced code, indented code and HTML comments', () => {
  for (const [open, close] of [['```markdown\n', '\n```'], ['~~~\n', '\n~~~'], ['<!--\n', '\n-->']]) {
    assert.throws(() => verifyModelAssets({ model_assets: [] }, `## Provenance\n${open}${readme()}${close}`), /README/);
  }
  const indented = readme().replace(/^\|/gm, '    |');
  assert.throws(() => verifyModelAssets({ model_assets: [] }, indented), /README/);
});

it('the existing CI verifier integrates both new checks and retains canonical AGPL checks', (t) => {
  const root = mkdtempSync(join(tmpdir(), 'aithema-licence-surface-'));
  t.after(() => trashTemp(root));
  for (const path of ['LICENSE', 'package.json', 'NOTICES.json', 'README.md']) cpSync(new URL(`../${path}`, import.meta.url), join(root, path));
  verifyLicenseSurface(root);
  const notices = JSON.parse(readFileSync(join(root, 'NOTICES.json'), 'utf8'));
  notices.model_assets = [asset];
  writeFileSync(join(root, 'NOTICES.json'), JSON.stringify(notices));
  assert.throws(() => verifyLicenseSurface(root), /match.*1:1/);
  notices.model_assets = [];
  writeFileSync(join(root, 'NOTICES.json'), JSON.stringify(notices));
  mkdirSync(join(root, 'contracts'));
  writeFileSync(join(root, 'contracts/evil.js'), `import '../runtime/evil.js';`);
  assert.throws(() => verifyLicenseSurface(root), /contracts\/evil.js.*runtime\/evil/);
  writeFileSync(join(root, 'LICENSE'), 'noncanonical');
  assert.throws(() => verifyLicenseSurface(root), /canonical AGPL/);
});
