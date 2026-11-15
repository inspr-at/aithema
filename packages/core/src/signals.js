// Exact normalized text is identity, never a semantic/fuzzy match.
export const signalKey = value => value.normalize('NFKC').toLowerCase().replace(/\s+/gu, ' ').trim();
const bases = new Set(['visitor', 'assistant', 'document']);
export function cleanSignals(values = [], metadata = []) {
  const prior = new Map((Array.isArray(metadata) ? metadata : []).filter(i => typeof i?.text === 'string').map(i => [signalKey(i.text), i]));
  const seen = new Set(), items = [];
  for (const value of Array.isArray(values) ? values : []) {
    const object = value && typeof value === 'object', source = object ? value.text : value;
    if (typeof source !== 'string' || object && !bases.has(value.basis)) continue;
    const text = source.replace(/\s+/gu, ' ').trim().slice(0, 500), key = signalKey(text);
    if (!key || seen.has(key)) continue;
    const basis = object ? value.basis : prior.get(key)?.basis;
    seen.add(key); items.push({ text, ...(bases.has(basis) ? { basis } : {}) });
    if (items.length === 24) break;
  }
  return items;
}

/** Final lists select visible signals; only source removal prunes the ledger. */
export function projectSignals(session, understanding, seq) {
  const ledger = session.signalLedger ?? [], known = new Map(ledger.map((item, index) => [item.key, { item, index }]));
  const supplied = new Map((understanding.signalItems ?? []).filter(item => typeof item?.text === 'string').map(item => [signalKey(item.text), item]));
  const turnIds = session.transcript.filter(t => !t.erased && !t.withdrawn).map(t => t.id);
  const uploadIds = (session.uploads ?? []).filter(u => !u.erased && !u.withdrawn && u.state === 'accepted').map(u => u.id);
  const items = cleanSignals(understanding.signals, understanding.signalItems).map(item => {
    const key = signalKey(item.text), old = known.get(key)?.item, stamp = supplied.get(key)?.firstSeen;
    // Persisted final events carry the original stamp even when earlier
    // understanding content has since been invalidated by a consent grant.
    const firstSeen = old?.firstSeen ?? (Number.isSafeInteger(stamp) && stamp > 0 && stamp <= seq ? stamp : seq);
    return { key, ...item, firstSeen };
  });
  items.sort((a, b) => b.firstSeen - a.firstSeen ||
    (known.get(a.key)?.index ?? ledger.length) - (known.get(b.key)?.index ?? ledger.length));
  const updates = new Map(items.map(item => [item.key, { ...item, turnIds: [...turnIds], uploadIds: [...uploadIds] }]));
  const retained = ledger.map(item => updates.get(item.key) ?? item);
  for (const item of updates.values()) if (!known.has(item.key)) retained.push(item);
  retained.sort((a, b) => a.firstSeen - b.firstSeen);
  return { signalLedger: retained, understanding: { ...understanding, signals: items.map(i => i.text), signalItems: items } };
}
