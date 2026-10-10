import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn, execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdtemp, mkdir, copyFile, chmod, readFile, writeFile, rm, stat, symlink } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, delimiter } from 'node:path';
import { createCodexImagegen, manifest } from '../src/index.js';
import { prepareBrief } from '../src/brief.js';
import { PluginError, PluginRegistry, validateManifest, isUIArtifact, IPTC_DIGITAL_SOURCE } from '@inspr/aithema-core';
import { uiGenerationConformance } from '../../../packages/core/src/ui-generation-conformance.js';
import { jumbf, pngChunk, webpChunk, webp } from '../../../test/image-fixtures.js';

const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO/aK0kAAAAASUVORK5CYII=', 'base64');
const spec = { prompt: 'Host policy: visitor wants a quiet library. Visual language: cream and ink.' };
function options(extra = {}) {
  const reports = []; let consumed = false;
  return { signal: new AbortController().signal, deadlineAt: Date.now() + 5000, reports,
    attempt: { attemptId: crypto.randomUUID(), claimId: crypto.randomUUID(), consume() { assert.equal(consumed, false); consumed = true; } },
    report: terminal => reports.push(terminal), ...extra };
}
const delay = ms => new Promise(resolve => setTimeout(resolve, ms));
async function until(predicate) {
  const deadline = Date.now() + 5000;
  while (!await predicate()) { assert.ok(Date.now() < deadline, 'fixture readiness timeout'); await delay(5); }
}
async function exists(path) { try { await stat(path); return true; } catch (error) { if (error.code === 'ENOENT') return false; throw error; } }
async function fake(t, extra = {}) {
  const root = await mkdtemp(join(tmpdir(), 'aithema-fake-codex-')), binaryPath = join(root, 'bin', 'codex');
  const codexHome = join(root, 'account'), trace = join(root, 'trace');
  await mkdir(join(root, 'bin')); await mkdir(codexHome); await mkdir(trace);
  await copyFile(new URL('./fixtures/fake-codex.cjs', import.meta.url), binaryPath); await chmod(binaryPath, 0o700);
  const oldPath = process.env.PATH;
  process.env.PATH = `${join(root, 'bin')}${delimiter}${oldPath}`;
  const records = [], probes = []; let active = 0, peak = 0;
  const spawnImpl = (file, args, config) => {
    assert.equal(file, binaryPath, 'tests must only spawn the fake executable');
    const record = { file, args, config };
    const probe = args.includes('--help') || args[0] === 'features';
    (probe ? probes : records).push(record);
    const child = spawn(process.execPath, [file, ...args], { ...config, env: { ...config.env, FAKE_TRACE_DIR: trace,
      FAKE_PROBE_MODE: extra.probeMode ?? '', FAKE_CREDENTIAL_CHUNK: extra.credentialChunk?.toString('base64') ?? '' } });
    record.child = child; active++; peak = Math.max(peak, active);
    child.once('close', () => active--);
    return child;
  };
  const binding = { plugin: manifest.id, model: 'fixture-model', effort: 'high', endpoint: 'https://chatgpt.com',
    accountRef: 'fixture-account', secretRef: 'unused-cli-account-ref', maxMicro: 0, maxTokens: 1,
    rates: { inputMicro: 0, outputMicro: 0 }, routing: { codex: { binaryPath: 'codex', codexHome, timeoutMs: 5000,
      trustedPromptsOnly: true } } };
  const plugin = createCodexImagegen({ binding, spawnImpl });
  t.after(async () => {
    for (const record of [...records, ...probes]) {
      if (record.child.exitCode === null && record.child.signalCode === null) {
        try { process.kill(-record.child.pid, 'SIGKILL'); } catch { /* already reaped */ }
        await new Promise(resolve => record.child.once('close', resolve));
      }
      assert.equal(await exists(record.config.cwd), false, 'adapter must remove its private workspace');
    }
    if (oldPath === undefined) delete process.env.PATH; else process.env.PATH = oldPath;
    await rm(root, { recursive: true, force: true });
  });
  return { root, binaryPath, codexHome, binding, plugin, records, probes, spawnImpl, peak: () => peak,
    async ready(index = records.length - 1) {
      await until(() => records[index]?.child.pid !== undefined);
      const path = join(trace, `${records[index].child.pid}.json`);
      await until(() => exists(path)); return JSON.parse(await readFile(path, 'utf8'));
    } };
}
function terminal(o, outcome, dispatched = true) {
  assert.equal(o.reports.length, 1);
  const report = o.reports[0];
  assert.equal(report.attemptId, o.attempt.attemptId); assert.equal(report.outcome, outcome);
  if (outcome === 'uncertain') assert.equal(Object.hasOwn(report, 'usage'), false);
  else assert.deepEqual(report.usage, { inputTokens: 0, outputTokens: 0 });
  if (dispatched) {
    assert.equal(report.chargedMicro, 0); assert.ok(Number.isSafeInteger(report.durationMs) && report.durationMs >= 0);
  } else assert.deepEqual(report, { attemptId: o.attempt.attemptId, outcome, usage: { inputTokens: 0, outputTokens: 0 } });
}
function reaped(record) { assert.throws(() => process.kill(record.child.pid, 0), { code: 'ESRCH' }); }
function alive(pid) {
  try {
    process.kill(pid, 0);
    // Linux can retain an orphan zombie until init reaps it; zombies cannot run or hold files.
    return !/^Z/u.test(execFileSync('ps', ['-o', 'stat=', '-p', String(pid)], { encoding: 'utf8' }).trim());
  } catch { return false; }
}

