import { PluginError } from '@inspr/aithema-core';
import { htmlArtifact as createArtifact } from '@inspr/aithema-core/ui-html-artifact';
export { promptDigest, previousDocument } from '@inspr/aithema-core/ui-html-artifact';
export const htmlArtifact = (html, options) => createArtifact(html, { ...options, provider: options.provider === undefined ? 'openrouter' : options.provider });
const TAG_BODY = `(?:[^>"']|"[^"]*"|'[^']*')*`;
const PROVENANCE = /<!--\s*aithema-provenance:[\s\S]*?-->\n?/gu;
const fail = (code = 'invalid-output') => { throw new PluginError(code); };
/** Model text → one document. Repairs only remove capability; anything else is rejected later. */
export function repairHTML(content) {
  if (typeof content !== 'string') return fail();
  const source = content.replace(/^﻿/u, ''), start = source.search(/<!doctype html>/iu);
  const end = source.toLowerCase().lastIndexOf('</html>');
  if (start < 0 || end < start) return fail();
  return source.slice(start, end + '</html>'.length)
    .replace(PROVENANCE, '')
    .replace(new RegExp(`<link\\b${TAG_BODY}>`, 'giu'), '')
    .replace(new RegExp(`<meta\\b(?=${TAG_BODY}\\bhttp-equiv\\b)${TAG_BODY}>`, 'giu'), '')
    .replace(/@import\b[^;{}<]*;/giu, '')
    .replace(/(\shref\s*=\s*)(["'])(?:https?:)?\/\/[^"']*\2/giu, '$1$2#$2');
}
