import { test, observeParsers, waitFor, CONFORMANCE_TIMEOUT_MS } from '../../extract-text/test/extractor-test-helpers.js';
import assert from 'node:assert/strict';
import { extractorConformance } from '../../../packages/core/src/extractor-conformance.js';
import { activeExtractorProcessCount, queuedExtractorProcessCount, extractorProcessPeakRssBytesForTest } from '../../../packages/core/src/extractor-process.js';
import { EXTRACTOR_LIMITS } from '../../../packages/core/src/extractor.js';
import { createPDFExtractor } from '../src/index.js';
import { bytes, pdf, pdfStreamBomb, HANG, stallWorkerURL } from '../../../test/extractor-fixtures.js';

test('nested FlateDecode PDF stream bomb is killed by a low RSS cap and reaped', async t => {
  const observed = observeParsers(t), data = pdfStreamBomb();
  const baseline = await createPDFExtractor().extract(pdf());
  assert.equal(baseline.status, 'accepted', 'the default RSS cap accepts a small PDF');
  const baselineMb = extractorProcessPeakRssBytesForTest(observed.children[0].child) / (1024 * 1024);
  assert.ok(baselineMb > 0, 'the watchdog sampled the real PDF child RSS');
  const maxRssMb = Math.ceil(baselineMb) + 48;
  assert.ok(maxRssMb < EXTRACTOR_LIMITS.maxRssMb, 'the default cap has more than 48 MiB of baseline headroom');
  t.diagnostic(`${process.version}: small PDF sampled peak RSS ${baselineMb.toFixed(2)} MiB; bomb cap ${maxRssMb} MiB; default headroom ${(EXTRACTOR_LIMITS.maxRssMb - baselineMb).toFixed(2)} MiB`);
  const plugin = createPDFExtractor({ limits: { maxRssMb } });
  const control = await plugin.extract(pdf());
  assert.equal(control.status, 'accepted', 'a small PDF is accepted at the same RSS cap');
  assert.equal(control.limits.maxRssMb, maxRssMb);
  assert.ok(data.length < 2048);
  assert.ok(data.includes('/Filter [/FlateDecode /FlateDecode]'));
  const result = await plugin.extract(data);
  assert.equal(result.status, 'unreadable'); assert.equal(result.reason, 'limit');
  assert.equal(result.limits.maxRssMb, maxRssMb);
  const bomb = observed.children[2];
  assert.ok(extractorProcessPeakRssBytesForTest(bomb.child) > maxRssMb * 1024 * 1024,
    'the bomb actually exceeds the calibrated RSS cap');
  assert.deepEqual(await bomb.closed, { code: null, signal: 'SIGKILL' });
  assert.throws(() => process.kill(bomb.child.pid, 0), { code: 'ESRCH' });
  assert.equal(activeExtractorProcessCount(), 0);
  assert.equal((await createPDFExtractor().extract(pdf())).status, 'accepted');
});

