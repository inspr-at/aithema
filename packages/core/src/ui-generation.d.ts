import type { OperationOptions, Health } from './plugin-contract.js';
export type UIImageMediaType = 'image/png' | 'image/webp' | 'image/jpeg';
export interface UIReference { bytes: Uint8Array; mediaType: UIImageMediaType; role: 'previous' | 'rejected' | 'upload' }
export interface UISpec {
  prompt: string; size?: '1024x1024' | '1536x1024' | '1024x1536'; quality?: 'low' | 'medium' | 'high' | 'auto'; format?: 'png' | 'webp';
  /** Private bytes only, at most nine references, each at most 12 MiB. */
  references?: UIReference[];
}
export type UIFeedback = string;
export interface UIArtifact {
  bytes: Uint8Array; mediaType: UIImageMediaType; width: number; height: number;
  promptDigest: string;
  provenance: {
    version: 1; origin: 'ai-generated' | 'ai-manipulated'; modality: 'image'; digitalSourceType: string;
    generatedAt: string; generator: { provider: string; model: string }; techniques: string[];
    assurances: { digitallySigned: false; imperceptibleWatermark: 'provider-status-unknown' };
    subject: { contentDigest: string; mediaType: string };
  };
}
export interface UIGeneration {
  generate(spec: UISpec, feedback: UIFeedback, options: OperationOptions): Promise<UIArtifact>;
  /** The artifact is the first previous reference; spec may add at most eight more. */
  edit(artifact: UIArtifact, spec: UISpec, feedback: UIFeedback, options: OperationOptions): Promise<UIArtifact>;
  health(options: Pick<OperationOptions, 'signal' | 'deadlineAt'>): Promise<Health>;
}
