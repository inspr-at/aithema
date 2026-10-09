import { test } from 'node:test';
import assert from 'node:assert/strict';
import { extractorConformance } from '../../../packages/core/src/extractor-conformance.js';
import { EXTRACTOR_MEDIA_TYPES } from '../../../packages/core/src/extractor.js';
import { createOOXMLExtractor } from '../src/index.js';
import { docx, xlsx, pptx, zip, HANG, stallWorkerURL, observeParsers } from '../../../test/extractor-fixtures.js';

function workbook(sheet, strings = '<si><t>First</t></si>') {
  return zip({
    'xl/workbook.xml': '<workbook><sheet name="Sheet" r:id="one"/></workbook>',
    'xl/_rels/workbook.xml.rels': '<Relationships><Relationship Id="one" Target="worksheets/sheet.xml"/></Relationships>',
    'xl/sharedStrings.xml': `<sst>${strings}</sst>`,
    'xl/worksheets/sheet.xml': `<worksheet><sheetData>${sheet}</sheetData></worksheet>`,
  });
}
test('styled blank cells and self-closing rows retain subsequent cell positions', async () => {
  const plugin = createOOXMLExtractor();
  const data = workbook('<row r="1"><c r="A1" t="s"><v>0</v></c><c r="B1" s="1"/></row>' +
    '<row r="2" customHeight="1"/><row r="3"><c r="A3"/><c r="B3"><v>42</v></c><c r="C3" s="1"/></row><row r="4"/>');
  const result = await plugin.extract(data);
  assert.equal(result.status, 'accepted');
  assert.equal(result.text, '## Sheet\nFirst\n\n\t42');
});
test('self-closing shared strings and text runs are empty without consuming later text', async () => {
  const plugin = createOOXMLExtractor();
  const sheet = await plugin.extract(workbook('<row><c t="s"><v>0</v></c><c t="s"><v>1</v></c>' +
    '<c t="inlineStr"><is><t/><t>Inline</t><t /></is></c></row>', '<si/><si><t>Second</t></si><si />'));
  assert.equal(sheet.text, '## Sheet\n\tSecond\tInline');
  const word = await plugin.extract(zip({ 'word/document.xml': '<w:document><w:p><w:t/><w:t>Word</w:t>' +
    '<w:t xml:space="preserve"/><w:t /></w:p></w:document>' }));
  assert.equal(word.text, 'Word');
  const slides = await plugin.extract(zip({
    'ppt/presentation.xml': '<p:presentation><p:sldId r:id="one"/></p:presentation>',
    'ppt/_rels/presentation.xml.rels': '<Relationships><Relationship Id="one" Target="slides/slide1.xml"/></Relationships>',
    'ppt/slides/slide1.xml': '<p:sld><a:p/><a:p><a:t/><a:t>Slide</a:t><a:t /></a:p><a:p /></p:sld>',
  }));
  assert.equal(slides.text, 'Slide');
});
test('duplicate worksheet targets are scanned once and preserve the first label', async () => {
  const plugin = createOOXMLExtractor();
  const result = await plugin.extract(zip({
    'xl/workbook.xml': '<workbook><sheet name="First" r:id="one"/><sheet name="Alias" r:id="two"/></workbook>',
    'xl/_rels/workbook.xml.rels': '<Relationships><Relationship Id="one" Target="worksheets/sheet.xml"/>' +
      '<Relationship Id="two" Target="/xl/worksheets/sheet.xml"/></Relationships>',
    'xl/worksheets/sheet.xml': '<worksheet><row><c><v>42</v></c></row></worksheet>',
  }), {}, { limits: { maxPages: 1 } });
  assert.equal(result.status, 'accepted');
  assert.deepEqual(result.segments, [{ id: 'segment:1', page: 1, text: '## First\n42' }]);
});

for (const [kind, fixture] of [['docx', docx], ['xlsx', xlsx], ['pptx', text => pptx([text])]]) {
  test(`${kind.toUpperCase()} passes extractor conformance with active process cancellation and deadlines`, async t => {
    const observed = observeParsers(t);
    const result = await extractorConformance(createOOXMLExtractor({ workerURL: stallWorkerURL }), {
      bytes: fixture('Readable Office extraction fixture source words'), mediaType: EXTRACTOR_MEDIA_TYPES[kind], expectedText: 'source words',
    }, { ...observed, stallBytes: fixture(HANG), unreadableBytes: zip({ 'word/document.xml': '<w:document><w:t>unterminated' }),
      archiveBombBytes: zip({ 'word/document.xml': '<w:document>' + 'A'.repeat(200_000) + '</w:document>' }, { compress: true }),
      ...(kind === 'pptx' ? { pageBytes: pptx(['First slide', 'Second slide']) } :
        { pageBytes: xlsx(['First sheet', 'Second sheet']) }) });
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
