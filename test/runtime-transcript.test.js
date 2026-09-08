import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

import {
  MAX_MESSAGE_CHARS,
  MAX_TRANSCRIPT_ENTRIES,
  MAX_TRANSCRIPT_CHARS,
  appendTurn,
  assistantTurnForPersistence,
  boundedTranscript,
  canAppendTranscript,
} from '../runtime/transcript.js';

describe('transcript bounds preserve START ceilings', () => {
  it('matches START MAX_MESSAGE_CHARS, MAX_TRANSCRIPT_ENTRIES, MAX_TRANSCRIPT_CHARS', () => {
    assert.equal(MAX_MESSAGE_CHARS, 8_000);
    assert.equal(MAX_TRANSCRIPT_ENTRIES, 80);
    assert.equal(MAX_TRANSCRIPT_CHARS, 96_000);
  });

  it('does not persist an incomplete assistant stream', () => {
    assert.equal(assistantTurnForPersistence('partial answer', false), null);
    assert.equal(assistantTurnForPersistence('   ', true), null);
    assert.equal(assistantTurnForPersistence('complete answer', true), 'complete answer');
  });

  it('dedupes identical last role+content and bounds recency', () => {
    let transcript = [];
    const first = appendTurn(transcript, 'user', 'hello');
    assert.equal(first.ok, true);
    transcript = first.transcript;
    const replay = appendTurn(transcript, 'user', 'hello');
    assert.equal(replay.ok, true);
    assert.equal(replay.deduped, true);
    assert.equal(replay.transcript.length, 1);
    assert.equal(replay.at, first.at);

    const long = 'x'.repeat(MAX_TRANSCRIPT_CHARS);
    const full = boundedTranscript([
      { role: 'user', content: long, at: '1' },
      { role: 'assistant', content: 'kept', at: '2' },
    ]);
    assert.equal(full.at(-1).content, 'kept');
    assert.equal(canAppendTranscript({ transcript: full }, 'more'), true);
  });

  it('transcript module has no fetch, fs, process.env, or vendor SDK imports', () => {
    const source = readFileSync(fileURLToPath(new URL('../runtime/transcript.js', import.meta.url)), 'utf8');
    assert.equal(/fetch\(|process\.env|node:fs|anthropic|openrouter|elevenlabs/.test(source), false);
  });
});
