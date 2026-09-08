/**
 * Server-side extraction and upload ceilings. Browser hints are not the boundary.
 * Pattern port of START extract/upload caps (page/output/deadline and request
 * bytes) without agency quotas, billing, or customer session store.
 */

export const MAX_CHARS_PER_FILE = 60_000;
export const MAX_PDF_PAGES = 100;
export const PDF_EXTRACTION_DEADLINE_MS = 10_000;
export const EXTRACTION_REQUEST_BUDGET_MS = 25_000;
export const MAX_PDF_IMAGE_PIXELS = 16_777_216;
export const MAX_UPLOAD_REQUEST_BYTES = 8 * 1024 * 1024;
export const MAX_FILE_BYTES = 2 * 1024 * 1024;
export const MAX_FILES_PER_REQUEST = 4;
export const MAX_DOCUMENTS_PER_PROJECT = 8;
export const MAX_CONCURRENT_PDF_PARSERS = 1;
export const PROVIDER_DOCUMENT_CHARS = 16_000;
export const SCANNED_TEXT_THRESHOLD = 20;

export const EXTRACTION_REASONS = Object.freeze([
  'ok',
  'unsupported',
  'empty',
  'scanned',
  'encrypted',
  'malformed',
  'failed',
  'cancelled',
  'too_large',
  'too_many',
]);

export const ACCEPTED_MEDIA_TYPES = Object.freeze([
  'application/pdf',
  'application/json',
  'text/plain',
  'text/csv',
  'text/xml',
  'application/xml',
]);

/**
 * @param {unknown} value
 */
export function normalizeUploadLimits(value) {
  const source = value && typeof value === 'object' && !Array.isArray(value) ? value : {};
  const maxUploadRequestBytes = bound(source.maxUploadRequestBytes, MAX_UPLOAD_REQUEST_BYTES, MAX_UPLOAD_REQUEST_BYTES);
  const maxFileBytes = bound(source.maxFileBytes, MAX_FILE_BYTES, MAX_FILE_BYTES);
  const maxFilesPerRequest = bound(source.maxFilesPerRequest, MAX_FILES_PER_REQUEST, MAX_FILES_PER_REQUEST);
  const maxDocumentsPerProject = bound(source.maxDocumentsPerProject, MAX_DOCUMENTS_PER_PROJECT, MAX_DOCUMENTS_PER_PROJECT);
  const maxPdfPages = bound(source.maxPdfPages, MAX_PDF_PAGES, MAX_PDF_PAGES);
  return Object.freeze({
    maxUploadRequestBytes,
    maxFileBytes,
    maxFilesPerRequest,
    maxDocumentsPerProject,
    maxPdfPages,
    maxCharsPerFile: MAX_CHARS_PER_FILE,
    pdfDeadlineMs: PDF_EXTRACTION_DEADLINE_MS,
    requestBudgetMs: EXTRACTION_REQUEST_BUDGET_MS,
    maxConcurrentPdfParsers: MAX_CONCURRENT_PDF_PARSERS,
    providerDocumentChars: PROVIDER_DOCUMENT_CHARS,
  });
}

/**
 * @param {unknown} value
 * @param {number} fallback
 * @param {number} ceiling
 */
function bound(value, fallback, ceiling) {
  if (value == null || value === '') return fallback;
  const numeric = Number(value);
  if (!Number.isFinite(numeric) || numeric <= 0) {
    throw new Error('upload limit must be a positive number');
  }
  return Math.min(Math.floor(numeric), ceiling);
}

/**
 * @param {string} mimeType
 */
export function canonicalMediaType(mimeType) {
  return String(mimeType ?? '').split(';')[0]?.trim().toLowerCase() || 'application/octet-stream';
}

/**
 * @param {string} mimeType
 */
export function isAcceptedMediaType(mimeType) {
  const type = canonicalMediaType(mimeType);
  return ACCEPTED_MEDIA_TYPES.includes(type);
}

/**
 * @param {string} filename
 * @param {string} mimeType
 */
export function mediaTypeFromFilename(filename, mimeType) {
  const declared = canonicalMediaType(mimeType);
  if (isAcceptedMediaType(declared) && declared !== 'application/octet-stream') return declared;
  const name = String(filename || '').toLowerCase();
  if (name.endsWith('.pdf')) return 'application/pdf';
  if (name.endsWith('.json')) return 'application/json';
  if (name.endsWith('.csv')) return 'text/csv';
  if (name.endsWith('.xml')) return 'application/xml';
  if (name.endsWith('.txt')) return 'text/plain';
  return declared;
}
