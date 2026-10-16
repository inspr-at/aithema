import { test, observeParsers } from '../../../plugins/extract-text/test/extractor-test-helpers.js';
import assert from 'node:assert/strict';
import { EXTRACTOR_LIMITS, UPLOAD_LIMITS, EXTRACTOR_MEDIA_TYPES, normalizeExtractorLimits, createExtractor, sniffDocument } from '../src/extractor.js';
import { runExtractorProcess, activeExtractorProcessCount } from '../src/extractor-process.js';
import { createTextExtractor } from '../../../plugins/extract-text/src/index.js';
import { createPDFExtractor } from '../../../plugins/extract-pdf/src/index.js';
import { createOOXMLExtractor } from '../../../plugins/extract-ooxml/src/index.js';
import { extractorLimitFixture, MiB } from '../../../test/extractor-limit-fixtures.js';
import { pdf } from '../../../test/extractor-fixtures.js';

test('AIT-219: measured input ceiling is 20 MiB and every host override can only lower a ceiling', () => {
  assert.equal(EXTRACTOR_LIMITS.maxBytes, 20 * MiB);
  assert.equal(UPLOAD_LIMITS.maxRequestBytes, 21 * MiB);
  assert.equal(EXTRACTOR_LIMITS.maxChars, 60_000);
  for (const [key, ceiling] of Object.entries(EXTRACTOR_LIMITS)) {
    assert.equal(normalizeExtractorLimits({ [key]: ceiling + 1 })[key], ceiling, key);
    assert.equal(normalizeExtractorLimits({ [key]: ceiling - 1 })[key], ceiling - 1, key);
  }
});

for (const format of ['text-pdf', 'image-pdf', 'docx', 'text']) {
  test(`AIT-219: ${format} at exactly the cap extracts and cap + 1 is unreadable (limit)`, async t => {
    const observed = observeParsers(t);
    const extractor = createExtractor({ plugins: [createPDFExtractor(), createOOXMLExtractor(), createTextExtractor()] });
    const data = extractorLimitFixture(format, 20 * MiB);
    const result = await extractor.extract(data);
    assert.equal(result.status, 'accepted');
    assert.ok(result.text.length > 0 && result.text.length <= 60_000);
    if (format !== 'image-pdf') assert.equal(result.truncated, true);
    const before = observed.workCount();
    const refused = await extractor.extract(Buffer.concat([data, Buffer.from(' ')]));
    assert.equal(refused.status, 'unreadable'); assert.equal(refused.reason, 'limit');
    assert.equal(observed.workCount(), before, 'oversized input never starts a worker');
    assert.equal(refused.text, ''); assert.deepEqual(refused.segments, []);
  });
}

test('AIT-219: a lowered host byte cap admits exactly the cap and refuses the next byte', async () => {
  const extractor = createExtractor({ plugins: [createTextExtractor()], limits: { maxBytes: 1024 } });
  const data = Buffer.alloc(1025, 97);
  assert.equal((await extractor.extract(data.subarray(0, 1024))).status, 'accepted');
  const result = await extractor.extract(data, {}, { limits: { maxBytes: 20 * MiB } });
  assert.equal(result.reason, 'limit'); assert.equal(result.limits.maxBytes, 1024);
});

test('AIT-219: the 20 MiB OOXML bomb trips compression bounds in admission and in the real worker', async t => {
  const observed = observeParsers(t), data = extractorLimitFixture('ooxml-bomb', 20 * MiB);
  assert.equal(sniffDocument(data).reason, 'limit');
  assert.equal((await createOOXMLExtractor().extract(data)).reason, 'limit');
  assert.equal(observed.workCount(), 0, 'admission refuses before decompression');
  const workerURL = new URL('../../../plugins/extract-ooxml/src/ooxml-extract-child.js', import.meta.url);
  const raw = await runExtractorProcess(workerURL, data, EXTRACTOR_MEDIA_TYPES.docx, EXTRACTOR_LIMITS,
    { signal: new AbortController().signal, deadlineAt: Date.now() + EXTRACTOR_LIMITS.deadlineMs });
  assert.deepEqual(raw, { reason: 'limit' });
  assert.equal(observed.workCount(), 1, 'the same archive bound is independently enforced inside the worker');
  assert.equal(activeExtractorProcessCount(), 0);
});

test('AIT-219: a 20 MiB PDF with many tiny objects trips worker bounds and the next document still extracts', async t => {
  const observed = observeParsers(t), data = extractorLimitFixture('many-objects-pdf', 20 * MiB);
  assert.equal(sniffDocument(data).reason, undefined, 'the object graph reaches the parser');
  const result = await createPDFExtractor().extract(data);
  assert.equal(result.status, 'unreadable'); assert.equal(result.reason, 'limit');
  assert.equal(observed.workCount(), 1);
  const record = observed.children[0];
  const { signal } = await record.closed;
  assert.ok(['SIGKILL', 'SIGABRT'].includes(signal), 'RSS watchdog or V8 heap ceiling terminates the parser');
  assert.throws(() => process.kill(record.child.pid, 0), { code: 'ESRCH' });
  assert.equal(activeExtractorProcessCount(), 0);
  assert.equal((await createPDFExtractor().extract(pdf())).status, 'accepted');
});
