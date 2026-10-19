import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { posix } from 'node:path';
import { moduleFiles } from '../release/lib/modules.mjs';
import { releasePaths } from '../release/pack.mjs';

const root = new URL('../', import.meta.url);
const packagePath = 'plugins/grok-voice/package.json';
const files = () => new Map(releasePaths(root).map(path => [path, readFileSync(new URL(path, root))]));

test('AIT-351: Grok is a release module with exact dependencies, all exports and browser assets', () => {
  const tree = files(), metadata = JSON.parse(tree.get(packagePath));
  const version = JSON.parse(tree.get('release/version.json')).version;
  assert.equal(metadata.private, false, 'Grok must enter the shipped module closure');
  assert.equal(metadata.version, version);
  assert.deepEqual(metadata.dependencies, { '@inspr/aithema-core': version, '@inspr/aithema-server': version });
  const lock = JSON.parse(tree.get('package-lock.json'));
  assert.deepEqual(lock.packages['plugins/grok-voice'].dependencies, metadata.dependencies);
  const grok = moduleFiles(tree, { path: packagePath });
  const server = moduleFiles(tree, { path: 'packages/server/package.json' });
  for (const target of Object.values(metadata.exports)) assert.ok(grok.has(target.slice(2)), target);
  for (const path of ['src/voice-coordinator.js', 'src/composed/accounting.js', 'src/composed/server.js',
    'src/composed/client.js', 'src/composed/browser-audio.js', 'src/composed/pcm-capture-worklet.js',
    'src/composed/network-client.js', 'src/composed/network-relay.js']) {
    assert.ok(server.has(path), `shipped helper/browser asset ${path}`);
  }
  for (const [name, members] of [['grok', grok], ['server', server]]) for (const [path, bytes] of members) {
    if (!/\.(?:js|ts)$/u.test(path)) continue;
    const source = bytes.toString();
    assert.doesNotMatch(source, /(?:plugins\/composed-voice|plugins\/elevenlabs\/src\/components|packages\/core\/src)/u);
    for (const [, , specifier] of source.matchAll(/\b(?:from\s*|import\s*(?:\(\s*)?)(['"`])(\.{1,2}\/[^'"`\n]+)\1/gu)) {
      const target = posix.normalize(posix.join(posix.dirname(path), specifier));
      assert.ok(members.has(target) || path.endsWith('.d.ts') && members.has(target.replace(/\.js$/u, '.d.ts')), `${name}/${path} -> ${specifier}`);
    }
  }
});

test('AIT-351: omitted coordinator helpers and browser worklets fail during module packing', () => {
  for (const source of ["import './missing.js';", "export { helper } from './missing.js';",
    "const worklet = new URL('./missing.js', import.meta.url);"]) {
    const tree = new Map([
      ['packages/server/package.json', Buffer.from(JSON.stringify({ name: '@inspr/aithema-server', exports: { '.': './src/index.js' } }))],
      ['packages/server/src/index.js', Buffer.from(source)],
    ]);
    assert.throws(() => moduleFiles(tree, { path: 'packages/server/package.json' }), /Unpackaged dependency/u);
  }
});

test('AIT-351: source-tree imports cannot depend on private prototype packages', () => {
  const tree = new Map([
    ['plugins/grok-voice/package.json', Buffer.from(JSON.stringify({ name: '@inspr/aithema-plugin-grok-voice' }))],
    ['plugins/grok-voice/src/server.js', Buffer.from("import { prototype } from '../../prototype/src/index.js';")],
    ['plugins/prototype/package.json', Buffer.from(JSON.stringify({ name: '@inspr/prototype', private: true, exports: { './index': './src/index.js' } }))],
    ['plugins/prototype/src/index.js', Buffer.from('export const prototype = true;')],
  ]);
  assert.throws(() => moduleFiles(tree, { path: packagePath }), /Unpackaged dependency/u);
});

test('AIT-351: rewritten source URLs follow declared targets, including root and conditional exports', () => {
  const tree = new Map([
    [packagePath, Buffer.from(JSON.stringify({ name: '@inspr/aithema-plugin-grok-voice' }))],
    ['plugins/grok-voice/src/client.js', Buffer.from("export { helper } from '../../../packages/server/src/composed/client.js';")],
    ['packages/server/src/composed/client.js', Buffer.from('export const helper = true;')],
  ]);
  for (const [exports, expected] of [
    [{ './composed-voice/client': './src/composed/client.js' }, '@inspr/aithema-server/composed-voice/client'],
    [{ '.': { import: './src/composed/client.js' } }, '@inspr/aithema-server'],
  ]) {
    tree.set('packages/server/package.json', Buffer.from(JSON.stringify({ name: '@inspr/aithema-server', exports })));
    assert.equal(moduleFiles(tree, { path: packagePath }).get('src/client.js').toString(), `export { helper } from '${expected}';`);
  }
  // A plausible subpath name is insufficient when it exports different bytes.
  for (const exports of [{}, { './composed/client': './src/other.js' }]) {
    tree.set('packages/server/package.json', Buffer.from(JSON.stringify({ name: '@inspr/aithema-server', exports })));
    assert.throws(() => moduleFiles(tree, { path: packagePath }), /Missing package export/u);
  }
});
