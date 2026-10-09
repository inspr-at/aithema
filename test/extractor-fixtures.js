import { deflateRawSync, deflateSync, crc32 } from 'node:zlib';
import childProcess from 'node:child_process';
import { syncBuiltinESMExports } from 'node:module';
import { activeExtractorProcessCount, extractorNetworkAttemptCount } from '../packages/core/src/extractor-process.js';
export const bytes = text => Buffer.from(text, 'utf8');
export const HANG = 'AIT-100-HANG';
export const stallWorkerURL = new URL('./fixtures/extractor-stall-child.js', import.meta.url);

// Small valid PDF with actual xref offsets. More pages exercise citation/page caps.
export function pdf(pages = ['A tiny valid PDF containing document extraction fixture text.'], { stream } = {}) {
  const objects = ['<< /Type /Catalog /Pages 2 0 R >>', '', '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>'];
  const pageRefs = [];
  for (const text of pages) {
    const pageId = objects.length + 1, contentId = pageId + 1;
    pageRefs.push(`${pageId} 0 R`);
    const escaped = text.replace(/([\\()])/gu, '\\$1');
    const content = stream ?? bytes(`BT /F1 12 Tf 20 100 Td (${escaped}) Tj ET`);
    objects.push(`<< /Type /Page /Parent 2 0 R /MediaBox [0 0 600 200] /Resources << /Font << /F1 3 0 R >> >> /Contents ${contentId} 0 R >>`,
      Buffer.concat([bytes(`<< /Length ${content.length}${stream ? ' /Filter [/FlateDecode /FlateDecode]' : ''} >>\nstream\n`), content, bytes('\nendstream')]));
  }
  objects[1] = `<< /Type /Pages /Kids [${pageRefs.join(' ')}] /Count ${pages.length} >>`;
  let out = bytes('%PDF-1.4\n');
  const offsets = [0];
  objects.forEach((object, index) => { offsets.push(out.length); out = Buffer.concat([out, bytes(`${index + 1} 0 obj\n`),
    typeof object === 'string' ? bytes(object) : object, bytes('\nendobj\n')]); });
  const xref = out.length;
  return Buffer.concat([out, bytes(`xref\n0 ${objects.length + 1}\n0000000000 65535 f \n` +
    offsets.slice(1).map(offset => `${String(offset).padStart(10, '0')} 00000 n \n`).join('') +
    `trailer\n<< /Size ${objects.length + 1} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`)]);
}
// Fixed 32 MiB expansion, even if the watchdog regresses; only hundreds of bytes on disk.
export const pdfStreamBomb = () => pdf([''], { stream: deflateSync(deflateSync(Buffer.alloc(32 * 1024 * 1024, 32))) });
export function zip(parts, { compress = false } = {}) {
  const local = [], central = [];
  let offset = 0;
  for (const [filename, content] of Object.entries(parts)) {
    const name = bytes(filename), data = typeof content === 'string' ? bytes(content) : content;
    const encoded = compress ? deflateRawSync(data) : data, crc = crc32(data), method = compress ? 8 : 0;
    const header = Buffer.alloc(30);
    header.writeUInt32LE(0x04034b50); header.writeUInt16LE(20, 4); header.writeUInt16LE(method, 8);
    header.writeUInt32LE(crc, 14); header.writeUInt32LE(encoded.length, 18); header.writeUInt32LE(data.length, 22);
    header.writeUInt16LE(name.length, 26);
    local.push(header, name, encoded);
    const entry = Buffer.alloc(46);
    entry.writeUInt32LE(0x02014b50); entry.writeUInt16LE(20, 4); entry.writeUInt16LE(20, 6);
    entry.writeUInt16LE(method, 10); entry.writeUInt32LE(crc, 16);
    entry.writeUInt32LE(encoded.length, 20); entry.writeUInt32LE(data.length, 24); entry.writeUInt16LE(name.length, 28);
    entry.writeUInt32LE(offset, 42); central.push(entry, name);
    offset += header.length + name.length + encoded.length;
  }
  const directory = Buffer.concat(central), end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50); end.writeUInt16LE(central.length / 2, 8); end.writeUInt16LE(central.length / 2, 10);
  end.writeUInt32LE(directory.length, 12); end.writeUInt32LE(offset, 16);
  return Buffer.concat([...local, directory, end]);
}
const xml = body => `<?xml version="1.0" encoding="UTF-8"?>${body}`;
const office = (main, type, parts) => zip({
  '[Content_Types].xml': xml(`<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Override PartName="/${main}" ContentType="application/vnd.openxmlformats-officedocument.${type}.main+xml"/></Types>`),
  '_rels/.rels': xml(`<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="${main}"/></Relationships>`), ...parts });
