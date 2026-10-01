import { canExecute, canonicalJson, loadContractFile, validate } from '../../contracts/validate.js';
import { screenBounds } from '../../contracts/design-invariants.js';
import { EngineError } from '../engine/common.js';

export const VOCABULARY_V1 = Object.freeze(loadContractFile('screen.schema.json').$defs.node.oneOf
  .map((branch) => branch.$ref.split('/').at(-1)));

/** Stable design diagnostics also live in contracts/error-codes.json. */
export class DesignError extends EngineError {
  constructor(code, message, diagnostics = []) {
    const catalogue = loadContractFile('error-codes.json');
    const descriptor = [...catalogue.codes, ...catalogue.design_diagnostics].find((entry) => entry.code === code);
    if (!descriptor) throw new TypeError('Unknown design diagnostic code');
    super(code, message, { code, status: descriptor.http });
    this.name = 'DesignError';
    this.diagnostics = diagnostics;
  }
}

function diagnostics(contract, doc, fallback, max) {
  if (contract === 'aithema.screen') {
    const bounds = screenBounds(doc);
    if (bounds.length) return bounds.map((message) => ({ code: message.split(':')[0], path: '$', message }));
  }
  try {
    const canonical = canonicalJson(doc);
    if (Buffer.byteLength(canonical, 'utf8') > max) return [{ code: 'design_limit', path: '$', message: 'Canonical byte limit exceeded' }];
  } catch {
    return [{ code: fallback, path: '$', message: 'Finite, acyclic canonical JSON required' }];
  }
  if (!doc || doc.contract !== contract) return [{ code: fallback, path: '$', message: `Expected ${contract}/1` }];
  const executable = canExecute(doc);
  if (!executable.ok) return [{ code: executable.code, path: '$', message: 'Unsupported contract reader version' }];
  const result = validate(contract, doc);
  return [...result.schemaErrors, ...result.invariants].map((message) => ({
    code: /^(design_[a-z_]+):/.exec(message)?.[1] ?? fallback,
    path: message.startsWith('$') ? message.split(':')[0] : '$', message,
  }));
}

/** Pure validator/lint. Hostile markup in text is valid and rendered as text. */
export function lintScreen(screen) {
  const errors = diagnostics('aithema.screen', screen, 'design_ir_invalid', 512 * 1024);
  const warnings = [];
  if (!errors.length) {
    const stack = [...screen.nodes];
    while (stack.length) {
      const node = stack.pop();
      if (typeof node.label === 'string' && !node.label.trim()) {
        warnings.push({ code: 'design_label_blank', path: node.id, message: 'Visible label is blank' });
      }
      stack.push(...(node.children ?? []));
    }
    warnings.sort((a, b) => a.path < b.path ? -1 : a.path > b.path ? 1 : 0);
  }
  return { ok: errors.length === 0, errors, warnings };
}

export function validateScreen(screen) {
  const result = lintScreen(screen);
  if (!result.ok) throw new DesignError(result.errors[0].code, 'Invalid screen IR', result.errors);
  return screen;
}

export function validateTokens(tokens) {
  const errors = diagnostics('aithema.design.tokens', tokens, 'design_tokens_invalid', 64 * 1024);
  if (errors.length) throw new DesignError(errors[0].code, 'Invalid design tokens', errors);
  return tokens;
}
