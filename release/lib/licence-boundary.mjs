import { existsSync, lstatSync, readFileSync, readdirSync, realpathSync } from 'node:fs';
import { dirname, isAbsolute, join, relative, sep } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const identifierStart = /[$_\p{ID_Start}]/u;
const identifierPart = /[$_\u200c\u200d\p{ID_Continue}]/u;
const lineNumber = (source, at) => source.slice(0, at).split(/\r\n|[\r\n\u2028\u2029]/).length;

/** All syntax comparisons go through this authority, including in the lexer. */
const is = (token, type, value) => token?.type === type && (value === undefined || token.value === value);
const any = (token, type, values) => values.some((value) => is(token, type, value));

// Exact imports used by contracts/validate.js. Changes require boundary review;
// do not derive this policy from candidate source or allow every Node builtin.
const allowedBuiltins = new Set(['node:crypto', 'node:fs', 'node:path', 'node:url']);
const forbiddenNames = new Set([
  'require', 'createRequire', 'register', 'registerHooks', 'getBuiltinModule',
  'module', 'process', 'eval', 'Function', 'Worker',
  // Node globals can expose process/eval through computed property names.
  'global', 'globalThis',
  // Other execution/loading capabilities (including browser element code).
  'WebAssembly', 'importScripts', 'SharedWorker',
]);

/**
 * Lex JavaScript without executing it. Comments, quoted strings, template raw
 * text and regex literals cannot manufacture imports. Template substitutions
 * are separately scanned as code. Unicode/hex escapes in specifiers and
 * identifiers are decoded. A template is never a quoted module specifier.
 */