test('private D4 manifest registers the UI kind without exposing operator binding', async t => {
  const f = await fake(t);
  assert.deepEqual(validateManifest(manifest), { ok: true, errors: [] });
  assert.equal(new PluginRegistry().register(f.plugin).get(manifest.id).generate, f.plugin.generate);
  assert.ok(Object.isFrozen(manifest.models[0].cost));
  assert.equal(manifest.models[0].qualification, 'unverified');
  for (const value of [f.codexHome, f.binaryPath, f.binding.accountRef, f.binding.secretRef, 'codexHome', 'binaryPath', 'timeoutMs']) {
    assert.equal(JSON.stringify(manifest).includes(value), false);
  }
});

test('generate sends a resolved stdin brief and returns actual bytes, model and digests', async t => {
  const f = await fake(t), o = options();
  o.report = async report => { assert.equal(await exists(f.records[0].config.cwd), false); reaped(f.records[0]); o.reports.push(report); };
  const result = await f.plugin.generate(spec, 'Use a blue action button.', o), record = await f.ready(0);
  const expected = Buffer.from(png); expected.writeUInt32BE(1536, 16); expected.writeUInt32BE(1024, 20);
  assert.ok(isUIArtifact(result)); assert.deepEqual(Buffer.from(result.bytes), expected);
  assert.equal(result.mediaType, 'image/png'); assert.equal(result.width, 1536); assert.equal(result.height, 1024);
  assert.equal(result.provenance.generator.provider, 'codex-imagegen'); assert.equal(result.provenance.generator.model, f.binding.model);
  assert.equal(result.provenance.origin, 'ai-generated'); assert.equal(result.provenance.digitalSourceType, IPTC_DIGITAL_SOURCE.generated);
  assert.deepEqual(result.provenance.credentials, { c2pa: 'absent', manifestByteLength: 0, verification: 'not-verified' });
  assert.equal(result.provenance.promptDigest, result.promptDigest);
  assert.deepEqual(result.provenance.assurances, { digitallySigned: false, imperceptibleWatermark: 'unknown', watermarkSource: null });
  assert.equal(result.provenance.subject.contentDigest, `sha-256=:${createHash('sha256').update(result.bytes).digest('base64')}:`);
  assert.equal(result.promptDigest, `sha256:${createHash('sha256').update(record.brief).digest('hex')}`);
  assert.deepEqual(record.args.slice(0, 5), ['exec', '-m', 'fixture-model', '-c', 'model_reasoning_effort="high"']);
  assert.ok(record.args.includes('--ignore-user-config')); assert.ok(record.args.includes('--ignore-rules'));
  assert.ok(record.args.includes('--ephemeral')); assert.ok(record.args.includes('--strict-config'));
  for (const override of ['sandbox_mode="workspace-write"', 'sandbox_workspace_write.network_access=false',
    'sandbox_workspace_write.writable_roots=[]', 'sandbox_workspace_write.exclude_tmpdir_env_var=true',
    'sandbox_workspace_write.exclude_slash_tmp=true', 'mcp_servers={}', 'web_search="disabled"',
    'project_doc_max_bytes=0', 'project_doc_fallback_filenames=[]', 'shell_environment_policy.inherit="none"',
    'shell_environment_policy.include_only=[]', 'shell_environment_policy.exclude=["*"]',
    'shell_environment_policy.set={}', 'allow_login_shell=false']) assert.ok(record.args.includes(override), override);
  for (const feature of ['shell_tool', 'unified_exec', 'unified_exec_tty', 'code_mode_host', 'view_image', 'apps',
    'plugins', 'browser_use', 'computer_use', 'multi_agent', 'hooks']) {
    const i = record.args.indexOf(feature); assert.ok(i > 0); assert.equal(record.args[i - 1], '--disable');
  }
  assert.equal(f.probes.length, 2);
  assert.equal(f.records[0].config.env.HOME, f.records[0].config.cwd);
  assert.equal(f.records[0].config.env.TMPDIR, f.records[0].config.cwd);
  assert.match(record.brief, /Never invent metrics, testimonials, prices, durations or capabilities/u);
  assert.ok(record.brief.includes(JSON.stringify(spec.prompt))); assert.match(record.brief, /blue action button/u);
  assert.equal(record.codexHome, f.codexHome); assert.equal(record.mode, 0o700);
  assert.deepEqual(Object.keys(f.records[0].config.env).sort(), ['CODEX_HOME', 'HOME', 'LANG', 'PATH', 'TMPDIR']);
  assert.deepEqual(f.records[0].config.stdio, ['pipe', 'ignore', 'ignore']); assert.equal(f.records[0].config.detached, true);
  terminal(o, 'completed');
});

