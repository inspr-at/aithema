export interface ExtractionLimits {
  maxBytes: number; maxChars: number; maxPages: number; deadlineMs: number;
  maxEntries: number; maxPartBytes: number; maxUncompressedBytes: number;
  maxCompressionRatio: number; maxHeapMb: number;
}
export interface ExtractionMetadata { mediaType?: string; filename?: string }
export interface ExtractionOptions { signal?: AbortSignal; deadlineAt?: number; limits?: Partial<ExtractionLimits> }
export interface ExtractionSegment { id: string; text: string; page?: number }
export type Extraction = { text: string; segments: ExtractionSegment[]; mediaType: string; truncated: boolean; limits: ExtractionLimits } &
  ({ status: 'accepted'; reason?: never } | { status: 'unreadable'; reason: 'unsupported' | 'empty' | 'malformed' | 'encrypted' | 'limit' });
export interface Extractor {
  extract(bytes: Uint8Array, metadata: ExtractionMetadata, options: ExtractionOptions): Promise<Extraction>;
  health(options?: Pick<ExtractionOptions, 'signal' | 'deadlineAt'>): Promise<{ available: boolean; reason?: string }>;
}
export const EXTRACTOR_LIMITS: Readonly<ExtractionLimits>;
export const UPLOAD_LIMITS: Readonly<{maxRequestBytes: number; maxFilesPerRequest: number; maxDocumentsPerSession: number; requestBudgetMs: number; providerDocumentChars: number}>;
export const EXTRACTOR_MEDIA_TYPES: Readonly<{pdf: string; docx: string; xlsx: string; pptx: string}>;
export const TEXT_MEDIA_TYPES: readonly string[];
export function normalizeExtractorLimits(value?: Partial<ExtractionLimits>): Readonly<ExtractionLimits>;
export function sniffDocument(bytes: Uint8Array, limits?: ExtractionLimits): {mediaType: string; reason?: string};
export function sniffUploadMime(bytes: Uint8Array, limits?: ExtractionLimits): string;
export function isExtraction(value: unknown): value is Extraction;
export function assertExtractor<T extends Extractor>(plugin: T): T;
export function createExtractor(options: {plugins: (Extractor & {manifest: object})[]; limits?: Partial<ExtractionLimits>}): Pick<Extractor, 'extract'> & {limits: Readonly<ExtractionLimits>};
