import { serveExtractor } from '@inspr/aithema-core/extractor-process';
import { fileURLToPath } from 'node:url';
export function parseText(bytes, mediaType, limits) {
  void mediaType;
  // XML/JSON/Markdown remain literal, untrusted source text. No entity resolver,
  // URL loading, imported approval, executable markup or recursive expansion.
  const text = new TextDecoder('utf-8', { fatal: true }).decode(bytes)
    .replace(/\r\n?/gu, '\n').replace(/\n{4,}/gu, '\n\n\n').trim();
  return { segments: [{ text: text.slice(0, limits.maxChars + 1) }], truncated: text.length > limits.maxChars };
}
if (process.argv[1] === fileURLToPath(import.meta.url)) serveExtractor(parseText);
