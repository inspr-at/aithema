import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { cpSync, mkdtempSync, mkdirSync, writeFileSync, symlinkSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';

for (const edge of ['esm', 'dynamic', 'commonjs', 'symlink']) {
  test(`installed host blocks ${edge} imports escaping to workspace files`, t => {
    const root = mkdtempSync(join(tmpdir(), 'aithema-import-guard-')), host = join(root, 'host');
    t.after(() => rmSync(root, { recursive: true, force: true }));
    mkdirSync(host);
    cpSync(new URL('../release/consumer-isolation.mjs', import.meta.url), join(host, 'isolation.mjs'));
    writeFileSync(join(root, 'workspace.cjs'), 'module.exports = 42;');
    writeFileSync(join(host, 'installed.cjs'), 'module.exports = 42;');
    const run = source => {
      writeFileSync(join(host, 'host.mjs'), source);
      return execFileSync(process.execPath, ['--import', './isolation.mjs', 'host.mjs'], { cwd: host, stdio: 'pipe' });
    };
    // A real installed CommonJS dependency and builtins remain usable.
    run("import assert from 'node:assert/strict'; import value from './installed.cjs'; assert.equal(value, 42);");
    const outside = JSON.stringify(pathToFileURL(join(root, 'workspace.cjs')).href);
    symlinkSync(join(root, 'workspace.cjs'), join(host, 'linked.cjs'));
    const source = {
      esm: `import value from ${outside};`,
      dynamic: `await import(${outside});`,
      commonjs: "import { createRequire } from 'node:module'; createRequire(import.meta.url)('../workspace.cjs');",
      symlink: "import value from './linked.cjs';",
    }[edge];
    assert.throws(() => run(source), error => {
      assert.equal(error.status, 1);
      assert.match(error.stderr.toString(), /Host import escaped temporary host/u);
      return true;
    });
  });
}
