import type { OperationOptions, Health } from './plugin-contract.js';
export type UIImageMediaType = 'image/png' | 'image/webp' | 'image/jpeg';
export interface UIReference { bytes: Uint8Array; mediaType: UIImageMediaType; role: 'previous' | 'rejected' | 'upload' }
export interface UISpec {
  prompt: string; size?: '1024x1024' | '1536x1024' | '1024x1536'; quality?: 'low' | 'medium' | 'high' | 'auto'; format?: 'png' | 'webp';
  /** Private bytes only, at most nine references, each at most 12 MiB. */
  references?: UIReference[];
}
export type UIFeedback = string;
export interface ImageCredentials {
  c2pa: 'present' | 'absent'; manifestByteLength: number; verification: 'not-verified';
}
export interface UIArtifact {
  bytes: Uint8Array; mediaType: UIImageMediaType; width: number; height: number;
  promptDigest: string;
  provenance: {
    version: 1; origin: 'ai-generated' | 'ai-manipulated'; modality: 'image'; digitalSourceType: string;
    generatedAt: string; generator: { provider: string; model: string }; techniques: string[];
    /** Absent only on legacy stored artifacts. Presence never means signature verification. */
    promptDigest?: string; credentials?: ImageCredentials;
    assurances: { digitallySigned: false; imperceptibleWatermark: 'provider-status-unknown' } |
      { digitallySigned: false; imperceptibleWatermark: 'provider-declared' | 'unknown'; watermarkSource: string | null };
    subject: { contentDigest: string; mediaType: string };
  };
}
export interface UIGeneration {
  generate(spec: UISpec, feedback: UIFeedback, options: OperationOptions): Promise<UIArtifact>;
  /** The artifact is the first previous reference; spec may add at most eight more. */
  edit(artifact: UIArtifact, spec: UISpec, feedback: UIFeedback, options: OperationOptions): Promise<UIArtifact>;
  health(options: Pick<OperationOptions, 'signal' | 'deadlineAt'>): Promise<Health>;
}
