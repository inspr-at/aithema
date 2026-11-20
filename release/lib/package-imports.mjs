// AIT-582: every packed tarball must be self-contained. A relative module
// specifier that resolves outside the tarball's `package/` root only works
// inside the monorepo; a consumer installing the tarball gets a broken import.
// Each member is parsed with TypeScript's parser and the scan walks the syntax
// tree, so comments, ordinary strings and regular expressions are never read as
// specifiers, and it covers more forms than modules.mjs rewrites. It is a tripwire
// for packing mistakes in repository code, not a validator of adversarial input.
// Where the scan cannot tell what a specifier is, it fails closed: a parse error, a
// malformed escape, an invalid URL, an absolute path, drive letter or file: URL, or
// an escaping literal inside a non-literal argument fails the check.
import { createRequire } from 'node:module';
import { posix } from 'node:path';

export const scannedMember = path => /\.(?:[cm]?js|[cm]?ts)$/u.test(path);

// Loaded on first scan (a pinned devDependency), so tooling that imports
// pack.mjs without scanning does not need it.
let typescript;
const parser = () => typescript ??= createRequire(import.meta.url)('typescript');

const lineTerminator = /[\n\r\u2028\u2029]/u;
const simpleEscapes = { n: '\n', r: '\r', t: '\t', b: '\b', f: '\f', v: '\v' };

/**
 * Cook string or template escapes like the engine; never throws. `malformed` marks an
 * escape the engine rejects (in a template also legacy octal and \8, \9).
 */
function cook(raw, template = false) {
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
    } else if (template && (c >= '1' && c <= '9' || c === '0' && /[0-9]/u.test(raw[i + 1] ?? ''))) {
      malformed = true; value += c;
    } else if (c >= '0' && c <= '7') {
      const octal = /^(?:[0-3][0-7]{0,2}|[4-7][0-7]?)/u.exec(raw.slice(i))[0];
      value += String.fromCharCode(parseInt(octal, 8)); i += octal.length - 1;
    } else if (c === '\r') { if (raw[i + 1] === '\n') i++; } else if (!lineTerminator.test(c)) value += simpleEscapes[c] ?? c;
  }
  return { value, malformed };
}

// Percent-encoded dots and separators count as written out (URL forms decode them).
const climbs = value => /(?:^|[/\\])\.\.(?:[/\\]|$)/u.test(value
  .replace(/%2e/giu, '.').replace(/%2f/giu, '/').replace(/%5c/giu, '\\'));