function lex(source, file) {
  let i = source.startsWith('#!') ? source.search(/[\r\n\u2028\u2029]/) : 0;
  if (i === -1) i = source.length;
  const failure = (message) => { throw new Error(`${file}:${lineNumber(source, i)}: ${message}`); };
  const escape = () => {
    i++; // backslash
    const char = source[i++];
    if (char === undefined) failure('unterminated escape');
    if (char === '\r') { if (source[i] === '\n') i++; return ''; }
    if (char === '\n' || char === '\u2028' || char === '\u2029') return '';
    if (char === 'x' || char === 'u') {
      const braced = char === 'u' && source[i] === '{';
      if (braced) i++;
      const end = braced ? source.indexOf('}', i) : i + (char === 'x' ? 2 : 4);
      const hex = source.slice(i, end);
      if (end < i || !/^[0-9a-f]+$/i.test(hex) || (!braced && hex.length !== end - i)
          || Number.parseInt(hex, 16) > 0x10ffff) failure('invalid hexadecimal escape');
      i = end + (braced ? 1 : 0);
      return String.fromCodePoint(Number.parseInt(hex, 16));
    }
    if (/[0-7]/.test(char)) {
      let octal = char;
      while (octal.length < (char <= '3' ? 3 : 2) && /[0-7]/.test(source[i] ?? '')) octal += source[i++];
      return String.fromCharCode(Number.parseInt(octal, 8));
    }
    return ({ n: '\n', r: '\r', t: '\t', b: '\b', f: '\f', v: '\v' })[char] ?? char;
  };
  const quoted = (quote) => {
    i++;
    let value = '';
    while (i < source.length && source[i] !== quote) {
      if (source[i] === '\\') value += escape();
      else {
        if (/\r|\n/.test(source[i])) failure('unterminated quoted string');
        value += source[i++];
      }
    }
    if (source[i++] !== quote) failure('unterminated quoted string');
    return value;
  };
  const scan = (substitution = false) => {
    const tokens = [];
    const embedded = [];
    const contexts = [];
    let expression = true;
    const constructs = [];
    let closedContext;
    while (i < source.length) {
      const char = source[i];
      if (/\s/.test(char)) { i++; continue; }
      if (source.startsWith('//', i)) { while (i < source.length && !/[\r\n\u2028\u2029]/.test(source[i])) i++; continue; }
      if (source.startsWith('/*', i)) {
        const end = source.indexOf('*/', i + 2);
        if (end === -1) failure('unterminated block comment');
        i = end + 2;
        continue;
      }
      if (substitution && char === '}' && contexts.length === 0) { i++; return { tokens, embedded }; }
      const at = i;
      let token;
      if (char === '"' || char === "'") {
        token = { type: 'string', value: quoted(char), at };
        expression = false;
      } else if (char === '`') {
        i++;
        let value = '';
        while (i < source.length && source[i] !== '`') {
          if (source[i] === '\\') value += escape();
          else if (source.startsWith('${', i)) {
            i += 2;
            embedded.push(scan(true));
          } else value += source[i++];
        }
        if (source[i++] !== '`') failure('unterminated template literal');
        token = { type: 'template', value, at };
        expression = false;
      } else if (char === '/' && expression) {
        i++;
        let inClass = false;
        let closed = false;
        while (i < source.length) {
          const next = source[i++];
          if (/[\r\n\u2028\u2029]/.test(next)) failure('unterminated regular expression');
          if (next === '\\') { i++; continue; }
          if (next === '[') inClass = true;
          else if (next === ']') inClass = false;
          else if (next === '/' && !inClass) { closed = true; break; }
        }
        if (!closed) failure('unterminated regular expression');
        while (identifierPart.test(source[i] ?? '')) i++;
        token = { type: 'regex', value: '', at };
        expression = false;
      } else if (identifierStart.test(char) || char === '\\') {
        let value = '';
        while (i < source.length && (identifierPart.test(source[i]) || source[i] === '\\')) {
          value += source[i] === '\\' ? escape() : source[i++];
        }
        token = { type: 'id', value, at, canBeMethod: ['object', 'class'].includes(contexts.at(-1)?.kind) };
        const previous = tokens.at(-1);
        const boundary = (token) => !token || any(token, 'punct', [';', '{', '}']) || any(token, 'id', ['export', 'default']);
        const declaration = boundary(previous) || (is(previous, 'id', 'async') && boundary(tokens.at(-2)));
        const member = any(previous, 'punct', ['.', '?.']);
        token.member = member;
        if (any(token, 'id', ['function', 'class']) && !member) {
          constructs.push({ token, expression: !declaration, depth: contexts.length });
        }
        expression = !member && any(token, 'id', ['return', 'throw', 'case', 'delete', 'void', 'typeof', 'new', 'in', 'of', 'yield', 'await', 'else', 'do']);
      } else if (/[0-9]/.test(char)) {
        i++;
        while (/[\w.]/.test(source[i] ?? '')) i++;
        token = { type: 'number', value: source.slice(at, i), at };
        expression = false;
      } else {
        const previous = tokens.at(-1);
        const value = ['=>', '?.', '++', '--'].find((punct) => source.startsWith(punct, i)) ?? char;
        i += value.length;
        token = { type: 'punct', value, at };
        token.depth = contexts.length;
        if (any(token, 'punct', ['(', '[', '{'])) {
          const control = is(token, 'punct', '(') && !previous?.member && any(previous, 'id', ['if', 'while', 'for', 'with', 'switch', 'catch']);
          let block = is(token, 'punct', '{') && (!expression || is(previous, 'punct', ')')
            || any(previous, 'id', ['else', 'do', 'try', 'finally']) || !previous || any(previous, 'punct', [';', '}'])
            || (is(previous, 'punct', '{') && ['block', 'function'].includes(contexts.at(-1)?.kind)));
          if (is(token, 'punct', '{') && is(previous, 'punct', ':') && ['block', 'function'].includes(contexts.at(-1)?.kind)) block = true;
          if (is(token, 'punct', '{') && is(previous, 'id', 'return')
              && /[\r\n\u2028\u2029]/.test(source.slice(previous.at + previous.value.length, at))) block = true;
          let kind = block ? 'block' : 'object';
          if (is(token, 'punct', '{') && is(previous, 'punct', ')') && closedContext?.functionExpression !== undefined) block = !closedContext.functionExpression;
          if (is(token, 'punct', '{') && is(previous, 'punct', '=>')) block = false;
          if (is(token, 'punct', '{') && (is(previous, 'punct', '=>') || (is(previous, 'punct', ')') && closedContext?.functionExpression !== undefined))) kind = 'function';
          const construct = constructs.at(-1);
          if (is(token, 'punct', '{') && is(construct?.token, 'id', 'class') && construct.depth === contexts.length) {
            block = !construct.expression;
            kind = 'class';
            constructs.pop();
          }
          const context = { token, control, block, kind: is(token, 'punct', '{') ? kind : undefined };
          if (is(token, 'punct', '(') && is(construct?.token, 'id', 'function') && construct.depth === contexts.length) {
            context.functionExpression = construct.expression;
            constructs.pop();
          }
          contexts.push(context);
          expression = true;
        } else if (any(token, 'punct', [')', ']', '}'])) {
          const context = contexts.pop();
          const opener = { ')': '(', ']': '[', '}': '{' }[value];
          if (!is(context?.token, 'punct', opener)) failure('unbalanced delimiter');
          closedContext = context;
          expression = Boolean(context?.control || context?.block);
        } else expression = !any(token, 'punct', ['.', '?.', '++', '--']);
      }
      token.depth ??= contexts.length;
      tokens.push(token);
    }
    if (substitution) failure('unterminated template substitution');
    if (contexts.length) failure('unterminated delimiter');
    return { tokens, embedded };
  };
  return scan();
}

