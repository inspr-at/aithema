import { deepFreeze, beginInvocation, operationScope, verifyHTMLArtifact, PluginError } from '@inspr/aithema-core';
import { htmlArtifact, previousDocument } from '@inspr/aithema-core/ui-html-artifact';
import { buildMessages, revisionOf } from '@inspr/aithema-core/ui-html-prompt';

// Deterministic adapters own their metadata; no provider plugin supplies defaults.
const manifest = deepFreeze({ id: 'fake-html', version: '0.0.0', apiVersion: '^1.0.0',
  kinds: ['ui-generation'], placement: 'server', entrypoints: { server: './src/index.js' },
  configSchema: { type: 'object', properties: {}, additionalProperties: false }, vendor: { name: 'Local deterministic fake', url: 'https://example.test' },
  models: [{ id: 'deterministic-html', operations: ['generate', 'edit'], streaming: false, structured: false,
    efforts: ['none'], languages: ['en', 'de'], germanQuality: 'unverified', formats: ['text/html'],
    processingLocations: ['unverified'], qualification: 'unverified', expiresAt: null,
    evidence: ['https://openrouter.ai/anthropic'],
    cost: { unit: 'token', inputMicro: null, outputMicro: null, reviewedAt: null } }] });

// No public enrollment: a copied generate cannot authorize another edit.
const implementations = new WeakMap();
export function localHTMLImplementation(plugin) {
  if (!plugin || typeof plugin !== 'object') return;
  const generate = Object.getOwnPropertyDescriptor(plugin, 'generate')?.value;
  const implementation = typeof generate === 'function' ? implementations.get(generate) : undefined;
  if (implementation && Object.getOwnPropertyDescriptor(plugin, 'edit')?.value === implementation.edit) return implementation;
}
export const isLocalHTML = plugin => Boolean(localHTMLImplementation(plugin));
export const localHTMLBinding = Object.freeze({ plugin: 'fake-html', model: 'deterministic-html', effort: 'none',
  endpoint: 'https://example.test', accountRef: 'local-demo', secretRef: 'local-only', maxMicro: 0, maxTokens: 1,
  rates: { inputMicro: 0, outputMicro: 0 } });
// Numeric entities keep arbitrary visitor text inert, including URL-like text
// which the static HTML policy otherwise treats as a potential external reference.
const escaped = text => [...text].map(c => `&#${c.codePointAt(0)};`).join('');
export function createLocalHTML({ now = () => 0 } = {}) {
  async function run(operation, spec, feedback, options, previous) {
    const scope = operationScope(options); let invocation, completed = false;
    try {
      invocation = await beginInvocation({ ...options, signal: scope.signal }); scope.signal.throwIfAborted();
      if (previous && !await verifyHTMLArtifact(previous)) throw new PluginError('invalid-output');
      const previousText = previous ? new TextDecoder().decode(previous.bytes) : undefined;
      const { messages } = buildMessages(spec, feedback, previousText);
      const revision = previousText ? revisionOf(previousText) + 1 : 1;
      const de = spec.language?.startsWith('de'), summary = escaped(spec.understanding?.summary || (de ? 'Ihr Entwurf' : 'Your draft'));
      const questions = (spec.understanding?.openQuestions ?? []).map(q => `<li>${escaped(q)}</li>`).join('');
      const html = `<!doctype html><html lang="${spec.language ?? 'en'}"><head><!-- Click-dummy. Revision ${revision}: current understanding. -->
<meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${summary}</title>
<style>body{font:1rem/1.5 system-ui;margin:0;padding:clamp(1rem,4vw,3rem);color:#243b40;background:#f7f5ef}main{max-width:70ch}button{font:inherit;min-height:44px;padding:.5rem 1rem}h1{overflow-wrap:anywhere}:focus-visible{outline:2px solid #227c78}em,i,cite,address,dfn,var{font-style:normal}</style></head><body><main>
<h1>${summary}</h1><p>${de ? 'Entwurf aus Ihrem Gespräch. Alle Daten sind Beispieldaten.' : 'Demo only: clickable draft from your conversation. All data is sample data.'}</p>
<p>${de ? 'Fassung' : 'Revision'} ${revision}</p><button type="button" id="toggle" aria-expanded="false">${de ? 'Offene Fragen' : 'Open questions'}</button>
<button type="button" id="reset">${de ? 'Demo zurücksetzen' : 'Reset demo'}</button><section id="questions" hidden><ul>${questions || `<li>${de ? 'Keine offenen Fragen.' : 'No open questions.'}</li>`}</ul></section>
<script>const button=document.getElementById('toggle'),panel=document.getElementById('questions');button.addEventListener('click',()=>{panel.hidden=!panel.hidden;button.setAttribute('aria-expanded',String(!panel.hidden))});document.getElementById('reset').addEventListener('click',()=>{panel.hidden=true;button.setAttribute('aria-expanded','false')});</script>
</main></body></html>`;
      invocation.dispatch();
      const artifact = htmlArtifact(html, { prompt: JSON.stringify(messages), model: 'deterministic-html', provider: 'local-demo-fake', operation, now: now() });
      invocation.usage({ inputTokens: 0, outputTokens: 0 }); completed = true; return artifact;
    } finally { try { await invocation?.finish(completed); } finally { scope.dispose(); } }
  }
  const generate = (spec, feedback, options) => run('generate', spec, feedback, options);
  const plugin = Object.freeze({ manifest, label: 'Fake HTML — local deterministic click-dummy, no provider network',
    estimateCost(request) {
      if (!request) return 0;
      const { feedback = '', previousArtifact, ...spec } = request;
      buildMessages(spec, feedback, previousArtifact ? previousDocument(previousArtifact) : undefined);
      return 0;
    },
    generate, edit: (artifact, spec, feedback, options) => run('edit', spec, feedback, options, artifact),
    async health(options) { options.signal?.throwIfAborted(); return { available: true }; } });
  implementations.set(generate, plugin); return plugin;
}
