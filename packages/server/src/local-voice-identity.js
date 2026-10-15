// Keep the existing export surface, but enrollment belongs only to the simulator.
export { isLocalVoice } from './dev/local-voice.js';
// Retained for import compatibility; public callers must never mint identity.
export const markLocalVoice = () => { throw new TypeError('Simulator identity is private'); };
