import type { OperationOptions, Health } from './plugin-contract.js';
export type HTMLProblem = 'empty' | 'size' | 'utf-8' | 'control-character' | 'document' | 'external-reference' | 'base' |
  'http-equiv' | 'form' | 'embedded-content' | 'module-script' | 'network-api' | 'storage' | 'navigation' | 'obfuscation';
/** Host-built click-dummy request. `prompt` is the trusted host brief; everything else is untrusted visitor data. */
export interface UIHTMLSpec {
  prompt: string;
  understanding?: { summary?: string; slots?: Record<string, string | null>; openQuestions?: string[] };
  visitorWords?: string[];
  /** BCP 47 page language; defaults to the language of the visitor's words. */
  language?: string;
  /** Overrides the revision derived from the previous dummy's head comment. */
  revision?: number;
  /** Not supported by HTML generation; must be absent or empty. */
  references?: [];
}
/** One self-contained UTF-8 document of at most 512 KiB, rendered only in the sandboxed preview. */
export interface UIHTMLArtifact {
  bytes: Uint8Array; mediaType: 'text/html'; promptDigest: string;
  provenance: {
    version: 1; origin: 'ai-generated' | 'ai-manipulated'; modality: 'html'; digitalSourceType: string;
    generatedAt: string; generator: { provider: string; model: string }; techniques: string[];
    assurances: { digitallySigned: false; imperceptibleWatermark: 'provider-status-unknown' };
    subject: { contentDigest: string; mediaType: 'text/html' };
  };
}
export interface HTMLGeneration {
  generate(spec: UIHTMLSpec, feedback: string, options: OperationOptions): Promise<UIHTMLArtifact>;
  /** The artifact is the previous dummy; feedback is required. */
  edit(artifact: UIHTMLArtifact, spec: UIHTMLSpec, feedback: string, options: OperationOptions): Promise<UIHTMLArtifact>;
  health(options: Pick<OperationOptions, 'signal' | 'deadlineAt'>): Promise<Health>;
}
export const HTML_MEDIA_TYPE: 'text/html';
export const MAX_HTML_BYTES: number;
export const HTML_PREVIEW_CSP: string;
export const HTML_PREVIEW_HOST_CSP: string;
export function frameDocument(html: string, options?: { standalone?: boolean }): string;
export function inspectHTML(bytes: Uint8Array): { ok: boolean; problems: HTMLProblem[] };
export function isHTMLArtifact(artifact: unknown): artifact is UIHTMLArtifact;
export function verifyHTMLArtifact(artifact: unknown): Promise<boolean>;
export function contentDigest(bytes: Uint8Array): Promise<string>;
