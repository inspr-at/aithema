import { test } from 'node:test';
import assert from 'node:assert/strict';
import { PluginRegistry } from '../src/plugins.js';
import { createExtractor, EXTRACTOR_LIMITS, EXTRACTOR_MEDIA_TYPES, normalizeExtractorLimits, sniffDocument,
  isExtraction, extractionResult, assertExtractor } from '../src/extractor.js';
import { extractorConformance } from '../src/extractor-conformance.js';
import { createPDFExtractor } from '../../../plugins/extract-pdf/src/index.js';
import { createOOXMLExtractor } from '../../../plugins/extract-ooxml/src/index.js';
import { createTextExtractor } from '../../../plugins/extract-text/src/index.js';
import { bytes, pdf, docx, xlsx, pptx, zip, HANG, stallWorkerURL, observeParsers } from '../../../test/extractor-fixtures.js';

test('conformance rejects trusting any supported declared type and checks every alternate format', async t => {
  const observed = observeParsers(t), plugin = createTextExtractor({ workerURL: stallWorkerURL });
  const formats = new Set(plugin.manifest.models.flatMap(model => model.formats)), declarations = [];
  const broken = { ...plugin, async extract(data, metadata, options) {
    const result = await plugin.extract(data, metadata, options);
    if (metadata.mediaType) declarations.push(metadata.mediaType);
    return result.status === 'accepted' && formats.has(metadata.mediaType) ? { ...result, mediaType: metadata.mediaType } : result;
  } };
  const result = await extractorConformance(broken, { bytes: bytes('Readable text conformance source words'), mediaType: 'text/plain' },
    { ...observed, stallBytes: bytes(HANG), unreadableBytes: Buffer.from([0]) });
  assert.equal(result.ok, false);
  assert.ok(result.failures.some(message => message.includes('sniffing')));
  for (const type of formats) if (type !== 'text/plain') assert.ok(declarations.includes(type), type);
  assert.ok(declarations.includes('text/plain'));
});
test('conformance requires page fixtures for a manifest supporting paginated formats', async t => {
  const observed = observeParsers(t);
  const result = await extractorConformance(createOOXMLExtractor({ workerURL: stallWorkerURL }),
    { bytes: docx('Readable Word source words'), mediaType: EXTRACTOR_MEDIA_TYPES.docx },
    { ...observed, stallBytes: docx(HANG), unreadableBytes: Buffer.from([0]) });
  assert.equal(result.ok, false);
  assert.ok(result.failures.some(message => message.includes('page')));
  assert.equal(observed.workCount(), 0);
});
test('conformance checks an optional archive bomb fixture', async t => {
  const observed = observeParsers(t), plugin = createOOXMLExtractor({ workerURL: stallWorkerURL });
  const archiveBombBytes = zip({ 'word/document.xml': '<w:document>' + 'A'.repeat(200_000) + '</w:document>' }, { compress: true });
  const broken = { ...plugin, async extract(data, metadata, options) {
    return plugin.extract(data === archiveBombBytes ? docx('Incorrectly accepted archive bomb') : data, metadata, options);
  } };
  const result = await extractorConformance(broken, { bytes: docx('Readable Word source words'), mediaType: EXTRACTOR_MEDIA_TYPES.docx },
    { ...observed, stallBytes: docx(HANG), unreadableBytes: Buffer.from([0]), pageBytes: xlsx(['One', 'Two']), archiveBombBytes });
  assert.equal(result.ok, false);
  assert.ok(result.failures.includes('archive bomb cap enforced'));
});
test('conformance deadline completes when a child closes before its started message', async t => {
  const observed = observeParsers(t);
  const result = await extractorConformance(createTextExtractor({ workerURL: stallWorkerURL }),
    { bytes: bytes('Readable conformance source words'), mediaType: 'text/plain' },
    { ...observed, stallBytes: bytes(HANG + '-DELAY-START'), unreadableBytes: Buffer.from([0]) });
  assert.deepEqual(result, { ok: true, failures: [] });
});

