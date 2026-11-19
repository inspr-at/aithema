import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { runInNewContext } from 'node:vm';
import { parse } from 'yaml';

const ci = parse(readFileSync(new URL('../.github/workflows/ci.yml', import.meta.url), 'utf8'));
const job = ci.jobs['preview-security'];
const engines = 'chromium webkit firefox';
const heavy = "(github.event_name != 'pull_request' || needs.changes.result != 'success' || needs.changes.outputs.docs-only != 'true')";
const step = id => {
  const found = job.steps.find(value => value.id === id);
  assert.ok(found, `preview-security needs ${id}`);
  return found;
};
const evaluate = (value, context) => runInNewContext(value.replace(/^\$\{\{|\}\}$/gu, '')
  .replaceAll('outputs.docs-only', "outputs['docs-only']")
  .replaceAll('outputs.cache-hit', "outputs['cache-hit']"), context);

test('AIT-564: engine and apt download caches bind the runner, architecture, exact core pin and browser list', () => {
  assert.equal(job.env?.PLAYWRIGHT_VERSION, '1.56.1');
  assert.equal(job.env.PLAYWRIGHT_BROWSERS_PATH, '${{ runner.temp }}/preview-browsers');
  for (const [id, prefix, path] of [
    ['preview_browsers', 'preview-browsers', '${{ env.PLAYWRIGHT_BROWSERS_PATH }}'],
    ['preview_apt', 'preview-apt', '${{ runner.temp }}/preview-apt-archives/*.deb'],
  ]) {
    const cache = step(id);
    assert.match(cache.uses, /^actions\/cache@[a-f0-9]{40}$/u);
    assert.equal(cache.with.path, path);
    assert.equal(cache.with.key, `${prefix}-v1-${job['runs-on']}-\${{ runner.arch }}-playwright-\${{ env.PLAYWRIGHT_VERSION }}-chromium-webkit-firefox`);
    assert.equal(cache.with['restore-keys'], undefined, 'Never restore browsers from a different pin');
    assert.equal(cache.if, heavy);
    assert.equal(cache['continue-on-error'], undefined);
  }
  const core = step('preview_core');
  assert.equal(core.run.trim(), 'npm install --prefix "$RUNNER_TEMP/preview-engines" --no-save --ignore-scripts --no-audit --no-fund "playwright-core@$PLAYWRIGHT_VERSION"');
  assert.equal(core.if, heavy);
  assert.ok(job.steps.indexOf(core) < job.steps.indexOf(step('preview_deps')));
  assert.ok(job.steps.indexOf(step('preview_apt')) < job.steps.indexOf(step('preview_deps')));
  assert.ok(job.steps.indexOf(step('preview_browsers')) < job.steps.indexOf(step('preview_download')));
});

test('AIT-564: every run installs the full OS dependency set; only a browser cache miss downloads engines', () => {
  const deps = step('preview_deps'), download = step('preview_download');
  assert.equal(deps.if, heavy);
  assert.match(deps.run, /node "\$RUNNER_TEMP\/preview-engines\/node_modules\/playwright-core\/cli\.js" install-deps chromium webkit firefox\s*$/u);
  assert.equal(download.run.trim(), `node "$RUNNER_TEMP/preview-engines/node_modules/playwright-core/cli.js" install ${engines}`);
  assert.doesNotMatch(deps.run + download.run, /--with-deps|--only-shell|--no-shell|\|\|\s*true/u);
  assert.ok(job.steps.indexOf(deps) < job.steps.indexOf(download));
  for (const event of ['pull_request', 'merge_group', 'push']) {
    for (const result of ['success', 'failure', 'skipped', undefined]) {
      for (const docsOnly of ['true', 'false', '', undefined]) {
        for (const hit of ['true', 'false', '', undefined]) {
          const context = {
            github: { event_name: event },
            needs: { changes: { result, outputs: { 'docs-only': docsOnly } } },
            steps: { preview_browsers: { outputs: { 'cache-hit': hit } } },
            always: () => true,
          };
          const light = event === 'pull_request' && result === 'success' && docsOnly === 'true';
          for (const value of job.steps) {
            const expected = value.name === 'Docs-only success' ? light
              : value === download ? !light && hit !== 'true' : !light;
            assert.equal(evaluate(value.if, context), expected, `${value.name ?? value.uses}: ${event}/${result}/${docsOnly}/${hit}`);
          }
        }
      }
    }
  }
});

