import { canonicalJson, loadContractFile, sha256Hex } from '../../contracts/validate.js';
import { DesignError, validateScreen, validateTokens } from './validate.js';
import { RENDERER_VERSION, rendererFragments } from './version.js';

export { RENDERER_VERSION };
const { baseCss, template } = rendererFragments();
const families = Object.freeze({ sans: 'system-ui, sans-serif', serif: 'Georgia, serif', monospace: 'monospace' });
// Keep tag names, class names and input types closed even if a caller mutates
// an in-memory IR after validation. Numeric keys intentionally reject strings.
const headingTags = new Map([[1, 'h1'], [2, 'h2'], [3, 'h3'], [4, 'h4'], [5, 'h5'], [6, 'h6']]);
const gridClasses = new Map([[1, 'grid columns-1'], [2, 'grid columns-2'], [3, 'grid columns-3'], [4, 'grid columns-4']]);
const inputTypes = new Map(['text', 'email', 'number', 'search'].map((type) => [type, type]));
const buttonClasses = new Map([['primary', 'button primary'], ['secondary', 'button secondary']]);
const alertClasses = new Map([['info', 'alert info'], ['success', 'alert success'], ['warning', 'alert warning'], ['error', 'alert error']]);

function renderingValue(table, value) {
  const result = table.get(value);
  if (result === undefined) throw new DesignError('design_ir_invalid', 'Unsupported component rendering value');
  return result;
}

