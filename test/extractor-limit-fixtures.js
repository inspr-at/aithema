// Generated in memory on the test runner; no source documents are retained.
import { deflateRawSync, crc32 } from 'node:zlib';

export const MiB = 1024 * 1024;
const bytes = value => Buffer.from(value);
const repeat = (value, length) => bytes(value.repeat(Math.ceil(length / value.length)).slice(0, length));
const sentence = 'Document extraction fixture contains readable requirements and source words. ';

function zip(entries) {
  const local = [], directory = [];
  let offset = 0;
  for (const [filename, data, compress = false] of entries) {
    const name = bytes(filename), encoded = compress ? deflateRawSync(data) : data;
    const header = Buffer.alloc(30), central = Buffer.alloc(46), crc = crc32(data);
    header.writeUInt32LE(0x04034b50); header.writeUInt16LE(20, 4); header.writeUInt16LE(compress ? 8 : 0, 8);
    header.writeUInt32LE(crc, 14); header.writeUInt32LE(encoded.length, 18); header.writeUInt32LE(data.length, 22);
    header.writeUInt16LE(name.length, 26);
    central.writeUInt32LE(0x02014b50); central.writeUInt16LE(20, 4); central.writeUInt16LE(20, 6);
    central.writeUInt16LE(compress ? 8 : 0, 10); central.writeUInt32LE(crc, 16);
    central.writeUInt32LE(encoded.length, 20); central.writeUInt32LE(data.length, 24);
    central.writeUInt16LE(name.length, 28); central.writeUInt32LE(offset, 42);
    local.push(header, name, encoded); directory.push(central, name);
    offset += header.length + name.length + encoded.length;
  }
  const end = Buffer.alloc(22), central = Buffer.concat(directory);
  end.writeUInt32LE(0x06054b50); end.writeUInt16LE(entries.length, 8); end.writeUInt16LE(entries.length, 10);
  end.writeUInt32LE(central.length, 12); end.writeUInt32LE(offset, 16);
  return Buffer.concat([...local, central, end]);
}

function officeEntries() {
  return [
    ['[Content_Types].xml', bytes('<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="xml" ContentType="application/xml"/><Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/></Types>')],
    ['_rels/.rels', bytes('<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="word/document.xml"/></Relationships>')],
  ];
}

function docx(size, bomb = false) {
  const entries = officeEntries();
  const main = text => bytes(`<w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:body><w:p><w:r><w:t>${text}</w:t></w:r></w:p></w:body></w:document>`);
  if (bomb) {
    // Finite 1 MiB expansion, >100:1. Stored media brings the archive to the
    // candidate ceiling, so rejection cannot be mistaken for input-size refusal.
    entries.push(['word/document.xml', main('A'.repeat(MiB)), true]);
  } else {
    // Stored (valid ZIP method 0) XML measures the full input as decoded text.
    // Split at 8 MiB to stay below the independent 16 MiB per-part ceiling.
    let remaining = size - zip(entries).length - 2048;
    for (const [name, open, close] of [
      ['word/document.xml', '<w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:body>', '</w:body></w:document>'],
      ['word/header1.xml', '<w:hdr xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main">', '</w:hdr>'],
      ['word/footer1.xml', '<w:ftr xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main">', '</w:ftr>'],
    ]) {
      const length = Math.min(8 * MiB, remaining);
      if (length <= 0) break;
      entries.push([name, Buffer.concat([bytes(open + '<w:p><w:r><w:t>'), repeat(sentence, length), bytes('</w:t></w:r></w:p>' + close)])]);
      remaining -= length;
    }
  }
  const mediaName = 'word/media/padding.bin';
  const overhead = zip([...entries, [mediaName, Buffer.alloc(0)]]).length;
  // For the bomb keep every stored media part below maxPartBytes as well.
  if (size - overhead > 16 * MiB) {
    entries.push(['word/media/image1.bin', Buffer.alloc(8 * MiB, 127)]);
  }
  const finalOverhead = zip([...entries, [mediaName, Buffer.alloc(0)]]).length;
  return zip([...entries, [mediaName, Buffer.alloc(size - finalOverhead, 127)]]);
}

