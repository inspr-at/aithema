import { createTextExtractor } from '@inspr/aithema-plugin-extract-text';
import { createPDFExtractor } from '@inspr/aithema-plugin-extract-pdf';
import { createOOXMLExtractor } from '@inspr/aithema-plugin-extract-ooxml';
/** Local, offline, zero-cost extractors. No provider fallback or legal item. */
export function registerDemoExtractors(registry, presets) {
  const extractors = [createTextExtractor(), createPDFExtractor(), createOOXMLExtractor()];
  for (const plugin of extractors) registry.register(plugin);
  for (const name of ['best', 'custom']) if (presets[name]?.plugins.length) {
    presets[name].plugins.push(...extractors.map(p => p.manifest.id));
    presets[name].extractors = extractors.map(p => ({ plugin: p.manifest.id }));
  }
  return extractors;
}
