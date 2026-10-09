import { isCanonicalMockReasoning } from './reasoning.js';
// Public technical metadata only. Legal qualification and account evidence are host-private (D4).
export const PLUGIN_KINDS = Object.freeze(['reasoning', 'stt', 'tts', 'live-voice', 'ui-generation', 'extractor', 'exporter']);
export const KIND_OPERATIONS = Object.freeze({ reasoning: ['stream', 'structured'], stt: ['transcribe'], tts: ['speak'],
  'live-voice': ['start'], 'ui-generation': ['generate', 'edit'], extractor: ['extract'], exporter: ['export'] });
const string = { type: 'string', minLength: 1, maxLength: 512 };
const list = items => ({ type: 'array', items, minItems: 1, uniqueItems: true });
const object = (properties, required = Object.keys(properties)) => ({ type: 'object', properties, required, additionalProperties: false });
const capability = { enum: ['native', 'emulated', 'unavailable'] };
export const MANIFEST_SCHEMA = object({
  id: { ...string, pattern: '^[a-z][a-z0-9-]*$' }, version: string, apiVersion: { enum: ['^1.0.0'] },
  kinds: list({ enum: PLUGIN_KINDS }), placement: { enum: ['server', 'browser'] },
  entrypoints: object({ server: string, browser: string }, []),
  configSchema: { type: 'object' },
  vendor: object({ name: string, url: string }),
  models: list(object({ id: string, operations: list(string), streaming: { type: 'boolean' },
    structured: { type: 'boolean' }, efforts: list(string), languages: list(string),
    germanQuality: { enum: ['qualified', 'unverified', 'unsupported'] }, formats: list(string),
    processingLocations: list(string), qualification: { enum: ['qualified', 'unverified'] },
    evidence: { type: 'array', items: string }, expiresAt: { anyOf: [string, { type: 'null' }] },
    cost: object({ unit: string, inputMicro: { anyOf: [{ type: 'number', minimum: 0 }, { type: 'null' }] },
      outputMicro: { anyOf: [{ type: 'number', minimum: 0 }, { type: 'null' }] },
      reviewedAt: { anyOf: [string, { type: 'null' }] } }),
  })),
  liveVoice: object({ reasoning: { enum: ['delegated', 'native'] },
    transcript: object({ finality: { enum: ['fragments', 'turns'] }, persistence: { enum: ['durable', 'memory-only'] } }),
    capabilities: object(Object.fromEntries(['sendText', 'updateContext', 'setInput', 'setOutput', 'pause', 'resume', 'interrupt', 'heard']
      .map(k => [k, capability]))),
    billing: object({ visitor: string, upstream: string }),
  }),
}, ['id', 'version', 'apiVersion', 'kinds', 'placement', 'entrypoints', 'configSchema', 'vendor', 'models']);

