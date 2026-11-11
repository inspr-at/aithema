import { execFileSync } from 'node:child_process';

// Release notes grow by roughly 33 KiB per release; refs and source inventories
// also grow. Keep ample headroom while retaining a conscious, finite output cap.
export const RELEASE_EXEC_MAX_BUFFER = 64 * 1024 * 1024;
// Paginated API reads and remote ref refreshes can take minutes on a busy host.
export const RELEASE_EXEC_TIMEOUT_MS = 5 * 60 * 1000;

// Callers that recover from malformed metadata must still refuse bound failures.
export class ReleaseExecBoundError extends Error {}

// Bounds are injectable by tests through function arguments, never environment.
export function releaseExecFileSync(command, args, {
  maxBuffer = RELEASE_EXEC_MAX_BUFFER, timeout = RELEASE_EXEC_TIMEOUT_MS, ...options
} = {}) {
  try {
    return execFileSync(command, args, { stdio: ['ignore', 'pipe', 'pipe'], ...options, maxBuffer, timeout });
  } catch (cause) {
    const bound = cause.code === 'ENOBUFS' ? `maxBuffer=${maxBuffer} bytes` :
      cause.code === 'ETIMEDOUT' ? `timeout=${timeout} ms` : null;
    if (!bound) throw cause;
    throw new ReleaseExecBoundError(`Release command "${[command, ...args].join(' ')}" exceeded ${bound}; ` +
      'review the required bound and raise it explicitly in release/lib/exec.mjs.', { cause });
  }
}
