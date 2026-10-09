import type { OperationOptions, Health } from './plugin-contract.js';
export interface UISpec { prompt: string; size?: '1024x1024' | '1536x1024' | '1024x1536'; quality?: 'low' | 'medium' | 'high' | 'auto'; format?: 'png' | 'webp' }
export type UIFeedback = string;
export interface UIArtifact {
  bytes: Uint8Array; mediaType: 'image/png' | 'image/webp'; width: number; height: number;
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
  edit(artifact: UIArtifact, feedback: UIFeedback, options: OperationOptions): Promise<UIArtifact>;
  health(options: Pick<OperationOptions, 'signal' | 'deadlineAt'>): Promise<Health>;
}
