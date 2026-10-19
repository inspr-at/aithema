import type { LiveVoice, VoiceSession, VoiceEvent, VoicePorts, VoiceStartOptions, VoiceReplyEnvelope,
  VoiceReplyExecutor, STT, TTS, STTComponent, TTSComponent, ComponentTerminal, OperationOptions,
  VoiceServerAdapter, VoiceBrowserMedia, LiveVoiceDeclaration } from '../../packages/core/src/plugin-contract.js';

declare const session: VoiceSession;
declare const options: VoiceStartOptions;
declare const legacy: LiveVoice;
declare const oldOptions: OperationOptions;
declare const oldSTT: STT;
declare const oldTTS: TTS;
legacy.start({ callId: 'call' }, options);
oldSTT.transcribe({ audio: new Uint8Array(), format: 'pcm', language: 'de' }, oldOptions);
oldTTS.speak({ text: 'Hallo', voice: 'voice', format: 'pcm' }, oldOptions);
session.close(options); session.pause(options); session.resume(options);
session.setInput(false, options); session.setOutput(false, options);
session.sendText('Ja', options);
session.sendText('Ja', { ...options, deliveryId: 'persisted-typed-turn' }); session.updateContext('context', options); session.interrupt(options);
const waiting: VoiceEvent = { type: 'waiting', reason: 'recovery-failed', callId: 'call', providerSessionId: 'segment', generation: 2, epoch: 3 };
const oldDeclaration: LiveVoiceDeclaration = { reasoning: 'delegated',
  transcript: { finality: 'turns', persistence: 'durable' }, billing: { visitor: 'duration', upstream: 'duration' },
  capabilities: { sendText: 'native', updateContext: 'native', setInput: 'native', setOutput: 'emulated',
    pause: 'emulated', resume: 'emulated', interrupt: 'native', heard: 'unavailable' } };
declare const adapter: VoiceServerAdapter;
declare const browserMedia: VoiceBrowserMedia;
declare const replyExecutor: VoiceReplyExecutor;
declare const stt: STTComponent;
declare const tts: TTSComponent;
const ports: VoicePorts = { serverAdapter: adapter, browserMedia, replyExecutor, components: { stt, tts } };
const envelope: VoiceReplyEnvelope = { source: 'authenticated-provider', payload: {} };
replyExecutor.execute(envelope, options);
const terminal: ComponentTerminal = { attemptId: 'attempt', outcome: 'completed',
  usage: { attemptId: 'attempt', role: 'stt', unit: 'seconds', quantity: 1.5, upstreamMicro: 10, source: 'provider', estimated: false } };
// @ts-expect-error Browser receipts cannot label themselves as an executor source.
const untrusted: VoiceReplyEnvelope = { ...envelope, source: 'browser-final' };
// @ts-expect-error Operation keys are returned by server execution, never input authority.
const forgedEnvelope: VoiceReplyEnvelope = { ...envelope, operation: { key: 'forged' } };
// @ts-expect-error Component usage cannot silently become token usage.
const invented: ComponentTerminal = { attemptId: 'attempt', outcome: 'completed', usage: { inputTokens: 1, outputTokens: 2 } };
// @ts-expect-error Completion without an admitted attempt has no terminal identity.
const unidentified: ComponentTerminal = { outcome: 'completed', usage: terminal.usage };
void [waiting, oldDeclaration, ports, untrusted, forgedEnvelope, invented, unidentified];