export function docx(text = 'Document extraction fixture &amp; readable words.') {
  return office('word/document.xml', 'wordprocessingml.document', {
    'word/document.xml': xml(`<w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:body><w:p><w:r><w:t>${text}</w:t></w:r></w:p></w:body></w:document>`) });
}
export function xlsx(text = 'Spreadsheet extraction fixture') {
  const texts = Array.isArray(text) ? text : [text];
  return office('xl/workbook.xml', 'spreadsheetml.sheet', {
    'xl/workbook.xml': xml(`<workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"><sheets>${texts.map((_, index) => `<sheet name="${index === 0 ? 'First &amp; last' : 'Next'}" sheetId="${index + 1}" r:id="rId${index + 1}"/>`).join('')}</sheets></workbook>`),
    'xl/_rels/workbook.xml.rels': xml(`<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">${texts.map((_, index) => `<Relationship Id="rId${index + 1}" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet${index + 1}.xml"/>`).join('')}</Relationships>`),
    'xl/sharedStrings.xml': xml(`<sst xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main">${texts.map(value => `<si><t>${value}</t></si>`).join('')}</sst>`),
    ...Object.fromEntries(texts.map((_, index) => [`xl/worksheets/sheet${index + 1}.xml`, xml(`<worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"><sheetData><row r="1"><c r="A1" t="s"><v>${index}</v></c><c r="B1"><v>42</v></c><c r="C1" t="inlineStr"><is><t>Inline text</t></is></c></row></sheetData></worksheet>`)])) });
}
export function pptx(texts = ['Presentation extraction fixture']) {
  return office('ppt/presentation.xml', 'presentationml.presentation', {
    'ppt/presentation.xml': xml(`<p:presentation xmlns:p="http://schemas.openxmlformats.org/presentationml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"><p:sldIdLst>${texts.map((_, index) => `<p:sldId id="${256 + index}" r:id="rId${index + 1}"/>`).join('')}</p:sldIdLst></p:presentation>`),
    'ppt/_rels/presentation.xml.rels': xml(`<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">${texts.map((_, index) => `<Relationship Id="rId${index + 1}" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/slide" Target="slides/slide${index + 1}.xml"/>`).join('')}</Relationships>`),
    ...Object.fromEntries(texts.map((text, index) => [`ppt/slides/slide${index + 1}.xml`, xml(`<p:sld xmlns:p="http://schemas.openxmlformats.org/presentationml/2006/main" xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main"><p:cSld><p:spTree><p:sp><p:txBody><a:bodyPr/><a:lstStyle/><a:p><a:r><a:t>${text}</a:t></a:r></a:p></p:txBody></p:sp></p:spTree></p:cSld></p:sld>`)])) });
}
export function observeParsers(t) {
  const original = childProcess.fork, children = [];
  let notify;
  t.mock.method(childProcess, 'fork', (...args) => {
    const child = original(...args);
    const closed = new Promise(resolve => child.once('close', (code, signal) => resolve({ code, signal })));
    const record = { child, args, closed, started: new Promise(resolve => {
      child.on('message', message => { if (message?.type === 'started') resolve(true); });
      child.once('close', () => resolve(false));
    }) };
    children.push(record); notify?.(record); notify = undefined;
    return child;
  });
  syncBuiltinESMExports();
  t.after(() => { t.mock.restoreAll(); syncBuiltinESMExports(); });
  return { children, spawned: () => new Promise(resolve => { notify = resolve; }),
    workCount: () => children.length, activeCount: activeExtractorProcessCount,
    requestCount: extractorNetworkAttemptCount,
    waitForWork: async (before, { signal } = {}) => {
      while (children.length <= before && !signal?.aborted) await new Promise(resolve => setTimeout(resolve, 1));
      if (signal?.aborted) return;
      await Promise.race([children[before].started, new Promise(resolve => {
        if (signal?.aborted) { resolve(); return; }
        signal?.addEventListener('abort', resolve, { once: true });
      })]);
    },
    killedCount: () => children.filter(({ child }) => child.signalCode === 'SIGKILL').length };
}
