import { test } from 'node:test';
import assert from 'node:assert/strict';
import { extractorConformance } from '../../../packages/core/src/extractor-conformance.js';
import { EXTRACTOR_MEDIA_TYPES } from '../../../packages/core/src/extractor.js';
import { createOOXMLExtractor } from '../src/index.js';
import { docx, xlsx, pptx, zip, HANG, stallWorkerURL, observeParsers } from '../../../test/extractor-fixtures.js';

for (const [kind, fixture] of [['docx', docx], ['xlsx', xlsx], ['pptx', text => pptx([text])]]) {
  test(`${kind.toUpperCase()} passes extractor conformance with active process cancellation and deadlines`, async t => {
    const observed = observeParsers(t);
    const result = await extractorConformance(createOOXMLExtractor({ workerURL: stallWorkerURL }), {
      bytes: fixture('Readable Office extraction fixture source words'), mediaType: EXTRACTOR_MEDIA_TYPES[kind], expectedText: 'source words',
    }, { ...observed, stallBytes: fixture(HANG), unreadableBytes: zip({ 'word/document.xml': '<w:document><w:t>unterminated' }),
      ...(kind === 'pptx' ? { pageBytes: pptx(['First slide', 'Second slide']) } :
        kind === 'xlsx' ? { pageBytes: xlsx(['First sheet', 'Second sheet']) } : {}) });
    assert.deepEqual(result, { ok: true, failures: [] });
  });
}
test('Office readers retain Word runs, spreadsheet strings/numbers and presentation order', async () => {
  const plugin = createOOXMLExtractor();
  const word = await plugin.extract(zip({ 'word/document.xml': '<w:document><w:body><w:p><w:r><w:t>First </w:t></w:r><w:r><w:t>sentence &amp; &#x1F600;.</w:t></w:r></w:p><w:p><w:r><w:t>Next</w:t><w:tab/><w:t>column</w:t><w:br/><w:t>line</w:t></w:r></w:p></w:body></w:document>',
    'word/header1.xml': '<w:p><w:r><w:t>Header</w:t></w:r></w:p>' }, { compress: true }));
  assert.equal(word.text, 'First sentence & 😀.\nNext\tcolumn\nline\n\n\nHeader');
  const compressed = zip({ 'word/document.xml': '<w:document><w:t>Maximum compression</w:t></w:document>' }, { compress: true });
  compressed.writeUInt16LE(6, 6); compressed.writeUInt16LE(6, compressed.indexOf(Buffer.from([80, 75, 1, 2])) + 8);
  assert.equal((await plugin.extract(compressed)).text, 'Maximum compression');
  const sheet = await plugin.extract(xlsx());
  assert.equal(sheet.text, '## First & last\nSpreadsheet extraction fixture\t42\tInline text');
  const slides = await plugin.extract(pptx(['First slide', 'Second slide']));
  assert.deepEqual(slides.segments.map(segment => [segment.page, segment.text]), [[1, 'First slide'], [2, 'Second slide']]);
});
test('zip bombs are refused before spawning: ratio, entry count, part size and total expansion', async t => {
  const observed = observeParsers(t), plugin = createOOXMLExtractor();
  const ratioBomb = zip({ 'word/document.xml': '<w:document>' + 'A'.repeat(200_000) + '</w:document>' }, { compress: true });
  assert.equal((await plugin.extract(ratioBomb)).reason, 'limit');
  const many = zip({ 'word/document.xml': '<w:document/>', ...Object.fromEntries(Array.from({ length: 512 }, (_, i) => [`extras/${i}`, 'a'])) });
  assert.equal((await plugin.extract(many)).reason, 'limit');
  const part = zip({ 'word/document.xml': '<w:document/>', 'ignored.bin': 'too big' });
  assert.equal((await plugin.extract(part, {}, { limits: { maxPartBytes: 6 } })).reason, 'limit');
  assert.equal((await plugin.extract(part, {}, { limits: { maxUncompressedBytes: 10 } })).reason, 'limit');
  assert.equal(observed.children.length, 0);
});
test('inflated size and CRC must match; encrypted, duplicate/traversal and malformed inputs are unreadable', async () => {
  const plugin = createOOXMLExtractor();
  const forged = zip({ 'word/document.xml': '<w:document><w:t>' + 'abcd'.repeat(100) + '</w:t></w:document>' }, { compress: true });
  const central = forged.indexOf(Buffer.from([80, 75, 1, 2]));
  forged.writeUInt32LE(8, 22); forged.writeUInt32LE(8, central + 24);
  assert.equal((await plugin.extract(forged)).status, 'unreadable');
  const corrupt = docx(); corrupt[corrupt.indexOf(Buffer.from('Document extraction'))] ^= 1;
  assert.equal((await plugin.extract(corrupt)).reason, 'malformed');
  const encrypted = zip({ 'word/document.xml': '<w:document/>' }); encrypted.writeUInt16LE(1, 6);
  encrypted.writeUInt16LE(1, encrypted.indexOf(Buffer.from([80, 75, 1, 2])) + 8);
  assert.equal((await plugin.extract(encrypted)).reason, 'encrypted');
  assert.equal((await plugin.extract(zip({ '../word/document.xml': '<w:document/>' }))).reason, 'malformed');
  const entities = zip({ 'word/document.xml': '<!DOCTYPE x [<!ENTITY y SYSTEM "https://never-contact.example.invalid/">]><w:document><w:t>&y;</w:t></w:document>' });
  assert.equal((await plugin.extract(entities)).reason, 'malformed');
});
