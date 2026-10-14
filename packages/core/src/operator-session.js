/** Trusted host port, separate from visitor identity and conversation ownership.
 * handle(Request) handles only the three fixed operator routes, or returns null.
 * session(Request) returns {name, subject} only for a live, server-revocable grant.
 * entry() returns public provider/navigation metadata; never tokens or subjects.
 */
export function assertOperatorSessionPort(port) {
  if (['handle', 'session', 'entry'].some(name => typeof port?.[name] !== 'function')) {
    throw new TypeError('Operator session operations missing');
  }
  return port;
}
