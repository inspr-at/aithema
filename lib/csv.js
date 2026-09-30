import { boundary } from './boundary.js';
/**
 * Spreadsheet formula neutralisation adapted from START understanding-csv.ts.
 * @see https://github.com/augmentoring/start-agm-com (read-only inspection)
 */

/** @typedef {readonly [field: string, value: unknown]} CsvRow */

/**
 * Neutralise formula injection, including leading whitespace / newline prefixes
 * that would otherwise slip past a first-character-only check.
 * @param {unknown} value
 */
const neutraliseSpreadsheetFormulaImpl = (value) => {
  const text = value == null ? '' : String(value);
  if (/^\s*[=+\-@]/u.test(text) || /^[\t\r]/u.test(text)) {
    return `'${text}`;
  }
  return text;
};

/**
 * @param {unknown} value
 */
const quote = (value) => `"${neutraliseSpreadsheetFormulaImpl(value).replaceAll('"', '""')}"`;

/**
 * Semicolon CSV plus BOM is the combination German Excel recognises reliably.
 * Adapted from START understanding-csv.ts encodeUnderstandingCsv.
 * @param {readonly CsvRow[]} rows
 * @param {{ field: string, value: string }} header
 */
function encodeRequirementsCsvImpl(rows, header = { field: 'Field', value: 'Value' }) {
  return `\uFEFF${[[header.field, header.value], ...rows]
    .map(([field, value]) => `${quote(field)};${quote(value)}`)
    .join('\r\n')}\r\n`;
}

export const neutraliseSpreadsheetFormula = boundary(neutraliseSpreadsheetFormulaImpl);
export const encodeRequirementsCsv = boundary(encodeRequirementsCsvImpl);