for (const format of ['png', 'webp']) for (const marked of [false, true]) test(`${format} Codex output ${marked ? 'with' : 'without'} synthetic C2PA is detected and preserved through generation and editing`, async t => {
  const payload = jumbf(), chunk = format === 'png' ? pngChunk('caBX', payload) : webpChunk('C2PA', payload);
  const f = await fake(t, { credentialChunk: marked ? chunk : undefined }), input = { ...spec, format };
  let expected = Buffer.from(format === 'png' ? png : webp);
  if (format === 'png') { expected.writeUInt32BE(1536, 16); expected.writeUInt32BE(1024, 20); }
  else { expected.writeUInt16LE(1536, 26); expected.writeUInt16LE(1024, 28); }
  if (marked) expected = format === 'png' ? Buffer.concat([expected.subarray(0, -12), chunk, expected.subarray(-12)]) : Buffer.concat([expected, chunk]);
  if (format === 'webp') expected.writeUInt32LE(expected.length - 8, 4);
  const source = await f.plugin.generate(input, '', options());
  const edited = await f.plugin.edit(source, input, 'Blue action', options());
  for (const result of [source, edited]) {
    assert.equal(isUIArtifact(result), true); assert.deepEqual(Buffer.from(result.bytes), expected);
    assert.deepEqual(result.provenance.credentials, { c2pa: marked ? 'present' : 'absent',
      manifestByteLength: marked ? payload.length : 0, verification: 'not-verified' });
    assert.deepEqual(result.provenance.assurances, { digitallySigned: false, imperceptibleWatermark: 'unknown', watermarkSource: null });
    assert.equal(result.provenance.subject.contentDigest, `sha-256=:${createHash('sha256').update(expected).digest('base64')}:`);
  }
});

test('Codex accepts a legacy artifact only as an edit reference', async t => {
  const f = await fake(t), source = await f.plugin.generate(spec, '', options());
  delete source.provenance.credentials; delete source.provenance.promptDigest;
  source.provenance.techniques = ['embedded-metadata', 'response-field'];
  source.provenance.assurances = { digitallySigned: false, imperceptibleWatermark: 'provider-status-unknown' };
  assert.equal(isUIArtifact(source), false); assert.equal(isUIArtifact(source, { allowLegacy: true }), true);
  const result = await f.plugin.edit(source, spec, 'Blue action', options());
  assert.equal(isUIArtifact(result), true);
  assert.equal((await f.ready(1)).references[0].bytes, Buffer.from(source.bytes).toString('base64'));
});

