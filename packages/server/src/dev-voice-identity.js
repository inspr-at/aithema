// Function identity, never manifest strings, identifies the zero-cost simulator.
const localStarts = new WeakSet();
export const isLocalVoice = plugin => localStarts.has(plugin?.start);
export const registerLocalVoice = start => localStarts.add(start);
