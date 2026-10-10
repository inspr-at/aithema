// Public contracts for later slices. Every operation takes this same authority/lifetime envelope.
export type Usage = { inputTokens: number; outputTokens: number };
export type Terminal = { attemptId: string; servedModel?: string } & ({ outcome: 'completed' | 'cancelled'; usage: Usage } | { outcome: 'uncertain' });
export interface OperationOptions {
  signal: AbortSignal;
  deadlineAt: number;
  attempt: { attemptId: string; claimId: string; consume(): Promise<void> | void };
  report(terminal: Terminal): Promise<void> | void;
}
export interface ProcessingScope {
  purpose: string; recipients: string[]; upstreamProcessors: string[]; dataCategories: string[];
  itemVersion: string | number;
  plugin?: string; model?: string; endpoint?: string; routing?: object; accountRef?: string; operation?: string;
}
export interface ConsentGrant extends ProcessingScope {
  covered: true; consentRevision: number; expiresAt: number;
  scope?: ProcessingScope; checkedAt?: number; withdrawn?: boolean;
}
export interface ConsentPort {
  coverage(query: { sessionId: string; scope: ProcessingScope; consentRevision: number },
    options?: Pick<OperationOptions, 'signal' | 'deadlineAt'>): Promise<ConsentGrant | { covered: false }> | ConsentGrant | { covered: false };
  grant?(query: { sessionId: string; consentRevision: number }): Promise<void> | void;
  withdraw?(query: { sessionId: string }): Promise<void> | void;
}
export interface Health { available: boolean; reason?: string }
export interface Reasoning {
  stream(request: { system: string; messages: { role: string; content: string }[] }, options: OperationOptions): AsyncIterable<string>;
  structured(request: { system: string; messages: { role: string; content: string }[]; schema: object }, options: OperationOptions): Promise<unknown>;
  health(options: Pick<OperationOptions, 'signal' | 'deadlineAt'>): Promise<Health>;
}
export interface STT {
  transcribe(request: { audio: Uint8Array; format: string; language: string }, options: OperationOptions): Promise<{ text: string }>;
  stream?(request: { audio: AsyncIterable<Uint8Array>; format: string }, options: OperationOptions): AsyncIterable<{ text: string; final: boolean }>;
}
export interface TTS { speak(request: { text: string; voice: string; format: string }, options: OperationOptions): AsyncIterable<Uint8Array> }
export type { UIGeneration, UISpec, UIFeedback, UIArtifact, UIReference, UIImageMediaType } from './ui-generation.js';
export type { HTMLGeneration, UIHTMLSpec, UIHTMLArtifact, HTMLProblem } from './ui-html.js';
export type { Extractor, Extraction, ExtractionSegment, ExtractionLimits, ExtractionMetadata, ExtractionOptions } from './extractor.js';
export interface Exporter { export(request: { session: object; format: string }, options: OperationOptions): Promise<{ bytes: Uint8Array; mediaType: string }> }
export type VoiceCapability = 'native' | 'emulated' | 'unavailable';
export interface LiveVoiceDeclaration {
  reasoning: 'delegated' | 'native';
  transcript: { finality: 'fragments' | 'turns'; persistence: 'durable' | 'memory-only' };
  capabilities: Record<'sendText' | 'updateContext' | 'setInput' | 'setOutput' | 'pause' | 'resume' | 'interrupt' | 'heard', VoiceCapability>;
  billing: { visitor: string; upstream: string };
}
export type VoiceEvent = { callId: string } & (
  { type: 'listening' | 'speaking' | 'recovering' | 'recovered' } |
  { type: 'partial' | 'final'; turnId: string; role: 'user' | 'assistant'; text: string } |
  { type: 'heard'; turnId: string; prefix: string } |
  { type: 'ended'; reason: string }
);
export interface VoiceUsage {
  providerSeconds: number; providerMinutes: number; pausedSeconds: number; visitorSeconds: number;
  upstreamMicro: number; visitorMicro: number; providerCredits?: number;
}
export interface VoiceTerminal {
  attemptId: string; callId: string; providerSessionId?: string;
  outcome: 'completed' | 'cancelled' | 'uncertain'; closureConfirmed: boolean;
  chargedMicro: number; usage: VoiceUsage | null; overrun?: boolean;
}
export type VoiceCommandOptions = Pick<OperationOptions, 'signal' | 'deadlineAt'>;
export interface VoiceStartOptions extends VoiceCommandOptions {
  attempt: OperationOptions['attempt'] & { maxMicro: number };
  report(terminal: VoiceTerminal): Promise<void> | void;
  spendDeadlineAt: number;
  browserLivenessDeadlineAt: number;
}
export interface VoiceSession {
  callId: string;
  readonly providerSessionId: string;
  events: AsyncIterable<VoiceEvent>;
  close(options: VoiceCommandOptions): Promise<Pick<VoiceTerminal, 'outcome' | 'closureConfirmed' | 'usage' | 'chargedMicro'>>;
  pause(options: VoiceCommandOptions): Promise<{ acknowledged: true; paused: true }>;
  resume(options: VoiceCommandOptions): Promise<{ acknowledged: true; paused: false }>;
  setInput(on: boolean, options: VoiceCommandOptions): Promise<void>;
  setOutput(on: boolean, options: VoiceCommandOptions): Promise<void>;
  sendText(text: string, options: VoiceCommandOptions): Promise<void>;
  updateContext(context: object | string, options: VoiceCommandOptions): Promise<void>;
  interrupt(options: VoiceCommandOptions): Promise<void>;
  heartbeat(options: VoiceCommandOptions): Promise<{ acknowledged: true; browserLivenessDeadlineAt: number }>;
}
// Joined contract: server consumes authority; browser receives only a short-lived credential.
// Each delegated reasoning call and reconnect needs its own separately admitted claim.
export interface LiveVoice { start(request: { callId: string; context?: object }, options: VoiceStartOptions): Promise<VoiceSession> }
export interface PrivateBinding {
  plugin: string; model: string; effort: string; endpoint: string; routing?: object;
  accountRef: string; secretRef: string; maxMicro: number; maxTokens: number;
  rates: { inputMicro: number; outputMicro: number; inputUSD?: number; outputUSD?: number };
  legal: { purpose: string; recipient: string; processors: string[]; dataCategories: string[];
    consentVersion: string; countries: string[]; training: boolean; retention: string; approved: boolean;
    evidence: { accountRef: string; secretRef: string; model: string; endpoint: string; routing: object;
      verifiedAt: number; expiresAt: number; qualified: boolean } };
}
export type LaneBindings = { reaction: PrivateBinding; understanding: PrivateBinding };
