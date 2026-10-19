const scope = turn => JSON.stringify([turn.callId, turn.providerSessionId]);
const sameCall = (a, b) => a?.callId === b?.callId && a?.providerSessionId === b?.providerSessionId;
const ordinal = turn => Number.isSafeInteger(turn.userTurnOrdinal) && turn.userTurnOrdinal > 0 ? turn.userTurnOrdinal : 0;

/** Keep completion fences separately from the row awaiting its durable turn. */
export function voiceTranscriptTransition({ pending = null, finalized = new Map() } = {}, event) {
  const close = (turn, completed = true) => {
    if (!turn?.callId || !turn.providerSessionId) return;
    const key = scope(turn), prior = finalized.get(key);
    finalized = new Map(finalized).set(key, { ordinal: Math.max(prior?.ordinal ?? 0, completed ? ordinal(turn) : 0),
      ids: new Set([...(prior?.ids ?? []), turn.id ?? turn.turnId]) });
  };
  if (event.type === 'reset' || event.type === 'speaking') {
    if (event.type === 'reset' || pending?.partial) { close(pending, false); pending = null; }
  } else if (event.type === 'partial' && event.role === 'user' && typeof event.text === 'string' &&
    event.callId && event.providerSessionId && event.turnId) {
    const fence = finalized.get(scope(event));
    const stale = fence?.ids.has(event.turnId) || ordinal(event) && ordinal(event) <= (fence?.ordinal ?? 0) ||
      sameCall(pending, event) && ordinal(event) && ordinal(event) < ordinal(pending);
    if (!stale && !pending?.finalId) pending = event.text.trim() ? { id: event.turnId, role: 'user', content: event.text,
      partial: true, callId: event.callId, providerSessionId: event.providerSessionId,
      ...(ordinal(event) ? { userTurnOrdinal: ordinal(event) } : {}) } : null;
  } else {
    const final = event.type === 'turn.final' ? event.data : event.type === 'final' ? event : null;
    if (final?.role === 'assistant' && pending?.partial && sameCall(pending, final)) { close(pending, false); pending = null; }
    if (final?.role === 'user') {
      close(final);
      const id = final.id ?? final.turnId;
      const matches = pending && sameCall(pending, final) && (pending.finalId ? (pending.finalId === id || pending.finalId === event.providerTurnId)
        : ordinal(pending) && ordinal(final) ? ordinal(pending) === ordinal(final) : pending.id === id);
      if (matches) {
        close(pending);
        if (event.type === 'turn.final') return { state: { pending: null, finalized }, replacement: { from: pending.id, to: id } };
        // Provider completion may precede SSE. Keep the occupied row, now with
        // final text, until the saved id can take it over in the same render.
        pending = { ...pending, partial: false, content: final.text, finalId: id };
      }
    }
  }
  return { state: { pending, finalized } };
}


/** Occupy only the existing bubble metadata line; insertion has no layout effect. */
export function paintVoiceInterruption(row, turn, copy) {
  let marker = row.querySelector('.voice-interruption');
  const heardLength = turn.interruption?.heardLength;
  const confirmed = heardLength === 'unknown' || Number.isSafeInteger(heardLength) && heardLength >= 0;
  if (turn.role !== 'assistant' || turn.erased || turn.withdrawn || !confirmed) {
    marker?.remove(); return;
  }
  if (!marker) {
    marker = row.ownerDocument.createElement('span'); marker.className = 'voice-interruption';
    marker.tabIndex = 0; marker.setAttribute('role', 'img');
    marker.innerHTML = '<svg viewBox="0 0 16 16" width="12" height="12" aria-hidden="true"><path d="M5 3v10M10 3v10M2 14 14 2" fill="none" stroke="currentColor" stroke-width="1.4" stroke-linecap="round"/></svg><span class="voice-interruption-label"></span><span class="voice-interruption-tooltip" role="tooltip"></span>';
    const tooltip = marker.querySelector('[role="tooltip"]');
    tooltip.id = `interruption-${encodeURIComponent(turn.id)}`;
    marker.setAttribute('aria-describedby', tooltip.id);
    row.querySelector('strong').append(marker);
  }
  marker.setAttribute('aria-label', copy.voiceInterrupted);
  marker.querySelector('.voice-interruption-label').textContent = copy.voiceInterrupted;
  marker.querySelector('[role="tooltip"]').textContent = heardLength === 'unknown'
    ? copy.voiceInterruptedDescription : copy.voiceInterruptedKnownDescription;
}
