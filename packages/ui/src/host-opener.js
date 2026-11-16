/** Static display projection; persistence belongs to first input or voice connection. */
export function hostOpenerTurn(session) {
  const opener = session.opener;
  if (session.transcript.length || session.tombstone || session.consentWithdrawn ||
    !opener || opener.locale !== session.locale || typeof opener.text !== 'string' || !opener.text.trim()) return null;
  return { id: 'host:opener', role: 'assistant', origin: 'host', content: opener.text };
}
export function openerTranscript(session, { visible = true } = {}) {
  const turn = visible && hostOpenerTurn(session);
  return turn ? [turn] : session.transcript;
}
