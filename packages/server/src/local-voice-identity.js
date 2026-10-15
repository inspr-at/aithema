// Runtime recognition of the deterministic development adapter, without importing it.
// Identity is process-local; a public manifest cannot opt into this exemption.
const starts = new WeakSet();
export const markLocalVoice = start => starts.add(start);
export const isLocalVoice = plugin => starts.has(plugin?.start);