/** Match parentheses only to distinguish an object/class import method. */
function parenEnd(tokens, openIndex) {
  let depth = 0;
  for (let index = openIndex; index < tokens.length; index++) {
    if (is(tokens[index], 'punct', '(')) depth++;
    else if (is(tokens[index], 'punct', ')') && --depth === 0) return index;
  }
  return -1;
}

/**
 * Enforce the entire code policy once, on every token stream (including nested
 * template substitutions). Loader names are forbidden regardless of their use,
 * alias, grouping, receiver or arguments. Only import.meta.url is admissible;
 * handing import.meta to an alias would expose resolve through string keys.
 */
function checkCode(tokens, source, file) {
  const reject = (token, detail) => {
    throw new Error(`${file}:${lineNumber(source, token.at)}: licence boundary rejects ${detail}`);
  };
  for (let index = 0; index < tokens.length; index++) {
    const token = tokens[index];
    if (is(token, 'id') && forbiddenNames.has(token.value)) reject(token, `identifier ${JSON.stringify(token.value)}`);
    if (!is(token, 'id', 'import') || any(tokens[index - 1], 'punct', ['.', '?.'])) continue;
    if (is(tokens[index + 1], 'punct', '(')) {
      const end = parenEnd(tokens, index + 1);
      if (token.canBeMethod && end >= 0 && is(tokens[end + 1], 'punct', '{')) continue;
      reject(token, 'dynamic import');
    }
    if (is(tokens[index + 1], 'punct', '.')) {
      if (!(is(tokens[index + 2], 'id', 'meta') && is(tokens[index + 3], 'punct', '.')
          && is(tokens[index + 4], 'id', 'url'))) reject(token, 'import.meta capability (only import.meta.url is allowed)');
    }
  }
}

