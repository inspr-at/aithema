import type { AudioFormatPort, OperationOptions, VoiceCommandOptions } from './plugin-contract.js';

/** Separately admitted component usage, in provider units and whole USD micro-dollars. */
export interface ComponentUsage {
  attemptId: string; role: 'stt' | 'reasoning' | 'tts';
  unit: 'seconds' | 'tokens' | 'characters' | 'bytes' | 'credits'; quantity: number;
  upstreamMicro: number; source: string; estimated: boolean;
}
/** Uncertain terminals retain at least the admitted maximum; no aggregate call charge. */
export type ComponentTerminal = { attemptId: string; servedModel?: string; chargedMicro?: number } &
  ({ outcome: 'completed' | 'cancelled'; usage: ComponentUsage } |
   { outcome: 'uncertain'; chargedMicro: number; usage?: ComponentUsage });
export interface ComponentOperationOptions extends Omit<OperationOptions, 'attempt' | 'report'> {
  /** Fresh authority for this one invocation. Retries and TTS fragments need new claims. */
  attempt: OperationOptions['attempt'] & { maxMicro: number };
  report(terminal: ComponentTerminal): Promise<void> | void;
}
export interface STTComponentCapabilities {
  streaming: boolean;
  /** Explicit language tags; an empty list promises no language support. No wildcard. */
  languages: readonly string[];
  /** Streaming text replaces the previous hypothesis; exactly one final ends the utterance. */
  partialTranscripts: boolean;
}
export interface TTSComponentCapabilities {
  streaming: boolean;
  languages: readonly string[];
  /** Alignment permits a prefix only after trusted playback confirms the associated bytes. */
  heardPrefix: 'unavailable' | 'aligned';
}
export interface STTRequest { audio: Uint8Array; format: string; language: string }
export interface STTStreamRequest { audio: AsyncIterable<Uint8Array>; format: string; language?: string }
export interface STTTranscript { text: string; final: boolean }
export interface TTSRequest { text: string; voice: string; format: string; language?: string }
/** textEnd is a UTF-16 offset into request.text, never inside a surrogate pair.
 * Offsets are nondecreasing; after the entire audio chunk is played, text.slice(0, textEnd)
 * is the conservative audible prefix. Synthesis/delivery alone is never heard evidence. */
export interface TTSAlignedChunk { audio: Uint8Array; textEnd: number }
export interface STTComponent extends AudioFormatPort {
  readonly capabilities: STTComponentCapabilities;
  transcribe(request: STTRequest, options: ComponentOperationOptions): Promise<{ text: string }>;
  /** Required iff streaming is declared; each utterance is one admitted invocation. */
  stream?(request: STTStreamRequest, options: ComponentOperationOptions): AsyncIterable<STTTranscript>;
}
export interface TTSComponent extends AudioFormatPort {
  readonly capabilities: TTSComponentCapabilities;
  /** Chunks use the negotiated encoding/rate/channels. Exhaustion must include settlement. */
  speak(request: TTSRequest, options: ComponentOperationOptions): AsyncIterable<Uint8Array>;
  /** Required for heardPrefix=aligned. Use instead of speak, with its own single claim. */
  speakAligned?(request: TTSRequest, options: ComponentOperationOptions): AsyncIterable<TTSAlignedChunk>;
}
export interface VoiceCompositionCapabilities {
  languages: readonly string[];
  streaming: { stt: boolean; tts: boolean };
  partialTranscripts: boolean;
  /** An upper bound: the pipeline must also have trusted playback confirmations. */
  heardPrefix: 'unavailable' | 'aligned';
}
export function assertSTTComponent<T extends STTComponent>(component: T): T;
export function assertTTSComponent<T extends TTSComponent>(component: T): T;
/** Validates declarations, not provider behaviour or qualification. */
export function voiceCompositionCapabilities(stt: STTComponent, tts: TTSComponent): VoiceCompositionCapabilities;
export function assertComponentUsage<T extends ComponentUsage>(usage: T): T;
export interface ComponentInvocation {
  readonly signal: AbortSignal;
  /** Exactly once, immediately before provider work, after consume resolves. */
  dispatch(): void;
  /** Record authoritative completion usage; invalid/over-ceiling usage retains uncertainty. */
  usage(quantity: number, upstreamMicro: number, source: string, estimated?: boolean): void;
  /** Only a transport-observed 4xx without usage, excluding 408/499, can release dispatch. */
  rejectWithoutUsage(status: number): void;
  /** Idempotent; first terminal wins, including abort/deadline. Report failures propagate. */
  finish(completed: boolean): Promise<void>;
}
export function componentInvocation(options: ComponentOperationOptions,
  descriptor: { role: ComponentUsage['role']; unit: ComponentUsage['unit']; model: string }): Promise<ComponentInvocation>;
export function boundedEvents<T>(source: AsyncIterable<T>, options: VoiceCommandOptions): AsyncGenerator<T, void, unknown>;
export interface AudioQueue extends AsyncIterableIterator<Uint8Array> {
  push(value: Uint8Array): void;
  /** Drain existing chunks, then finish. */
  end(): void;
  /** Discard queued bytes and finish. */
  clear(): void;
  return(): Promise<IteratorResult<Uint8Array>>;
}
export function audioQueue(limit?: number): AudioQueue;
export const TTS_SPEAK_BYTES: number;
export const TTS_MESSAGE_BYTES: number;
export const TTS_WIRE_CHARACTERS: number;