test('ordered previous, rejected and upload bytes go to private files and variadic -i, never a positional prompt', async t => {
  const f = await fake(t), references = ['previous', 'rejected', 'upload'].map(role => ({ bytes: png, mediaType: 'image/png', role }));
  await f.plugin.generate({ ...spec, references, model: 'browser-model', binaryPath: 'browser-command', codexHome: '/browser-account' }, 'feedback', options());
  const record = await f.ready(0), index = record.args.indexOf('-i');
  assert.equal(record.args.length - index - 1, 3); assert.equal(record.references.length, 3);
  for (const [i, reference] of record.references.entries()) {
    assert.equal(reference.bytes, png.toString('base64')); assert.equal(reference.mode, 0o600);
    assert.equal(reference.path, join(f.records[0].config.cwd, `references/reference-${i}-${references[i].role}.png`));
    assert.match(record.brief, new RegExp(`role=${references[i].role}`));
  }
  assert.equal(record.codexHome, f.codexHome); assert.equal(record.args[2], f.binding.model);
  assert.equal(record.brief.includes('browser-command'), false);
});

test('edit prepends the artifact as previous, carries host policy and marks manipulation', async t => {
  const f = await fake(t), source = await f.plugin.generate(spec, '', options()), o = options();
  const refs = [{ bytes: png, mediaType: 'image/png', role: 'rejected' }];
  const result = await f.plugin.edit(source, { ...spec, references: refs, size: '1024x1536', quality: 'low', format: 'webp' }, 'Make the action blue', o);
  const record = await f.ready(1);
  assert.equal(record.references.length, 2); assert.match(record.references[0].path, /0-previous.png$/u);
  assert.match(record.references[1].path, /1-rejected.png$/u);
  assert.match(record.brief, /1024x1536; quality: low; format: webp/u); assert.ok(record.brief.includes(JSON.stringify(spec.prompt)));
  assert.equal(result.provenance.origin, 'ai-manipulated'); assert.equal(result.provenance.digitalSourceType, IPTC_DIGITAL_SOURCE.manipulated);
  terminal(o, 'completed');
});

test('finds a single requested WebP outside output and reads dimensions from bytes', async t => {
  const f = await fake(t), result = await f.plugin.generate({ prompt: 'fixture-mode:webp', format: 'webp' }, '', options());
  assert.ok(isUIArtifact(result)); assert.equal(result.mediaType, 'image/webp'); assert.equal(result.width, 1536); assert.equal(result.height, 1024);
});
for (const [mode, code] of [['none', 'invalid-output'], ['many', 'invalid-output'], ['nonzero', 'provider'],
  ['bad', 'invalid-output'], ['oversize', 'limit'], ['symlink', 'invalid-output'], ['hardlink', 'invalid-output'],
  ['extratext', 'invalid-output'], ['extraextensionless', 'invalid-output'], ['jpeg', 'invalid-output'],
  ['wrongsize', 'invalid-output'], ['dimensioncap', 'limit'], ['beyondtolerance', 'invalid-output'], ['crash', 'provider']]) {
  test(`fake CLI ${mode} fails with typed ${code}, one zero-cost terminal and cleanup`, async t => {
    const f = await fake(t), o = options();
    await assert.rejects(f.plugin.generate({ prompt: `fixture-mode:${mode}` }, '', o), error => error.code === code && error.message === code);
    terminal(o, 'uncertain'); reaped(f.records[0]); assert.equal(await exists(f.records[0].config.cwd), false);
  });
}