/** Collect only static, top-level, quoted import/export-from declarations. */
export function moduleSpecifiers(source, file = '<source>') {
  const out = [];
  const scan = ({ tokens, embedded }, topLevel) => {
    checkCode(tokens, source, file);
    const error = (token) => {
      throw new Error(`${file}:${lineNumber(source, token.at)}: licence boundary requires a static top-level literal module declaration`);
    };
    const add = (token, kind) => out.push({ specifier: token.value, kind, line: lineNumber(source, token.at) });
    // A bounded declaration grammar, never a forward search for 'from'. String
    // aliases are ModuleExportName data and cannot terminate or balance syntax.
    const named = (start, exporting, declaration) => {
      let cursor = start + 1;
      while (!is(tokens[cursor], 'punct', '}')) {
        if (!is(tokens[cursor], 'id') && !is(tokens[cursor], 'string')) error(declaration);
        const quoted = is(tokens[cursor++], 'string');
        if (is(tokens[cursor], 'id', 'as')) {
          cursor++;
          if (!is(tokens[cursor], 'id') && !(exporting && is(tokens[cursor], 'string'))) error(declaration);
          cursor++;
        } else if (quoted && !exporting) error(declaration);
        if (is(tokens[cursor], 'punct', '}')) break;
        if (!is(tokens[cursor], 'punct', ',')) error(declaration);
        cursor++;
      }
      return cursor + 1;
    };
    const from = (cursor, declaration, kind) => {
      if (!is(tokens[cursor], 'id', 'from') || !is(tokens[cursor + 1], 'string')) error(declaration);
      add(tokens[cursor + 1], kind);
      return cursor + 1;
    };
    for (let index = 0; index < tokens.length; index++) {
      const token = tokens[index];
      if (!any(token, 'id', ['import', 'export'])) continue;
      const next = tokens[index + 1];
      if (any(tokens[index - 1], 'punct', ['.', '?.']) || is(next, 'punct', ':')) continue;
      if (is(next, 'punct', '(') && token.canBeMethod) continue;
      if (is(token, 'id', 'import') && is(next, 'punct', '.')) continue; // checked by checkCode
      if (!topLevel || token.depth !== 0) error(token);
      if (is(token, 'id', 'import')) {
        if (is(next, 'string')) { add(next, 'import'); index++; continue; }
        let cursor = index + 1;
        if (is(tokens[cursor], 'id')) {
          cursor++;
          if (!is(tokens[cursor], 'punct', ',')) { index = from(cursor, token, 'import'); continue; }
          cursor++;
        }
        if (is(tokens[cursor], 'punct', '{')) cursor = named(cursor, false, token);
        else if (is(tokens[cursor], 'punct', '*') && is(tokens[cursor + 1], 'id', 'as') && is(tokens[cursor + 2], 'id')) cursor += 3;
        else error(token);
        index = from(cursor, token, 'import');
      } else if (is(next, 'punct', '*')) {
        let cursor = index + 2;
        if (is(tokens[cursor], 'id', 'as')) {
          cursor++;
          if (!is(tokens[cursor], 'id') && !is(tokens[cursor], 'string')) error(token);
          cursor++;
        }
        index = from(cursor, token, 'export from');
      } else if (is(next, 'punct', '{')) {
        const cursor = named(index + 1, true, token);
        index = is(tokens[cursor], 'id', 'from') ? from(cursor, token, 'export from') : cursor - 1;
      }
    }
    for (const child of embedded) scan(child, false);
  };
  scan(lex(source, file), true);
  return out;
}

function inside(root, path) {
  const rel = relative(root, path);
  return rel === '' || (rel !== '..' && !rel.startsWith(`..${sep}`) && !isAbsolute(rel));
}

function safeFileURL(tree, url) {
  try {
    const target = fileURLToPath(url);
    if (!inside(tree, target)) return false;
    let ancestor = target;
    while (!existsSync(ancestor) && ancestor !== tree) ancestor = dirname(ancestor);
    return inside(realpathSync(tree), realpathSync(ancestor));
  } catch { return false; }
}

function allowedSpecifier(tree, file, specifier) {
  if (specifier.startsWith('node:')) return allowedBuiltins.has(specifier);
  if (!specifier.startsWith('./') && !specifier.startsWith('../')) return false;
  try {
    // Check existing ancestors too: a missing leaf must not hide a symlink out.
    return safeFileURL(tree, new URL(specifier, pathToFileURL(file)));
  } catch { return false; }
}

/** Check only the independently publishable trees, never loading their code. */
export function verifyLicenceBoundary(repoRoot) {
  let checked = 0;
  for (const name of ['contracts', 'element']) {
    const tree = join(repoRoot, name);
    if (!existsSync(tree)) continue;
    const walk = (path) => {
      const stat = lstatSync(path);
      const file = relative(repoRoot, path);
      if (stat.isSymbolicLink()) throw new Error(`${file}: licence boundary symlink rejected`);
      if (stat.isDirectory()) {
        for (const entry of readdirSync(path).sort()) walk(join(path, entry));
      } else if (/\.(?:[cm]?js|jsx|[cm]?ts|tsx)$/.test(path)) {
        checked++;
        for (const { specifier, line } of moduleSpecifiers(readFileSync(path, 'utf8'), file)) {
          if (!allowedSpecifier(tree, path, specifier)) {
            throw new Error(`${file}:${line}: licence boundary rejects specifier ${JSON.stringify(specifier)}`);
          }
        }
      }
    };
    walk(tree);
  }
  return checked;
}
