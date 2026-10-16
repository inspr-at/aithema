// Shared wire contract for the host's describe() port and the Settings reader.
// Diagnostics name fields only: never include host payloads or ledger values.
export class ConsentDocumentError extends Error {
  constructor(field, requirement) { super(`Invalid consent.describe(): ${field} ${requirement}`); }
}
const record = value => value !== null && typeof value === 'object' && !Array.isArray(value);
const text = value => typeof value === 'string' && value.trim().length > 0;
export function validateConsentDocument(doc) {
  const require = (valid, field, requirement) => { if (!valid) throw new ConsentDocumentError(field, requirement); };
  require(record(doc), 'document', 'must be an object');
  require(doc.mock === undefined || typeof doc.mock === 'boolean', 'mock', 'must be a boolean when supplied');
  const shorthand = doc.mock === true && doc.items === undefined;
  require(shorthand && doc.contract === undefined || text(doc.contract), 'contract', 'must be a non-empty string');
  require(shorthand || Array.isArray(doc.items), 'items', 'must be an array');
  const ids = new Set();
  for (const [index, item] of (doc.items ?? []).entries()) {
    const field = `items[${index}]`;
    require(record(item), field, 'must be an object');
    require(text(item.id) && !ids.has(item.id), `${field}.id`, 'must be a unique non-empty string');
    ids.add(item.id);
    require(Number.isSafeInteger(item.version) && item.version > 0 || text(item.version), `${field}.version`, 'must be a positive safe integer or non-empty string');
    for (const key of ['title', 'recipients', 'text']) require(text(item[key]), `${field}.${key}`, 'must be a non-empty string');
  }
  if (shorthand) ids.add('mock-processing');
  const list = (value, field) => require(Array.isArray(value) && new Set(value).size === value.length &&
    value.every(id => typeof id === 'string' && ids.has(id)), field, 'must be an array of unique known item IDs');
  list(doc.selected, 'selected');
  if (doc.optional !== undefined) list(doc.optional, 'optional');
  for (const key of ['intro', 'withdrawal']) if (doc[key] !== undefined) require(text(doc[key]), key, 'must be a non-empty string');
  if (doc.features !== undefined) {
    require(record(doc.features), 'features', 'must be an object of item-ID arrays');
    for (const value of Object.values(doc.features)) list(value, 'features entry');
  }
  return doc;
}
