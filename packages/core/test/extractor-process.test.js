import { test, observeParsers, waitFor } from '../../../plugins/extract-text/test/extractor-test-helpers.js';
import assert from 'node:assert/strict';
import childProcess from 'node:child_process';
import { EventEmitter, once } from 'node:events';
import { syncBuiltinESMExports } from 'node:module';
import { promisify } from 'node:util';
import { createTextExtractor } from '../../../plugins/extract-text/src/index.js';
import { activeExtractorProcessCount, queuedExtractorProcessCount } from '../src/extractor-process.js';
import { EXTRACTOR_LIMITS, normalizeExtractorLimits } from '../src/extractor.js';
import { bytes } from '../../../test/extractor-fixtures.js';
const workerURL = new URL('../../../test/fixtures/extractor-failure-child.js', import.meta.url);

function controlledChildren(t) {
  const children = [], events = new EventEmitter();
  t.mock.method(childProcess, 'fork', () => {
    // No OS process or RSS sample: the test controls every lifecycle event.
    const child = new EventEmitter();
    Object.assign(child, { pid: undefined, killed: false, send() {},
      kill() { child.killed = true; return true; } });
    children.push(child); events.emit('spawned', child);
    return child;
  });
  syncBuiltinESMExports();
  t.after(() => {
    for (const child of children) child.emit('close', 0, null);
    t.mock.restoreAll(); syncBuiltinESMExports();
  });
  return { children, spawned: () => waitFor(once(events, 'spawned').then(([child]) => child), 'controlled child spawn') };
}

test('exit and result do not release a slot before close, and duplicate close cannot release the next slot', async t => {
  const observed = controlledChildren(t), plugin = createTextExtractor();
  const spawned = observed.spawned();
  let settled = false;
  const first = plugin.extract(bytes('First')).then(result => { settled = true; return result; });
  const child = await spawned;
  const second = plugin.extract(bytes('Second')), third = plugin.extract(bytes('Third'));
  assert.equal(queuedExtractorProcessCount(), 2);
  child.emit('message', { type: 'result', result: { segments: [{ text: 'First' }] } });
  child.emit('exit', null, 'SIGKILL');
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(child.killed, true);
  assert.equal(settled, false, 'result acknowledgement waits for close');
  assert.equal(activeExtractorProcessCount(), 1);
  assert.equal(queuedExtractorProcessCount(), 2, 'exit alone cannot start queued work');
  assert.equal(observed.children.length, 1);
  const nextSpawn = observed.spawned();
  child.emit('close', null, 'SIGKILL');
  assert.equal((await waitFor(first, 'first result after close')).text, 'First');
  const nextChild = await nextSpawn;
  child.emit('close', null, 'SIGKILL');
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(observed.children.length, 2, 'duplicate close cannot spawn the third child');
  assert.equal(activeExtractorProcessCount(), 1);
  assert.equal(queuedExtractorProcessCount(), 1);
  const lastSpawn = observed.spawned();
  nextChild.emit('message', { type: 'result', result: { segments: [{ text: 'Second' }] } });
  nextChild.emit('close', null, 'SIGKILL');
  assert.equal((await waitFor(second, 'second result after close')).text, 'Second');
  const lastChild = await lastSpawn;
  lastChild.emit('close', 0, null);
  assert.equal((await waitFor(third, 'third result after close')).reason, 'malformed');
  assert.equal(activeExtractorProcessCount(), 0);
  assert.equal(queuedExtractorProcessCount(), 0);
});

