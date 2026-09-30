import { isIP } from 'node:net';

/** Match the settings capability predicate; a provider name alone proves nothing. */
export function isOperatorLocalLane(row) {
  if (!row?.enabled || row.execution_location !== 'operator' || row.template?.deployment !== 'self_hosted') return false;
  try {
    const host = new URL(row.template.endpoint).hostname;
    return host === 'localhost' || host === '[::1]' || (isIP(host) === 4 && host.startsWith('127.'));
  } catch { return false; }
}
