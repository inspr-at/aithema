import { existsSync, lstatSync, readFileSync, readdirSync, realpathSync } from 'node:fs';
import { isBuiltin } from 'node:module';
import { dirname, isAbsolute, join, relative, sep } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const identifierStart = /[$_\p{ID_Start}]/u;
const identifierPart = /[$_\u200c\u200d\p{ID_Continue}]/u;
const lineNumber = (source, at) => source.slice(0, at).split(/\r\n|[\r\n\u2028\u2029]/).length;

/**
 * Lex JavaScript without executing it. Comments, quoted strings, template raw
 * text and regex literals cannot manufacture imports. Template substitutions
 * are separately scanned as code. Unicode/hex escapes in specifiers are decoded.
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
        let literal = true;
        while (i < source.length && source[i] !== '`') {
          if (source[i] === '\\') value += escape();
          else if (source.startsWith('${', i)) {
            literal = false;
            i += 2;
            embedded.push(scan(true));
          } else value += source[i++];
        }
        if (source[i++] !== '`') failure('unterminated template literal');
        token = { type: literal ? 'string' : 'template', value, at };
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
        const previous = tokens.at(-1)?.value;
        const declaration = previous === undefined || [';', '{', '}', 'export', 'default'].includes(previous)
          || (previous === 'async' && (tokens.length === 1 || [';', '{', '}', 'export', 'default'].includes(tokens.at(-2)?.value)));
        if (['function', 'class'].includes(value) && !['.', '?.'].includes(previous)) {
          constructs.push({ kind: value, expression: !declaration, depth: contexts.length });
        }
        expression = ['return', 'throw', 'case', 'delete', 'void', 'typeof', 'new', 'in', 'of', 'yield', 'await', 'else', 'do'].includes(value);
      } else if (/[0-9]/.test(char)) {
        i++;
        while (/[\w.]/.test(source[i] ?? '')) i++;
        token = { type: 'number', value: source.slice(at, i), at };
        expression = false;
      } else {
        const previous = tokens.at(-1)?.value;
        const value = ['=>', '?.', '++', '--'].find((punct) => source.startsWith(punct, i)) ?? char;
        i += value.length;
        token = { type: 'punct', value, at };
        if (value === '(' || value === '[' || value === '{') {
          const control = value === '(' && ['if', 'while', 'for', 'with', 'switch', 'catch'].includes(previous);
          let block = value === '{' && (!expression || previous === ')' || previous === 'else' || previous === 'do'
            || previous === 'try' || previous === 'finally' || previous === undefined || previous === ';' || previous === '}'
            || (previous === '{' && ['block', 'function'].includes(contexts.at(-1)?.kind)));
          if (value === '{' && previous === ':' && ['block', 'function'].includes(contexts.at(-1)?.kind)) block = true;
          if (value === '{' && previous === 'return'
              && /[\r\n\u2028\u2029]/.test(source.slice(tokens.at(-1).at + previous.length, at))) block = true;
          let kind = block ? 'block' : 'object';
          if (value === '{' && previous === ')' && closedContext?.functionExpression !== undefined) block = !closedContext.functionExpression;
          if (value === '{' && previous === '=>') block = false;
          if (value === '{' && (previous === '=>' || (previous === ')' && closedContext?.functionExpression !== undefined))) kind = 'function';
          const construct = constructs.at(-1);
          if (value === '{' && construct?.kind === 'class' && construct.depth === contexts.length) {
            block = !construct.expression;
            kind = 'class';
            constructs.pop();
          }
          const context = { value, control, block, kind: value === '{' ? kind : undefined };
          if (value === '(' && construct?.kind === 'function' && construct.depth === contexts.length) {
            context.functionExpression = construct.expression;
            constructs.pop();
          }
          contexts.push(context);
          expression = true;
        } else if ([')', ']', '}'].includes(value)) {
          const context = contexts.pop();
          closedContext = context;
          expression = Boolean(context?.control || context?.block);
        } else expression = !['.', '?.', '++', '--'].includes(value);
      }
      tokens.push(token);
    }
    if (substitution) failure('unterminated template substitution');
    return { tokens, embedded };
  };
  return scan();
}

const punct = (token, value) => token?.type === 'punct' && token.value === value;

function parenEnd(tokens, openIndex) {
  let depth = 0;
  for (let index = openIndex; index < tokens.length; index++) {
    if (punct(tokens[index], '(')) depth++;
    else if (punct(tokens[index], ')')) {
      depth--;
      if (depth === 0) return index;
    }
  }
  return -1;
}

/** Split call arguments or object fields using syntax tokens only. */
function splitArguments(tokens) {
  const args = [];
  let start = 0;
  let depth = 0;
  for (let index = 0; index < tokens.length; index++) {
    const token = tokens[index];
    if (token.type !== 'punct') continue;
    if (['(', '[', '{'].includes(token.value)) depth++;
    else if ([')', ']', '}'].includes(token.value)) depth--;
    else if (token.value === ',' && depth === 0) {
      args.push(tokens.slice(start, index));
      start = index + 1;
    }
  }
  if (start < tokens.length) args.push(tokens.slice(start));
  return args;
}