test('registers all extractor plugins and dispatches exclusively from actual bytes', async () => {
  const registry = new PluginRegistry();
  [createPDFExtractor(), createOOXMLExtractor(), createTextExtractor()].forEach(plugin => registry.register(plugin));
  const extractor = createExtractor({ plugins: registry.list(), limits: { maxChars: 32 } });
  for (const [data, type] of [[pdf(), EXTRACTOR_MEDIA_TYPES.pdf], [docx(), EXTRACTOR_MEDIA_TYPES.docx],
    [xlsx(), EXTRACTOR_MEDIA_TYPES.xlsx], [pptx(), EXTRACTOR_MEDIA_TYPES.pptx], [bytes('Tiny plain text'), 'text/plain']]) {
    const result = await extractor.extract(data, { mediaType: 'image/png', filename: 'lie.png' });
    assert.equal(result.mediaType, type); assert.equal(result.status, 'accepted'); assert.ok(isExtraction(result));
    assert.ok(result.text.length <= 32); assert.equal(result.limits.maxChars, 32);
  }
});
test('sniffing inspects real ZIP entries; payload markers, declared types and filenames have no authority', () => {
  assert.equal(sniffDocument(zip({ 'random.txt': 'word/document.xml' })).mediaType, 'application/zip');
  assert.equal(sniffDocument(zip({ 'word/document.xml': '<w:document/>', 'xl/workbook.xml': '<workbook/>' })).reason, 'unsupported');
  for (const [input, type] of [['name,value\nA,1\nB,2', 'text/csv'], ['# A heading\nSome words', 'text/markdown'],
    ['<?xml version="1.0"?><root>words</root>', 'application/xml'], ['Just words', 'text/plain']]) {
    assert.equal(sniffDocument(bytes(input)).mediaType, type);
  }
});
test('limits only decrease, validate exactly, and refuse unsupported binary uploads', async () => {
  assert.equal(normalizeExtractorLimits({ maxBytes: Number.MAX_SAFE_INTEGER }).maxBytes, EXTRACTOR_LIMITS.maxBytes);
  for (const value of [{ maxBytes: 0 }, { maxChars: 1.5 }, { maxPages: Infinity }, { maxEntries: '1' }, { mystery: 2 }]) {
    assert.throws(() => normalizeExtractorLimits(value), TypeError);
  }
  assert.throws(() => assertExtractor({}), TypeError);
  const extractor = createExtractor({ plugins: [] });
  for (const data of [bytes('unsupported with no registered parser'), Buffer.from([0, 1, 2]), Buffer.from([137, 80, 78, 71, 13, 10, 26, 10])]) {
    const result = await extractor.extract(data);
    assert.equal(result.status, 'unreadable'); assert.equal(result.reason, 'unsupported'); assert.ok(isExtraction(result));
  }
});
test('caps include separators, IDs stay deterministic, and truncation never splits a surrogate pair', () => {
  const limits = normalizeExtractorLimits({ maxChars: 10 });
  const result = extractionResult({ segments: [{ text: 'First', page: 1 }, { text: 'Second', page: 2 }] }, 'application/pdf', limits);
  assert.equal(result.text, 'First\n\nSec'); assert.equal(result.truncated, true);
  assert.deepEqual(result.segments.map(segment => segment.id), ['segment:1', 'segment:2']);
  assert.ok(isExtraction(result));
  const emoji = extractionResult({ segments: [{ text: '123456789😀' }] }, 'text/plain', limits);
  assert.equal(emoji.text, '123456789'); assert.equal(emoji.truncated, true);
  assert.equal(isExtraction({ ...result, segments: [result.segments[0], result.segments[0]] }), false);
});
test('dispatcher rejects broken plugin output and checks lifetime before any sniffing', async () => {
  const plugin = createTextExtractor();
  const extractor = createExtractor({ plugins: [{ ...plugin, extract: async () => ({ text: 'bad', mediaType: 'image/png' }) }] });
  await assert.rejects(extractor.extract(bytes('words')), { code: 'invalid-output' });
  const controller = new AbortController(); controller.abort();
  await assert.rejects(extractor.extract(Buffer.alloc(0), {}, { signal: controller.signal }), { code: 'cancelled' });
  await assert.rejects(extractor.extract(Buffer.alloc(0), {}, { deadlineAt: Date.now() - 1 }), { code: 'deadline' });
});
test('conformance rejects a deliberately broken extractor and missing active fixtures', async t => {
  const observed = observeParsers(t), fixture = { bytes: bytes('Text extraction fixture with plenty of characters'), mediaType: 'text/plain' };
  assert.equal((await extractorConformance(createTextExtractor(), fixture)).ok, false);
  const plugin = createTextExtractor({ workerURL: stallWorkerURL });
  const broken = { ...plugin, async extract(data, metadata, options) {
    if (options.signal.aborted || options.deadlineAt < Date.now()) return { text: 'ignored cancellation' };
    const result = await plugin.extract(data, metadata, options);
    return result.status === 'accepted' ? { ...result, mediaType: metadata.mediaType ?? result.mediaType } : result;
  } };
  const result = await extractorConformance(broken, fixture, { ...observed,
    stallBytes: bytes(HANG), unreadableBytes: Buffer.from([0]) });
  assert.equal(result.ok, false);
  assert.ok(result.failures.some(message => message.includes('sniffing')));
  assert.ok(result.failures.some(message => message.includes('preflight cancellation')));
});
test('child transport guards deny every network probe before an outbound request', async t => {
  const observed = observeParsers(t), before = observed.requestCount();
  const plugin = createTextExtractor({ workerURL: new URL('../../../test/fixtures/extractor-network-child.js', import.meta.url) });
  const result = await plugin.extract(bytes('Trusted transport probe fixture'));
  assert.equal(result.status, 'accepted'); assert.equal(result.text, 'Denied 13/13 transports');
  assert.equal(observed.requestCount() - before, 13);
});
