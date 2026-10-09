// Slim Gen-2 runtime/pdf-extract-child.js. Only the parent owns wall-clock timeout.
import { getDocumentProxy } from 'unpdf';
import { serveExtractor } from '@inspr/aithema-core/extractor-process';
import { fileURLToPath } from 'node:url';
export async function parsePDF(bytes, mediaType, limits) {
  void mediaType;
  let document;
  try {
    document = await getDocumentProxy(Uint8Array.from(bytes), { maxImageSize: 16_777_216, isEvalSupported: false,
      useSystemFonts: false, disableFontFace: true, stopAtErrors: true });
    if (!Number.isSafeInteger(document.numPages) || document.numPages < 1) return { reason: 'malformed' };
    if (document.numPages > limits.maxPages) return { reason: 'limit' };
    const segments = [];
    let chars = 0, truncated = false;
    // Read page by page, so reaching the output ceiling avoids parsing every later page.
    for (let page = 1; page <= document.numPages; page++) {
      const proxy = await document.getPage(page);
      const content = await proxy.getTextContent();
      let text = '';
      for (const item of content.items) {
        if (typeof item.str !== 'string') continue;
        text += item.str + (item.hasEOL ? '\n' : ' ');
        if (text.length + chars > limits.maxChars) { truncated = true; break; }
      }
      proxy.cleanup();
      text = text.trim();
      if (text) { segments.push({ text, page }); chars += text.length + (segments.length > 1 ? 2 : 0); }
      if (truncated || chars >= limits.maxChars) { truncated ||= page < document.numPages; break; }
    }
    // Textless/scanned PDFs are honestly unreadable; no OCR or network fallback.
    return { segments, truncated };
  } catch (error) {
    return { reason: /password|encrypt/iu.test(error?.name ?? '') ? 'encrypted' : 'malformed' };
  } finally { await document?.destroy?.(); }
}
if (process.argv[1] === fileURLToPath(import.meta.url)) serveExtractor(parsePDF);