for (const operation of ['generate', 'edit']) for (const mode of ['cancelled', 'deadline']) {
  test(`${operation} preflight ${mode} consumes without dispatch and retains exact zero settlement`, async t => {
    const f = await fake(t), source = await f.plugin.generate(spec, '', options()), count = f.records.length;
    const controller = new AbortController(), o = options({ signal: controller.signal, deadlineAt: Date.now() + (mode === 'deadline' ? -1 : 5000) });
    if (mode === 'cancelled') controller.abort();
    await assert.rejects(operation === 'edit' ? f.plugin.edit(source, spec, 'feedback', o) : f.plugin.generate(spec, '', o), { code: mode });
    terminal(o, 'cancelled', false); assert.equal(f.records.length, count);
  });
}

for (const mode of ['hang', 'ignoreterm', 'descendant']) {
  test(`active cancellation kills/reaps the ${mode} process group before settling`, async t => {
    const f = await fake(t), controller = new AbortController(), o = options({ signal: controller.signal });
    const pending = f.plugin.generate({ prompt: `fixture-mode:${mode}` }, '', o);
    // Observe the rejection immediately, avoiding a timing-dependent unhandled rejection.
    const rejected = assert.rejects(pending, { code: 'cancelled' });
    const record = await f.ready(0); controller.abort(); await rejected;
    terminal(o, 'uncertain'); reaped(f.records[0]);
    if (record.descendantPid) await until(() => !alive(record.descendantPid));
    assert.equal(await exists(record.cwd), false);
  });
}

test('a successful leader exit also kills its orphaned tool descendants', async t => {
  const f = await fake(t); await f.plugin.generate({ prompt: 'fixture-mode:orphan' }, '', options());
  const record = await f.ready(0); reaped(f.records[0]); await until(() => !alive(record.descendantPid));
});

test('host deadlines and binding timeouts each kill a CLI that ignores SIGTERM', async t => {
  const f = await fake(t);
  for (const ownTimeout of [false, true]) {
    const plugin = ownTimeout ? f.plugin.bind({ ...f.binding, routing: { codex: { ...f.binding.routing.codex, timeoutMs: 200 } } }) : f.plugin;
    assert.deepEqual(await plugin.health(options()), { available: true });
    const o = options({ deadlineAt: Date.now() + (ownTimeout ? 5000 : 200) });
    await assert.rejects(plugin.generate({ prompt: 'fixture-mode:ignoreterm' }, '', o), { code: 'deadline' });
    terminal(o, 'uncertain'); reaped(f.records.at(-1)); assert.ok(o.reports[0].durationMs < 2000);
  }
});

test('one server slot serializes distinct instances and snapshots queued reference bytes', async t => {
  const f = await fake(t), other = createCodexImagegen({ binding: f.binding, spawnImpl: f.spawnImpl });
  const first = f.plugin.generate({ prompt: 'fixture-mode:slow' }, '', options()); await f.ready(0);
  const input = Uint8Array.from(png), second = other.generate({ ...spec, references: [{ bytes: input, mediaType: 'image/png', role: 'upload' }] }, '', options());
  await new Promise(resolve => setImmediate(resolve)); input.fill(0);
  await Promise.all([first, second]); assert.equal(f.peak(), 1); assert.equal(f.records.length, 2);
  assert.equal((await f.ready(1)).references[0].bytes, png.toString('base64'));
});

test('cancelled and expired queued work never dispatches or blocks the next job', async t => {
  const f = await fake(t), controller = new AbortController(), firstOptions = options({ signal: controller.signal });
  const first = f.plugin.generate({ prompt: 'fixture-mode:hang' }, '', firstOptions), rejected = assert.rejects(first, { code: 'cancelled' });
  await f.ready(0);
  const queuedController = new AbortController(), cancelled = options({ signal: queuedController.signal }), expired = options({ deadlineAt: Date.now() + 30 });
  const second = assert.rejects(f.plugin.generate(spec, '', cancelled), { code: 'cancelled' });
  const third = assert.rejects(f.plugin.generate(spec, '', expired), { code: 'deadline' });
  await new Promise(resolve => setImmediate(resolve)); queuedController.abort();
  await Promise.all([second, third]); assert.equal(f.records.length, 1);
  terminal(cancelled, 'cancelled', false); terminal(expired, 'cancelled', false);
  controller.abort(); await rejected; await f.plugin.generate(spec, '', options()); assert.equal(f.records.length, 2); assert.equal(f.peak(), 1);
});

