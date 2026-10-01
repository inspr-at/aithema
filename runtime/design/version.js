import { readFileSync } from 'node:fs';
import { sha256Hex } from '../../contracts/validate.js';
import { DesignError } from './validate.js';

export const RENDERER_VERSION = '1';

// An implemented renderer version names immutable byte generators, not just
// a stylesheet filename. Changing these sources/fragments requires a version
// review and new golden output; never silently regenerate an old revision with
// new CSS or a new template. Digests are pinned, not derived from candidate data.
const digests = Object.freeze({
  'renderer.js': 'fdd7998e5bd2f763e430e73737e1d36ff6161769a049bc867de4a7c54f7e1e4c',
  'export.js': '398b3b55a5415c82e1fab507ec29b35332aedfb26bb56d20837c114b399c1351',
  'export-fragments/base-1.css': '99b9c12cf04bd1217676a0eabefb0c5f0616e8d374b8f0d2e12a86a92ef18f9c',
  'export-fragments/document.html': '5baa6422d3600c0d3e67f022165366b7c0c803ba21454425a1fb7a686da81c6b',
});

/** The optional reader is for adversarial verification without filesystem edits. */
export function rendererFragments(read = (name) => readFileSync(new URL(name, import.meta.url), 'utf8')) {
  const source = {};
  for (const [name, digest] of Object.entries(digests)) {
    const text = read(name);
    if (typeof text !== 'string' || sha256Hex(text) !== digest) {
      throw new DesignError('design_renderer_unsupported', 'Renderer version source or fragment digest differs from its pin');
    }
    source[name] = text;
  }
  return { baseCss: source['export-fragments/base-1.css'], template: source['export-fragments/document.html'] };
}
