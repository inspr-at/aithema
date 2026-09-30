import { boundary } from './boundary.js';
import { canonicalJson, validate, validateExtensions } from '../contracts/validate.js';

/**
 * @typedef {{namespace: string, version: string, schema: object, title: string}} ExtensionDescriptor
 * @typedef {readonly ExtensionDescriptor[]} ExtensionRegistry
 * @typedef {Record<string, {version: string, data: unknown}>} ItemExtensions
 */

function refusal(code, message) {
  return Object.assign(new Error(message), { code, status: 422 });
}

/** Every older value must remain valid, recursively, within one major. */
function assertAdditive(previous, next, path = '$') {
  if (previous.type !== next.type && !(previous.type === 'integer' && next.type === 'number')) {
    throw refusal('extension_invalid', `${path}: minor changes must preserve or widen the type`);
  }
  if (next.enum && (!previous.enum || previous.enum.some((value) =>
    !next.enum.some((candidate) => canonicalJson(value) === canonicalJson(candidate))))) {
    throw refusal('extension_invalid', `${path}: minor changes cannot narrow an enum`);
  }
  for (const limit of ['maxLength', 'maxItems']) {
    if (previous[limit] !== undefined && next[limit] < previous[limit]) {
      throw refusal('extension_invalid', `${path}: minor changes cannot lower ${limit}`);
    }
  }
  if (previous.type === 'object') {
    if ((next.required ?? []).some((key) => !(previous.required ?? []).includes(key))) {
      throw refusal('extension_invalid', `${path}: minor changes cannot add required properties`);
    }
    for (const [key, schema] of Object.entries(previous.properties)) {
      if (!Object.hasOwn(next.properties, key)) throw refusal('extension_invalid', `${path}: minor changes cannot remove property ${key}`);
      assertAdditive(schema, next.properties[key], `${path}.${key}`);
    }
  }
  if (previous.type === 'array') assertAdditive(previous.items, next.items, `${path}[]`);
}

function append(registry, descriptor) {
  const result = validate('aithema.extension', descriptor);
  if (!result.ok) {
    const errors = [...result.schemaErrors, ...result.invariants];
    throw refusal(errors.some((error) => error.startsWith('extension_limit:')) ? 'extension_limit' : 'extension_invalid',
      `invalid extension descriptor: ${errors.join('; ')}`);
  }
  // Registry entries are descriptors, never execution envelopes.
  if (Object.keys(descriptor).some((key) => !['namespace', 'version', 'schema', 'title'].includes(key))) {
    throw refusal('extension_invalid', 'registry requires namespace, version, schema and title only');
  }
  const [major, minor] = descriptor.version.split('.').map(Number);
  const siblings = registry.filter((entry) => entry.namespace === descriptor.namespace && Number(entry.version.split('.')[0]) === major);
  const previous = siblings.at(-1);
  if (previous) {
    if (minor <= Number(previous.version.split('.')[1])) throw refusal('extension_invalid', 'extension minors must be registered once in increasing order');
    assertAdditive(previous.schema, descriptor.schema);
  }
  return Object.freeze([...registry, descriptor]);
}

/** Explicit immutable registry, with no global registration or I/O. */
function createExtensionRegistryImpl(descriptors = []) {
  if (!Array.isArray(descriptors)) throw refusal('extension_invalid', 'extension registry must be an array of descriptors');
  return descriptors.reduce(append, Object.freeze([]));
}

function registerExtensionImpl(registry, descriptor) {
  return append(createExtensionRegistryImpl(registry), descriptor);
}

/** The authority used by all working-spec writes and handover boundaries. */
function assertItemExtensionsImpl(extensions, registry = []) {
  const descriptors = createExtensionRegistryImpl(registry);
  const result = validateExtensions(extensions, descriptors);
  if (!result.ok) throw refusal(result.code, result.errors.join('; '));
  return extensions;
}

export const createExtensionRegistry = boundary(createExtensionRegistryImpl);
export const registerExtension = boundary(registerExtensionImpl);
export const assertItemExtensions = boundary(assertItemExtensionsImpl);
