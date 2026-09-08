/** @import { RequirementsHandover } from './types.js' */
import PDFDocument from 'pdfkit';

import {
  formatUnsupportedPdfSample,
  notoSansFontFiles,
  splitFontRuns,
  unsupportedPdfCharacters,
} from './fonts.js';
import { reviewedHandoverIdentity } from './portable.js';
import { printablePdfText } from './text.js';

/**
 * Printable PDF for one reviewed baseline. Fonts are embedded OFL Noto Sans
 * Latin/Latin-Ext/Greek/Cyrillic subsets. No JavaScript, annotations, or
 * external asset fetches.
 * Unsupported scripts are refused rather than painted as missing glyphs.
 * @param {RequirementsHandover} handover
 * @returns {Promise<Buffer>}
 */
export async function exportReviewedPdf(handover) {
  const identity = reviewedHandoverIdentity(handover);
  assertHandoverPdfScripts(handover);
  const baseline = handover.baseline;
  const fonts = notoSansFontFiles();

  return new Promise((resolve, reject) => {
    const doc = new PDFDocument({
      size: 'A4',
      bufferPages: true,
      pdfVersion: '1.7',
      autoFirstPage: true,
      margins: { top: 56, bottom: 64, left: 48, right: 48 },
      info: {
        Title: `Reviewed handover ${identity.baseline_ref} r${identity.revision}`,
        Author: 'Aithema',
        Producer: 'Aithema reviewed export',
      },
    });
    const chunks = [];
    let settled = false;
    const succeed = (value) => {
      if (settled) return;
      settled = true;
      resolve(value);
    };
    const fail = (error) => {
      if (settled) return;
      settled = true;
      reject(error);
    };
    doc.on('data', (chunk) => chunks.push(chunk));
    doc.on('error', fail);
    doc.on('end', () => succeed(Buffer.concat(chunks)));

    try {
      doc.registerFont('latin', fonts.latin);
      doc.registerFont('latinExt', fonts.latinExt);
      doc.registerFont('greek', fonts.greek);
      doc.registerFont('cyrillic', fonts.cyrillic);

      const width = contentWidth(doc);

      heading(doc, 'Reviewed requirements handover');
      metaLine(doc, 'stream_ref', handover.stream_ref, width);
      metaLine(doc, 'baseline_ref', identity.baseline_ref, width);
      metaLine(doc, 'revision', String(identity.revision), width);
      metaLine(doc, 'content_digest', identity.content_digest, width);
      metaLine(doc, 'revision_seal', identity.revision_seal, width);
      paragraph(
        doc,
        `Recorded approval claim: approved_by ${baseline.approved_by} at ${baseline.approved_at}. This claim is not imported authority.`,
        width,
        9,
      );
      paragraph(
        doc,
        'Unapproved proposals, conversation notes, provider configuration, and identity maps are excluded.',
        width,
        9,
      );
      paragraph(doc, `Exported at ${handover.exported_at}`, width, 9);

      heading(doc, 'Requirements', 14);
      for (const requirement of baseline.requirements) {
        ensureSpace(doc, 72);
        heading(doc, requirement.requirement_ref, 12);
        paragraph(doc, requirement.statement, width, 11);
        paragraph(doc, 'Acceptance criteria', width, 9);
        for (const [index, criterion] of requirement.acceptance_criteria.entries()) {
          paragraph(doc, `${index + 1}. ${criterion}`, width, 10);
        }
        const refs = requirement.constraint_refs.length
          ? requirement.constraint_refs.join(', ')
          : 'None';
        paragraph(doc, `constraint_refs: ${refs}`, width, 9);
      }

      heading(doc, 'Constraints', 14);
      if (!baseline.constraints.length) {
        paragraph(doc, 'None recorded in this reviewed snapshot.', width, 10);
      } else {
        for (const constraint of baseline.constraints) {
          ensureSpace(doc, 48);
          paragraph(doc, `${constraint.constraint_ref} (${constraint.kind})`, width, 11);
          paragraph(doc, constraint.statement, width, 10);
        }
      }

      const range = doc.bufferedPageRange();
      paintPageFooters(doc, range.count);
      if (doc.bufferedPageRange().count !== range.count) {
        fail(Object.assign(new Error('PDF footer placement must not add pages'), {
          code: 'export_pdf_footer',
        }));
        return;
      }
      doc.flushPages();
      doc.end();
    } catch (error) {
      fail(error);
    }
  });
}

/**
 * @param {RequirementsHandover} handover
 */
function assertHandoverPdfScripts(handover) {
  const samples = [];
  const seen = new Set();
  for (const value of handoverPrintableStrings(handover)) {
    for (const char of unsupportedPdfCharacters(printablePdfText(value))) {
      if (seen.has(char)) continue;
      seen.add(char);
      samples.push(char);
    }
  }
  if (!samples.length) return;
  const shown = formatUnsupportedPdfSample(samples.slice(0, 8));
  throw Object.assign(
    new Error(
      `PDF export embeds Noto Sans Latin, Latin-Extended, Greek, and Cyrillic subset files only (not full Unicode coverage). This reviewed baseline contains characters those subsets cannot paint (for example ${shown}). Download the HTML or JSON export for a lossless copy.`,
    ),
    { code: 'export_pdf_unsupported_script', samples },
  );
}

