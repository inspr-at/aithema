// Shared helpers only (no tests): a tiny HTML parser and an accessibility audit
// for the server-rendered workspace markup. All attributes are double-quoted in
// our output, so this stays honest without a DOM dependency.

const VOID = new Set(['meta', 'input', 'br', 'hr', 'img', 'link']);
const unescape = (value) => value.replaceAll('&quot;', '"').replaceAll('&#39;', "'").replaceAll('&lt;', '<').replaceAll('&gt;', '>').replaceAll('&amp;', '&');

export function parseHtml(html) {
  const root = { tag: '#root', attrs: {}, children: [], parent: null };
  let current = root;
  const token = /<!--[\s\S]*?-->|<!DOCTYPE[^>]*>|<\/([a-zA-Z][\w-]*)\s*>|<([a-zA-Z][\w-]*)((?:\s+[^<>]*?)?)\s*(\/?)>|([^<]+)/g;
  for (const match of html.matchAll(token)) {
    const [, closing, opening, rawAttrs, selfClose, text] = match;
    if (text !== undefined) {
      current.children.push({ text: unescape(text), parent: current });
    } else if (opening) {
      const attrs = {};
      for (const attr of (rawAttrs ?? '').matchAll(/([^\s=/]+)(?:="([^"]*)")?/g)) attrs[attr[1]] = unescape(attr[2] ?? '');
      const node = { tag: opening.toLowerCase(), attrs, children: [], parent: current };
      current.children.push(node);
      if (!VOID.has(node.tag) && !selfClose) current = node;
    } else if (closing) {
      let node = current;
      while (node && node.tag !== closing.toLowerCase()) node = node.parent;
      if (node?.parent) current = node.parent;
    }
  }
  return root;
}

export function walk(node, visit) {
  for (const child of node.children ?? []) {
    if (child.tag) { visit(child); walk(child, visit); }
  }
}

export function find(root, predicate) {
  const rows = [];
  walk(root, (node) => { if (predicate(node)) rows.push(node); });
  return rows;
}

export function textOf(node) {
  if (node.text !== undefined) return node.text;
  if (['script', 'style'].includes(node.tag)) return '';
  return (node.children ?? []).map(textOf).join('').replace(/\s+/g, ' ').trim();
}

const INTERACTIVE = (node) => (['button', 'textarea', 'select', 'summary'].includes(node.tag)
  || node.tag === 'input' && node.attrs.type !== 'hidden'
  || node.tag === 'a' && Object.hasOwn(node.attrs, 'href')
  || Object.hasOwn(node.attrs, 'tabindex') && node.attrs.tabindex !== '-1')
  && !Object.hasOwn(node.attrs, 'hidden');

function accessibleName(root, node) {
  if (node.attrs['aria-labelledby']) {
    return node.attrs['aria-labelledby'].split(/\s+/)
      .map((id) => find(root, (n) => n.attrs.id === id).map(textOf).join(' ')).join(' ').trim();
  }
  if (node.attrs['aria-label']) return node.attrs['aria-label'].trim();
  if (node.tag === 'input' || node.tag === 'textarea' || node.tag === 'select') {
    const byFor = node.attrs.id ? find(root, (n) => n.tag === 'label' && n.attrs.for === node.attrs.id) : [];
    let wrapper = node.parent;
    while (wrapper && wrapper.tag !== 'label') wrapper = wrapper.parent;
    return [...byFor, ...(wrapper ? [wrapper] : [])].map(textOf).join(' ').trim();
  }
  return textOf(node);
}

/**
 * @returns {{problems: string[], focusOrder: {tag: string, name: string, id?: string}[], headings: {level: number, text: string}[]}}
 */
export function auditAccessibility(html) {
  const root = parseHtml(html);
  const problems = [];
  const ids = new Map();
  walk(root, (node) => {
    if (node.attrs.id) ids.set(node.attrs.id, (ids.get(node.attrs.id) ?? 0) + 1);
  });
  for (const [id, count] of ids) if (count > 1) problems.push(`duplicate id ${id}`);
  const missing = (id, where) => { if (!ids.has(id)) problems.push(`${where} references missing id ${id}`); };
  walk(root, (node) => {
    for (const key of ['aria-labelledby', 'aria-describedby', 'aria-controls']) {
      for (const id of (node.attrs[key] ?? '').split(/\s+/).filter(Boolean)) missing(id, `${node.tag} ${key}`);
    }
    if (node.tag === 'label' && node.attrs.for) missing(node.attrs.for, 'label for');
    if (node.tag === 'a' && node.attrs.href?.startsWith('#') && node.attrs.href.length > 1) missing(node.attrs.href.slice(1), `link ${node.attrs.href}`);
    if (Object.hasOwn(node.attrs, 'tabindex') && Number(node.attrs.tabindex) > 0) problems.push(`positive tabindex on ${node.tag}`);
    for (const name of Object.keys(node.attrs)) if (/^on/i.test(name)) problems.push(`inline handler ${name} on ${node.tag}`);
    if (node.attrs.href?.trim().toLowerCase().startsWith('javascript:')) problems.push('javascript: link');
    if (node.tag === 'script' && !node.attrs.src && node.attrs.type !== 'application/json') problems.push('inline executable script');
    if (['input', 'textarea', 'select'].includes(node.tag) && node.attrs.type !== 'hidden' && !accessibleName(root, node)) {
      problems.push(`unlabelled ${node.tag}${node.attrs.name ? ` ${node.attrs.name}` : ''}`);
    }
    if (node.tag === 'button' && !accessibleName(root, node)) problems.push('button without an accessible name');
    if (node.attrs.role === 'log' && !accessibleName(root, node)) problems.push('log region without a name');
    if (node.tag === 'form' && (!node.attrs.action || !node.attrs.method)) problems.push('form without action/method');
  });
  const mains = find(root, (n) => n.tag === 'main');
  if (mains.length !== 1) problems.push(`expected exactly one <main>, found ${mains.length}`);
  const lang = find(root, (n) => n.tag === 'html')[0]?.attrs.lang;
  if (!lang) problems.push('html lang missing');
  const headings = find(root, (n) => /^h[1-6]$/.test(n.tag)).map((n) => ({ level: Number(n.tag[1]), text: textOf(n) }));
  let previous = 0;
  for (const heading of headings) {
    if (heading.level > previous + 1) problems.push(`heading jump to h${heading.level} "${heading.text}" after h${previous}`);
    previous = heading.level;
  }
  const focusOrder = find(root, INTERACTIVE).map((node) => ({ tag: node.tag, name: accessibleName(root, node), id: node.attrs.id }));
  const first = find(root, INTERACTIVE)[0];
  if (!first || first.tag !== 'a' || first.attrs.href !== `#${mains[0]?.attrs.id}`) problems.push('the skip link is not the first focusable element');
  return { problems, focusOrder, headings };
}
