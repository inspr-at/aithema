import { isIP } from 'node:net';

/** Canonical URL host predicate shared by settings and zero-cost qualification. @param {string} host */
export function isLoopbackHost(host) {
  return host === 'localhost' || host === '[::1]' || (isIP(host) === 4 && host.startsWith('127.'));
}

/** A provider name alone proves nothing; require an enabled self-hosted loopback lane. */
export function isOperatorLocalLane(row) {
  if (!row?.enabled || row.execution_location !== 'operator' || row.template?.deployment !== 'self_hosted') return false;
  try {
    return isLoopbackHost(new URL(row.template.endpoint).hostname);
  } catch { return false; }
}
