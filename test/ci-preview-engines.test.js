import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
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
  .replaceAll('outputs.duplicate-of', "outputs['duplicate-of']")
  .replaceAll('outputs.cache-hit', "outputs['cache-hit']"), context);

test('AIT-564 round 3: main preview cache seeding has exactly the npm-cache trigger', () => {
  const warmer = ci.jobs['preview-cache'];
  assert.ok(warmer, 'Main needs a preview-cache warmer for PR and merge-group cache reuse');
  assert.equal(warmer.needs, ci.jobs['npm-cache'].needs);
  assert.equal(warmer.if, ci.jobs['npm-cache'].if);
  assert.equal(warmer['runs-on'], job['runs-on']);
  assert.equal(warmer['timeout-minutes'], 10, 'Allow a slow-mirror cold seed without raising qualification limits');
  assert.deepEqual(warmer.env, job.env);
  for (const event of ['push', 'pull_request', 'merge_group']) {
    for (const ref of ['refs/heads/main', 'refs/heads/other']) {
      for (const attempt of [1, 2]) {
        for (const result of ['success', 'failure', 'skipped']) {
          for (const duplicate of ['', 'fixture-run']) {
            const context = {
              github: { event_name: event, ref, run_attempt: attempt },
              needs: { changes: { result, outputs: { 'duplicate-of': duplicate } } },
            };
            assert.equal(evaluate(warmer.if, context), event === 'push' && ref === 'refs/heads/main'
              && attempt === 1 && result === 'success' && duplicate !== '');
          }
        }
      }
    }
  }
});

test('AIT-564 round 3: warmer shares exact cache keys, paths and producer commands with qualification', () => {
  const warmer = ci.jobs['preview-cache'];
  assert.ok(warmer);
  const warmStep = id => {
    const found = warmer.steps.find(value => value.id === id);
    assert.ok(found, `preview-cache needs ${id}`);
    return found;
  };
  assert.equal(warmer.steps[0], warmStep('preview_paths'));
  for (const id of ['preview_paths', 'preview_core', 'preview_deps', 'preview_download']) {
    assert.equal(warmStep(id).run, step(id).run, `Identical ${id} commands prevent cache drift`);
  }
  for (const [restoreId, producerId, saveId] of [
    ['preview_apt', 'preview_deps', 'preview_apt_save'],
    ['preview_browsers', 'preview_download', 'preview_browsers_save'],
  ]) {
    const restore = warmStep(restoreId), producer = warmStep(producerId), save = warmStep(saveId);
    assert.equal(restore.uses, step(restoreId).uses);
    assert.deepEqual(restore.with, { ...step(restoreId).with, 'lookup-only': true });
    assert.equal(restore.if, undefined, 'Always look up both exact keys without downloading');
    assert.equal(save.uses, step(saveId).uses);
    assert.deepEqual(save.with, step(saveId).with);
    assert.equal(warmer.steps.indexOf(save), warmer.steps.indexOf(producer) + 1);
    assert.ok(warmer.steps.indexOf(restore) < warmer.steps.indexOf(warmStep('preview_core')));
  }
  const setup = warmer.steps.find(value => value.uses?.startsWith('actions/setup-node@'));
  assert.equal(setup?.uses, job.steps.find(value => value.uses?.startsWith('actions/setup-node@')).uses);
  assert.deepEqual(setup.with, { 'node-version': '24' });
  assert.ok(warmer.steps.indexOf(setup) < warmer.steps.indexOf(warmStep('preview_core')));
  for (const aptHit of ['true', 'false', '', undefined]) {
    for (const browserHit of ['true', 'false', '', undefined]) {
      for (const outcome of ['success', 'failure', 'cancelled', 'skipped', undefined]) {
        const context = { steps: {
          preview_apt: { outputs: { 'cache-hit': aptHit } },
          preview_browsers: { outputs: { 'cache-hit': browserHit } },
          preview_deps: { outcome }, preview_download: { outcome },
        } };
        for (const value of warmer.steps) {
          const expected = ['preview_paths', 'preview_apt', 'preview_browsers'].includes(value.id) ? true
            : value.id === 'preview_deps' ? aptHit !== 'true'
            : value.id === 'preview_download' ? browserHit !== 'true'
            : value.id === 'preview_apt_save' ? aptHit !== 'true' && outcome === 'success'
            : value.id === 'preview_browsers_save' ? browserHit !== 'true' && outcome === 'success'
            : aptHit !== 'true' || browserHit !== 'true';
          assert.equal(value.if === undefined ? true : evaluate(value.if, context), expected,
            `${value.id ?? value.uses}: ${aptHit}/${browserHit}/${outcome}`);
          assert.equal(value['continue-on-error'], undefined);
        }
      }
    }
  }
  assert.equal(warmer.steps.some(value => value.run?.includes('qualify-html-preview')), false);
});

test('AIT-564 round 3: a missing runner ImageVersion fails without publishing an apt key component', t => {
  const directory = mkdtempSync(join(tmpdir(), 'preview-missing-image-'));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  const githubOutput = join(directory, 'github-output');
  writeFileSync(githubOutput, '');
  const result = spawnSync('bash', ['-e', '-o', 'pipefail', '-c', step('preview_paths').run], {
    encoding: 'utf8',
    env: { PATH: process.env.PATH, RUNNER_TEMP: directory, GITHUB_ENV: join(directory, 'github-env'), GITHUB_OUTPUT: githubOutput },
  });
  assert.notEqual(result.status, 0);
  assert.equal(readFileSync(githubOutput, 'utf8'), '');
});