/** Every module specifier in one member: static, dynamic, URL, require, resolve and TS forms. */
export function moduleSpecifiers(text, member = 'module.js') {
  const ts = parser(), kind = ts.SyntaxKind;
  const source = ts.createSourceFile(member, text, ts.ScriptTarget.Latest, true, /\.[cm]?ts$/u.test(member) ? ts.ScriptKind.TS : ts.ScriptKind.JS);
  const chunkKinds = new Set([kind.StringLiteral, kind.NoSubstitutionTemplateLiteral, kind.TemplateHead, kind.TemplateMiddle, kind.TemplateTail]);
  const chunks = new Map(), spans = [];
  // The cooked value of one literal chunk; its raw text lies between the delimiters.
  const chunk = node => {
    if (!chunks.has(node)) {
      const start = node.getStart(source) + 1, end = node.end - (node.kind === kind.TemplateHead || node.kind === kind.TemplateMiddle ? 2 : 1);
      chunks.set(node, cook(text.slice(start, Math.max(start, end)), node.kind !== kind.StringLiteral));
    }
    return chunks.get(node);
  };
  // Pre-order walk with an explicit stack, so no nesting depth can overflow the call
  // stack. `enter` returns false to skip a node's children.
  const walk = (root, enter) => {
    const stack = [root];
    while (stack.length) {
      const node = stack.pop();
      if (enter(node) === false) continue;
      const children = [];
      ts.forEachChild(node, child => { children.push(child); });
      for (let i = children.length - 1; i >= 0; i--) stack.push(children[i]);
    }
  };
  const chunksIn = node => {
    const found = [];
    walk(node, child => { if (chunkKinds.has(child.kind)) found.push(chunk(child)); });
    return found;
  };
  const unwrap = node => {
    while (ts.isParenthesizedExpression(node) || ts.isAsExpression(node) || ts.isSatisfiesExpression(node)
      || ts.isTypeAssertionExpression(node) || ts.isNonNullExpression(node)) node = node.expression;
    return node;
  };
  // Constant-fold literals and `+` through parentheses. A template with substitutions
  // or `literal + expression` yields its static prefix (partial); `rest` holds the
  // literal chunks after the prefix. Anything else is not foldable (null).
  // A left-associative `+` chain is flattened with a loop and folded left to right;
  // only a parenthesized right operand recurses.
  const plus = node => ts.isBinaryExpression(node) && node.operatorToken.kind === kind.PlusToken;
  const fold = node => {
    node = unwrap(node);
    if (ts.isStringLiteral(node) || ts.isNoSubstitutionTemplateLiteral(node)) return { ...chunk(node), partial: false, rest: [] };
    if (ts.isTemplateExpression(node)) {
      const rest = node.templateSpans.flatMap(span => [...chunksIn(span.expression), chunk(span.literal)]);
      return { ...chunk(node.head), partial: true, rest };
    }
    if (!plus(node)) return null;
    const rights = [];
    while (plus(node)) { rights.push(node.right); node = unwrap(node.left); }
    let unit = fold(node);
    if (!unit) return null;
    for (let i = rights.length - 1; i >= 0; i--) {
      if (unit.partial) { for (const part of chunksIn(rights[i])) unit.rest.push(part); continue; }
      const right = fold(rights[i]);
      unit = right ? { value: unit.value + right.value, malformed: unit.malformed || right.malformed, partial: right.partial, rest: right.rest }
        : { ...unit, partial: true, rest: chunksIn(rights[i]) };
    }
    return unit;
  };
  const finish = (unit, node, ambiguous) => ({
    specifier: unit.value, partial: unit.partial, malformed: unit.malformed || unit.rest.some(part => part.malformed),
    climbs: unit.rest.some(part => climbs(part.value)), index: node.getStart(source), ...(ambiguous ? { ambiguous } : {}),
  });
  // One literal (or a fold of literals) is the specifier. Any other expression is
  // ambiguous: every literal inside it is a candidate, so an escaping one fails closed.
  const argumentSpecifiers = arg => {
    const unit = fold(arg);
    if (unit) return [finish(unit, arg)];
    const candidates = [];
    walk(arg, node => {
      if (ts.isStringLiteral(node) || ts.isNoSubstitutionTemplateLiteral(node) || ts.isTemplateExpression(node)) candidates.push(finish(fold(node), node, true));
    });
    return candidates;
  };
  // Callees and receivers are read through parentheses and TypeScript wrappers too.
  const isImportMeta = node => (node = unwrap(node), ts.isMetaProperty(node) && node.keywordToken === kind.ImportKeyword && node.name.text === 'meta');
  const mentionsMetaUrl = root => {
    let hit = false;
    walk(root, node => { if (ts.isPropertyAccessExpression(node) && isImportMeta(node.expression) && node.name.text === 'url') hit = true; return !hit; });
    return hit;
  };
  const named = (node, name) => (node = unwrap(node), ts.isIdentifier(node) && node.text === name);

  const found = source.referencedFiles.map(reference => ({ kind: 'reference path', specifier: reference.fileName, partial: false, malformed: false, index: reference.pos }));
  const take = (form, arg) => { if (arg) for (const specifier of argumentSpecifiers(arg)) found.push({ kind: form, ...specifier }); };
  walk(source, node => {
    if (chunkKinds.has(node.kind) && !node.isUnterminated) spans.push([node.getStart(source) + 1, node.end - 1]);
    if (ts.isImportDeclaration(node)) take(node.importClause ? 'from' : 'import', node.moduleSpecifier);
    else if (ts.isExportDeclaration(node)) take('from', node.moduleSpecifier);
    else if (ts.isImportEqualsDeclaration(node) && ts.isExternalModuleReference(node.moduleReference)) take('import = require()', node.moduleReference.expression);
    else if (ts.isImportTypeNode(node) && ts.isLiteralTypeNode(node.argument)) take('import()', node.argument.literal);
    else if (ts.isCallExpression(node)) {
      const callee = unwrap(node.expression), [first] = node.arguments;
      if (callee.kind === kind.ImportKeyword) take('import()', first);
      else if (named(callee, 'require')) take('require()', first);
      else if (ts.isPropertyAccessExpression(callee) && callee.name.text === 'resolve') {
        if (named(callee.expression, 'require')) take('require.resolve()', first);
        else if (isImportMeta(callee.expression)) take('import.meta.resolve()', first);
      }
    } else if (ts.isNewExpression(node) && named(node.expression, 'URL') && node.arguments?.length > 1 && mentionsMetaUrl(node.arguments[1])) {
      take('new URL(…, import.meta.url)', node.arguments[0]);
    }
  });

  // Any parse error fails the member closed. The one exception is an escape error
  // inside a closed string or template chunk: cook() decides it, and a specifier with
  // a malformed escape fails on its own. An unterminated literal always fails.
  const message = diagnostic => ts.flattenDiagnosticMessageText(diagnostic.messageText, ' ');
  const structural = source.parseDiagnostics.filter(diagnostic => /^Unterminated (?:string|template)/u.test(message(diagnostic))
    || !spans.some(([start, end]) => diagnostic.start >= start && diagnostic.start + (diagnostic.length ?? 0) <= end))
    .sort((a, b) => a.start - b.start);
  if (structural.length) {
    const [first] = structural, what = message(first);
    const problem = /^Unterminated string/u.test(what) ? 'unterminated string'
      : /^Unterminated template/u.test(what) ? 'unterminated template'
        : /^Unterminated regular expression/u.test(what) ? 'unterminated regular expression'
          : /^'\*\/' expected/u.test(what) ? 'unterminated comment'
            : /^'[)\]}]' expected/u.test(what) && !text.slice(first.start).trim() ? 'unclosed bracket'
              : /^[)\]}]$/u.test(text[first.start] ?? '') ? 'unmatched closing bracket'
                : `line ${source.getLineAndCharacterOfPosition(first.start).line + 1}: ${what}`;
    return [{ kind: 'scan', problem, index: 0 }];
  }
  return found.sort((a, b) => a.index - b.index);
}

