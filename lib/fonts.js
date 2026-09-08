import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';

const require = createRequire(import.meta.url);
const fontkit = require('fontkit');

/** @typedef {'latin' | 'latinExt' | 'greek' | 'cyrillic'} PdfFontKey */

export const PDF_FONT_KEYS = Object.freeze(/** @type {const} */ (['latin', 'latinExt', 'greek', 'cyrillic']));

let loadedFonts = null;

/**
 * SIL OFL Noto Sans subsets from the pinned @fontsource/noto-sans package.
 * Latin (incl. Latin-1), Latin Extended, Greek, and Cyrillic. CJK is not
 * embedded (those files are large); standalone HTML uses the system stack.
 */
export function notoSansFontFiles() {
  const pkgDir = dirname(require.resolve('@fontsource/noto-sans/package.json'));
  const files = join(pkgDir, 'files');
  return Object.freeze({
    latin: join(files, 'noto-sans-latin-400-normal.woff'),
    latinExt: join(files, 'noto-sans-latin-ext-400-normal.woff'),
    greek: join(files, 'noto-sans-greek-400-normal.woff'),
    cyrillic: join(files, 'noto-sans-cyrillic-400-normal.woff'),
  });
}

/**
 * @returns {Readonly<Record<PdfFontKey, { hasGlyphForCodePoint: (code: number) => boolean }>>}
 */
function notoSansFonts() {
  if (loadedFonts) return loadedFonts;
  const files = notoSansFontFiles();
  loadedFonts = Object.freeze({
    latin: fontkit.openSync(files.latin),
    latinExt: fontkit.openSync(files.latinExt),
    greek: fontkit.openSync(files.greek),
    cyrillic: fontkit.openSync(files.cyrillic),
  });
  return loadedFonts;
}

function isLayoutWhitespace(code) {
  return code === 0x09 || code === 0x0A || code === 0x0D || code === 0x20;
}

/**
 * Documented PDF script routing. Returns null when the code point is not in a
 * named subset range; callers then look up an actual glyph.
 * @param {number} code
 * @returns {PdfFontKey | null}
 */
function preferredFontForCodePoint(code) {
  if (code >= 0x0400 && code <= 0x052F) return 'cyrillic';
  if (code >= 0x1C80 && code <= 0x1C8F) return 'cyrillic';
  if (code >= 0x0370 && code <= 0x03FF) return 'greek';
  if (code >= 0x1F00 && code <= 0x1FFF) return 'greek';
  if (code >= 0x0100 && code <= 0x024F) return 'latinExt';
  if (code <= 0x00FF) return 'latin';
  return null;
}

/**
 * @param {number} code
 * @returns {PdfFontKey | null}
 */
export function fontKeyForCodePoint(code) {
  if (isLayoutWhitespace(code)) return 'latin';
  const fonts = notoSansFonts();
  const preferred = preferredFontForCodePoint(code);
  if (preferred && fonts[preferred].hasGlyphForCodePoint(code)) return preferred;
  for (const key of PDF_FONT_KEYS) {
    if (fonts[key].hasGlyphForCodePoint(code)) return key;
  }
  return null;
}

/**
 * Unique characters the embedded Noto Sans subsets cannot paint.
 * Layout whitespace is never treated as missing.
 * @param {string} text
 * @returns {string[]}
 */
export function unsupportedPdfCharacters(text) {
  const found = [];
  const seen = new Set();
  for (const char of String(text ?? '')) {
    const code = char.codePointAt(0) ?? 0;
    if (fontKeyForCodePoint(code) != null) continue;
    if (seen.has(code)) continue;
    seen.add(code);
    found.push(char);
  }
  return found;
}

/**
 * Readable sample for PDF refusal messages. Uses U+codepoint labels so
 * invisible or unpaintable characters stay identifiable in plain text.
 * @param {string} char
 * @returns {string}
 */
export function formatUnsupportedPdfCharacter(char) {
  const code = char.codePointAt(0) ?? 0;
  const hex = code.toString(16).toUpperCase();
  return `U+${hex.length < 4 ? hex.padStart(4, '0') : hex}`;
}

/**
 * @param {readonly string[]} chars
 * @returns {string}
 */
export function formatUnsupportedPdfSample(chars) {
  return chars.map(formatUnsupportedPdfCharacter).join(', ');
}

/**
 * @param {string} text
 * @returns {readonly { font: PdfFontKey, text: string }[]}
 */
export function splitFontRuns(text) {
  const runs = [];
  let currentFont = null;
  let buffer = '';
  for (const char of text) {
    const font = fontKeyForCodePoint(char.codePointAt(0) ?? 0);
    if (font == null) {
      throw Object.assign(
        new Error('PDF text contains a character that the embedded fonts cannot paint'),
        { code: 'export_pdf_unsupported_script' },
      );
    }
    if (currentFont === null) {
      currentFont = font;
      buffer = char;
      continue;
    }
    if (font === currentFont) {
      buffer += char;
      continue;
    }
    runs.push({ font: currentFont, text: buffer });
    currentFont = font;
    buffer = char;
  }
  if (buffer) runs.push({ font: currentFont, text: buffer });
  return runs;
}