// Deliberately small dependency-free JSON Schema subset used by the manifest contract.
export function validateSchema(value, schema, path = '$', errors = []) {
  const fail = message => errors.push(`${path}: ${message}`);
  if (schema.anyOf) {
    if (!schema.anyOf.some(s => validateSchema(value, s, path, []).length === 0)) fail('no matching shape');
    return errors;
  }
  if (schema.enum && !schema.enum.includes(value)) fail('unsupported value');
  if (schema.type) {
    const valid = schema.type === 'null' ? value === null : schema.type === 'array' ? Array.isArray(value)
      : schema.type === 'object' ? value !== null && typeof value === 'object' && !Array.isArray(value)
      : schema.type === 'number' ? typeof value === 'number' && Number.isFinite(value) : typeof value === schema.type;
    if (!valid) { fail(`expected ${schema.type}`); return errors; }
  }
  if (typeof value === 'string') {
    if (value.length < (schema.minLength ?? 0) || value.length > (schema.maxLength ?? Infinity)) fail('invalid length');
    if (schema.pattern && !new RegExp(schema.pattern, 'u').test(value)) fail('invalid format');
  }
  if (typeof value === 'number' && value < (schema.minimum ?? -Infinity)) fail('below minimum');
  if (Array.isArray(value)) {
    if (value.length < (schema.minItems ?? 0)) fail('too few items');
    if (schema.uniqueItems && new Set(value.map(v => JSON.stringify(v))).size !== value.length) fail('duplicate item');
    value.forEach((v, i) => schema.items && validateSchema(v, schema.items, `${path}[${i}]`, errors));
  } else if (value && typeof value === 'object') {
    for (const k of schema.required ?? []) if (!Object.hasOwn(value, k)) fail(`missing ${k}`);
    for (const [k, v] of Object.entries(value)) {
      if (schema.properties?.[k]) validateSchema(v, schema.properties[k], `${path}.${k}`, errors);
      else if (schema.additionalProperties === false) fail(`unknown ${k}`);
    }
  }
  return errors;
}
export function validateManifest(manifest) {
  const errors = validateSchema(manifest, MANIFEST_SCHEMA);
  if (!errors.length) {
    const privateKeys = /^(?:apiKey|apiToken|token|accessToken|refreshToken|password|passphrase|credentials?|clientSecret|privateKey|authorization|secret|secretRef|accountRef|accountId|legal|retention|training|consent|consentVersion|purpose|processors|recipient|dataCategories)$/iu;
    const containsPrivateConfig = schema => {
      if (!schema || typeof schema !== 'object') return false;
      return ['default', 'const', 'examples'].some(k => Object.hasOwn(schema, k)) ||
        Array.isArray(schema.enum) && schema.enum.some(value => typeof value === 'string') ||
        Object.entries(schema).some(([k, v]) => privateKeys.test(k.replace(/[_-]/gu, '')) || containsPrivateConfig(v));
    };
    if (containsPrivateConfig(manifest.configSchema)) errors.push('private config belongs in host binding');
    if (!manifest.entrypoints[manifest.placement]) errors.push('missing placement entrypoint');
    if (manifest.kinds.includes('live-voice') && !manifest.liveVoice) errors.push('missing live voice contract');
    if (manifest.kinds.includes('live-voice') && (!manifest.entrypoints.server || !manifest.entrypoints.browser)) errors.push('live voice requires both entrypoints');
    if (manifest.liveVoice && (manifest.liveVoice.capabilities.pause === 'unavailable') !==
      (manifest.liveVoice.capabilities.resume === 'unavailable')) errors.push('pause/resume availability must agree');
    if (new Set(manifest.models.map(m => m.id)).size !== manifest.models.length) errors.push('duplicate model id');
    const operations = manifest.kinds.flatMap(k => KIND_OPERATIONS[k]);
    if (manifest.models.some(m => m.operations.some(op => !operations.includes(op) && !(op === 'stream' && manifest.kinds.includes('stt'))))) errors.push('unknown model operation');
    if (manifest.models.some(m => [m.expiresAt, m.cost.reviewedAt].some(v => v !== null && !Number.isFinite(Date.parse(v))))) errors.push('invalid metadata date');
  }
  return { ok: errors.length === 0, errors };
}
export function publicReasoningManifest(id, name, url, placement = 'server') {
  return { id, version: '0.0.0', apiVersion: '^1.0.0', kinds: ['reasoning'], placement,
    entrypoints: { [placement]: './src/index.js' }, configSchema: object({}), vendor: { name, url },
    models: [{ id: '*', operations: ['stream', 'structured'], streaming: true, structured: true,
      efforts: ['none'], languages: ['en', 'de'], germanQuality: 'unverified', formats: ['text', 'json-schema'],
      processingLocations: ['unverified'], qualification: 'unverified', evidence: [], expiresAt: null,
      cost: { unit: 'token', inputMicro: null, outputMicro: null, reviewedAt: null } }] };
}
export function deepFreeze(value) {
  if (value && typeof value === 'object') { Object.values(value).forEach(deepFreeze); Object.freeze(value); }
  return value;
}
const deeplyFrozen = value => !value || typeof value !== 'object' ||
  Object.isFrozen(value) && Object.values(value).every(deeplyFrozen);
export const mockManifest = deepFreeze(publicReasoningManifest('mock', 'Mock reasoning', 'https://example.test'));
export class PluginRegistry {
  #entries = new Map();
  #mockInstances = new WeakSet();
  register(plugin) {
    const result = validateManifest(plugin?.manifest);
    if (!result.ok) throw new TypeError(`Invalid plugin manifest: ${result.errors.join('; ')}`);
    if (this.#entries.has(plugin.manifest.id)) throw new TypeError('Duplicate plugin');
    if (typeof plugin.health !== 'function' || plugin.manifest.kinds.flatMap(k => KIND_OPERATIONS[k]).some(k => typeof plugin[k] !== 'function')) {
      throw new TypeError('Missing plugin operation or health');
    }
    const entry = { ...plugin, manifest: deeplyFrozen(plugin.manifest) ? plugin.manifest : deepFreeze(structuredClone(plugin.manifest)) };
    if (isCanonicalMockReasoning(plugin)) { Object.freeze(entry); this.#mockInstances.add(entry); }
    this.#entries.set(entry.manifest.id, entry); return this;
  }
  isCanonicalMock(plugin) { return this.#mockInstances.has(plugin); }
  get(id) { return this.#entries.get(id); }
  list() { return [...this.#entries.values()]; }
}
/** Private effective selection; callers must never serialize it into a session or public manifest. */
export function createBinding(value) {
  const allowed = ['plugin', 'model', 'effort', 'endpoint', 'routing', 'accountRef', 'secretRef', 'maxMicro', 'maxTokens', 'rates', 'legal'];
  if (!value || typeof value !== 'object' || Object.keys(value).some(k => !allowed.includes(k)) ||
    !['plugin', 'model', 'effort', 'endpoint', 'accountRef', 'secretRef'].every(k => typeof value[k] === 'string' && value[k].length > 0) ||
    !Number.isSafeInteger(value.maxMicro) || value.maxMicro < 0 || !Number.isSafeInteger(value.maxTokens) || value.maxTokens < 1 ||
    (value.routing !== undefined && (!value.routing || typeof value.routing !== 'object' || Array.isArray(value.routing))) ||
    !value.rates || !['inputMicro', 'outputMicro'].every(k => Number.isSafeInteger(value.rates[k]) && value.rates[k] >= 0)) throw new TypeError('Invalid private binding');
  const url = new URL(value.endpoint);
  if (!['https:', 'http:'].includes(url.protocol) || url.username || url.password || url.search || url.hash) throw new TypeError('Invalid binding endpoint');
  return deepFreeze(structuredClone(value));
}
