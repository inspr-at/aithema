// Public contracts for later slices. Every operation takes this same authority/lifetime envelope.
export type Usage = { inputTokens: number; outputTokens: number };
export type Terminal = { attemptId: string } & ({ outcome: 'completed' | 'cancelled'; usage: Usage } | { outcome: 'uncertain' });
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
export interface UIGeneration {
  generate(request: { brief: string; format: string }, options: OperationOptions): Promise<{ content: string; format: string }>;
  edit(request: { content: string; instruction: string; format: string }, options: OperationOptions): Promise<{ content: string; format: string }>;
}
export interface Extractor { extract(request: { bytes: Uint8Array; mediaType: string }, options: OperationOptions): Promise<{ text: string }> }
export interface Exporter { export(request: { session: object; format: string }, options: OperationOptions): Promise<{ bytes: Uint8Array; mediaType: string }> }
export type VoiceEvent = { type: 'listening' | 'speaking' | 'partial' | 'final' | 'heard' | 'recovering' | 'recovered' | 'ended';
  callId: string; turnId?: string; text?: string; prefix?: string; reason?: string };
export interface VoiceSession {
  callId: string;
  events: AsyncIterable<VoiceEvent>;
  close(options: OperationOptions): Promise<void>;
  pause(options: OperationOptions): Promise<{ acknowledged: true }>;
  resume(options: OperationOptions): Promise<{ acknowledged: true }>;
  setInput(on: boolean, options: OperationOptions): Promise<void>;
  setOutput(on: boolean, options: OperationOptions): Promise<void>;
  sendText(text: string, options: OperationOptions): Promise<void>;
  updateContext(context: object, options: OperationOptions): Promise<void>;
  interrupt(options: OperationOptions): Promise<void>;
}
// Manifest also declares delegated/native reasoning, transcript policy and per-control capabilities.
// A future transport must implement durable identity, spend/liveness deadlines, confirmed closure
// and return control to the UI after three failed reconnects; no controls are admitted in this slice.
export interface LiveVoice { start(request: { callId: string; context: object }, options: OperationOptions): Promise<VoiceSession> }
export interface PrivateBinding {
  plugin: string; model: string; effort: string; endpoint: string; routing?: object;
  accountRef: string; secretRef: string; maxMicro: number; maxTokens: number;
  rates: { inputMicro: number; outputMicro: number };
  legal: { purpose: string; recipient: string; processors: string[]; dataCategories: string[];
    consentVersion: string; countries: string[]; training: boolean; retention: string; approved: boolean;
    evidence: { accountRef: string; secretRef: string; model: string; endpoint: string; routing: object;
      verifiedAt: number; expiresAt: number; qualified: boolean } };
}
export type LaneBindings = { reaction: PrivateBinding; understanding: PrivateBinding };