test('async consume precedes dispatch and async terminal persistence precedes return', async t => {
  const f = await fake(t); let consume, persist;
  const consuming = new Promise(resolve => { consume = resolve; }), persisting = new Promise(resolve => { persist = resolve; });
  const o = options(); o.attempt.consume = () => consuming;
  o.report = async report => { o.reports.push(report); await persisting; };
  let returned = false; const pending = f.plugin.generate(spec, '', o).then(result => { returned = true; return result; });
  await new Promise(resolve => setImmediate(resolve)); assert.equal(f.records.length, 0); consume();
  await until(() => o.reports.length); assert.equal(returned, false); persist(); await pending; assert.equal(returned, true);
});

test('authority refusal reuses its exact terminal and never spawns', async t => {
  const f = await fake(t), o = options();
  o.attempt.consume = () => { o.report({ attemptId: o.attempt.attemptId, outcome: 'cancelled', usage: { inputTokens: 0, outputTokens: 0 } }); throw new PluginError('not-admitted'); };
  await assert.rejects(f.plugin.generate(spec, '', o), { code: 'not-admitted' }); terminal(o, 'cancelled', false); assert.equal(f.records.length, 0);
  await assert.rejects(f.plugin.generate(spec, '', { signal: o.signal, deadlineAt: o.deadlineAt }), { code: 'not-admitted' });
  const missingReport = options();
  missingReport.attempt.consume = () => assert.fail('missing reporter must refuse before consume');
  delete missingReport.report;
  await assert.rejects(f.plugin.generate(spec, '', missingReport), { code: 'not-admitted' });
  assert.equal(f.records.length, 0);
});

test('invalid briefs, references and edit artifacts fail before spawning', async t => {
  const f = await fake(t), valid = { bytes: png, mediaType: 'image/png', role: 'upload' };
  for (const [input, code] of [[{}, 'invalid-output'], [{ prompt: '' }, 'invalid-output'], [{ prompt: 'x'.repeat(32001) }, 'limit'],
    [{ ...spec, size: 'unknown' }, 'invalid-output'], [{ ...spec, format: 'jpeg' }, 'invalid-output'],
    [{ ...spec, quality: 'unknown' }, 'invalid-output'], [{ ...spec, references: [{ ...valid, url: 'https://example.invalid/ref.png' }] }, 'invalid-output'],
    [{ ...spec, references: [{ ...valid, role: 'unknown' }] }, 'invalid-output'], [{ ...spec, references: [{ ...valid, mediaType: 'image/webp' }] }, 'invalid-output'],
    [{ ...spec, references: Array(10).fill(valid) }, 'limit'], [{ ...spec, references: [{ ...valid, bytes: new Uint8Array(12 * 1024 * 1024 + 1) }] }, 'limit']]) {
    const o = options(); await assert.rejects(f.plugin.generate(input, '', o), { code }); terminal(o, 'cancelled', false);
  }
  await assert.rejects(f.plugin.edit({ url: 'https://example.invalid' }, spec, 'feedback', options()), { code: 'invalid-output' });
  assert.equal(f.records.length, 0);
  const source = await f.plugin.generate(spec, '', options());
  await assert.rejects(f.plugin.edit(source, { ...spec, references: Array(9).fill(valid) }, 'feedback', options()), { code: 'limit' });
  await assert.rejects(f.plugin.edit(source, spec, '', options()), { code: 'invalid-output' });
  await assert.rejects(f.plugin.edit({ ...source, width: 2 }, spec, 'feedback', options()), { code: 'invalid-output' });
  assert.equal(f.records.length, 1);
});

