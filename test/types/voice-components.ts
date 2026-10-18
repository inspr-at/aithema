import { componentInvocation, assertSTTComponent, assertTTSComponent, voiceCompositionCapabilities,
  assertComponentUsage, audioQueue, boundedEvents } from '@inspr/aithema-core/voice-components';
import type { STTComponent, TTSComponent, ComponentOperationOptions, ComponentTerminal,
  TTSAlignedChunk } from '@inspr/aithema-core/voice-components';
import type { STTComponent as LegacySTT, ComponentOperationOptions as LegacyOptions } from '@inspr/aithema-core/plugin-contract';
const stt: STTComponent = {
  capabilities: { streaming: true, partialTranscripts: true, languages: ['de'] },
  async negotiateAudioFormat(offered) { return offered[0]; },
  async transcribe(request, options) { options.attempt.maxMicro.toFixed(); return { text: request.language }; },
  async *stream() { yield { text: 'Hallo', final: true }; },
};
const tts: TTSComponent = {
  capabilities: { streaming: true, languages: ['de'], heardPrefix: 'aligned' },
  async negotiateAudioFormat(offered) { return offered[0]; },
  async *speak() { yield new Uint8Array(2); },
  async *speakAligned() { yield { audio: new Uint8Array(2), textEnd: 5 }; },
};
const legacy: LegacySTT = stt;
const options: ComponentOperationOptions = { signal: new AbortController().signal, deadlineAt: Date.now() + 1000,
  attempt: { attemptId: 'a', claimId: 'c', maxMicro: 100, consume() {} }, report(terminal) {
    if (terminal.outcome === 'uncertain') terminal.chargedMicro.toFixed();
    else assertComponentUsage(terminal.usage);
  } };
const oldOptions: LegacyOptions = options;
const invocation = await componentInvocation(options, { role: 'tts', unit: 'characters', model: 'fake' });
invocation.dispatch(); invocation.usage(5, 10, 'fake'); await invocation.finish(true);
assertSTTComponent(stt); assertTTSComponent(tts); voiceCompositionCapabilities(stt, tts);
const queue = audioQueue(); queue.push(new Uint8Array(2)); queue.end();
for await (const bytes of boundedEvents(queue, options)) bytes.byteLength.toFixed();
const alignment: TTSAlignedChunk = { audio: new Uint8Array(2), textEnd: 5 };
// @ts-expect-error Every component needs its own explicit admission ceiling.
const missingMax: ComponentOperationOptions['attempt'] = { attemptId: 'a', claimId: 'c', consume() {} };
// @ts-expect-error Uncertain terminals explicitly retain their charge.
const missingCharge: ComponentTerminal = { attemptId: 'a', outcome: 'uncertain' };
// @ts-expect-error Capability languages are explicit language tags, not a string.
const wrongCaps: STTComponent['capabilities'] = { streaming: true, partialTranscripts: true, languages: 'de' };
// @ts-expect-error Component usage cannot be confused with reasoning tokens.
const wrongUsage: ComponentTerminal = { attemptId: 'a', outcome: 'completed', usage: { inputTokens: 1, outputTokens: 2 } };
void [legacy, oldOptions, alignment, missingMax, missingCharge, wrongCaps, wrongUsage];
