import { readFile } from 'node:fs/promises';

// Independent synthetic oracles shared by the ElevenLabs wire replay and the
// composed coordinator. No production codec or recorder creates expectations.
export async function readVoiceObservabilityFixture(kind) {
  if (!['callbacks', 'reconciliation'].includes(kind)) throw new TypeError('Unknown fixture');
  const bytes = await readFile(new URL(`./fixtures/voice-observability-${kind}.json`, import.meta.url), 'utf8');
  return { bytes, fixture: JSON.parse(bytes) };
}

// Decode only the hand-authored oracle, never an observed production response.
export function voiceFixtureFrames(record) {
  if (record.response.headers['content-type'] === 'application/json') return [JSON.parse(record.response.body)];
  return record.response.body.split('\n\n').filter(Boolean).map(frame => {
    if (!frame.startsWith('data: ')) throw new TypeError('Expected fixture SSE data');
    return frame.slice(6) === '[DONE]' ? '[DONE]' : JSON.parse(frame.slice(6));
  });
}