test('binding configuration is private, immutable, explicit and has no API-key resolver', async t => {
  const f = await fake(t);
  f.binding.routing.codex.codexHome = '/mutated'; assert.equal(f.plugin.binding.routing.codex.codexHome, f.codexHome);
  const original = f.plugin.binding;
  for (const codex of [undefined, {}, { ...original.routing.codex, codexHome: 'relative' },
    { ...original.routing.codex, binaryPath: 'codex --dangerously-bypass-approvals-and-sandbox' },
    { ...original.routing.codex, timeoutMs: 0 }, { ...original.routing.codex, timeoutMs: 1800001 },
    { ...original.routing.codex, browserOverride: true }, { ...original.routing.codex, trustedPromptsOnly: false },
    { ...original.routing.codex, trustedPromptsOnly: undefined }, { ...original.routing.codex, trustedPromptsOnly: 'true' }]) {
    assert.throws(() => createCodexImagegen({ binding: { ...original, routing: { codex } } }), /private CLI binding/u);
  }
  for (const patch of [{ model: '-flag' }, { effort: 'unknown' }, { maxMicro: 1 }, { rates: { inputMicro: 1, outputMicro: 0 } }]) {
    assert.throws(() => createCodexImagegen({ binding: { ...original, ...patch } }), /private CLI binding/u);
  }
});

test('health checks local startup compatibility without rendering; missing binary never launches', async t => {
  const f = await fake(t); assert.deepEqual(await f.plugin.health(options()), { available: true }); assert.equal(f.records.length, 0);
  assert.equal(f.probes.length, 2);
  const unavailable = f.plugin.bind({ ...f.binding, routing: { codex: { ...f.binding.routing.codex, binaryPath: join(f.root, 'missing') } } });
  assert.deepEqual(await unavailable.health(options()), { available: false });
  const o = options(); await assert.rejects(unavailable.generate(spec, '', o), { code: 'unavailable' }); terminal(o, 'cancelled', false);
  assert.equal(f.records.length, 0);
});

for (const entry of ['config.toml', 'AGENTS.md', 'other-file', 'sessions']) {
  test(`dedicated account refuses ${entry} before CLI startup or render`, async t => {
    const f = await fake(t), o = options();
    if (entry === 'sessions') await mkdir(join(f.codexHome, entry));
    else await writeFile(join(f.codexHome, entry), 'fixture only');
    assert.deepEqual(await f.plugin.health(options()), { available: false });
    await assert.rejects(f.plugin.generate(spec, '', o), { code: 'unavailable' });
    terminal(o, 'cancelled', false); assert.equal(f.records.length, 0); assert.equal(f.probes.length, 0);
  });
}

test('account directory symlinks are refused without inspecting the target', async t => {
  const f = await fake(t), path = join(f.root, 'linked-account'); await symlink(f.codexHome, path);
  const plugin = f.plugin.bind({ ...f.binding, routing: { codex: { ...f.binding.routing.codex, codexHome: path } } });
  assert.deepEqual(await plugin.health(options()), { available: false });
  const o = options(); await assert.rejects(plugin.generate(spec, '', o), { code: 'unavailable' });
  terminal(o, 'cancelled', false); assert.equal(f.probes.length, 0);
});

test('account safety is rechecked after a cached successful startup', async t => {
  const f = await fake(t); assert.deepEqual(await f.plugin.health(options()), { available: true });
  await writeFile(join(f.codexHome, 'config.toml'), 'fixture only');
  const o = options(); await assert.rejects(f.plugin.generate(spec, '', o), { code: 'unavailable' });
  terminal(o, 'cancelled', false); assert.equal(f.records.length, 0); assert.equal(f.probes.length, 2);
});

for (const probeMode of ['rejectflag', 'missingflag', 'rejectfeature', 'missingfeature', 'unsafeshell', 'flood']) {
  test(`startup self-check ${probeMode} fails closed before rendering`, async t => {
    const f = await fake(t, { probeMode }), o = options();
    await assert.rejects(f.plugin.generate(spec, '', o), { code: 'unavailable' });
    terminal(o, 'cancelled', false); assert.equal(f.records.length, 0);
    assert.deepEqual(await f.plugin.health(options()), { available: false });
  });
}

test('deadline during non-rendering startup retains preflight settlement and kills the probe', async t => {
  const f = await fake(t, { probeMode: 'hanghelp' }), o = options({ deadlineAt: Date.now() + 200 });
  await assert.rejects(f.plugin.generate(spec, '', o), { code: 'deadline' });
  terminal(o, 'cancelled', false); assert.equal(f.records.length, 0); reaped(f.probes[0]);
});

