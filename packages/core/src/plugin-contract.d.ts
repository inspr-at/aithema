// Public contracts for later slices. Every operation takes this same authority/lifetime envelope.
export type Usage = { inputTokens: number; outputTokens: number };
// A trusted provider may report an actual USD cost in whole micro-dollars.
// Without it the host uses token rates or the uncertain reservation maximum.
export type Terminal = { attemptId: string; servedModel?: string; chargedMicro?: number } & ({ outcome: 'completed' | 'cancelled'; usage: Usage } | { outcome: 'uncertain'; usage?: Usage });
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
export interface STT extends Partial<AudioFormatPort> {
  transcribe(request: { audio: Uint8Array; format: string; language: string }, options: OperationOptions): Promise<{ text: string }>;
  stream?(request: { audio: AsyncIterable<Uint8Array>; format: string }, options: OperationOptions): AsyncIterable<{ text: string; final: boolean }>;
}
export interface TTS extends Partial<AudioFormatPort> { speak(request: { text: string; voice: string; format: string }, options: OperationOptions): AsyncIterable<Uint8Array> }
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
  ownership?: Record<'stt' | 'tts' | 'turnTaking', 'provider' | 'server' | 'browser'>;
  optionalCapabilities?: Partial<Record<'forceInterrupt' | 'alignment' | 'playbackRetry' | 'metering' | 'speakText', VoiceCapability>>;
}
export type VoiceEvent = { callId: string; providerSessionId?: string; generation?: string | number; epoch?: number } & (
  { type: 'listening' | 'speaking'; replay?: boolean; completed?: boolean } |
  { type: 'recovering' | 'recovered' } |
  { type: 'waiting'; reason?: string } |
  { type: 'partial' | 'final'; turnId: string; role: 'user' | 'assistant'; text: string } |
  { type: 'heard'; turnId: string; prefix: string } |
  { type: 'ended'; reason: string }
);
export interface VoiceUsage {
  providerSeconds: number; providerMinutes: number; pausedSeconds: number; visitorSeconds: number;
  upstreamMicro: number; visitorMicro: number; providerCredits?: number; characters?: number;
  costSource?: string; costEstimated?: boolean; usdPerCredit?: number; estimateMicroPerMinute?: number;
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
  retryPlayback?(options: VoiceCommandOptions): Promise<void>;
  readonly replaying?: boolean;
  /** Speak an already persisted assistant final through ordinary speech admission. */
  speakReply?(reply: { turnId: string; text: string }, options?: VoiceCommandOptions): Promise<{ kind: 'text' | 'audio' | 'busy'; text?: string }>;
  replayLastReply?(options?: VoiceCommandOptions): Promise<{ kind: 'text' | 'audio'; text: string }>;
  stopReplay?(): Promise<void>;
  heartbeat(options: VoiceCommandOptions): Promise<{ acknowledged: true; browserLivenessDeadlineAt: number }>;
}
// Joined contract: server consumes authority; browser receives only a short-lived credential.
// Each delegated reasoning call and reconnect needs its own separately admitted claim.
export interface LiveVoice {
  start(request: { callId: string; context?: object }, options: VoiceStartOptions): Promise<VoiceSession>;
  health?(options: VoiceCommandOptions): Promise<Health>;
  ports?: VoicePorts;
}

