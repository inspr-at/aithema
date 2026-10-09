// Trusted fixture only. Normal documents use the real parser; a sentinel stalls
// its CPU after IPC delivery so cancellation/deadlines must kill an actual process.
import { serveExtractor } from '../../packages/core/src/extractor-process.js';
import { EXTRACTOR_MEDIA_TYPES } from '../../packages/core/src/extractor.js';
serveExtractor(async (bytes, mediaType, limits) => {
  if (Buffer.from(bytes).includes('AIT-100-HANG')) {
    if (Buffer.from(bytes).includes('-DELAY-START')) await new Promise(resolve => setTimeout(resolve, 1100));
    process.send?.({ type: 'started' });
    for (;;) { /* deterministic non-cooperative CPU work */ }
  }
  const [module, operation] = mediaType === EXTRACTOR_MEDIA_TYPES.pdf ? ['extract-pdf/src/pdf-extract-child.js', 'parsePDF'] :
    Object.values(EXTRACTOR_MEDIA_TYPES).includes(mediaType) ? ['extract-ooxml/src/ooxml-extract-child.js', 'parseOOXML'] :
      ['extract-text/src/text-extract-child.js', 'parseText'];
  const parser = await import(`../../plugins/${module}`);
  return parser[operation](bytes, mediaType, limits);
});
