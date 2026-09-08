/**
 * In-process PDF text extraction used only inside the dedicated parser child.
 * The parent kills this process on cancel; a Promise.race deadline is not enough.
 */

import { extractText, getDocumentProxy } from 'unpdf';

import {
  MAX_CHARS_PER_FILE,
  MAX_PDF_IMAGE_PIXELS,
  MAX_PDF_PAGES,
  PDF_EXTRACTION_DEADLINE_MS,
  SCANNED_TEXT_THRESHOLD,
} from '../lib/extract-limits.js';

if (typeof Math.sumPrecise !== 'function') {
  Math.sumPrecise = (values) => {
    let total = 0;
    for (const value of values) total += Number(value);
    return total;
  };
}

function clamp(value) {
  const normalised = value.replace(/\r\n/g, '\n').replace(/\n{4,}/g, '\n\n\n').trim();
  return normalised.length > MAX_CHARS_PER_FILE
    ? { text: normalised.slice(0, MAX_CHARS_PER_FILE), truncated: true }
    : { text: normalised, truncated: false };
}

function allowance(deadlineAt, milliseconds) {
  const remaining = (deadlineAt ?? Number.POSITIVE_INFINITY) - Date.now();
  return Math.min(milliseconds, Math.max(0, remaining));
}

function withDeadline(operation, milliseconds) {
  let timer;
  return Promise.race([
    operation,
    new Promise((_, reject) => {
      timer = setTimeout(() => reject(new Error('extraction deadline exceeded')), milliseconds);
    }),
  ]).finally(() => {
    if (timer !== undefined) clearTimeout(timer);
  });
}

async function destroyDocument(document) {
  try {
    const task = document?.loadingTask;
    await task?.destroy?.();
  } catch {
    // Already gone is the state this wanted.
  }
}

function looksLikePdf(bytes) {
  const head = Buffer.from(bytes.subarray(0, 16)).toString('latin1');
  return head.includes('%PDF');
}

function classifyPdfError(error) {
  const name = error instanceof Error ? error.name : '';
  const message = error instanceof Error ? error.message : String(error);
  if (/password|encrypt/i.test(name) || /password|encrypt/i.test(message)) return 'encrypted';
  if (/deadline/i.test(message)) return 'failed';
  if (/page count/i.test(message)) return 'failed';
  return 'malformed';
}

export async function extractPdfInProcess(bytes, options = {}) {
  const deadlineAt = options.deadlineAt ?? Date.now() + PDF_EXTRACTION_DEADLINE_MS;
  const maxPages = Number.isInteger(options.maxPdfPages) ? options.maxPdfPages : MAX_PDF_PAGES;
  if (allowance(deadlineAt, 1) === 0) {
    return { text: null, reason: 'failed', truncated: false };
  }
  if (!looksLikePdf(bytes)) {
    return { text: null, reason: 'malformed', truncated: false };
  }

  let document;
  try {
    document = await withDeadline(
      getDocumentProxy(bytes, { maxImageSize: MAX_PDF_IMAGE_PIXELS }),
      allowance(deadlineAt, PDF_EXTRACTION_DEADLINE_MS),
    );
    if (!Number.isSafeInteger(document.numPages) || document.numPages < 1 || document.numPages > maxPages) {
      return { text: null, reason: 'failed', truncated: false };
    }
    const { text: pages } = await withDeadline(
      extractText(document, { mergePages: true }),
      allowance(deadlineAt, PDF_EXTRACTION_DEADLINE_MS),
    );
    const merged = Array.isArray(pages) ? pages.join('\n\n') : pages;
    const { text, truncated } = clamp(merged ?? '');
    if (!text) return { text: null, reason: 'empty', truncated: false };
    if (text.length <= SCANNED_TEXT_THRESHOLD) {
      return { text: null, reason: 'scanned', truncated: false };
    }
    return { text, reason: 'ok', truncated };
  } catch (error) {
    return { text: null, reason: classifyPdfError(error), truncated: false };
  } finally {
    if (document) await destroyDocument(document);
  }
}

process.on('message', async (message) => {
  if (!message || message.type !== 'extract') return;
  try {
    const bytes = Buffer.from(message.bytes, 'base64');
    const result = await extractPdfInProcess(bytes, {
      deadlineAt: message.deadlineAt,
      maxPdfPages: message.maxPdfPages,
    });
    process.send?.({ type: 'result', result });
  } catch (error) {
    process.send?.({
      type: 'result',
      result: { text: null, reason: classifyPdfError(error), truncated: false },
    });
  }
});