test('AIT-564: engine and apt download caches bind the runner, architecture, exact core pin and browser list', () => {
  assert.equal(job.env?.PLAYWRIGHT_VERSION, '1.56.1');
  assert.equal(job.env.PLAYWRIGHT_BROWSERS_PATH, undefined);
  assert.doesNotMatch(JSON.stringify(job.env), /\brunner\./u, 'runner context is not allowed in job-level env');
  for (const [id, prefix, path] of [
    ['preview_browsers', 'preview-browsers', '${{ env.PLAYWRIGHT_BROWSERS_PATH }}'],
    ['preview_apt', 'preview-apt', '${{ runner.temp }}/preview-apt-archives/*.deb'],
  ]) {
    const cache = step(id);
    assert.equal(cache.uses, 'actions/cache/restore@5a3ec84eff668545956fd18022155c47e93e2684');
    assert.equal(cache.with.path, path);
    const image = id === 'preview_apt' ? '-${{ steps.preview_paths.outputs.image-version }}' : '';
    assert.equal(cache.with.key, `${prefix}-v1-${job['runs-on']}-\${{ runner.arch }}${image}-playwright-\${{ env.PLAYWRIGHT_VERSION }}-chromium-webkit-firefox`);
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
        for (const browserHit of ['true', 'false', '', undefined]) {
          const aptHit = browserHit === 'true' ? 'false' : 'true';
          const outcome = 'success';
          const context = {
            github: { event_name: event },
            needs: { changes: { result, outputs: { 'docs-only': docsOnly } } },
            steps: {
              preview_browsers: { outputs: { 'cache-hit': browserHit } },
              preview_apt: { outputs: { 'cache-hit': aptHit } },
              preview_deps: { outcome }, preview_download: { outcome },
            },
            always: () => true,
          };
          const light = event === 'pull_request' && result === 'success' && docsOnly === 'true';
          for (const value of job.steps) {
            const expected = value.name === 'Docs-only success' ? light
              : value === download ? !light && browserHit !== 'true'
              : value.id === 'preview_apt_save' ? !light && aptHit !== 'true' && outcome === 'success'
              : value.id === 'preview_browsers_save' ? !light && browserHit !== 'true' && outcome === 'success'
              : !light;
            assert.equal(evaluate(value.if, context), expected, `${value.name ?? value.uses}: ${event}/${result}/${docsOnly}/${browserHit}/${aptHit}/${outcome}`);
          }
        }
      }
    }
  }
});

test('AIT-564 round 2: initialize browser path through GITHUB_ENV and expose the runner image version', t => {
  const init = step('preview_paths');
  assert.equal(init.if, heavy);
  assert.equal(job.steps.indexOf(init), 1, 'Initialize before every other heavy step');
  const directory = mkdtempSync(join(tmpdir(), 'preview-paths-'));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  const githubEnv = join(directory, 'github-env'), githubOutput = join(directory, 'github-output');
  const result = spawnSync('bash', ['-e', '-o', 'pipefail', '-c', init.run], {
    encoding: 'utf8',
    env: { PATH: process.env.PATH, RUNNER_TEMP: directory, GITHUB_ENV: githubEnv, GITHUB_OUTPUT: githubOutput, ImageVersion: 'fixture-image-version' },
  });
  assert.equal(result.status, 0, result.stderr);
  assert.equal(readFileSync(githubEnv, 'utf8'), `PLAYWRIGHT_BROWSERS_PATH=${directory}/preview-browsers\n`);
  assert.equal(readFileSync(githubOutput, 'utf8'), 'image-version=fixture-image-version\n');
});

test('AIT-564 round 2: save each exact cache immediately after its producer succeeds, before qualification', () => {
  for (const [restoreId, producerId, saveId] of [
    ['preview_apt', 'preview_deps', 'preview_apt_save'],
    ['preview_browsers', 'preview_download', 'preview_browsers_save'],
  ]) {
    const restore = step(restoreId), producer = step(producerId), save = step(saveId);
    assert.equal(save.uses, 'actions/cache/save@5a3ec84eff668545956fd18022155c47e93e2684');
    assert.deepEqual(save.with, restore.with, 'Save the exact restored key and path without fallback keys');
    assert.equal(save.if, `${heavy} && steps.${restoreId}.outputs.cache-hit != 'true' && steps.${producerId}.outcome == 'success'`);
    for (const hit of ['true', 'false', '', undefined]) {
      for (const outcome of ['success', 'failure', 'cancelled', 'skipped', undefined]) {
        const context = {
          github: { event_name: 'push' },
          needs: { changes: { result: 'success', outputs: { 'docs-only': 'false' } } },
          steps: { [restoreId]: { outputs: { 'cache-hit': hit } }, [producerId]: { outcome } },
        };
        assert.equal(evaluate(save.if, context), hit !== 'true' && outcome === 'success', `${saveId}: ${hit}/${outcome}`);
      }
    }
    assert.equal(job.steps.indexOf(save), job.steps.indexOf(producer) + 1);
    assert.ok(job.steps.indexOf(save) < job.steps.findIndex(value => value.name === 'Qualify the strict host and demo with local fixtures'));
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