test('controlled deadlines reject queued work without spawning and retain a killed child until close', async t => {
  const observed = controlledChildren(t), plugin = createTextExtractor();
  t.mock.timers.enable({ apis: ['Date', 'setTimeout'], now: 1_000_000 });
  const spawned = observed.spawned();
  const running = plugin.extract(bytes('Running'));
  const rejected = assert.rejects(running, { code: 'deadline' });
  const child = await spawned;
  const queued = assert.rejects(plugin.extract(bytes('Queued'), {}, { deadlineAt: Date.now() + 50 }), { code: 'deadline' });
  assert.equal(queuedExtractorProcessCount(), 1);
  t.mock.timers.tick(49);
  assert.equal(queuedExtractorProcessCount(), 1, 'queued work survives until its deadline');
  t.mock.timers.tick(1);
  await waitFor(queued, 'queued deadline rejection');
  assert.equal(queuedExtractorProcessCount(), 0);
  assert.equal(observed.children.length, 1, 'expired queued work never spawns');
  t.mock.timers.tick(EXTRACTOR_LIMITS.deadlineMs - 50);
  assert.equal(child.killed, true, 'the production 10s deadline kills the child');
  assert.equal(activeExtractorProcessCount(), 1, 'the slot remains occupied until close');
  child.emit('close', null, 'SIGKILL');
  await waitFor(rejected, 'running deadline rejection after close');
  assert.equal(activeExtractorProcessCount(), 0);
  const nextSpawn = observed.spawned(), next = plugin.extract(bytes('Next'));
  const nextChild = await nextSpawn;
  nextChild.emit('message', { type: 'result', result: { segments: [{ text: 'Next' }] } });
  nextChild.emit('close', null, 'SIGKILL');
  assert.equal((await waitFor(next, 'request after deadline')).text, 'Next');
});

async function linuxSampler(t, suffix) {
  // Simulate a systemd unit without getconf; no real command may run in these tests.
  const original = childProcess.execFile;
  const commands = t.mock.fn((...args) => {
    queueMicrotask(() => args.at(-1)(Object.assign(new Error('Command unavailable'), { code: 'ENOENT' })));
    return new EventEmitter();
  });
  // A plain replacement avoids execFile's custom promisify wrapper retaining the real command.
  childProcess.execFile = commands;
  syncBuiltinESMExports();
  t.after(() => { childProcess.execFile = original; t.mock.restoreAll(); syncBuiltinESMExports(); });
  const { residentBytes } = await import(`../src/extractor-process.js?${suffix}`);
  return { sample: (pid, readProc) => residentBytes(pid, { platform: 'linux', readProc }), commands };
}

test('Linux RSS uses only VmRSS from proc status in kB without executing commands', async t => {
  const { sample, commands } = await linuxSampler(t, 'linux-status'), reads = [];
  const rss = await sample(421, async (path, encoding) => {
    reads.push([path, encoding]);
    return 'Name:\tparser\nVmSize:\t999999 kB\nVmHWM:\t65536 kB\nVmRSS:\t12345 kB\nRssAnon:\t12000 kB\n';
  });
  assert.equal(rss, 12345 * 1024);
  assert.deepEqual(reads, [['/proc/421/status', 'utf8']]);
  assert.equal(commands.mock.callCount(), 0);
});

test('Linux RSS recovers on the next sample after the first proc read rejects', async t => {
  const { sample, commands } = await linuxSampler(t, 'linux-recovery');
  const reads = [];
  const readProc = async path => {
    reads.push(path);
    if (reads.length === 1) throw Object.assign(new Error('Temporary proc failure'), { code: 'EACCES' });
    return 'VmRSS:\t8192 kB\n';
  };
  await assert.rejects(sample(422, readProc), { code: 'EACCES' });
  assert.equal(await sample(422, readProc), 8 * 1024 * 1024);
  assert.deepEqual(reads, ['/proc/422/status', '/proc/422/status']);
  assert.equal(commands.mock.callCount(), 0);
});

test('Linux RSS is zero for zombie status without Vm lines', async t => {
  const { sample, commands } = await linuxSampler(t, 'linux-zombie');
  const status = 'Name:\tparser\nState:\tZ (zombie)\nTgid:\t423\nPid:\t423\nThreads:\t1\n';
  assert.equal(await sample(423, async () => status), 0);
  assert.equal(commands.mock.callCount(), 0);
});

