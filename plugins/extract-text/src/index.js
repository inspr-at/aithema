import { extractorManifest, TEXT_MEDIA_TYPES } from '@inspr/aithema-core/extractor';
import { createProcessExtractor } from '@inspr/aithema-core/extractor-process';
export const manifest = extractorManifest('extract-text', [...TEXT_MEDIA_TYPES]);
export function createTextExtractor({ limits, workerURL = new URL('./text-extract-child.js', import.meta.url) } = {}) {
  return createProcessExtractor({ manifest, limits, workerURL, parserURL: new URL('./text-extract-child.js', import.meta.url) });
}