const importMetaBase = { kind: 'import.meta.url' };

/** A deliberately bounded static grammar. Never evaluate candidate code. */
function staticLoaderBase(tokens) {
  while (punct(tokens[0], '(') && parenEnd(tokens, 0) === tokens.length - 1) tokens = tokens.slice(1, -1);
  if (tokens.length === 5 && tokens[0].type === 'id' && tokens[0].value === 'import'
      && punct(tokens[1], '.') && tokens[2].type === 'id' && tokens[2].value === 'meta'
      && punct(tokens[3], '.') && tokens[4].type === 'id' && tokens[4].value === 'url') return importMetaBase;
  if (tokens.length === 1 && tokens[0].type === 'string') return { kind: 'literal', value: tokens[0].value };
  if (tokens[0]?.type !== 'id' || tokens[0].value !== 'new' || tokens[1]?.type !== 'id'
      || tokens[1].value !== 'URL' || !punct(tokens[2], '(')) return undefined;
  const end = parenEnd(tokens, 2);
  if (end < 0 || (end !== tokens.length - 1 && !(end === tokens.length - 3
      && punct(tokens[end + 1], '.') && tokens[end + 2].type === 'id' && tokens[end + 2].value === 'href'))) return undefined;
  const args = splitArguments(tokens.slice(3, end));
  if (args.length !== 2 || args[0].length !== 1 || args[0][0].type !== 'string') return undefined;
  const base = staticLoaderBase(args[1]);
  return base ? { kind: 'url', value: args[0][0].value, base } : undefined;
}

/** module.register also accepts an options object containing parentURL. */
function registerParent(tokens) {
  if (!punct(tokens[0], '{') || !punct(tokens.at(-1), '}')) return tokens;
  let parent;
  for (const field of splitArguments(tokens.slice(1, -1))) {
    const key = field[0];
    if (!['id', 'string'].includes(key?.type) || !punct(field[1], ':')
        || !['parentURL', 'data', 'transferList'].includes(key.value)) return [];
    if (key.value === 'parentURL') {
      if (parent) return [];
      parent = field.slice(2);
    }
  }
  return parent ?? [];
}

/** Dotted or computed `name` call, including optional chaining. Not a declaration. */
function isNamedCall(tokens, index, name) {
  const token = tokens[index];
  const previous = tokens[index - 1];
  if (token.type === 'id' && token.value === name) return !(previous?.type === 'id' && previous.value === 'function');
  return token.type === 'string' && token.value === name && punct(previous, '[');
}

function receiverIsModule(tokens, index) {
  const token = tokens[index];
  if (token.type === 'id') {
    const dot = tokens[index - 1];
    return (punct(dot, '.') || punct(dot, '?.')) && tokens[index - 2]?.type === 'id' && tokens[index - 2]?.value === 'module';
  }
  const beforeBracket = punct(tokens[index - 2], '?.') ? tokens[index - 3] : tokens[index - 2];
  return beforeBracket?.type === 'id' && beforeBracket?.value === 'module';
}

function callOpen(tokens, index) {
  let open = index + 1;
  if (tokens[index].type === 'string' && punct(tokens[open], ']')) open++;
  if (punct(tokens[open], '?.')) open++;
  return punct(tokens[open], '(') ? open : -1;
}