// CommonJS, `import = require` and TypeScript reference paths resolve as file paths:
// `?`, `#` and `%2e` are literal, and `\` is a separator only on Windows.
const fileKinds = new Set(['require()', 'require.resolve()', 'import = require()', 'reference path']);

// A static prefix stands for its directory; a trailing `.` or `..` segment may climb one more level.
function directoryPrefix(prefix) {
  const cut = prefix.lastIndexOf('/') + 1;
  return /^\.{1,2}$/u.test(prefix.slice(cut)) ? prefix.slice(0, cut) + '..' : prefix.slice(0, cut);
}

const urlTarget = url => {
  let path = url.pathname;
  try { path = decodeURIComponent(path); } catch { /* Keep the encoded path for the message. */ }
  return { path, target: url.host ? url.host + path : path.slice(1) || '/' };
};

/** `null` when the specifier is not relative; else `{ target, inside }`, or `{ reason }` when it fails on its own. */
function resolveTarget(member, { kind, specifier, partial }) {
  const file = fileKinds.has(kind), backslash = file && specifier.includes('\\');
  if (file) specifier = specifier.replaceAll('\\', '/');
  // An absolute path, drive letter or file: URL never stays inside the installed
  // package. It is classified on the whole static text, before a partial specifier
  // is cut back to its directory.
  if (/^file:/iu.test(specifier)) {
    let target; try { target = urlTarget(new URL(specifier)).target; } catch { target = specifier; }
    return { target, reason: 'is a file: URL, so it is not inside package/' };
  }
  if (/^[a-z]:(?:[/\\]|$)/iu.test(specifier)) return { target: posix.normalize(specifier.replaceAll('\\', '/')), reason: 'is absolute, so it is not inside package/' };
  const absolute = /^[/\\]/u.test(specifier);
  if (partial) specifier = directoryPrefix(specifier) || (absolute ? '/' : '');
  if (!specifier) return null;
  if (absolute) {
    let target; try { target = file ? posix.normalize(specifier).replace(/^\/+/u, '') || '/' : urlTarget(new URL(specifier, 'file:///')).target; } catch { target = specifier; }
    return { target, reason: 'is absolute, so it is not inside package/' };
  }
  if (file) {
    if (kind !== 'reference path' && !/^\.{1,2}(?:\/|$)/u.test(specifier)) return null;
    const path = posix.resolve('/package', posix.dirname(member), specifier);
    const inside = path === '/package' || path.startsWith('/package/');
    if (inside && backslash) return { reason: 'contains \\, a path separator only on Windows, so it cannot be checked' };
    return { target: path.slice(1) || '/', inside };
  }
  // ES modules, import.meta.resolve and new URL resolve as URLs against the member's file URL.
  const relative = kind.startsWith('new URL') ? !/^[a-z][a-z0-9+.-]*:/iu.test(specifier) : /^\.{1,2}(?:\/|$)/u.test(specifier);
  if (!relative) return null;
  let resolved;
  try { const base = new URL('file:///'); base.pathname = `/package/${member}`; resolved = new URL(specifier, base); }
  catch { return { reason: 'is not a valid URL and cannot be checked' }; }
  if (resolved.protocol !== 'file:') return null;
  const { path, target } = urlTarget(resolved);
  return { target, inside: resolved.host === '' && path.startsWith('/package/') };
}

/** Scan unpacked tarball members (paths relative to package/) and return every escaping specifier. */
export function crossPackageImports(members) {
  const escapes = []; let scanned = 0;
  for (const [member, bytes] of members) {
    if (!scannedMember(member)) continue;
    scanned++;
    for (const found of moduleSpecifiers(bytes.toString('utf8'), member)) {
      const { kind, specifier } = found;
      if (found.problem) { escapes.push({ member, kind, reason: `could not be scanned completely (${found.problem}), so its imports cannot be checked` }); continue; }
      if (found.malformed) { escapes.push({ member, kind, specifier, reason: 'has a malformed escape and cannot be checked' }); continue; }
      const resolved = resolveTarget(member, found);
      if (!resolved) continue;
      if (resolved.reason) escapes.push({ member, kind, specifier, target: resolved.target, reason: resolved.reason });
      else if (!resolved.inside) {
        const reason = found.ambiguous ? `may resolve to ${resolved.target}, outside package/ (the argument is not a single literal)`
          : `resolves to ${resolved.target}, outside package/`;
        escapes.push({ member, kind, specifier, target: resolved.target, reason });
      } else if (found.climbs) {
        escapes.push({ member, kind, specifier, reason: 'may climb outside package/ (a later part of the argument contains ..)' });
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