// Additive composition ports. Existing session methods and duration terminals keep
// their contract. Configuration and opaque grant payloads belong to the adapter.
export interface VoiceMediaGrant {
  callId: string; providerSessionId: string; expiresAt: number; opaque: unknown;
}
export interface VoiceServerSegment {
  callId: string; providerSessionId: string; grant: VoiceMediaGrant;
}
export interface VoiceReconciliationEvidence {
  details: unknown;
  terminal: Pick<VoiceTerminal, 'providerSessionId' | 'outcome' | 'closureConfirmed' | 'usage' | 'chargedMicro'>;
}
export interface VoiceCallbackRoute {
  method: string; path: string; handle(request: Request): Promise<Response>;
  /** Preserve an adapter's hidden-path rejection without invoking a mismatched handler. */
  methodNotAllowedStatus?: 404 | 405;
}
/** Private adapter data; the generic server only forwards it at segment start. */
export interface VoiceCallbackContext {
  identity?: string; details?: object; request?: object; receipt?: object;
  prepare(): void | Promise<void>;
  revoke(): void | Promise<void>;
}
export interface VoiceServerCallbacks {
  readonly callbackRoutes: readonly VoiceCallbackRoute[];
  prepareCallback?(request: unknown): VoiceCallbackContext;
  revokeRecord?(record: object): void | Promise<void>;
}
export interface VoiceServerAdapter<Config = unknown, StartRequest = { callId: string }, Segment extends VoiceServerSegment = VoiceServerSegment> {
  readonly config?: Config;
  validateConfig(config: unknown): Config;
  /** Optional legacy host normalization; private field names stay in the adapter. */
  normalizeBinding?(binding: object): object;
  readonly binding?: { endpoint: string; secretRef: string; upstreamMicroPerMinute: number;
    visitorMicroPerMinute: number; reservationSeconds?: number; adapterConfig?: Config };
  matchesConfig?(config: unknown): boolean;
  startSegment(request: StartRequest, options: VoiceStartOptions): Promise<Segment>;
  stopSegment(segment: Segment, options: VoiceCommandOptions & { reason?: string; outcome?: 'completed' | 'cancelled' }): Promise<VoiceReconciliationEvidence['terminal']>;
  reconciliationEvidence(request: { call: object; maxMicro: number; outcome?: 'completed' | 'cancelled' }, options: VoiceCommandOptions): Promise<VoiceReconciliationEvidence>;
  quoteSpeakText?(request: { text: string }, options: VoiceCommandOptions): Promise<VoiceTextQuote>;
  speakText?(request: { text: string; quote: VoiceTextQuote }, options: VoiceTextOptions): Promise<VoiceTextAudio>;
  // Provider request authentication must precede the generic operation boundary.
  callbackRoutes?: readonly VoiceCallbackRoute[];
  // Bind server-owned operations and host-private callback configuration once.
  bindCallbacks?(ports: object): VoiceServerCallbacks;
}
export interface VoiceTextQuote { maxMicro: number; opaque?: unknown }
export interface VoiceTextAudio { audio: { format: 'pcm_16000'; data: string }; usage?: VoiceUsage & { characters: number } }
export interface VoiceTextOptions extends VoiceCommandOptions {
  attempt: OperationOptions['attempt'];
  report(terminal: Omit<VoiceTerminal, 'attemptId' | 'callId'>): Promise<void> | void;
}
export interface VoicePresentation {
  label: string;
  translations?: { locale: string; label: string;
    consentItem?: { id: string; version: number; title: string; recipients: string; text: string } }[];
}
export interface VoiceMediaOptions extends VoiceCommandOptions {
  holdSignal?: AbortSignal;
  onPlaybackBlocked?(retry: () => Promise<void>): void;
}
export interface VoiceBrowserMedia {
  connect(grant: VoiceMediaGrant, options: VoiceMediaOptions): Promise<VoiceSession>;
  capture(session: VoiceSession, on: boolean, options: VoiceCommandOptions): Promise<void>;
  playback(session: VoiceSession, on: boolean, options: VoiceCommandOptions): Promise<void>;
  retryPlayback?(session: VoiceSession, options: VoiceCommandOptions): Promise<void>;
  teardown(session: VoiceSession, options: VoiceCommandOptions): ReturnType<VoiceSession['close']>;
}
export interface VoiceOperationIdentity {
  key: string; callId: string; providerSessionId: string; ordinal: number | null;
}
// Only an authenticated adapter or an in-process server coordinator may construct
// this envelope. Browser transcript receipts never authorize executor admissions.
export interface VoiceReplyEnvelope {
  source: 'authenticated-provider' | 'server-coordinator';
  payload: unknown;
}
export type VoiceReplyEvent =
  { type: 'operation'; operation: VoiceOperationIdentity; replyId: string } |
  { type: 'delta'; text: string } |
  { type: 'completion'; replyId: string; text: string };
export interface VoiceReplyExecutor {
  execute(envelope: VoiceReplyEnvelope, options: VoiceCommandOptions): AsyncIterable<VoiceReplyEvent>;
}
export interface AudioFormat {
  encoding: string; sampleRateHz: number; channels: number; mediaType?: string;
}
export interface AudioFormatPort {
  negotiateAudioFormat(offered: readonly AudioFormat[], options: VoiceCommandOptions): Promise<AudioFormat>;
}
export type { ComponentUsage, ComponentTerminal, ComponentOperationOptions, STTComponent, TTSComponent,
  STTComponentCapabilities, TTSComponentCapabilities, STTRequest, STTStreamRequest, STTTranscript,
  TTSRequest, TTSAlignedChunk, VoiceCompositionCapabilities, ComponentInvocation, AudioQueue } from './voice-components.js';
import type { STTComponent, TTSComponent } from './voice-components.js';
export interface VoicePorts {
  serverAdapter?: VoiceServerAdapter;
  browserMedia?: VoiceBrowserMedia;
  replyExecutor?: VoiceReplyExecutor;
  components?: { stt?: STTComponent; tts?: TTSComponent };
}
export interface PrivateBinding {
  plugin: string; model: string; effort: string; endpoint: string; routing?: object;
  accountRef: string; secretRef: string; maxMicro: number; maxTokens: number;
  rates: { inputMicro: number; outputMicro: number; inputUSD?: number; outputUSD?: number };
  legal: { purpose: string; recipient: string; processors: string[]; dataCategories: string[];
    consentVersion: string;
    /** Recipients' seat countries (ISO alpha-2); subject to the host country policy and EU-only for eu. */
    countries: string[];
    /** Contractually guaranteed processing countries (ISO alpha-2, non-empty when present).
     * Required and EU-only for eu, alongside EU-only recipient seats; undefined means absent. */
    processingCountries?: string[];
    training: boolean; retention: string; approved: boolean;
    evidence: { accountRef: string; secretRef: string; model: string; endpoint: string; routing: object;
      verifiedAt: number; expiresAt: number; qualified: boolean } };
}
export type LaneBindings = { reaction: PrivateBinding; understanding: PrivateBinding };

/** Trusted host authentication, independent of visitor identity and ownership. */
export interface OperatorSessionPort {
  handle(request: Request): Promise<Response | null>;
  session(request: Request): { name: string; subject: string } | null;
  entry(): { provider: string; url: string; logoutUrl: string };
}
export interface OperatorIdentityProvider {
  label: string;
  sessionNamespace: string;
  allows(subject: string): boolean;
  begin(): { url: string; pending: { state: string; nonce: string; verifier: string } };
  complete(code: string, pending: { state: string; nonce: string; verifier: string }, signal?: AbortSignal): Promise<{ subject: string; name: string }>;
}
