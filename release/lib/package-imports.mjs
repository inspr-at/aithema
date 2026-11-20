// AIT-582: every packed tarball must be self-contained. A relative module
// specifier that resolves outside the tarball's `package/` root only works
// inside the monorepo; a consumer installing the tarball gets a broken import.
// The scan tokenizes instead of grepping, so comments and ordinary strings are
// never read as specifiers, and it covers more forms than modules.mjs rewrites.
// Where the scan cannot tell what a specifier is, it fails closed: a malformed
// escape, an invalid URL, or an escaping literal inside a non-literal argument
// fails the check instead of passing silently.
import { posix } from 'node:path';

export const scannedMember = path => /\.(?:[cm]?js|[cm]?ts)$/u.test(path);

const lineTerminator = /[\n\r\u2028\u2029]/u;
const wordChar = /[\p{ID_Continue}$\u200c\u200d#]/u;
const space = /[\s\ufeff]/u;
// After these words an expression starts, so `/` opens a regular expression.
const expressionKeywords = new Set(['return', 'typeof', 'instanceof', 'in', 'of', 'new', 'delete', 'void', 'throw',
  'case', 'do', 'else', 'yield', 'await', 'extends']);
// `(` after these opens a statement head; `/` after its `)` opens a regular expression.
const statementHeads = new Set(['if', 'while', 'for', 'with']);
// `{` after these opens a block.
const blockKeywords = new Set(['else', 'do', 'try', 'finally', 'static']);
const opens = new Set(['(', '[', '{']), closes = new Set([')', ']', '}']);
const simpleEscapes = { n: '\n', r: '\r', t: '\t', b: '\b', f: '\f', v: '\v' };

const lineEnd = (text, from) => {
  const terminator = /[\n\r\u2028\u2029]/gu; terminator.lastIndex = from;
  return terminator.exec(text)?.index ?? text.length;
};

/** Cook string, template or identifier escapes like the engine; never throws. `malformed` marks an escape the engine would reject. */
function cook(raw) {
  let value = '', malformed = false;
  for (let i = 0; i < raw.length; i++) {
    if (raw[i] !== '\\') { value += raw[i]; continue; }
    const c = raw[++i];
    if (c === undefined) { malformed = true; break; }
    if (c === 'u' && raw[i + 1] === '{') {
      const braced = /^\{([0-9a-fA-F]+)\}/u.exec(raw.slice(i + 1)), point = braced ? parseInt(braced[1], 16) : NaN;
      if (!(point <= 0x10ffff)) { malformed = true; value += '\\u'; continue; }
      value += String.fromCodePoint(point); i += braced[0].length;
    } else if (c === 'u' || c === 'x') {
      const size = c === 'u' ? 4 : 2, hex = raw.slice(i + 1, i + 1 + size);
      if (hex.length !== size || !/^[0-9a-fA-F]+$/u.test(hex)) { malformed = true; value += '\\' + c; continue; }
      value += String.fromCharCode(parseInt(hex, 16)); i += size;
    } else if (c >= '0' && c <= '7') {
      const octal = /^(?:[0-3][0-7]{0,2}|[4-7][0-7]?)/u.exec(raw.slice(i))[0];
      value += String.fromCharCode(parseInt(octal, 8)); i += octal.length - 1;
    } else if (c === '\r') { if (raw[i + 1] === '\n') i++; } else if (!lineTerminator.test(c)) value += simpleEscapes[c] ?? c;
  }
  return { value, malformed };
}

/** Length of the identifier character (or `\u` escape) at `j`, or 0. */
function wordLength(text, j) {
  if (text[j] === '\\') return /^\\u(?:\{[0-9a-fA-F]+\}|[0-9a-fA-F]{4})/u.exec(text.slice(j, j + 16))?.[0].length ?? 0;
  const char = String.fromCodePoint(text.codePointAt(j));
  return wordChar.test(char) ? char.length : 0;
}

/**
 * Lex JavaScript/TypeScript into significant tokens; comments and whitespace are dropped.
 * Whether `/` opens a regular expression follows the previous significant token, with a
 * bracket stack: `)` of an if/while/for/with head and `}` of a block or a function or
 * class declaration allow one; `)` of an expression, `}` of an object literal, function
 * or class expression, a postfix `++`/`--`, a template tail and a property name divide.
 */
export function tokenize(text) {
  const tokens = [], references = [], frames = [{ kind: 'block', ternary: 0 }], bodies = [];
  // A clean scan ends with every bracket, template, comment and string closed;
  // anything else means the member may have been misread.
  let problem;
  const fail = reason => { problem ??= reason; };
  let i = text.startsWith('#!') ? lineEnd(text, 0) : 0, lastEnd = i;
  const frame = () => frames.at(-1);
  const add = (type, value, start, end, regexAfter, extra) => {
    const token = { type, value, index: start, end, regexAfter, newline: lineTerminator.test(text.slice(lastEnd, start)), ...extra };
    tokens.push(token); lastEnd = end; return token;
  };
  const newlineAt = start => lineTerminator.test(text.slice(lastEnd, start));
  // A template chunk ends at its closing backtick or at `${`.
  const templateChunk = start => {
    let j = start;
    while (j < text.length && text[j] !== '`' && !(text[j] === '$' && text[j + 1] === '{')) j += text[j] === '\\' ? 2 : 1;
    if (j >= text.length) fail('unterminated template');
    return { ...cook(text.slice(start, Math.min(j, text.length))), end: j, open: text[j] === '$' };
  };
  const braceIsBlock = (prev, newline) => {
    if (!prev) return true;
    if (prev.type === 'punct') {
      if ([';', '}', ')', ']', '=>'].includes(prev.value)) return true;
      if (prev.value === '{') return frame().kind === 'block';
      return prev.value === ':' && prev.label === true;
    }
    if (prev.type === 'word' && !prev.property) {
      if (blockKeywords.has(prev.value)) return true;
      if (prev.value === 'return' || prev.value === 'yield') return newline;
      return !expressionKeywords.has(prev.value) && !['const', 'let', 'var', 'default'].includes(prev.value);
    }
    return !(prev.type === 'template' || prev.type === 'template-part') || !prev.open;
  };
  while (i < text.length) {
    const c = text[i], prev = tokens.at(-1);
    if (space.test(c)) { i++; continue; }
    if (c === '/' && text[i + 1] === '/') {
      const end = lineEnd(text, i), line = text.slice(i, end);
      const reference = /^\/\/\/\s*<reference\s+path\s*=\s*(['"])(.*?)\1/u.exec(line);
      if (reference) references.push({ kind: 'reference path', specifier: reference[2], partial: false, index: i });
      i = end; continue;
    }
    if (c === '/' && text[i + 1] === '*') {
      const end = text.indexOf('*/', i + 2);
      if (end < 0) fail('unterminated comment');
      i = end < 0 ? text.length : end + 2; continue;
    }
    if (c === '\'' || c === '"') {
      let j = i + 1;
      while (j < text.length && text[j] !== c && text[j] !== '\n' && text[j] !== '\r') j += text[j] === '\\' ? (text.startsWith('\r\n', j + 1) ? 3 : 2) : 1;
      if (text[j] !== c) fail('unterminated string');
      const { value, malformed } = cook(text.slice(i + 1, Math.min(j, text.length)));
      add('string', value, i, j + 1, false, { malformed }); i = j + 1; continue;
    }
    if (c === '`') {
      const chunk = templateChunk(i + 1), end = chunk.end + (chunk.open ? 2 : 1);
      add('template', chunk.value, i, end, chunk.open, { malformed: chunk.malformed, substituted: chunk.open, open: chunk.open });
      if (chunk.open) frames.push({ kind: '${', ternary: 0 });
      i = end; continue;
    }
    if (c === '}' && frame().kind === '${') {
      frames.pop();
      const chunk = templateChunk(i + 1), end = chunk.end + (chunk.open ? 2 : 1);
      add('template-part', chunk.value, i, end, chunk.open, { malformed: chunk.malformed, open: chunk.open });
      if (chunk.open) frames.push({ kind: '${', ternary: 0 });
      i = end; continue;
    }
    if (c === '/' && (!prev || prev.regexAfter)) {
      let j = i + 1, inClass = false;
      while (j < text.length && !lineTerminator.test(text[j]) && (inClass || text[j] !== '/')) {
        if (text[j] === '\\') j++;
        else if (text[j] === '[') inClass = true;
        else if (text[j] === ']') inClass = false;
        j++;
      }
      if (text[j] === '/') {
        j++; for (let n; j < text.length && (n = wordLength(text, j));) j += n;
        add('regex', text.slice(i, j), i, j, false); i = j; continue;
      }
    }
    if (c === '.' && /[0-9]/u.test(text[i + 1] ?? '') || wordLength(text, i)) {
      let j = i; for (let n; j < text.length && (n = text[j] === '.' && j === i ? 1 : wordLength(text, j));) j += n;
      const raw = text.slice(i, j), value = raw.includes('\\') ? cook(raw).value : raw;
      if (/^[0-9.]/u.test(value)) { add('number', value, i, j, false); i = j; continue; }
      const property = prev?.type === 'punct' && (prev.value === '.' || prev.value === '?.');
      if (!property && (value === 'function' || value === 'class')) {
        const async = prev?.type === 'word' && prev.value === 'async' && !prev.property;
        const before = async ? tokens.at(-2) : prev, newline = async ? prev.newline : newlineAt(i);
        const statement = !before || before.statement || (before.type === 'word' && ['export', 'default'].includes(before.value))
          || (!before.regexAfter && newline);
        bodies.push({ depth: frames.length, kind: statement ? 'statement' : 'expression' });
      }
      add('word', value, i, j, !property && expressionKeywords.has(value), { property, statement: !property && (value === 'else' || value === 'do') });
      i = j; continue;
    }
    const three = text.slice(i, i + 3), two = text.slice(i, i + 2);
    if (three === '...' || three === '??=') { add('punct', three, i, i + 3, true); i += 3; continue; }
    if (two === '=>' || two === '??') { add('punct', two, i, i + 2, true); i += 2; continue; }
    if (two === '?.' && !/[0-9]/u.test(text[i + 2] ?? '')) { add('punct', two, i, i + 2, false); i += 2; continue; }
    if (two === '++' || two === '--') {
      const postfix = prev !== undefined && !prev.regexAfter && !newlineAt(i);
      add('punct', two, i, i + 2, !postfix); i += 2; continue;
    }
    if (c === '(') {
      const head = prev?.type === 'word' && !prev.property && (statementHeads.has(prev.value)
        || prev.value === 'await' && tokens.at(-2)?.type === 'word' && tokens.at(-2).value === 'for');
      frames.push({ kind: '(', head, ternary: 0 }); add('punct', c, i, i + 1, true);
    } else if (c === '[') {
      frames.push({ kind: '[', ternary: 0 }); add('punct', c, i, i + 1, true);
    } else if (c === ')' || c === ']') {
      const top = frame(), matched = top.kind === (c === ')' ? '(' : '[');
      if (matched) frames.pop(); else fail('unmatched closing bracket');
      const head = matched && top.head === true;
      add('punct', c, i, i + 1, head, { statement: head });
    } else if (c === '{') {
      const body = bodies.at(-1)?.depth === frames.length ? bodies.pop() : undefined;
      const kind = body || braceIsBlock(prev, newlineAt(i)) ? 'block' : 'object';
      frames.push({ kind, function: body?.kind, ternary: 0 });
      add('punct', c, i, i + 1, true, { statement: kind === 'block' });
    } else if (c === '}') {
      const top = frame();
      if (top.kind !== 'block' && top.kind !== 'object' || frames.length === 1) fail('unmatched closing bracket');
      if (frames.length > 1) frames.pop();
      const block = top.kind === 'block' && top.function !== 'expression';
      add('punct', c, i, i + 1, block, { statement: block });
    } else if (c === '?') {
      frame().ternary++; add('punct', c, i, i + 1, true);
    } else if (c === ':') {
      const top = frame(), ternary = top.ternary > 0;
      if (ternary) top.ternary--;
      // `{ class: x }` names a property; no body follows.
      if (prev?.type === 'word' && ['function', 'class'].includes(prev.value) && bodies.at(-1)?.depth === frames.length) bodies.pop();
      const label = !ternary && top.kind === 'block';
      add('punct', c, i, i + 1, true, { label, statement: label });
    } else if (c === ';') {
      if (bodies.at(-1)?.depth === frames.length) bodies.pop();
      if (frame().kind === 'block') frame().ternary = 0;
      add('punct', c, i, i + 1, true, { statement: true });
    } else add('punct', c, i, i + 1, c !== '.');
    i++;
  }
  if (frames.length > 1) fail('unclosed bracket');
  return { tokens, references, problem };
}

const depthChange = token => token.type === 'punct' ? (opens.has(token.value) ? 1 : closes.has(token.value) ? -1 : 0)
  : token.type === 'template' ? (token.open ? 1 : 0) : token.type === 'template-part' && !token.open ? -1 : 0;
const isPunct = (token, value) => token?.type === 'punct' && token.value === value;

/** Index of the token closing the bracket opened at `k`. */
function closing(tokens, k) {
  for (let n = k, depth = 0; n < tokens.length; n++) if ((depth += depthChange(tokens[n])) <= 0) return n;
  return tokens.length;
}

/** The arguments of the call whose `(` is at `k`, each as a token list. */
function callArguments(tokens, k) {
  const end = closing(tokens, k), args = [];
  let start = k + 1;
  for (let n = k + 1, depth = 0; n < end; n++) {
    if (depth === 0 && isPunct(tokens[n], ',')) { args.push(tokens.slice(start, n)); start = n + 1; }
    depth += depthChange(tokens[n]);
  }
  if (start < end) args.push(tokens.slice(start, end));
  return args;
}

const literal = token => token?.type === 'string' || token?.type === 'template' && !token.open;
const hasMeta = (tokens, name) => tokens.some((token, n) => token.type === 'word' && token.value === 'import' && !token.property
  && isPunct(tokens[n + 1], '.') && tokens[n + 2]?.value === 'meta' && isPunct(tokens[n + 3], '.') && tokens[n + 4]?.value === name);

/**
 * The specifier an argument expression evaluates to: one literal (or literals joined by `+`),
 * or a static prefix (a template before its first `${`, literals before a `+ expression`).
 * Anything else is ambiguous: every literal inside it is a candidate, so an escaping one fails closed.
 */
function argumentSpecifiers(arg) {
  while (isPunct(arg[0], '(') && closing(arg, 0) === arg.length - 1) arg = arg.slice(1, -1);
  if (!arg.length) return [];
  const topLevel = [];
  for (let n = 0, depth = 0; n < arg.length; n++) { if (depth === 0) topLevel.push(arg[n]); depth += depthChange(arg[n]); }
  const branching = topLevel.some(token => token.type === 'punct' && ['?', '??', '|', '&', ',', '=', '??='].includes(token.value));
  if (!branching) {
    let specifier = '', malformed = false, n = 0;
    while (literal(arg[n])) {
      specifier += arg[n].value; malformed ||= arg[n].malformed; n++;
      if (n === arg.length) return [{ specifier, partial: false, malformed, index: arg[0].index }];
      if (!isPunct(arg[n], '+') || n + 1 === arg.length) break;
      n++;
    }
    if (arg[n]?.type === 'template' && arg[n].open) {
      return [{ specifier: specifier + arg[n].value, partial: true, malformed: malformed || arg[n].malformed, index: arg[0].index }];
    }
    if (n > 0 && isPunct(arg[n - 1], '+')) return [{ specifier, partial: true, malformed, index: arg[0].index }];
  }
  return arg.filter(token => token.type === 'string' || token.type === 'template')
    .map(token => ({ specifier: token.value, partial: token.open === true, malformed: token.malformed, index: token.index, ambiguous: true }));
}

/** Every module specifier in the source: static, dynamic, URL, require, resolve and TS reference forms. */
export function moduleSpecifiers(text) {
  const { tokens, references, problem } = tokenize(text), found = [...references];
  if (problem) return [{ kind: 'scan', problem, index: 0 }];
  const word = (k, value) => tokens[k]?.type === 'word' && tokens[k].value === value && !tokens[k].property;
  const take = (kind, token) => found.push({ kind, specifier: token.value, partial: false, malformed: token.malformed === true, index: token.index });
  const call = (kind, k, base) => {
    const args = callArguments(tokens, k);
    if (base && !(args.length > 1 && hasMeta(args[1], 'url'))) return;
    for (const specifier of argumentSpecifiers(args[0] ?? [])) found.push({ kind, ...specifier });
  };
  for (let k = 0; k < tokens.length; k++) {
    if (tokens[k].type !== 'word' || tokens[k].property) continue;
    const name = tokens[k].value;
    if (name === 'from' && literal(tokens[k + 1])) take('from', tokens[k + 1]);
    else if (name === 'import' && literal(tokens[k + 1])) take('import', tokens[k + 1]);
    else if (name === 'import' && isPunct(tokens[k + 1], '(')) call('import()', k + 1);
    else if (name === 'import' && hasMeta(tokens.slice(k, k + 5), 'resolve') && isPunct(tokens[k + 5], '(')) call('import.meta.resolve()', k + 5);
    else if (name === 'require' && isPunct(tokens[k + 1], '(')) call('require()', k + 1);
    else if (name === 'require' && isPunct(tokens[k + 1], '.') && tokens[k + 2]?.value === 'resolve' && isPunct(tokens[k + 3], '(')) call('require.resolve()', k + 3);
    else if (name === 'new' && word(k + 1, 'URL') && isPunct(tokens[k + 2], '(')) call('new URL(…, import.meta.url)', k + 2, true);
  }
  return found.sort((a, b) => a.index - b.index);
}

// CommonJS and TypeScript reference paths resolve as file paths: `?` and `#` are
// literal, and `\` counts as a separator (it is one on Windows).
const fileKinds = new Set(['require()', 'require.resolve()', 'reference path']);

// A static prefix stands for its directory; a trailing `.` or `..` segment may climb one more level.
function directoryPrefix(prefix) {
  const cut = prefix.lastIndexOf('/') + 1;
  return /^\.{1,2}$/u.test(prefix.slice(cut)) ? prefix.slice(0, cut) + '..' : prefix.slice(0, cut);
}

/** `null` when the specifier is not relative; else `{ target, inside }`, or `{ reason }` when it cannot be resolved. */
function resolveTarget(member, { kind, specifier, partial }) {
  const file = fileKinds.has(kind);
  if (file) specifier = specifier.replaceAll('\\', '/');
  if (partial) specifier = directoryPrefix(specifier);
  if (!specifier) return null;
  if (file) {
    if (kind !== 'reference path' && !/^(?:\.{1,2}(?:\/|$)|\/)/u.test(specifier)) return null;
    const path = posix.resolve('/package', posix.dirname(member), specifier);
    return { target: path.slice(1) || '/', inside: path === '/package' || path.startsWith('/package/') };
  }
  // ES modules and new URL resolve like the module loader does for file URLs, so `%2e%2e` and `\` normalize too.
  const relative = kind.startsWith('new URL') ? !/^[a-z][a-z0-9+.-]*:/iu.test(specifier) || /^file:/iu.test(specifier)
    : /^(?:\.{1,2}(?:\/|$)|\/|file:)/iu.test(specifier);
  if (!relative) return null;
  let resolved;
  try { const base = new URL('file:///'); base.pathname = `/package/${member}`; resolved = new URL(specifier, base); }
  catch { return { reason: 'is not a valid URL and cannot be checked' }; }
  if (resolved.protocol !== 'file:') return null;
  let path = resolved.pathname;
  try { path = decodeURIComponent(path); } catch { /* Keep the encoded path for the message. */ }
  return { target: path.slice(1) || '/', inside: resolved.host === '' && path.startsWith('/package/') };
}

/** Scan unpacked tarball members (paths relative to package/) and return every escaping specifier. */
export function crossPackageImports(members) {
  const escapes = []; let scanned = 0;
  for (const [member, bytes] of members) {
    if (!scannedMember(member)) continue;
    scanned++;
    for (const found of moduleSpecifiers(bytes.toString('utf8'))) {
      const { kind, specifier } = found;
      if (found.problem) { escapes.push({ member, kind, reason: `could not be scanned completely (${found.problem}), so its imports cannot be checked` }); continue; }
      if (found.malformed) { escapes.push({ member, kind, specifier, reason: 'has a malformed escape and cannot be checked' }); continue; }
      const resolved = resolveTarget(member, found);
      if (resolved?.reason) escapes.push({ member, kind, specifier, reason: resolved.reason });
      else if (resolved && !resolved.inside) {
        const reason = found.ambiguous ? `may resolve to ${resolved.target}, outside package/ (the argument is not a single literal)`
          : `resolves to ${resolved.target}, outside package/`;
        escapes.push({ member, kind, specifier, target: resolved.target, reason });
      }
    }
  }
  return { scanned, escapes };
}

/** Scan one tarball; `message` is set when any member imports outside its package root. */
export function scanPackageImports(tarball, members) {
  const { scanned, escapes } = crossPackageImports(members);
  const message = escapes.length ? `Cross-package import in ${tarball}: ` + escapes.map(({ member, kind, specifier, reason }) =>
    specifier === undefined ? `package/${member} ${reason}` : `package/${member} ${kind} '${specifier}' ${reason}`).join('; ') : undefined;
  return { tarball, scanned, escapes: escapes.length, message };
}

/** Throw once, naming every failing tarball; `cause` is a later verification error, if any. */
export function assertPackageImportScans(scans, cause) {
  const failures = scans.filter(scan => scan.message);
  if (failures.length) throw new Error(failures.map(scan => scan.message).join('\n'), cause ? { cause } : undefined);
}