test('a synchronous render spawn failure has exact preflight zero settlement', async t => {
  const f = await fake(t), plugin = createCodexImagegen({ binding: f.binding, spawnImpl(file, args, config) {
    if (args[0] === 'exec' && !args.includes('--help')) throw new Error('fixture spawn failure');
    return f.spawnImpl(file, args, config);
  } });
  const o = options(); await assert.rejects(plugin.generate(spec, '', o), { code: 'unavailable' });
  terminal(o, 'cancelled', false); assert.equal(f.records.length, 0);
});

test('an asynchronous render spawn error has exact preflight zero settlement', async t => {
  const f = await fake(t), plugin = createCodexImagegen({ binding: f.binding, spawnImpl(file, args, config) {
    if (args[0] === 'exec' && !args.includes('--help')) return spawn(join(f.root, 'nonexistent'), args, config);
    return f.spawnImpl(file, args, config);
  } });
  const o = options(); await assert.rejects(plugin.generate(spec, '', o), { code: 'unavailable' });
  terminal(o, 'cancelled', false); assert.equal(f.records.length, 0);
});

test('requested WebP rejects a returned PNG even with matching dimensions', async t => {
  const f = await fake(t), o = options();
  await assert.rejects(f.plugin.generate({ prompt: 'fixture-mode:wrongformat', format: 'webp' }, '', o), { code: 'invalid-output' });
  terminal(o, 'uncertain');
});

test('requested PNG rejects a returned WebP even with matching dimensions', async t => {
  const f = await fake(t), o = options();
  await assert.rejects(f.plugin.generate({ prompt: 'fixture-mode:webp' }, '', o), { code: 'invalid-output' });
  terminal(o, 'uncertain');
});

for (const size of ['1024x1024', '1536x1024', '1024x1536']) {
  test(`dimensions at the 5% tolerance boundary are admitted for ${size}`, async t => {
    const f = await fake(t), result = await f.plugin.generate({ prompt: 'fixture-mode:tolerance', size }, '', options());
    const [width, height] = size.split('x').map(Number);
    assert.equal(result.width, Math.floor(width * 1.05)); assert.equal(result.height, Math.ceil(height * 0.95));
  });
}

test('Codex imagegen passes the reusable UI conformance kit with fake executable stalls', async t => {
  const f = await fake(t), source = await f.plugin.generate(spec, '', options());
  assert.deepEqual(await uiGenerationConformance(f.plugin, { spec, feedback: 'Blue action', artifact: source }, {
    timeoutMs: 2000, stallSpec: { prompt: 'fixture-mode:hang' }, stallFeedback: 'fixture-mode:hang',
    requestCount: () => f.records.length, expectedUsage: { inputTokens: 0, outputTokens: 0 },
  }), { ok: true, failures: [] });
});

test('the UI conformance kit rejects a broken artifact and omitted authority/report behavior', async t => {
  const f = await fake(t), source = await f.plugin.generate(spec, '', options());
  const settings = { timeoutMs: 2000, stallSpec: { prompt: 'fixture-mode:hang' }, stallFeedback: 'fixture-mode:hang', requestCount: () => f.records.length };
  const brokenDigest = { ...f.plugin, async generate(...args) {
    const result = await f.plugin.generate(...args); result.provenance.subject.contentDigest = `sha-256=:${Buffer.alloc(32).toString('base64')}:`; return result;
  } };
  const result = await uiGenerationConformance(brokenDigest, { spec, feedback: 'Blue', artifact: source }, settings);
  assert.equal(result.ok, false); assert.ok(result.failures.includes('generate bytes/provenance artifact'));
  const broken = { ...f.plugin, generate: async () => source, edit: async () => source };
  const refused = await uiGenerationConformance(broken, { spec, feedback: 'Blue', artifact: source }, settings);
  assert.equal(refused.ok, false); assert.ok(refused.failures.includes('generate claim not consumed'));
  assert.ok(refused.failures.includes('edit consume refusal missing'));
});

test('brief digest changes with visitor words, visual feedback and reference roles', () => {
  const first = prepareBrief('generate', spec, '', undefined).brief;
  const second = prepareBrief('generate', spec, 'Blue', undefined).brief;
  assert.notEqual(first, second);
  assert.notEqual(prepareBrief('generate', { prompt: 'A different host policy' }, '', undefined).brief, first);
});