/**
 * @param {RequirementsHandover} handover
 * @returns {string[]}
 */
function handoverPrintableStrings(handover) {
  const baseline = handover.baseline;
  const strings = [
    handover.stream_ref,
    handover.exported_at,
    baseline.baseline_ref,
    String(baseline.revision),
    baseline.content_digest,
    baseline.revision_seal,
    baseline.approved_by,
    baseline.approved_at,
  ];
  for (const requirement of baseline.requirements) {
    strings.push(requirement.requirement_ref, requirement.statement, ...requirement.acceptance_criteria, ...requirement.constraint_refs);
  }
  for (const constraint of baseline.constraints) {
    strings.push(constraint.constraint_ref, constraint.kind, constraint.statement);
  }
  return strings;
}

function heading(doc, text, size = 16) {
  ensureSpace(doc, 28);
  doc.moveDown(0.4);
  richText(doc, text, { size, width: contentWidth(doc) });
}

function metaLine(doc, label, value, width) {
  richText(doc, `${label} ${value}`, { size: 9, width });
}

function paragraph(doc, text, width, size) {
  richText(doc, text, { size, width });
}

function contentWidth(doc) {
  return doc.page.width - doc.page.margins.left - doc.page.margins.right;
}

function ensureSpace(doc, min) {
  const bottom = doc.page.height - doc.page.margins.bottom;
  if (doc.y + min > bottom) doc.addPage();
}

/**
 * Wrap on whitespace, then on characters when a token is wider than the
 * content box. Widths are measured from the same font runs used to paint.
 * @param {PDFKit.PDFDocument} doc
 * @param {string} text
 * @param {{ size: number, width: number }} options
 */
function richText(doc, text, options) {
  const clean = printablePdfText(text);
  const width = options.width;
  const size = options.size;
  const lines = wrapPaintedLines(doc, clean, width, size);
  for (const line of lines) {
    ensureSpace(doc, lineHeight(doc, size) + 2);
    paintLine(doc, line, size);
  }
  doc.x = doc.page.margins.left;
}

/**
 * @param {PDFKit.PDFDocument} doc
 * @param {string} text
 * @param {number} width
 * @param {number} size
 * @returns {string[]}
 */
function wrapPaintedLines(doc, text, width, size) {
  const tokens = text.split(/(\s+)/);
  const lines = [];
  let line = '';
  const flush = () => {
    if (!line) return;
    lines.push(line);
    line = '';
  };
  for (const token of tokens) {
    if (!token) continue;
    if (/^\n+$/.test(token)) {
      flush();
      continue;
    }
    const pieces = breakTokenToWidth(doc, token.replace(/\n/g, ' '), width, size);
    for (const piece of pieces) {
      const candidate = line + piece;
      if (line && widthOfPaintedText(doc, candidate, size) > width) {
        flush();
        line = /^\s+$/.test(piece) ? '' : piece;
      } else {
        line = candidate;
      }
    }
  }
  flush();
  return lines;
}

/**
 * @param {PDFKit.PDFDocument} doc
 * @param {string} token
 * @param {number} width
 * @param {number} size
 * @returns {string[]}
 */
function breakTokenToWidth(doc, token, width, size) {
  if (!token) return [];
  if (widthOfPaintedText(doc, token, size) <= width) return [token];
  const pieces = [];
  let current = '';
  for (const char of token) {
    const candidate = current + char;
    if (current && widthOfPaintedText(doc, candidate, size) > width) {
      pieces.push(current);
      current = char;
    } else {
      current = candidate;
    }
  }
  if (current) pieces.push(current);
  return pieces;
}

/**
 * @param {PDFKit.PDFDocument} doc
 * @param {string} text
 * @param {number} size
 */
function widthOfPaintedText(doc, text, size) {
  let total = 0;
  for (const run of splitFontRuns(text)) {
    doc.font(run.font).fontSize(size);
    total += doc.widthOfString(run.text);
  }
  return total;
}

function lineHeight(doc, size) {
  doc.font('latin').fontSize(size);
  return doc.currentLineHeight();
}

function paintLine(doc, text, size) {
  const left = doc.page.margins.left;
  const y = doc.y;
  let x = left;
  const height = lineHeight(doc, size);
  for (const run of splitFontRuns(text)) {
    doc.font(run.font).fontSize(size);
    doc.text(run.text, x, y, { lineBreak: false, continued: false });
    x += doc.widthOfString(run.text);
  }
  doc.x = left;
  doc.y = y + height;
}

/**
 * Footer sits in the bottom margin. Do not pass `width`: PDFKit's LineWrapper
 * treats y below maxY() as a page break and would append a blank page.
 * @param {PDFKit.PDFDocument} doc
 * @param {number} pageCount
 */
function paintPageFooters(doc, pageCount) {
  for (let i = 0; i < pageCount; i += 1) {
    doc.switchToPage(i);
    const label = `Page ${i + 1} of ${pageCount}`;
    doc.font('latin').fontSize(8).fillColor('#333');
    const labelWidth = doc.widthOfString(label);
    const x = (doc.page.width - labelWidth) / 2;
    const y = doc.page.height - 40;
    doc.text(label, x, y, { lineBreak: false });
  }
}
