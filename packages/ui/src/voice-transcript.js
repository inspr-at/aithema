/** Provider partials replace the whole hypothesis; only a saved user turn can promote it. */
export function voiceTranscriptTransition(pending, event) {
  if (event.type === 'reset') return { pending: null };
  if (event.type === 'partial' && event.role === 'user' && typeof event.text === 'string' &&
    event.callId && event.providerSessionId && event.turnId) {
    return { pending: event.text.trim() ? { id: event.turnId, role: 'user', content: event.text,
      partial: true, callId: event.callId, providerSessionId: event.providerSessionId } : null };
  }
  const final = event.type === 'turn.final' ? event.data : event.type === 'final' ? event : null;
  if (pending && final?.role === 'user' && final.callId === pending.callId &&
    final.providerSessionId === pending.providerSessionId) {
    return { pending: null, replacement: { from: pending.id, to: final.id ?? final.turnId } };
  }
  return { pending };
}
