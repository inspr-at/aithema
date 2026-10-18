import { createComposedVoice as createSupportedComposedVoice } from '@inspr/aithema-server/composed-voice/server';
import { configureComposedComponents } from './configuration.js';

// Legacy source-only component selection. Supported hosts inject admitted ports.
export function createComposedVoice(options = {}) {
  const { config = {} } = options;
  const selected = config.stt !== undefined || config.tts !== undefined ? configureComposedComponents(options) : null;
  return createSupportedComposedVoice({ ...options, ...(selected ? { stt: selected.stt, tts: selected.tts,
    authorize: selected.authorize, componentsReady: selected.preflight } : {}) });
}
