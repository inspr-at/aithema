export function createTouchVisitor({ host, log = console.log }) {
  return session => {
    const failed = () => {
      try { Promise.resolve(log({ event: 'host.touch-visitor.failed', sessionId: session.id })).catch(() => {}); }
      catch { /* Diagnostics cannot interrupt a turn or call. */ }
    };
    // Activity is best effort: accepted input and call controls must continue.
    try { Promise.resolve(host?.touchVisitor?.(session)).catch(failed); }
    catch { failed(); }
  };
}