test('PDF extractor passes offline conformance, page/output caps and SIGKILL checks', async t => {
  const observed = observeParsers(t);
  const result = await extractorConformance(createPDFExtractor({ workerURL: stallWorkerURL }), {
    bytes: pdf(), mediaType: 'application/pdf', expectedText: 'extraction fixture',
  }, { ...observed, timeoutMs: CONFORMANCE_TIMEOUT_MS, stallBytes: pdf([HANG]), unreadableBytes: bytes('%PDF-1.7\nBroken PDF'),
    pageBytes: pdf(['First page', 'Second page']) });
  assert.deepEqual(result, { ok: true, failures: [] });
});
test('PDF page segments are citable, ordered, stable and independent of the declared media type', async () => {
  const plugin = createPDFExtractor(), data = pdf(['Page one source text', 'Page two source text']);
  const result = await plugin.extract(data, { mediaType: 'text/plain', filename: 'lie.txt' });
  assert.equal(result.status, 'accepted'); assert.equal(result.mediaType, 'application/pdf');
  assert.deepEqual(result.segments, [{ id: 'segment:1', text: 'Page one source text', page: 1 },
    { id: 'segment:2', text: 'Page two source text', page: 2 }]);
  assert.equal((await plugin.extract(data, {}, { limits: { maxPages: 1 } })).reason, 'limit');
  assert.equal((await plugin.extract(pdf(['']))).reason, 'empty');
  assert.equal((await plugin.extract(bytes('%PDF-1.7\nMalformed'))).status, 'unreadable');
});
test('a hanging PDF child is reaped before cancellation resolves and carries bounded private options', async t => {
  const observed = observeParsers(t), plugin = createPDFExtractor({ workerURL: stallWorkerURL });
  const controller = new AbortController(), spawned = observed.spawned();
  const work = plugin.extract(pdf([HANG]), {}, { signal: controller.signal });
  const rejected = assert.rejects(work, { code: 'cancelled' });
  t.after(() => controller.abort());
  const record = await waitFor(spawned, 'hanging PDF spawn');
  assert.equal(await waitFor(record.started, 'hanging PDF started message'), true);
  assert.equal(activeExtractorProcessCount(), 1);
  controller.abort(); await waitFor(rejected, 'PDF cancellation acknowledgement');
  assert.deepEqual(await waitFor(record.closed, 'cancelled PDF close'), { code: null, signal: 'SIGKILL' });
  assert.throws(() => process.kill(record.child.pid, 0), { code: 'ESRCH' });
  assert.equal(activeExtractorProcessCount(), 0);
  assert.ok(record.args[2].execArgv.includes('--max-old-space-size=128'));
  assert.ok(record.args[2].execArgv.includes('--permission'));
  assert.deepEqual(record.args[2].env, { NODE_NO_WARNINGS: '1' });
});
test('queued requests respect cancellation and deadlines without spawning; the next request can finish', async t => {
  const observed = observeParsers(t), plugin = createPDFExtractor({ workerURL: stallWorkerURL });
  const running = new AbortController(), spawned = observed.spawned();
  const work = plugin.extract(pdf([HANG]), {}, { signal: running.signal });
  const rejected = assert.rejects(work, { code: 'cancelled' });
  t.after(() => running.abort());
  const record = await waitFor(spawned, 'PDF spawn before queue checks');
  assert.equal(await waitFor(record.started, 'PDF started before queue checks'), true);
  const queued = new AbortController();
  const waiting = plugin.extract(pdf(), {}, { signal: queued.signal });
  const cancelled = assert.rejects(waiting, { code: 'cancelled' });
  assert.equal(queuedExtractorProcessCount(), 1); queued.abort(); await cancelled;
  t.mock.timers.enable({ apis: ['Date', 'setTimeout'], now: Date.now() });
  const expired = assert.rejects(plugin.extract(pdf(), {}, { deadlineAt: Date.now() + 50 }), { code: 'deadline' });
  assert.equal(queuedExtractorProcessCount(), 1);
  t.mock.timers.tick(50);
  await waitFor(expired, 'queued PDF deadline');
  t.mock.timers.reset();
  assert.equal(observed.children.length, 1); assert.equal(queuedExtractorProcessCount(), 0);
  running.abort(); await waitFor(rejected, 'running PDF cancellation after queue checks');
  const result = await waitFor(plugin.extract(pdf()), 'PDF after queue cancellation'); assert.equal(result.status, 'accepted');
  assert.equal(activeExtractorProcessCount(), 0);
});
test('cancellation while immediate slot acquisition yields creates no child', async t => {
  const observed = observeParsers(t), controller = new AbortController();
  const work = createPDFExtractor().extract(pdf(), {}, { signal: controller.signal });
  const rejected = assert.rejects(work, { code: 'cancelled' }); controller.abort(); await rejected;
  assert.equal(observed.children.length, 0);
});
