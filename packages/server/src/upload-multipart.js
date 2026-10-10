const crlf = Buffer.from('\r\n'), dash = Buffer.from('--'), headerEnd = Buffer.from('\r\n\r\n');
const MAX_HEADER_BYTES = 8 * 1024;

// Scan bytes before handing any headers to the native multipart parser. Only
// bounded headers enter formData(); file payloads remain views of the one body.
export function scanUploadMultipart(input, contentType, maxFiles) {
  const match = /^multipart\/form-data\s*;\s*boundary=(?:"([^"]+)"|([^;\s]+))\s*$/iu.exec(contentType);
  const boundary = match?.[1] ?? match?.[2];
  if (!boundary || !/^[0-9A-Za-z'()+_,\-./:=? ]{1,70}$/u.test(boundary) || boundary.endsWith(' ')) throw new TypeError('Invalid multipart boundary');
  const bytes = Buffer.from(input.buffer, input.byteOffset, input.byteLength);
  const marker = Buffer.from(`--${boundary}`), delimiter = Buffer.from(`\r\n--${boundary}`), parts = [];
  if (!bytes.subarray(0, marker.length).equals(marker)) throw new TypeError('Invalid multipart start');
  let offset = marker.length;
  while (true) {
    if (bytes.subarray(offset, offset + 2).equals(dash)) {
      const tail = bytes.subarray(offset + 2);
      if (tail.length && !tail.equals(crlf)) throw new TypeError('Invalid multipart end');
      break;
    }
    if (!bytes.subarray(offset, offset + 2).equals(crlf)) throw new TypeError('Invalid multipart delimiter');
    // Two scalar fields plus the configured files; the closing delimiter is
    // the third extra delimiter. Stop before decoding or parsing any headers.
    if (parts.length >= maxFiles + 2) throw new RangeError('Multipart part limit');
    const start = offset + 2;
    const headerLength = bytes.subarray(start, start + MAX_HEADER_BYTES + headerEnd.length).indexOf(headerEnd);
    if (headerLength < 0) {
      if (bytes.length - start > MAX_HEADER_BYTES) throw new RangeError('Multipart header limit');
      throw new TypeError('Invalid multipart headers');
    }
    if (headerLength > MAX_HEADER_BYTES) throw new RangeError('Multipart header limit');
    const bodyStart = start + headerLength + headerEnd.length;
    let end = bytes.indexOf(delimiter, bodyStart);
    while (end >= 0) {
      const suffix = bytes.subarray(end + delimiter.length, end + delimiter.length + 2);
      if (suffix.equals(crlf) || suffix.equals(dash)) break;
      end = bytes.indexOf(delimiter, end + delimiter.length);
    }
    if (end < 0) throw new TypeError('Missing multipart end');
    parts.push({ headers: bytes.subarray(start, bodyStart), bytes: bytes.subarray(bodyStart, end) });
    offset = end + delimiter.length;
  }
  // Transport encodings would change the bytes behind the receipt. Browser
  // multipart uploads use literal bytes; refuse encoded parts instead.
  if (parts.some(p => /^content-transfer-encoding\s*:/imu.test(p.headers.toString('utf8')))) throw new TypeError('Encoded multipart part');
  const metadata = Buffer.concat([...parts.flatMap(p => [marker, crlf, p.headers, crlf]), Buffer.from(`--${boundary}--\r\n`)]);
  return { parts, metadata };
}
