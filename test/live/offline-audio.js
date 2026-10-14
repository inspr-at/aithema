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
    '--file-format=WAVE', '--data-format=LEI16@48000', '-o', file, speech[locale].join(' ')], { timeout: 30_000 });
  const bytes = await readFile(file);
  if (bytes.toString('ascii', 0, 4) !== 'RIFF' || bytes.toString('ascii', 8, 12) !== 'WAVE') throw new Error('Offline speech is not a PCM WAV');
  // Canonical PCM header: avoid AudioToolbox's extra format/padding chunks in
  // Chrome's fake-device WAV parser. The samples remain offline synthetic speech.
  let dataOffset = -1, formatOffset = -1;
  for (let offset = 12; offset + 8 <= bytes.length;) {
    const size = bytes.readUInt32LE(offset + 4);
    if (bytes.toString('ascii', offset, offset + 4) === 'data') dataOffset = offset;
    if (bytes.toString('ascii', offset, offset + 4) === 'fmt ') formatOffset = offset;
    offset += 8 + size + size % 2;
  }
  if (dataOffset < 0 || formatOffset < 0) throw new Error('Offline WAV has no sample data or format');
  const channels = bytes.readUInt16LE(formatOffset + 10), rate = bytes.readUInt32LE(formatOffset + 12), bits = bytes.readUInt16LE(formatOffset + 22);
  if (channels !== 1 || rate !== 48000 || bits !== 16) throw new Error('Offline WAV must be mono PCM16 at 48 kHz');
  const dataSize = bytes.readUInt32LE(dataOffset + 4), end = dataOffset + 8 + dataSize;
  if (end > bytes.length || !bytes.subarray(dataOffset + 8, end).some(value => value !== 0)) throw new Error('Offline speech WAV is empty or silent');
  const header = Buffer.alloc(44), pcm = Buffer.concat([bytes.subarray(dataOffset + 8, end), Buffer.alloc(48_000)]);
  header.write('RIFF'); header.writeUInt32LE(36 + pcm.length, 4); header.write('WAVEfmt ', 8);
  header.writeUInt32LE(16, 16); header.writeUInt16LE(1, 20); header.writeUInt16LE(1, 22);
  header.writeUInt32LE(48000, 24); header.writeUInt32LE(96000, 28); header.writeUInt16LE(2, 32); header.writeUInt16LE(16, 34);
  header.write('data', 36); header.writeUInt32LE(pcm.length, 40);
  const loop = Buffer.concat([header, pcm]);
  await writeFile(file, loop);
  return file;
}