function assemblePDF(objects) {
  const chunks = [bytes('%PDF-1.4\n')], offsets = [0];
  let length = chunks[0].length;
  for (const [index, object] of objects.entries()) {
    offsets.push(length);
    const chunk = Buffer.concat([bytes(`${index + 1} 0 obj\n`), typeof object === 'string' ? bytes(object) : object, bytes('\nendobj\n')]);
    chunks.push(chunk); length += chunk.length;
  }
  const xref = length;
  chunks.push(bytes(`xref\n0 ${objects.length + 1}\n0000000000 65535 f \n` + offsets.slice(1)
    .map(offset => `${String(offset).padStart(10, '0')} 00000 n \n`).join('') +
    `trailer\n<< /Size ${objects.length + 1} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`));
  return Buffer.concat(chunks);
}
const stream = (data, attributes = '') => Buffer.concat([bytes(`<< /Length ${data.length} ${attributes}>>\nstream\n`), data, bytes('\nendstream')]);

function normalPDF(size, imageHeavy) {
  const pages = imageHeavy ? 20 : 100;
  const make = payload => {
    const objects = ['<< /Type /Catalog /Pages 2 0 R >>', '', '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>'];
    const refs = [];
    for (let page = 0; page < pages; page++) {
      const id = objects.length + 1, length = Math.floor(payload / pages) + (page < payload % pages ? 1 : 0);
      refs.push(`${id} 0 R`);
      objects.push(`<< /Type /Page /Parent 2 0 R /MediaBox [0 0 600 800] /Resources << /Font << /F1 3 0 R >>${imageHeavy ? ` /XObject << /Im ${id + 2} 0 R >>` : ''} >> /Contents ${id + 1} 0 R >>`);
      if (imageHeavy) {
        const imageLength = Math.floor(length / 512) * 512;
        const caption = `BT /F1 12 Tf 20 750 Td (Document extraction fixture image page ${page + 1}) Tj ET\nq 512 0 0 600 0 0 cm /Im Do Q\n`;
        objects.push(stream(Buffer.concat([bytes(caption), Buffer.alloc(length - imageLength, 32)])),
          stream(Buffer.alloc(imageLength, 127), `/Type /XObject /Subtype /Image /Width 512 /Height ${imageLength / 512} /ColorSpace /DeviceGray /BitsPerComponent 8 `));
      } else {
        const command = `(${sentence}) Tj T*\n`;
        const content = command.repeat(Math.floor(length / command.length));
        objects.push(stream(bytes('BT /F1 8 Tf 0.2 TL 20 750 Td\n' + content + ' '.repeat(length - content.length) + '\nET')));
      }
    }
    objects[1] = `<< /Type /Pages /Kids [${refs.join(' ')}] /Count ${pages} >>`;
    return assemblePDF(objects);
  };
  let payload = size - 100_000;
  for (let attempt = 0; attempt < 5; attempt++) {
    const data = make(payload);
    if (data.length === size) return data;
    payload += size - data.length;
  }
  throw new Error('PDF fixture size did not converge');
}

function manyObjectsPDF(size) {
  // Every empty content stream is referenced. This forces PDF.js to resolve
  // hundreds of thousands of objects rather than ignore unreferenced filler.
  const count = Math.floor(size / 110);
  const objects = ['<< /Type /Catalog /Pages 2 0 R >>', '<< /Type /Pages /Kids [3 0 R] /Count 1 >>',
    `<< /Type /Page /Parent 2 0 R /MediaBox [0 0 600 800] /Contents [${Array.from({ length: count }, (_, i) => `${i + 4} 0 R`).join(' ')}] >>`,
    ...Array.from({ length: count }, () => stream(Buffer.alloc(0)))];
  // Padding is a comment in a referenced stream, not bytes after %%EOF.
  const base = assemblePDF(objects);
  let padding = size - base.length;
  for (let attempt = 0; attempt < 5; attempt++) {
    objects[3] = stream(bytes('%' + ' '.repeat(padding - 2) + '\n'));
    const data = assemblePDF(objects);
    if (data.length === size) return data;
    padding += size - data.length;
  }
  throw new Error('Object PDF fixture size did not converge');
}

export function extractorLimitFixture(format, size) {
  if (format === 'text') return repeat(sentence, size);
  if (format === 'text-pdf') return normalPDF(size, false);
  if (format === 'image-pdf') return normalPDF(size, true);
  if (format === 'docx') return docx(size);
  if (format === 'ooxml-bomb') return docx(size, true);
  if (format === 'many-objects-pdf') return manyObjectsPDF(size);
  throw new TypeError('Unknown fixture format');
}