test('Linux RSS is zero for exiting status without VmRSS', async t => {
  const { sample, commands } = await linuxSampler(t, 'linux-exiting');
  for (const status of [
    'Name:\tparser\nState:\tX (dead)\nPid:\t423\nThreads:\t1\n',
    // An exiting process can lose its memory map before its state changes.
    'Name:\tparser\nState:\tR (running)\nPid:\t423\nThreads:\t1\n',
    'VmSize: 1024 kB\n',
  ]) {
    assert.equal(await sample(423, async () => status), 0);
  }
  assert.equal(commands.mock.callCount(), 0);
});

test('Linux RSS rejects malformed and unsafe VmRSS values', async t => {
  const { sample } = await linuxSampler(t, 'linux-invalid');
  for (const status of ['VmRSS:\n', 'VmRSS: -1 kB\n', 'VmRSS: 1.5 kB\n',
    'VmRSS: 1024 MB\n', 'VmRSS: 9007199254740992 kB\n',
    'State:\tZ (zombie)\nVmRSS: invalid kB\n']) {
    await assert.rejects(sample(423, async () => status), /Invalid RSS/u);
  }
  assert.equal(await sample(423, async () => 'VmRSS: 0 kB\n'), 0);
});

test('macOS watchdog skips ticks while ps is pending and resumes after completion', async t => {
  const descriptor = Object.getOwnPropertyDescriptor(process, 'platform');
  const originalExecFile = childProcess.execFile;
  Object.defineProperty(process, 'platform', { value: 'darwin' });
  const child = new EventEmitter(), callbacks = [];
  Object.assign(child, { pid: 424, exitCode: null, signalCode: null, killed: false, send() {},
    kill() {
      child.killed = true; child.signalCode = 'SIGKILL';
      queueMicrotask(() => child.emit('close', null, 'SIGKILL'));
      return true;
    } });
  t.mock.method(childProcess, 'fork', () => child);
  const execFile = (command, args, options, callback) => {
    assert.equal(command, '/bin/ps');
    assert.deepEqual(args, ['-o', 'rss=', '-p', '424']);
    callbacks.push(callback);
    return new EventEmitter();
  };
  execFile[promisify.custom] = (...args) => new Promise((resolve, reject) => {
    execFile(...args, (error, stdout, stderr) => error ? reject(error) : resolve({ stdout, stderr }));
  });
  childProcess.execFile = execFile;
  syncBuiltinESMExports();
  t.mock.timers.enable({ apis: ['setTimeout', 'setInterval'] });
  let outcome;
  try {
    const { runExtractorProcess } = await import('../src/extractor-process.js?macos-pending');
    outcome = runExtractorProcess(workerURL, bytes('pending'), 'text/plain', normalizeExtractorLimits(),
      { signal: new AbortController().signal, deadlineAt: Date.now() + 60_000 })
      .then(result => ({ result }), error => ({ error }));
    await Promise.resolve();
    assert.equal(callbacks.length, 1, 'initial sample starts immediately');
    t.mock.timers.tick(100);
    assert.equal(callbacks.length, 1, 'pending ps prevents overlapping samples');
    callbacks[0](null, '1024\n', '');
    await new Promise(resolve => setImmediate(resolve));
    t.mock.timers.tick(25);
    assert.equal(callbacks.length, 2, 'sampling resumes once ps completes');
    callbacks[1](new Error('ps failed'));
    assert.equal((await waitFor(outcome, 'failed RSS sample to close the child')).error?.code, 'unavailable');
    assert.equal(child.killed, true, 'a failed sample still fails closed');
  } finally {
    child.emit('close', 0, null);
    for (const callback of callbacks) callback(null, '1024\n', '');
    await waitFor(outcome, 'mock watchdog cleanup');
    childProcess.execFile = originalExecFile;
    t.mock.restoreAll(); syncBuiltinESMExports();
    Object.defineProperty(process, 'platform', descriptor);
  }
});

