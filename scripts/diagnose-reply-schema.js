// OPS only: inherit the host process configuration; never load files or log values.
import { pathToFileURL } from 'node:url';
import { createSession, reasoningRequest, purposeReplySchema, matchesSchema, unfenceReply } from '../packages/core/src/index.js';
import { start2PurposePolicy } from '../demo/safeguards.js';

// Match the core schema subset, reporting only schema-owned paths and rule names.
// Unknown property names are untrusted too: do not echo them into an OPS log.
function schemaFailure(value, schema, path = '$') {
  const fail = rule => ({ path, rule });
  if (schema.anyOf) return schema.anyOf.some(shape => matchesSchema(value, shape)) ? null : fail('anyOf');
  const type = schema.type;
  const validType = type === 'null' ? value === null : type === 'array' ? Array.isArray(value)
    : type === 'object' ? value !== null && typeof value === 'object' && !Array.isArray(value)
    : typeof value === type;
  if (!validType) return fail('type');
  if (schema.enum && !schema.enum.includes(value)) return fail('enum');
  if (type === 'string') {
    if (schema.minLength !== undefined && value.length < schema.minLength) return fail('minLength');
    if (schema.maxLength !== undefined && value.length > schema.maxLength) return fail('maxLength');
  }
  if (type === 'object') {
    for (const key of schema.required ?? []) if (!Object.hasOwn(value, key)) return { path: `${path}.${key}`, rule: 'required' };
    for (const [key, shape] of Object.entries(schema.properties)) if (Object.hasOwn(value, key)) {
      const failure = schemaFailure(value[key], shape, `${path}.${key}`); if (failure) return failure;
    }
    if (schema.additionalProperties === false && Object.keys(value).some(key => !Object.hasOwn(schema.properties, key))) {
      return { path: `${path}.*`, rule: 'additionalProperties' };
    }
  }
  if (type === 'array') {
    if (schema.minItems !== undefined && value.length < schema.minItems) return fail('minItems');
    if (schema.maxItems !== undefined && value.length > schema.maxItems) return fail('maxItems');
    for (const [index, item] of value.entries()) {
      const failure = schemaFailure(item, schema.items, `${path}[${index}]`); if (failure) return failure;
    }
    if (schema.contains) {
      const count = value.filter(item => matchesSchema(item, schema.contains)).length;
      if (count < (schema.minContains ?? 1)) return fail('minContains');
      if (schema.maxContains !== undefined && count > schema.maxContains) return fail('maxContains');
    }
  }
  return null;
}

export function diagnoseReplySchema(raw, streamComplete = true) {
  let value, parsed = false;
  try { value = JSON.parse(unfenceReply(raw)); parsed = true; } catch { /* Report shape only. */ }
  const object = value !== null && typeof value === 'object' && !Array.isArray(value);
  const keys = object ? Object.keys(value) : [];
  return {
    parsed, top_level_keys: [...new Set(keys.map(key => Object.hasOwn(purposeReplySchema.properties, key) ? key : '<unknown>'))].sort(),
    scope_present: object && Object.hasOwn(value, 'scope'),
    scope_valid: object && matchesSchema(value.scope, purposeReplySchema.properties.scope),
    schema_failure: parsed ? schemaFailure(value, purposeReplySchema) : { path: '$', rule: 'parse' },
    fence_present: /^\s*```|```\s*$/u.test(raw), stream_complete: streamComplete,
  };
}

const cases = [
  { id: 'in-de', locale: 'de', text: 'Wir möchten die manuelle Auftragsbearbeitung in unserem Betrieb vereinfachen.' },
  { id: 'in-en', locale: 'en', text: 'We want to simplify manual order processing in our business.' },
  { id: 'off-de', locale: 'de', text: 'Geben Sie mir ein Rezept für Gemüsesuppe.' },
];

export async function runReplySchemaDiagnostics({ invoke, write = line => console.log(JSON.stringify(line)) }) {
  // Report raw shape per wire call, including the compatibility retry. Three
  // calls total; a retry consumes the budget for a later case, never expands it.
  let calls = 0;
  for (const item of cases) {
    const session = createSession({ locale: item.locale });
    session.transcript.push({ role: 'user', content: item.text });
    const request = reasoningRequest(session, 'reaction', false, '', { purposePolicy: start2PurposePolicy });
    for (let attempt = 0; attempt < 2 && calls < 3; attempt++) {
      const input = attempt ? { ...request, replySchemaConstrained: false,
        system: request.system + '\nThe previous output was rejected. Return only safe reply JSON following the purpose policy; never echo rejected text.' } : request;
      let raw = '', complete = false, failure;
      calls++;
      try {
        for await (const delta of invoke(input, session)) {
          if (typeof delta !== 'string' || raw.length + delta.length > 300_000) throw new TypeError('Invalid stream');
          raw += delta;
        }
        complete = true;
      } catch (error) { failure = error; /* Never print provider messages or output. */ }
      const providerErrorClass = !failure ? null : ['4xx', '5xx'].includes(failure.providerErrorClass)
        ? failure.providerErrorClass : failure.code === 'provider' ? 'provider' : 'other';
      write({ case: item.id, path: attempt ? 'prompt-only-retry' : 'constrained', attempt_count: attempt + 1,
        provider_error_class: providerErrorClass, ...diagnoseReplySchema(raw, complete) });
      if (!failure?.responseFormatUnsupported || attempt) break;
    }
    if (calls >= 3) break;
  }
}

async function main() {
  if (!process.argv.includes('--allow-live') || process.env.CI) throw new Error('OPS manual use only');
  const { SQLiteStorage, createSpendCap, createPluginRuntime } = await import('../packages/server/src/index.js');
  const { PluginRegistry } = await import('../packages/core/src/index.js');
  const { createOpenRouterReasoning } = await import('../plugins/openrouter/src/index.js');
  const { openRouterConfig } = await import('../demo/openrouter-config.js');
  const config = openRouterConfig(process.env);
  const storage = new SQLiteStorage();
  try {
    const spendCap = createSpendCap({ storage, account: config.reaction.accountRef, capMicro: Math.min(config.capMicro, 50_000) });
    let calls = 0;
    const reasoning = createOpenRouterReasoning({ binding: config.reaction, prices: config.prices, spendCap,
      fetchImpl: (...args) => {
        // Independent wire-call cap, including any future adapter changes.
        if (++calls > 3) throw new Error('Diagnostic call cap');
        return fetch(...args);
      } });
    const runtime = createPluginRuntime({ storage, registry: new PluginRegistry().register(reasoning),
      consent: { coverage: ({ scope, consentRevision }) => ({ covered: true, ...scope, scope, consentRevision, checkedAt: Date.now(), expiresAt: Date.now() + 60_000 }) },
      presets: { best: { plugins: ['openrouter'], bindings: { reaction: config.reaction }, policy: { endpoints: [config.reaction.endpoint] } } } });
    await runReplySchemaDiagnostics({ async *invoke(request, context) {
      const session = storage.create({ ...context, demo: true, ownerToken: 'ops-reply-diagnostic' });
      const admitted = await runtime.admit({ session: storage.get(session.id), lane: 'reaction', operation: 'stream', request,
        options: { signal: new AbortController().signal, deadlineAt: Date.now() + 30_000 } });
      let failed = true;
      try { yield* admitted.plugin.stream(request, admitted.options); failed = false; }
      finally { await admitted.finish({ failed }); }
    } });
  } finally { storage.close(); }
}
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch(() => { console.error('{"diagnostic_error":true}'); process.exitCode = 1; });
}