function installFixture(t, hit, fail = '') {
  const directory = mkdtempSync(join(tmpdir(), 'preview-engines-'));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  const commands = ['preview_core', 'preview_deps', ...(hit ? [] : ['preview_download'])].map(id => step(id).run);
  const result = spawnSync('bash', ['-e', '-o', 'pipefail', '-c', `
npm() { printf 'npm %s\\n' "$*"; test "$FAIL" != npm; }
node() { printf 'node %s\\n' "$*"; test "$FAIL" != deps || test "$2" != install-deps; }
sudo() { test "$1" = tee; test "$2" = /etc/apt/apt.conf.d/99-preview-security-cache; cat > "$RUNNER_TEMP/apt.conf"; }
${commands.join('\n')}
`], { encoding: 'utf8', env: { PATH: process.env.PATH, RUNNER_TEMP: directory, PLAYWRIGHT_VERSION: job.env?.PLAYWRIGHT_VERSION ?? '', FAIL: fail } });
  return { result, directory };
}

for (const hit of [false, true]) {
  test(`AIT-564: actual ${hit ? 'warm' : 'cold'} install commands preserve dependency installation without live calls`, t => {
    const { result, directory } = installFixture(t, hit);
    assert.equal(result.status, 0, result.stderr);
    assert.match(result.stdout, /playwright-core@1\.56\.1/u);
    assert.match(result.stdout, /cli\.js install-deps chromium webkit firefox/u);
    assert.equal(result.stdout.includes('cli.js install chromium webkit firefox'), !hit);
    const config = readFileSync(join(directory, 'apt.conf'), 'utf8');
    assert.equal(config, `Dir::Cache::archives "${directory}/preview-apt-archives";\nBinary::apt-get::APT::Keep-Downloaded-Packages "true";\n`);
    assert.doesNotMatch(config, /AllowUnauthenticated|Trusted|Check-Valid-Until|Post-Invoke|Dir::State/u);
  });
}

for (const fail of ['npm', 'deps']) {
  test(`AIT-564: ${fail} failure stops the install without hiding errors`, t => {
    const { result } = installFixture(t, false, fail);
    assert.notEqual(result.status, 0);
    assert.doesNotMatch(result.stdout, /cli\.js install chromium/u);
  });
}

test('AIT-564: qualification command, evidence and both limits remain unchanged', () => {
  assert.equal(job['runs-on'], 'ubuntu-24.04');
  assert.equal(job['timeout-minutes'], 6);
  const qualify = job.steps.find(value => value.name === 'Qualify the strict host and demo with local fixtures');
  assert.equal(qualify.run, 'node scripts/qualify-html-preview.mjs "$RUNNER_TEMP/preview-engines/node_modules/playwright-core/index.mjs" "$RUNNER_TEMP/preview-security.json" "$GITHUB_SHA"');
  assert.equal(qualify['timeout-minutes'], 2);
  assert.equal(qualify.if, heavy);
  assert.ok(job.steps.indexOf(step('preview_download')) < job.steps.indexOf(qualify));
  const artifact = job.steps.find(value => value.with?.name === 'preview-security');
  assert.equal(artifact.with.path, '${{ runner.temp }}/preview-security.json');
  assert.equal(artifact.with['if-no-files-found'], 'error');
  for (const value of job.steps) assert.equal(value['continue-on-error'], undefined);
});
