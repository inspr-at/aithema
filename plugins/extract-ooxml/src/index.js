import { extractorManifest, EXTRACTOR_MEDIA_TYPES } from '@inspr/aithema-core/extractor';
import { createProcessExtractor } from '@inspr/aithema-core/extractor-process';
export const manifest = extractorManifest('extract-ooxml', ['docx', 'xlsx', 'pptx'].map(kind => EXTRACTOR_MEDIA_TYPES[kind]));
export function createOOXMLExtractor({ limits, workerURL = new URL('./ooxml-extract-child.js', import.meta.url) } = {}) {
  return createProcessExtractor({ manifest, limits, workerURL, parserURL: new URL('./ooxml-extract-child.js', import.meta.url) });
}
