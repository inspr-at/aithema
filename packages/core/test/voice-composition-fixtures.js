import * as components from '../src/voice-components.js';

export function compositionFixture() {
  const counters = { claims: 0, secrets: 0, transport: 0, negotiation: 0 };
  const capture = { encoding: 'pcm_s16le', sampleRateHz: 16000, channels: 1 };
  const playback = { encoding: 'pcm_s16le', sampleRateHz: 24000, channels: 1 };
  const negotiate = format => async () => { counters.negotiation++; return { ...format }; };
  const dispatch = () => { counters.claims++; counters.secrets++; counters.transport++; };
  const stt = { capabilities: { streaming: false, partialTranscripts: false, languages: ['de', 'en'] },
    negotiateAudioFormat: negotiate(capture), async transcribe() { dispatch(); return { text: 'synthetic' }; } };
  const tts = { format: playback, capabilities: { streaming: false, languages: ['DE', 'en'], heardPrefix: 'unavailable', voices: ['fixture-voice'] },
    negotiateAudioFormat: negotiate(playback), async *speak() { dispatch(); yield new Uint8Array(2); } };
  return { stt, tts, capture, playback, languages: ['de'], voice: 'fixture-voice', counters };
}

export const invalidCompositions = [
  ['invalid STT port', 'composition-stt-invalid', f => { f.stt.transcribe = null; }],
  ['invalid TTS port', 'composition-tts-invalid', f => { f.tts.speak = null; }],
  ['missing streaming operation', 'composition-stt-invalid', f => { f.stt.capabilities.streaming = true; }],
  ['missing aligned operation', 'composition-tts-invalid', f => { f.tts.capabilities.heardPrefix = 'aligned'; }],
  ['missing voice', 'composition-voice-invalid', f => { delete f.voice; }],
  ['invalid voice', 'composition-voice-invalid', f => { f.voice = 'unknown-voice'; }],
  ['blank voice', 'composition-voice-invalid', f => { f.voice = ' '; }],
  ['capture encoding', 'composition-capture-format', f => { f.capture = { ...f.capture, encoding: 'other' }; }],
  ['capture rate', 'composition-capture-format', f => { f.capture = { ...f.capture, sampleRateHz: 48000 }; }],
  ['capture channels', 'composition-capture-format', f => { f.capture = { ...f.capture, channels: 2 }; }],
  ['playback encoding', 'composition-playback-format', f => { f.playback = { ...f.playback, encoding: 'other' }; }],
  ['playback rate', 'composition-playback-format', f => { f.playback = { ...f.playback, sampleRateHz: 48000 }; }],
  ['playback channels', 'composition-playback-format', f => { f.playback = { ...f.playback, channels: 2 }; }],
  ['missing capture format', 'composition-capture-format', f => { delete f.capture; }],
  ['empty component intersection', 'composition-languages-empty', f => { f.tts.capabilities.languages = ['fr']; }],
  ['empty requested intersection', 'composition-languages-empty', f => { f.languages = ['fr']; }],
  ['empty requested languages', 'composition-languages-empty', f => { f.languages = []; }],
  ['invalid requested languages', 'composition-languages-invalid', f => { f.languages = ['*']; }],
  ['overstated STT streaming', 'composition-capabilities-exceeded', f => { f.capabilities = { ...components.voiceCompositionCapabilities(f.stt, f.tts), streaming: { stt: true, tts: false } }; }],
  ['overstated TTS streaming', 'composition-capabilities-exceeded', f => { f.capabilities = { ...components.voiceCompositionCapabilities(f.stt, f.tts), streaming: { stt: false, tts: true } }; }],
  ['overstated partials', 'composition-capabilities-exceeded', f => { f.capabilities = { ...components.voiceCompositionCapabilities(f.stt, f.tts), partialTranscripts: true }; }],
  ['overstated alignment', 'composition-capabilities-exceeded', f => { f.capabilities = { ...components.voiceCompositionCapabilities(f.stt, f.tts), heardPrefix: 'aligned' }; }],
  ['overstated language', 'composition-capabilities-exceeded', f => { f.capabilities = { ...components.voiceCompositionCapabilities(f.stt, f.tts), languages: ['fr'] }; }],
  ['unknown capability', 'composition-capabilities-exceeded', f => { f.capabilities = { ...components.voiceCompositionCapabilities(f.stt, f.tts), unsupported: true }; }],
];
