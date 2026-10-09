import { extractorManifest, EXTRACTOR_MEDIA_TYPES } from '@inspr/aithema-core/extractor';
import { createProcessExtractor } from '@inspr/aithema-core/extractor-process';
export const manifest = extractorManifest('extract-pdf', [EXTRACTOR_MEDIA_TYPES.pdf]);
export function createPDFExtractor({ limits, workerURL = new URL('./pdf-extract-child.js', import.meta.url) } = {}) {
  return createProcessExtractor({ manifest, limits, workerURL, parserURL: new URL('./pdf-extract-child.js', import.meta.url),
    dependencies: { unpdf: new URL('../package.json', import.meta.resolve('unpdf')) } });
}