test('RSS limits default to 384 MiB and hosts can only lower them', () => {
  assert.equal(EXTRACTOR_LIMITS.maxRssMb, 384);
  assert.equal(normalizeExtractorLimits({ maxRssMb: 512 }).maxRssMb, 384);
  assert.equal(normalizeExtractorLimits({ maxRssMb: 16 }).maxRssMb, 16);
});
for (const mode of ['crash', 'signal', 'heap']) {
  test(`child ${mode} without a result is unreadable limit and releases the slot`, async t => {
    const observed = observeParsers(t);
    const warnings = t.mock.method(console, 'warn', () => {});
    // This checks crash classification/reaping, not deadline speed. Freeze both
    // Date and the deadline timer so loaded child startup cannot consume the
    // production 10s budget. waitFor's real timer still catches missing events.
    t.mock.timers.enable({ apis: ['Date', 'setTimeout'], now: 1_000_000 });
    const plugin = createTextExtractor({ workerURL, limits: { maxHeapMb: 16 } });
    const result = await waitFor(plugin.extract(bytes(mode)), `${mode} result and child close`);
    assert.equal(result.status, 'unreadable'); assert.equal(result.reason, 'limit');
    const { code, signal } = await waitFor(observed.children[0].closed, `${mode} close event`);
    assert.ok(code !== 0 || signal);
    if (mode === 'heap') assert.ok(signal === 'SIGABRT' || code === 134, 'actual V8 heap OOM');
    assert.deepEqual(warnings.mock.calls.map(call => call.arguments), [
      ['Extractor child exited without a result; treating as limit', { code, signal }],
    ]);
    assert.equal(activeExtractorProcessCount(), 0);
    assert.equal((await waitFor(createTextExtractor().extract(bytes('Next request')), 'request after crashed child')).text, 'Next request');
    assert.equal(warnings.mock.callCount(), 1, 'normal result cleanup does not log a crash');
  });
}
test('spawn error with no pid settles without close and releases the global slot exactly once', async t => {
  const original = childProcess.fork, child = new EventEmitter();
  child.pid = undefined; child.kill = () => false; child.send = () => {};
  let first = true;
  t.mock.method(childProcess, 'fork', (...args) => {
    if (!first) return original(...args);
    first = false;
    queueMicrotask(() => child.emit('error', Object.assign(new Error('spawn failed'), { code: 'EAGAIN' })));
    return child;
  });
  syncBuiltinESMExports();
  const work = createTextExtractor().extract(bytes('Spawn failure'));
  const outcome = work.then(() => null, error => error);
  try {
    const error = await waitFor(outcome, 'spawn failure without a close event');
    assert.equal(error?.code, 'unavailable');
    assert.equal(activeExtractorProcessCount(), 0);
    child.emit('close', null, null);
    assert.equal((await waitFor(createTextExtractor().extract(bytes('Next request')), 'request after spawn failure')).text, 'Next request');
  } finally {
    child.emit('close', null, null); await waitFor(outcome, 'spawn failure cleanup');
    t.mock.restoreAll(); syncBuiltinESMExports();
  }
});
test('async child exits when its parent IPC disconnects', async t => {
  const child = childProcess.fork(workerURL, [], { env: { NODE_NO_WARNINGS: '1' }, execArgv: [], stdio: ['ignore', 'ignore', 'ignore', 'ipc'] });
  const started = once(child, 'message'), exited = once(child, 'exit');
  t.after(async () => {
    if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL');
    // After explicit IPC disconnect this stdio-ignored child has no pipes to
    // close. Wait for reaping via exit; Node may omit close in this case.
    await waitFor(exited, 'disconnected child cleanup');
  });
  child.send({ type: 'extract', bytes: bytes('disconnect'), limits: {} });
  const [message] = await waitFor(started, 'disconnect fixture started message');
  assert.deepEqual(message, { type: 'started' });
  child.disconnect();
  assert.deepEqual(await waitFor(exited, 'child exit after IPC disconnect'), [1, null]);
});
