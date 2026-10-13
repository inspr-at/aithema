import { domainToASCII } from 'node:url';

/** One recipient representation for persistence and delivery.
 * Preserve the local part; abuse accounting separately folds its case. */
export function canonicalEmail(value) {
  if (typeof value !== 'string' || /[\p{Cc}\p{Cf}]/u.test(value)) throw new TypeError('Invalid email address');
  const trimmed = value.trim();
  const parts = /^([^\s@<>;,]+)@([^\s@<>;,]+)$/u.exec(trimmed);
  if (!parts || /[\\/:?#%\[\]]/u.test(parts[2])) throw new TypeError('Invalid email address');
  const domain = domainToASCII(parts[2]).toLowerCase();
  const labels = domain.split('.');
  if (labels.length < 2 || labels.some(label => !/^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/u.test(label))) throw new TypeError('Invalid email address');
  const address = `${parts[1]}@${domain}`;
  if (address.length > 254 || parts[1].length > 64) throw new TypeError('Invalid email address');
  return address;
}
