// Legacy convenience exports. Implementation and callback wiring belong to the
// plugin; new hosts should import these factories from the plugin itself.
export { createVoiceProvider } from '../../plugins/elevenlabs/src/provider.js';
export { createFacadeSecrets } from '../../plugins/elevenlabs/src/callbacks.js';
