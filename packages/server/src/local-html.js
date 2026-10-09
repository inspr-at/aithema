import { deepFreeze, beginInvocation, operationScope, verifyHTMLArtifact, PluginError } from '@inspr/aithema-core';
import { manifest as htmlManifest, htmlArtifact, buildMessages, revisionOf } from '../../../plugins/claude-html/src/index.js';

const localGenerates = new WeakSet();
export const isLocalHTML = plugin => localGenerates.has(plugin?.generate);
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
<h1>${summary}</h1><p>${de ? 'Entwurf aus Ihrem Gespräch. Alle Daten sind Beispieldaten.' : 'Draft click-dummy, generated from your conversation. All data is sample data.'}</p>
<p>Revision ${revision}</p><button type="button" id="toggle" aria-expanded="false">${de ? 'Offene Fragen' : 'Open questions'}</button>
<button type="button" id="reset">${de ? 'Demo zurücksetzen' : 'Reset demo'}</button><section id="questions" hidden><ul>${questions || `<li>${de ? 'Keine offenen Fragen.' : 'No open questions.'}</li>`}</ul></section>
<script>const button=document.getElementById('toggle'),panel=document.getElementById('questions');button.addEventListener('click',()=>{panel.hidden=!panel.hidden;button.setAttribute('aria-expanded',String(!panel.hidden))});document.getElementById('reset').addEventListener('click',()=>{panel.hidden=true;button.setAttribute('aria-expanded','false')});</script>
</main></body></html>`;
      invocation.dispatch();
      const artifact = htmlArtifact(html, { prompt: JSON.stringify(messages), model: 'deterministic-html', provider: 'local-demo-fake', operation, now: now() });
      invocation.usage({ inputTokens: 0, outputTokens: 0 }); completed = true; return artifact;
    } finally { try { await invocation?.finish(completed); } finally { scope.dispose(); } }
  }
  const generate = (spec, feedback, options) => run('generate', spec, feedback, options);
  localGenerates.add(generate);
  return { manifest: deepFreeze({ ...htmlManifest, id: 'fake-html', vendor: { name: 'Local deterministic fake', url: 'https://example.test' },
    models: [{ ...htmlManifest.models[0], id: 'deterministic-html' }] }), label: 'Fake HTML — local deterministic click-dummy, no provider network',
    generate, edit: (artifact, spec, feedback, options) => run('edit', spec, feedback, options, artifact),
    async health(options) { options.signal?.throwIfAborted(); return { available: true }; } };
}