/** Collect literal import/export-from/require specifiers, failing closed on computed calls. */
export function moduleSpecifiers(source, file = '<source>') {
  const out = [];
  const scan = ({ tokens, embedded }) => {
    const error = (token, kind) => {
      throw new Error(`${file}:${lineNumber(source, token.at)}: non-literal ${kind} specifier`);
    };
    const add = (token, kind, loaderBase) => out.push({ specifier: token.value, kind, line: lineNumber(source, token.at), ...(loaderBase ? { loaderBase } : {}) });
    const loaderBase = (args, token, kind) => {
      const base = staticLoaderBase(args);
      if (!base) throw new Error(`${file}:${lineNumber(source, token.at)}: unproven ${kind} loader base`);
      return base;
    };
    const methodDefinition = (start) => {
      const end = parenEnd(tokens, start);
      return end >= 0 && punct(tokens[end + 1], '{');
    };
    for (let index = 0; index < tokens.length; index++) {
      const token = tokens[index];
      const next = tokens[index + 1];
      const previous = tokens[index - 1];
      if (token.type === 'id' && token.value === 'import'
          && !['.', '?.'].includes(previous?.value) && next?.value !== ':' && next?.value !== '.') {
        if (next?.value === '(') {
          if (token.canBeMethod && methodDefinition(index + 1)) continue;
          const arg = tokens[index + 2];
          if (arg?.type !== 'string' || ![')', ','].includes(tokens[index + 3]?.value)) error(token, 'dynamic import');
          add(arg, 'dynamic import');
        } else if (next?.type === 'string') add(next, 'import');
        else {
          for (let j = index + 1; j < tokens.length && tokens[j].value !== ';'; j++) {
            if (tokens[j].value === 'from' && tokens[j + 1]?.type === 'string') { add(tokens[j + 1], 'import'); break; }
          }
        }
      } else if (token.type === 'id' && token.value === 'export' && ['*', '{'].includes(next?.value)) {
        let depth = 0;
        for (let j = index + 1; j < tokens.length && tokens[j].value !== ';'; j++) {
          if (tokens[j].value === '{') depth++;
          if (tokens[j].value === '}') depth--;
          if (depth === 0 && tokens[j].value === 'from' && tokens[j + 1]?.type === 'string') {
            add(tokens[j + 1], 'export from'); break;
          }
          if (depth === 0 && tokens[j].value === '}' && tokens[j + 1]?.value !== 'from') break;
        }
      } else if ((token.type === 'id' && token.value === 'require' && previous?.value !== 'function')
          || (token.type === 'string' && token.value === 'require' && previous?.value === '[')) {
        let open = index + 1;
        if (tokens[open]?.value === ']') open++;
        if (tokens[open]?.value === '?.') open++;
        if (tokens[open]?.value === '.' && tokens[open + 1]?.value === 'resolve') open += 2;
        if (tokens[open]?.value !== '(' || (token.canBeMethod && methodDefinition(open))) continue;
        const arg = tokens[open + 1];
        if (arg?.type !== 'string' || ![')', ','].includes(tokens[open + 2]?.value)) error(token, 'require');
        add(arg, 'require');
      } else if (isNamedCall(tokens, index, 'register') && receiverIsModule(tokens, index)) {
        const open = callOpen(tokens, index);
        if (open < 0 || (token.canBeMethod && methodDefinition(open))) continue;
        const arg = tokens[open + 1];
        if (arg?.type !== 'string' || !(punct(tokens[open + 2], ')') || punct(tokens[open + 2], ','))) error(token, 'module.register');
        const end = parenEnd(tokens, open);
        if (end < 0) error(token, 'module.register');
        const args = splitArguments(tokens.slice(open + 1, end));
        const base = args.length < 2 ? { kind: 'literal', value: 'data:' }
          : loaderBase(registerParent(args[1]), token, 'module.register');
        add(arg, 'module.register', base);
      } else if (isNamedCall(tokens, index, 'createRequire')) {
        const open = callOpen(tokens, index);
        if (open < 0 || (token.canBeMethod && methodDefinition(open))) continue;
        const end = parenEnd(tokens, open);
        if (end < 0) error(token, 'createRequire');
        const base = loaderBase(tokens.slice(open + 1, end), token, 'createRequire');
        let cursor = end + 1;
        while (punct(tokens[cursor], ')')) cursor++;
        if (punct(tokens[cursor], '?.') && tokens[cursor + 1]?.value === 'resolve') {
          cursor += 2;
          if (punct(tokens[cursor], '?.')) cursor++;
        } else if (punct(tokens[cursor], '?.')) cursor++;
        if (punct(tokens[cursor], '.') && tokens[cursor + 1]?.value === 'resolve') {
          cursor += 2;
          if (punct(tokens[cursor], '?.')) cursor++;
        }
        if (!punct(tokens[cursor], '(')) {
          // Check constructions too: their result may be stored and called later.
          add(token, 'loader base', base);
          continue;
        }
        const arg = tokens[cursor + 1];
        if (arg?.type !== 'string' || !(punct(tokens[cursor + 2], ')') || punct(tokens[cursor + 2], ','))) error(token, 'createRequire');
        add(arg, 'createRequire', base);
      }
    }
    embedded.forEach(scan);
  };
  scan(lex(source, file));
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

function resolveLoaderBase(base, file) {
  if (base.kind === 'import.meta.url') return pathToFileURL(file);
  if (base.kind === 'literal') return isAbsolute(base.value) ? pathToFileURL(base.value) : new URL(base.value);
  return new URL(base.value, resolveLoaderBase(base.base, file));
}

function allowedSpecifier(tree, file, specifier, loaderBase, kind) {
  let base = pathToFileURL(file);
  if (loaderBase) {
    try { base = resolveLoaderBase(loaderBase, file); }
    catch { return false; }
    if (!safeFileURL(tree, base)) return false;
    if (kind === 'loader base') return true;
  }
  if (specifier.startsWith('node:')) return isBuiltin(specifier);
  if (!specifier.startsWith('./') && !specifier.startsWith('../')) return false;
  try {
    // Check existing ancestors too: a missing leaf must not hide a symlink out.
    return safeFileURL(tree, new URL(specifier, base));
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
        for (const { specifier, line, loaderBase, kind } of moduleSpecifiers(readFileSync(path, 'utf8'), file)) {
          if (!allowedSpecifier(tree, path, specifier, loaderBase, kind)) {
            throw new Error(`${file}:${line}: licence boundary rejects specifier ${JSON.stringify(specifier)}`);
          }
        }
      }
    };
    walk(tree);
  }
  return checked;
}
