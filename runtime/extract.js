/**
 * Bounded document extraction. Text/CSV/JSON/XML are decoded in-process as
 * untrusted text (no URL fetch, no XML entity expansion). PDF parsing runs in
 * a child process that is SIGKILL'd on cancel — stopping the waiter is not enough.
 */

import { fork } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { randomUUID } from 'node:crypto';

import {
  canonicalMediaType,
  EXTRACTION_REQUEST_BUDGET_MS,
  isAcceptedMediaType,
  MAX_CHARS_PER_FILE,
  MAX_CONCURRENT_PDF_PARSERS,
  MAX_PDF_PAGES,
  mediaTypeFromFilename,
  PDF_EXTRACTION_DEADLINE_MS,
} from '../lib/extract-limits.js';
import { isOwnFormatHandover } from '../lib/intake.js';

const CHILD_PATH = fileURLToPath(new URL('./pdf-extract-child.js', import.meta.url));

/** @type {Set<import('node:child_process').ChildProcess>} */
const liveParsers = new Set();
let activePdf = 0;
/** @type {Array<() => void>} */
const pdfWaiters = [];

export function activePdfParserCount() {
  return liveParsers.size;
}

function abortError() {
  const error = new Error('extraction cancelled');
  error.name = 'AbortError';
  error.code = 'cancelled';
  return error;
}

function acquirePdfSlot(signal) {
  if (signal?.aborted) return Promise.reject(abortError());
  if (activePdf < MAX_CONCURRENT_PDF_PARSERS) {
    activePdf += 1;
    return Promise.resolve();
  }
  return new Promise((resolve, reject) => {
    const waiter = () => {
      signal?.removeEventListener('abort', onAbort);
      if (signal?.aborted) {
        reject(abortError());
        return;
      }
      activePdf += 1;
      resolve();
    };
    const onAbort = () => {
      const index = pdfWaiters.indexOf(waiter);
      if (index >= 0) pdfWaiters.splice(index, 1);
      reject(abortError());
    };
    pdfWaiters.push(waiter);
    if (signal) signal.addEventListener('abort', onAbort, { once: true });
  });
}

function releasePdfSlot() {
  activePdf = Math.max(0, activePdf - 1);
  const next = pdfWaiters.shift();
  if (next) next();
}

function clampText(value) {
  const normalised = String(value ?? '').replace(/\r\n/g, '\n').replace(/\n{4,}/g, '\n\n\n').trim();
  return normalised.length > MAX_CHARS_PER_FILE
    ? { text: normalised.slice(0, MAX_CHARS_PER_FILE), truncated: true }
    : { text: normalised, truncated: false };
}

function decodeUtf8(bytes) {
  return new TextDecoder('utf-8', { fatal: false }).decode(bytes);
}

/**
 * @param {Uint8Array | Buffer} bytes
 * @param {string} mimeType
 * @param {{ deadlineAt?: number, maxPdfPages?: number, signal?: AbortSignal, filename?: string }} [options]
 */
export async function extractDocument(bytes, mimeType, options = {}) {
  const type = mediaTypeFromFilename(options.filename, mimeType);
  if (options.signal?.aborted) {
    return { text: null, reason: 'cancelled', truncated: false, media_type: type, own_format: false };
  }
  if (!isAcceptedMediaType(type)) {
    return { text: null, reason: 'unsupported', truncated: false, media_type: type, own_format: false };
  }

  if (type === 'application/pdf') {
    const pdf = await extractPdfInChild(bytes, options);
    return { ...pdf, media_type: type, own_format: false };
  }

  const decoded = decodeUtf8(bytes);
  if (type === 'application/json') {
    let parsed;
    try {
      parsed = JSON.parse(decoded);
    } catch {
      const { text, truncated } = clampText(decoded);
      return text
        ? { text, reason: 'ok', truncated, media_type: type, own_format: false, uncertainty: 'json_parse_failed' }
        : { text: null, reason: 'malformed', truncated: false, media_type: type, own_format: false };
    }
    if (isOwnFormatHandover(parsed)) {
      const { text, truncated } = clampText(decoded);
      return {
        text,
        reason: 'ok',
        truncated,
        media_type: type,
        own_format: true,
        parsed,
      };
    }
    const { text, truncated } = clampText(decoded);
    return text
      ? { text, reason: 'ok', truncated, media_type: type, own_format: false }
      : { text: null, reason: 'empty', truncated: false, media_type: type, own_format: false };
  }

  const { text, truncated } = clampText(decoded);
  return text
    ? { text, reason: 'ok', truncated, media_type: type, own_format: false }
    : { text: null, reason: 'empty', truncated: false, media_type: type, own_format: false };
}

