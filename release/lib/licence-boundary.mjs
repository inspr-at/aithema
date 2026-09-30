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

function parenEnd(tokens, openIndex) {
  let depth = 0;
  for (let index = openIndex; index < tokens.length; index++) {
    if (tokens[index].value === '(') depth++;
    else if (tokens[index].value === ')') {
      depth--;
      if (depth === 0) return index;
    }
  }
  return -1;
}

/** Dotted or computed `name` call, including optional chaining. Not a declaration. */
function isNamedCall(tokens, index, name) {
  const token = tokens[index];
  const previous = tokens[index - 1];
  if (token.type === 'id' && token.value === name) return previous?.value !== 'function';
  return token.type === 'string' && token.value === name && previous?.value === '[';
}

function receiverIsModule(tokens, index) {
  const token = tokens[index];
  if (token.type === 'id') {
    const dot = tokens[index - 1];
    return ['.', '?.'].includes(dot?.value) && tokens[index - 2]?.type === 'id' && tokens[index - 2]?.value === 'module';
  }
  const beforeBracket = tokens[index - 2]?.value === '?.' ? tokens[index - 3] : tokens[index - 2];
  return beforeBracket?.type === 'id' && beforeBracket?.value === 'module';
}

function callOpen(tokens, index) {
  let open = index + 1;
  if (tokens[index].type === 'string' && tokens[open]?.value === ']') open++;
  if (tokens[open]?.value === '?.') open++;
  return tokens[open]?.value === '(' ? open : -1;
}

/** Collect literal import/export-from/require specifiers, failing closed on computed calls. */
export function moduleSpecifiers(source, file = '<source>') {
  const out = [];
  const scan = ({ tokens, embedded }) => {
    const error = (token, kind) => {
      throw new Error(`${file}:${lineNumber(source, token.at)}: non-literal ${kind} specifier`);
    };
    const add = (token, kind) => out.push({ specifier: token.value, kind, line: lineNumber(source, token.at) });
    const methodDefinition = (start) => {
      let depth = 0;
      for (let index = start; index < tokens.length; index++) {
        if (tokens[index].value === '(') depth++;
        if (tokens[index].value === ')' && --depth === 0) return tokens[index + 1]?.value === '{';
      }
      return false;
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
        if (arg?.type !== 'string' || ![')', ','].includes(tokens[open + 2]?.value)) error(token, 'module.register');
        add(arg, 'module.register');
      } else if (isNamedCall(tokens, index, 'createRequire')) {
        const open = callOpen(tokens, index);
        if (open < 0 || (token.canBeMethod && methodDefinition(open))) continue;
        const end = parenEnd(tokens, open);
        if (end < 0) error(token, 'createRequire');
        let cursor = end + 1;
        while (tokens[cursor]?.value === ')') cursor++;
        if (tokens[cursor]?.value === '?.' && tokens[cursor + 1]?.value === 'resolve') {
          cursor += 2;
          if (tokens[cursor]?.value === '?.') cursor++;
        } else if (tokens[cursor]?.value === '?.') cursor++;
        if (tokens[cursor]?.value === '.' && tokens[cursor + 1]?.value === 'resolve') {
          cursor += 2;
          if (tokens[cursor]?.value === '?.') cursor++;
        }
        if (tokens[cursor]?.value !== '(') continue;
        const arg = tokens[cursor + 1];
        if (arg?.type !== 'string' || ![')', ','].includes(tokens[cursor + 2]?.value)) error(token, 'createRequire');
        add(arg, 'createRequire');
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

function allowedSpecifier(tree, file, specifier) {
  if (specifier.startsWith('node:')) return isBuiltin(specifier);
  if (!specifier.startsWith('./') && !specifier.startsWith('../')) return false;
  try {
    const target = fileURLToPath(new URL(specifier, pathToFileURL(file)));
    if (!inside(tree, target)) return false;
    // Check existing ancestors too: a missing leaf must not hide a symlink out.
    let ancestor = target;
    while (!existsSync(ancestor) && ancestor !== tree) ancestor = dirname(ancestor);
    return inside(realpathSync(tree), realpathSync(ancestor));
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
