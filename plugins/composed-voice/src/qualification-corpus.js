import { open } from 'node:fs/promises';
import { isAbsolute } from 'node:path';

/** Bounded, unmodified PCM16 mono inputs, validated before either paid lane.
 * Both lanes receive identical bytes. No silence prefix or fixture offsets. */
export async function readQualificationCorpus(item) {
  const clips = {};
  for (const [name, key] of [['utterance', 'utterancePath'], ['bargeIn', 'bargeInPath']]) {
    if (!isAbsolute(item?.[key] ?? '')) throw new TypeError('Absolute corpus utterancePath and bargeInPath required');
    const file = await open(item[key], 'r');
    try {
      const size = (await file.stat()).size;
      if (size > 16_000_000) throw new Error('Corpus WAV bound exceeded');
      const read = async (length, position) => {
        const bytes = Buffer.alloc(length);
        if ((await file.read(bytes, 0, length, position)).bytesRead !== length) throw new Error('Incomplete corpus WAV');
        return bytes;
      };
      const header = await read(12, 0);
      if (header.toString('ascii', 0, 4) !== 'RIFF' || header.toString('ascii', 8, 12) !== 'WAVE') throw new Error('PCM16 mono corpus WAV required');
      const end = header.readUInt32LE(4) + 8;
      if (end > size) throw new Error('Incomplete corpus WAV');
      let rate;
      for (let at = 12, chunks = 0; at + 8 <= end && chunks < 128; chunks++) {
        const chunk = await read(8, at), length = chunk.readUInt32LE(4), start = at + 8;
        if (start + length > end) throw new Error('Incomplete corpus WAV');
        if (chunk.toString('ascii', 0, 4) === 'fmt ' && length >= 16) {
          const fmt = await read(16, start);
          if (fmt.readUInt16LE(0) !== 1 || fmt.readUInt16LE(2) !== 1 || fmt.readUInt16LE(12) !== 2 || fmt.readUInt16LE(14) !== 16) throw new Error('PCM16 mono corpus WAV required');
          rate = fmt.readUInt32LE(4);
          if (rate < 8000 || rate > 96000) throw new Error('Invalid corpus sample rate');
        }
        if (chunk.toString('ascii', 0, 4) === 'data' && rate && length > 0 && length % 2 === 0) {
          clips[name] = { sampleRateHz: rate, pcm: (await read(length, start)).toString('base64') };
          break;
        }
        at = start + length + length % 2;
      }
      if (!clips[name]) throw new Error('PCM16 mono corpus WAV data required');
    } finally { await file.close(); }
  }
  return clips;
}