/**
 * @param {Uint8Array | Buffer} bytes
 * @param {{ deadlineAt?: number, maxPdfPages?: number, signal?: AbortSignal }} options
 */
export async function extractPdfInChild(bytes, options = {}) {
  await acquirePdfSlot(options.signal);
  let child;
  try {
    child = fork(CHILD_PATH, [], {
      stdio: ['ignore', 'ignore', 'ignore', 'ipc'],
      serialization: 'json',
    });
  } catch (error) {
    releasePdfSlot();
    throw error;
  }
  liveParsers.add(child);
  let settled = false;

  return new Promise((resolve, reject) => {
    const finish = (fn) => {
      if (settled) return;
      settled = true;
      liveParsers.delete(child);
      options.signal?.removeEventListener('abort', onAbort);
      clearTimeout(killTimer);
      try {
        if (child.connected) child.disconnect();
      } catch {
        // already disconnected
      }
      if (!child.killed) {
        try { child.kill('SIGKILL'); } catch { /* gone */ }
      }
      releasePdfSlot();
      fn();
    };
    const onAbort = () => finish(() => reject(abortError()));
    const killTimer = setTimeout(onAbort, Math.max(250, PDF_EXTRACTION_DEADLINE_MS + 500));

    if (options.signal?.aborted) {
      finish(() => reject(abortError()));
      return;
    }
    if (options.signal) options.signal.addEventListener('abort', onAbort, { once: true });

    child.on('message', (message) => {
      if (message?.type !== 'result') return;
      finish(() => resolve(message.result));
    });
    child.on('error', (error) => {
      finish(() => reject(error));
    });
    child.on('exit', (code, signal) => {
      if (settled) return;
      if (signal === 'SIGKILL' || options.signal?.aborted) {
        finish(() => reject(abortError()));
        return;
      }
      finish(() => resolve({ text: null, reason: 'failed', truncated: false }));
    });
    try {
      child.send({
        type: 'extract',
        bytes: Buffer.from(bytes).toString('base64'),
        deadlineAt: options.deadlineAt ?? Date.now() + EXTRACTION_REQUEST_BUDGET_MS,
        maxPdfPages: options.maxPdfPages ?? MAX_PDF_PAGES,
      });
    } catch (error) {
      finish(() => reject(error));
    }
  });
}

/**
 * @param {object} extraction
 * @param {{ filename: string, mimeType: string, byteSize: number }} fileMeta
 */
export function createDocumentRecord(extraction, fileMeta) {
  return Object.freeze({
    document_ref: `document:${randomUUID()}`,
    filename: String(fileMeta.filename || 'upload').slice(0, 200),
    media_type: extraction.media_type || canonicalMediaType(fileMeta.mimeType),
    byte_size: fileMeta.byteSize,
    extraction_reason: extraction.reason,
    truncated: Boolean(extraction.truncated),
    extracted_text: extraction.text,
    source_kind: extraction.own_format ? 'own_format' : 'generic',
    uncertainty: extraction.uncertainty
      || (extraction.reason === 'ok' ? null : extraction.reason),
    own_format: Boolean(extraction.own_format),
    parsed: extraction.parsed,
    created_at: new Date().toISOString(),
  });
}
