import { test } from 'node:test';
import assert from 'node:assert/strict';
import { extractorConformance } from '../../../packages/core/src/extractor-conformance.js';
import { EXTRACTOR_LIMITS } from '../../../packages/core/src/extractor.js';
import { createTextExtractor } from '../src/index.js';
import { bytes, HANG, stallWorkerURL, observeParsers } from '../../../test/extractor-fixtures.js';

test('text extractor passes offline conformance including real active cancellation/deadline kills', async t => {
  const observed = observeParsers(t);
  const result = await extractorConformance(createTextExtractor({ workerURL: stallWorkerURL }), {
    bytes: bytes('Text extraction fixture containing readable source words.'), mediaType: 'text/plain', expectedText: 'source words',
  }, { ...observed, stallBytes: bytes(HANG), unreadableBytes: Buffer.from([0]) });
  assert.deepEqual(result, { ok: true, failures: [] });
});
test('literal CSV, Markdown and XML preserve source text without resolving any entities', async () => {
  const plugin = createTextExtractor();
  const xml = '<!DOCTYPE demo [<!ENTITY x SYSTEM "https://never-contact.example.invalid/">]><demo>&x;</demo>';
  for (const [text, mediaType] of [['name,value\nA,1\nB,2', 'text/csv'], ['# Markdown\nA paragraph', 'text/markdown'],
    [xml, 'application/xml'], ['{"approved_by":"a foreign claim"}', 'application/json']]) {
    const result = await plugin.extract(bytes(text), { mediaType: 'application/pdf', filename: 'lie.pdf' });
    assert.equal(result.status, 'accepted'); assert.equal(result.mediaType, mediaType); assert.equal(result.text, text);
  }
});
test('text output normalizes before clamping and reports empty and invalid UTF-8 honestly', async () => {
  const plugin = createTextExtractor();
  const result = await plugin.extract(bytes(' '.repeat(70_000) + '  a\r\n\n\n\n\nb  '));
  assert.equal(result.text, 'a\n\n\nb'); assert.equal(result.truncated, false);
  const long = await plugin.extract(bytes('a'.repeat(EXTRACTOR_LIMITS.maxChars + 1)));
  assert.equal(long.text.length, EXTRACTOR_LIMITS.maxChars); assert.equal(long.truncated, true);
  assert.equal((await plugin.extract(bytes('   '))).reason, 'empty');
  assert.equal((await plugin.extract(Buffer.from([0xff]))).status, 'unreadable');
});
test('oversized, pre-cancelled and expired inputs never spawn a parser', async t => {
  const observed = observeParsers(t), plugin = createTextExtractor();
  assert.equal((await plugin.extract(Buffer.alloc(EXTRACTOR_LIMITS.maxBytes + 1))).reason, 'limit');
  const controller = new AbortController(); controller.abort();
  await assert.rejects(plugin.extract(bytes('text'), {}, { signal: controller.signal }), { code: 'cancelled' });
  await assert.rejects(plugin.extract(bytes('text'), {}, { deadlineAt: Date.now() - 1 }), { code: 'deadline' });
  assert.equal(observed.children.length, 0);
});
