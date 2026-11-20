// AIT-582: every packed tarball must be self-contained. A relative module
// specifier that resolves outside the tarball's `package/` root only works
// inside the monorepo; a consumer installing the tarball gets a broken import.
// The scan tokenizes instead of grepping, so comments and ordinary strings are
// never read as specifiers, and it covers more forms than modules.mjs rewrites.

export const scannedMember = path => /\.(?:[cm]?js|[cm]?ts)$/u.test(path);

const word = /[\p{ID_Continue}$‌‍#]/u;
const space = /[\s﻿]/u;
// After these words an expression starts, so `/` opens a regular expression.
const expressionKeywords = new Set(['return', 'typeof', 'instanceof', 'in', 'of', 'new', 'delete', 'void', 'throw',
  'case', 'do', 'else', 'yield', 'await', 'extends']);

function cook(raw) {
  return raw.replace(/\\(?:u\{([0-9a-fA-F]+)\}|u([0-9a-fA-F]{4})|x([0-9a-fA-F]{2})|\r\n|([\s\S]))/gu, (_, braced, unicode, hex, other) => {
    if (braced ?? unicode ?? hex) return String.fromCodePoint(parseInt(braced ?? unicode ?? hex, 16));
    if (other === undefined || /[\r\n  ]/u.test(other)) return '';
    return { n: '\n', r: '\r', t: '\t', b: '\b', f: '\f', v: '\v', 0: '\0' }[other] ?? other;
  });
}

/** Lex JavaScript/TypeScript into significant tokens; comments and whitespace are dropped. */
export function tokenize(text) {
  const tokens = [], references = [], templates = [];
  let i = text.startsWith('#!') ? text.indexOf('\n') + 1 || text.length : 0, braces = 0;
  const regexAllowed = () => {
    const prev = tokens.at(-1);
    if (!prev) return true;
    if (prev.type === 'word') return expressionKeywords.has(prev.value);
    if (prev.type === 'punct') return ![')', ']', '}'].includes(prev.value);
    return false;
  };
  // A template chunk ends at its closing backtick or at `${`.
  const templateChunk = start => {
    let j = start, raw = '';
    while (j < text.length && text[j] !== '`' && !(text[j] === '$' && text[j + 1] === '{')) {
      if (text[j] === '\\') { raw += text.slice(j, j + 2); j += 2; } else raw += text[j++];
    }
    return { raw, end: j, open: text[j] === '$' };
  };
  while (i < text.length) {
    const c = text[i];
    if (space.test(c)) { i++; continue; }
    if (c === '/' && text[i + 1] === '/') {
      const end = text.indexOf('\n', i), line = text.slice(i, end < 0 ? text.length : end);
      const reference = /^\/\/\/\s*<reference\s+path\s*=\s*(['"])(.*?)\1/u.exec(line);
      if (reference) references.push({ kind: 'reference path', specifier: reference[2], index: i });
      i = end < 0 ? text.length : end; continue;
    }
    if (c === '/' && text[i + 1] === '*') { const end = text.indexOf('*/', i + 2); i = end < 0 ? text.length : end + 2; continue; }
    if (c === '\'' || c === '"') {
      let j = i + 1, raw = '';
      while (j < text.length && text[j] !== c && text[j] !== '\n') {
        if (text[j] === '\\') { raw += text.slice(j, j + 2); j += 2; } else raw += text[j++];
      }
      tokens.push({ type: 'string', value: cook(raw), index: i }); i = j + 1; continue;
    }
    if (c === '`') {
      const chunk = templateChunk(i + 1);
      tokens.push({ type: 'template', value: cook(chunk.raw), substituted: chunk.open, index: i });
      if (chunk.open) { templates.push(braces); i = chunk.end + 2; } else i = chunk.end + 1;
      continue;
    }
    if (c === '}' && templates.length && templates.at(-1) === braces) {
      templates.pop();
      const chunk = templateChunk(i + 1);
      tokens.push({ type: 'template-part', index: i });
      if (chunk.open) { templates.push(braces); i = chunk.end + 2; } else i = chunk.end + 1;
      continue;
    }
    if (c === '/' && regexAllowed()) {
      let j = i + 1, inClass = false;
      while (j < text.length && text[j] !== '\n' && (inClass || text[j] !== '/')) {
        if (text[j] === '\\') j++;
        else if (text[j] === '[') inClass = true;
        else if (text[j] === ']') inClass = false;
        j++;
      }
      if (text[j] === '/') {
        j++; while (j < text.length && word.test(text[j])) j++;
        tokens.push({ type: 'regex', index: i }); i = j; continue;
      }
    }
    if (word.test(c)) {
      let j = i; while (j < text.length && word.test(text[j])) j++;
      const value = text.slice(i, j);
      tokens.push({ type: /^[0-9]/u.test(value) ? 'number' : 'word', value, index: i }); i = j; continue;
    }
    if (text.startsWith('...', i)) { tokens.push({ type: 'punct', value: '...', index: i }); i += 3; continue; }
    if (c === '{') braces++;
    if (c === '}') braces--;
    tokens.push({ type: 'punct', value: c, index: i }); i++;
  }
  return { tokens, references };
}

/** Every module specifier in the source: static, dynamic, URL, require, resolve and TS reference forms. */
export function moduleSpecifiers(text) {
  const { tokens, references } = tokenize(text), found = [...references];
  const is = (k, type, value) => tokens[k]?.type === type && (value === undefined || tokens[k].value === value);
  const literal = k => tokens[k]?.type === 'string' || tokens[k]?.type === 'template';
  const take = (kind, k) => found.push({ kind, specifier: tokens[k].value, partial: tokens[k].substituted === true, index: tokens[k].index });
  const sequence = (k, ...parts) => parts.every((part, n) => is(k + n, part === '(' || part === '.' || part === ',' ? 'punct' : 'word', part));
  for (let k = 0; k < tokens.length; k++) {
    const member = is(k - 1, 'punct', '.');
    if (member || tokens[k].type !== 'word') continue;
    const name = tokens[k].value;
    if (name === 'from' && literal(k + 1)) take('from', k + 1);
    else if (name === 'import' && literal(k + 1)) take('import', k + 1);
    else if (name === 'import' && sequence(k + 1, '(') && literal(k + 2)) take('import()', k + 2);
    else if (name === 'import' && sequence(k + 1, '.', 'meta', '.', 'resolve', '(') && literal(k + 6)) take('import.meta.resolve()', k + 6);
    else if (name === 'require' && sequence(k + 1, '(') && literal(k + 2)) take('require()', k + 2);
    else if (name === 'require' && sequence(k + 1, '.', 'resolve', '(') && literal(k + 4)) take('require.resolve()', k + 4);
    else if (name === 'new' && sequence(k + 1, 'URL', '(') && literal(k + 3) && sequence(k + 4, ',', 'import', '.', 'meta', '.', 'url')) {
      take('new URL(…, import.meta.url)', k + 3);
    }
  }
  return found.sort((a, b) => a.index - b.index);
}

// Resolve like the module loader does for file URLs, so `%2e%2e` and `\` tricks normalize too.
function resolveTarget(member, { kind, specifier, partial }) {
  if (partial) specifier = specifier.slice(0, specifier.lastIndexOf('/') + 1);
  const url = kind.startsWith('new URL') ? !/^[a-z][a-z0-9+.-]*:/iu.test(specifier) || /^file:/iu.test(specifier)
    : /^(?:\.{1,2}(?:\/|$)|\/|file:)/iu.test(specifier);
  if (!specifier || !url && kind !== 'reference path') return null;
  const resolved = new URL(kind === 'reference path' && !/^\.{0,2}\//u.test(specifier) ? './' + specifier : specifier,
    `file:///package/${member}`);
  if (resolved.protocol !== 'file:') return null;
  const path = decodeURIComponent(resolved.pathname);
  return { target: path.slice(1) || '/', inside: resolved.host === '' && path.startsWith('/package/') };
}

/** Scan unpacked tarball members (paths relative to package/) and return every escaping specifier. */
export function crossPackageImports(members) {
  const escapes = []; let scanned = 0;
  for (const [member, bytes] of members) {
    if (!scannedMember(member)) continue;
    scanned++;
    for (const found of moduleSpecifiers(bytes.toString('utf8'))) {
      const resolved = resolveTarget(member, found);
      if (resolved && !resolved.inside) escapes.push({ member, kind: found.kind, specifier: found.specifier, target: resolved.target });
    }
  }
  return { scanned, escapes };
}

/** Throw when any member of the named tarball imports outside its package root. */
export function assertPackageImports(tarball, members) {
  const { scanned, escapes } = crossPackageImports(members);
  if (escapes.length) {
    throw new Error(`Cross-package import in ${tarball}: ` + escapes.map(({ member, kind, specifier, target }) =>
      `package/${member} ${kind} '${specifier}' resolves to ${target}, outside package/`).join('; '));
  }
  return { tarball, scanned };
}
