// The SDK ships generated loaders rather than standalone worklet files. Capture
// their bundled source through the public loader; do not evaluate extracted code.
const assets = new Map([
  ['raw-audio.js', ['rawAudioProcessor.generated.js', 'loadRawAudioProcessor']],
  ['audio-concat.js', ['audioConcatProcessor.generated.js', 'loadAudioConcatProcessor']],
]);
const cached = new Map();
export async function voiceAsset(name) {
  if (!assets.has(name)) return null;
  if (!cached.has(name)) {
    const [file, symbol] = assets.get(name);
    const source = (async () => {
      const module = await import(`../node_modules/@elevenlabs/client/dist/platform/web/${file}`);
      let bytes;
      await module[symbol]({ async addModule(url) { bytes = await fetch(url).then(r => r.arrayBuffer()); } });
      return bytes;
    })();
    cached.set(name, source);
  }
  return cached.get(name);
}