export function escapeHtml(value) {
  return String(value).replace(/[&<>"']/g, (char) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[char]);
}

/** The only supported version pins both the templates and the base CSS. */
export function checkRenderer(version) {
  if (version !== RENDERER_VERSION) throw new DesignError('design_renderer_unsupported', 'Persisted renderer version is unsupported');
}

export function checkGenerator(generator) {
  const schema = loadContractFile('screen.schema.json').$defs.generator_id;
  if (!generator || typeof generator !== 'object' || Array.isArray(generator)
      || Object.keys(generator).sort().join(',') !== Object.keys(schema.properties).sort().join(',')
      || schema.required.some((key) => typeof generator[key] !== 'string'
        || [...generator[key]].length < schema.properties[key].minLength || [...generator[key]].length > schema.properties[key].maxLength)) {
    throw new DesignError('design_input_invalid', 'Generator identity requires only model_id and prompt_version');
  }
  try { canonicalJson(generator); } catch { throw new DesignError('design_input_invalid', 'Generator identity is not canonical JSON'); }
}

/** Typed values cannot introduce CSS syntax, URLs, escapes or closing tags. */
export function tokensStylesheet(tokens) {
  validateTokens(tokens);
  const declarations = Object.entries(tokens.color).sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0)
    .map(([key, value]) => `  --${key.replaceAll('_', '-')}: ${value};`);
  declarations.push(`  --space: ${tokens.space}px;`, `  --radius: ${tokens.radius}px;`,
    `  --font-family: ${families[tokens.font_family]};`, `  --font-size: ${tokens.font_size}px;`);
  return `:root {\n${declarations.join('\n')}\n}\n`;
}

/** Formula encoding: RFC 8785 tuple [IR, renderer_version, tokens_digest,
 * generator_id]. Tuple framing avoids ambiguous delimiter concatenation. */
export function designRevision({ screen_ir, renderer_version, tokens_digest, generator_id }) {
  validateScreen(screen_ir);
  if (typeof renderer_version !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/.test(renderer_version)) {
    throw new DesignError('design_input_invalid', 'A safe renderer version is required');
  }
  checkGenerator(generator_id);
  if (typeof tokens_digest !== 'string' || !/^[0-9a-f]{64}$(?![\s\S])/.test(tokens_digest)) throw new DesignError('design_input_invalid', 'Canonical tokens digest required');
  return sha256Hex(canonicalJson([screen_ir, renderer_version, tokens_digest, generator_id]));
}

function attrs(node, className) {
  return `id="${escapeHtml(node.id)}" class="${escapeHtml(className)}" data-element-ref="${escapeHtml(node.id)}"`;
}

function renderNode(node) {
  const e = escapeHtml;
  const children = () => node.children.map(renderNode).join('\n');
  const a = (className = node.kind) => attrs(node, className);
  switch (node.kind) {
    case 'stack': case 'row': return `<div ${a()}>\n${children()}\n</div>`;
    case 'grid': return `<div ${a(renderingValue(gridClasses, node.columns))}>\n${children()}\n</div>`;
    case 'section': return `<section ${a()} aria-label="${e(node.label)}">\n${children()}\n</section>`;
    case 'card': return `<section ${a()} aria-label="${e(node.label)}">\n${children()}\n</section>`;
    case 'heading': { const tag = renderingValue(headingTags, node.level); return `<${tag} ${a()}>${e(node.text)}</${tag}>`; }
    case 'text': return `<p ${a()}>${e(node.text)}</p>`;
    case 'button': return `<button ${a(renderingValue(buttonClasses, node.variant))} type="button">${e(node.label)}</button>`;
    case 'link': return `<span ${a()} data-target-ref="${e(node.target)}">${e(node.label)}</span>`;
    case 'input': return `<label ${a('field')}>${e(node.label)}<input type="${renderingValue(inputTypes, node.input_type)}" value="${e(node.value)}" readonly></label>`;
    case 'textarea': return `<label ${a('field')}>${e(node.label)}<textarea readonly>${e(node.value)}</textarea></label>`;
    case 'select': return `<label ${a('field')}>${e(node.label)}<select disabled>${node.options.map((label) => `<option>${e(label)}</option>`).join('')}</select></label>`;
    case 'checkbox': case 'radio': return `<label ${a('choice')}>${e(node.label)}<input type="${node.kind}"${node.kind === 'radio' ? ` name="${e(node.group)}"` : ''}${node.checked ? ' checked' : ''} disabled></label>`;
    case 'switch': return `<span ${a('choice')} role="switch" aria-checked="${node.checked}" aria-disabled="true">${e(node.label)}</span>`;
    case 'badge': return `<span ${a()}>${e(node.text)}</span>`;
    case 'alert': return `<div ${a(renderingValue(alertClasses, node.variant))} role="note">${e(node.text)}</div>`;
    case 'list': { const tag = node.ordered ? 'ol' : 'ul'; return `<${tag} ${a()}>\n${node.children.map((child) => `<li>${renderNode(child)}</li>`).join('\n')}\n</${tag}>`; }
    case 'table': return `<table ${a()}><caption>${e(node.label)}</caption><thead><tr>${node.columns.map((label) => `<th scope="col">${e(label)}</th>`).join('')}</tr></thead><tbody>${node.rows.map((row) => `<tr>${row.map((cell) => `<td>${e(cell)}</td>`).join('')}</tr>`).join('')}</tbody></table>`;
    case 'tabs': return `<section ${a()} aria-label="${e(node.label)}">\n${children()}\n</section>`;
    case 'divider': return `<hr ${a()}>`;
    case 'image': return `<div ${a()} role="img" aria-label="${e(node.label)}">${e(node.label)}</div>`;
    default: throw new DesignError('design_ir_invalid', 'Unsupported component');
  }
}

/** Pure byte generation. Host seq is kept in the returned binding, never in
 * HTML/provenance: seq is not one of the four identity inputs. */
export function renderScreen(input, { exporting = false } = {}) {
  const { screen_ir, tokens, renderer_version, generator_id, design_input_seq } = input;
  validateTokens(tokens);
  if (!Number.isSafeInteger(design_input_seq) || design_input_seq < 1) throw new DesignError('design_input_invalid', 'A host-owned design input seq is required');
  const tokens_digest = sha256Hex(canonicalJson(tokens));
  checkRenderer(renderer_version);
  const design_rev = designRevision({ screen_ir, renderer_version, tokens_digest, generator_id });
  if (screen_ir.renderer_version !== renderer_version || canonicalJson(screen_ir.generator_id) !== canonicalJson(generator_id)) {
    throw new DesignError('design_input_invalid', 'Rendering identity must match the persisted IR metadata');
  }
  const stylesheets = [
    { path: `base-${renderer_version}.css`, css: baseCss },
    { path: `tokens-${tokens_digest}.css`, css: tokensStylesheet(tokens) },
  ];
  const provenance = canonicalJson({ design_rev, generator_id, renderer_version, screen_ir_sha256: sha256Hex(canonicalJson(screen_ir)), tokens_digest });
  const values = { lang: escapeHtml(screen_ir.lang), title: escapeHtml(screen_ir.title), provenance: escapeHtml(provenance),
    screen_ref: escapeHtml(screen_ir.screen_ref), design_rev,
    styles: stylesheets.map(({ path, css }) => exporting ? `<style>\n${css}</style>` : `<link rel="stylesheet" href="${path}">`).join('\n'),
    body: screen_ir.nodes.map(renderNode).join('\n'),
  };
  // Single-pass replacement: hostile text resembling a placeholder stays text.
  const html = template.replace(/\{\{([a-z_]+)\}\}/g, (_, key) => values[key]);
  return { design_rev, design_input_seq, renderer_version, tokens_digest, generator_id: { ...generator_id }, html, stylesheets };
}
