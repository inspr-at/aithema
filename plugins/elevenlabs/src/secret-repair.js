// Private, value-free signal scoped to the facade store already shared by host
// and callback adapter. Weak keys retain neither stopped hosts nor credentials.
const listeners = new WeakMap();
export function watchBearerRejections(secrets, listener) {
  if (!secrets) return () => {};
  listeners.set(secrets, listener);
  return () => { if (listeners.get(secrets) === listener) listeners.delete(secrets); };
}
export function reportBearerRejection(secrets) {
  listeners.get(secrets)?.();
}
