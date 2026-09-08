/**
 * HTML/header escaping for untrusted user and model strings.
 * Export filenames and printable documents treat input as text, never markup.
 */

export function escapeHtml(value) {
  return String(value)
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#39;');
}

/**
 * ASCII filename plus RFC 5987 filename* so Content-Disposition cannot
 * smuggle CR/LF or quotes from baseline_ref / user text.
 * @param {string} filename
 */
export function contentDispositionAttachment(filename) {
  const raw = String(filename || 'download').replace(/[\r\n\0]/g, '');
  const ascii = raw.replace(/[^\x20-\x7E]/g, '_').replace(/["\\]/g, '_') || 'download';
  const encoded = encodeURIComponent(raw).replace(/['()]/g, (ch) => `%${ch.charCodeAt(0).toString(16).toUpperCase()}`);
  return `attachment; filename="${ascii}"; filename*=UTF-8''${encoded}`;
}

/**
 * @param {string} baselineRef
 * @param {number} revision
 * @param {string} ext
 */
export function reviewedExportFilename(baselineRef, revision, ext) {
  const safeRef = String(baselineRef).replace(/[^A-Za-z0-9._-]+/g, '_').slice(0, 80) || 'baseline';
  const safeRev = Number.isInteger(revision) ? String(revision) : '0';
  const safeExt = String(ext).replace(/[^A-Za-z0-9]+/g, '') || 'bin';
  return `aithema-${safeRef}-r${safeRev}.${safeExt}`;
}

/**
 * Printable PDF text: keep newlines/tabs; drop other controls so user bytes
 * cannot be confused with PDF operators.
 * @param {unknown} value
 */
export function printablePdfText(value) {
  return String(value ?? '').replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/g, '');
}
