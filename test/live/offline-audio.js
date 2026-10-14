import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

export const speech = {
  de: ['Wir möchten unsere öffentliche Schnittstelle verbessern.', 'Bitte erklären Sie die nächsten Schritte.', 'Einen Moment. Wir brauchen zuerst einen einfachen Entwurf.'],
  en: ['We want to improve our public interface.', 'Please explain the next steps.', 'One moment. We need a simple draft first.'],
};

/** macOS's installed offline voice only. Never downloads a voice or calls TTS APIs. */
export async function offlineAudio(directory, locale) {
  if (process.platform !== 'darwin') throw new Error('Generate the speech WAV on mbp2606 with its installed macOS voices');
  const file = join(directory, 'synthetic-speech.wav');
  await promisify(execFile)('/usr/bin/say', ['-v', locale === 'de' ? 'Anna' : 'Samantha',
    '--file-format=WAVE', '--data-format=LEI16@16000', '-o', file, speech[locale].join(' ')], { timeout: 30_000 });
  const bytes = await readFile(file);
  if (bytes.toString('ascii', 0, 4) !== 'RIFF' || bytes.toString('ascii', 8, 12) !== 'WAVE') throw new Error('Offline speech is not a PCM WAV');
  // Append a short silence at the loop boundary, retaining say's format chunks.
  let dataOffset = -1;
  for (let offset = 12; offset + 8 <= bytes.length;) {
    const size = bytes.readUInt32LE(offset + 4);
    if (bytes.toString('ascii', offset, offset + 4) === 'data') { dataOffset = offset; break; }
    offset += 8 + size + size % 2;
  }
  if (dataOffset < 0) throw new Error('Offline WAV has no sample data');
  const dataSize = bytes.readUInt32LE(dataOffset + 4), end = dataOffset + 8 + dataSize;
  if (end > bytes.length || !bytes.subarray(dataOffset + 8, end).some(value => value !== 0)) throw new Error('Offline speech WAV is empty or silent');
  const loop = Buffer.concat([bytes.subarray(0, end), Buffer.alloc(16_000)]);
  loop.writeUInt32LE(dataSize + 16_000, dataOffset + 4); loop.writeUInt32LE(loop.length - 8, 4);
  await writeFile(file, loop);
  return file;
}
