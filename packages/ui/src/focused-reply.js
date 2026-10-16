/** A server-produced clarify reply uses the call's existing admitted speech path. */
export async function deliverFocusedReply(rail, reply) {
  if (!reply.focusRequestId || reply.role !== 'assistant' || !rail?.session || rail.paused || !rail.output) return;
  return rail.session.speakReply?.({ turnId: reply.id, text: reply.content });
}
