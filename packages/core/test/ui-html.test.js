import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { inspectHTML, isHTMLArtifact, verifyHTMLArtifact, contentDigest, uiGenerationConformance, beginInvocation, operationScope,
  normalizedError, deepFreeze, IPTC_DIGITAL_SOURCE, MAX_HTML_BYTES, HTML_PREVIEW_CSP, isUIArtifact } from '@inspr/aithema-core';
const dummy = readFileSync(new URL('../../../test/fixtures/click-dummy.html', import.meta.url), 'utf8');
const encode = text => new TextEncoder().encode(text);
const page = body => encode(`<!doctype html><html><head><title>x</title></head><body>${body}</body></html>`);
async function artifact(html, origin = 'ai-generated') {
  const bytes = encode(html);
  return { bytes, mediaType: 'text/html', promptDigest: `sha256:${createHash('sha256').update('prompt').digest('hex')}`,
    provenance: { version: 1, origin, modality: 'html', digitalSourceType: IPTC_DIGITAL_SOURCE[origin === 'ai-generated' ? 'generated' : 'manipulated'],
      generatedAt: new Date(0).toISOString(), generator: { provider: 'fixture', model: 'fixture-model' }, techniques: ['response-field'],
      assurances: { digitallySigned: false, imperceptibleWatermark: 'provider-status-unknown' },
      subject: { contentDigest: await contentDigest(bytes), mediaType: 'text/html' } } };
}
test('the sample click-dummy passes the static policy; the preview CSP is strict', () => {
  assert.deepEqual(inspectHTML(encode(dummy)), { ok: true, problems: [] });
  for (const directive of ["default-src 'none'", "script-src 'unsafe-inline'", "style-src 'unsafe-inline'", 'img-src data:', 'font-src data:', "form-action 'none'", "base-uri 'none'"]) {
    assert.ok(HTML_PREVIEW_CSP.includes(directive), directive);
  }
  assert.doesNotMatch(HTML_PREVIEW_CSP, /https?:|\*|'self'|connect-src/u);
});
for (const [name, bytes, problem] of [
  ['an empty body', new Uint8Array(), 'empty'],
  ['invalid UTF-8', Uint8Array.from([0x3c, 0xff, 0xfe]), 'utf-8'],
  ['oversize bytes', new Uint8Array(MAX_HTML_BYTES + 1).fill(0x20), 'size'],
  ['a fragment', encode('<div>hello</div>'), 'document'],
  ['two documents', encode(`${dummy}\n${dummy}`), 'document'],
  ['text after the document', encode(`${dummy}<p>more</p>`), 'document'],
  ['a NUL byte', page('a\u0000b'), 'control-character'],
  ['an https image', page('<img src="https://example.invalid/x.png" alt="">'), 'external-reference'],
  ['a protocol-relative link', page('<a href="//example.invalid">x</a>'), 'external-reference'],
  ['a relative link', page('<a href="/elsewhere">x</a>'), 'external-reference'],
  ['a javascript: link', page('<a href="javascript:void 0">x</a>'), 'external-reference'],
  ['an entity-hidden scheme', page('<img src="&#104;ttps:x">'), 'external-reference'],
  ['an srcset', page('<img src="data:image/png;base64,AA==" srcset="a.png 2x">'), 'external-reference'],
  ['an external script', page('<script src="app.js"></script>'), 'external-reference'],
  ['a stylesheet link', page('<link rel="stylesheet" href="#x">'), 'embedded-content'],
  ['a CSS import', page('<style>@import "x.css";</style>'), 'external-reference'],
  ['a CSS url', page('<div style="background:url(x.png)"></div>'), 'external-reference'],
  ['an escaped CSS url', page('<style>.a{background:u\\72l(x.png)}</style>'), 'obfuscation'],
  ['an SVG href animation', page('<svg><a><set attributeName="href" to="x"/></a></svg>'), 'external-reference'],
  ['a base element', page('<base href="#">'), 'base'],
  ['a meta refresh', page('<meta http-equiv="refresh" content="0;url=#">'), 'http-equiv'],
  ['a form posting out', page('<form action="/submit"><button>x</button></form>'), 'form'],
  ['a POST form', page('<form method="post"></form>'), 'form'],
  ['a button formaction', page('<form><button formaction="/x">x</button></form>'), 'form'],
  ['an iframe', page('<iframe srcdoc="x"></iframe>'), 'embedded-content'],
  ['an object', page('<object data="x"></object>'), 'embedded-content'],
  ['a module script', page('<script type="module">1</script>'), 'module-script'],
  ['fetch', page('<script>fetch("/x")</script>'), 'network-api'],
  ['a beacon in a handler', page('<button onclick="navigator.sendBeacon(1)">x</button>'), 'network-api'],
  ['a WebSocket', page('<script>new WebSocket(u)</script>'), 'network-api'],
  ['window.open', page('<script>window.open("#")</script>'), 'network-api'],
  ['document.cookie', page('<script>document.cookie</script>'), 'storage'],
  ['localStorage', page('<script>localStorage.setItem("a", 1)</script>'), 'storage'],
  ['a location assignment', page('<script>location = "#x"</script>'), 'navigation'],
  ['a literal src assignment', page('<script>img.src = "x.png"</script>'), 'navigation'],
  ['eval', page('<script>eval("1")</script>'), 'obfuscation'],
  ['an ASCII escape', page('<script>self["\\x66etch"]()</script>'), 'obfuscation'],
  ['an unterminated script', encode('<!doctype html><html><head></head><body><script>1</body></html>'), 'document'],
  ['a swallowed tag', page('<img alt=\'x onerror=1 <img src=y>'), 'document'],
]) test(`inspectHTML rejects ${name}`, () => {
  const result = inspectHTML(bytes);
  assert.equal(result.ok, false); assert.ok(result.problems.includes(problem), result.problems.join());
});
test('inspectHTML allows in-page anchors, data images, SVG namespaces, hash routing and prose about locations', () => {
  const html = page('<svg xmlns="http://www.w3.org/2000/svg" xmlns:xlink="http://www.w3.org/1999/xlink"><use href="#i"/></svg>' +
    '<a href="#top">Top</a><img src="data:image/png;base64,AA==" alt=""><p>Pick a location; fetch the mail.</p>' +
    '<style>.a{background:url(data:image/png;base64,AA==);content:"\\201C"}</style><form><button>Send</button></form>' +
    '<script>const label = "Choose a location"; location.hash = "#a"; if (1 < 2 && label) document.title = label;</script>');
  assert.deepEqual(inspectHTML(html), { ok: true, problems: [] });
});
test('html artifacts have exact keys, html modality and a digest that matches the bytes', async () => {
  const good = await artifact(dummy);
  assert.equal(isHTMLArtifact(good), true); assert.equal(await verifyHTMLArtifact(good), true);
  assert.equal(isUIArtifact(good), false, 'image predicate stays image-only');
  for (const mutate of [a => { a.width = 1; }, a => { a.mediaType = 'text/html;charset=utf-8'; }, a => { a.provenance.modality = 'image'; },
    a => { a.provenance.url = 'https://example.invalid'; }, a => { a.provenance.subject.mediaType = 'image/png'; },
    a => { a.bytes = new Uint8Array(MAX_HTML_BYTES + 1); }, a => { a.provenance.generator.model = ''; }]) {
    const broken = await artifact(dummy); mutate(broken); assert.equal(isHTMLArtifact(broken), false);
  }
  const stale = await artifact(dummy); stale.bytes = encode(dummy.replace('Fixit', 'Fixat'));
  assert.equal(isHTMLArtifact(stale), true); assert.equal(await verifyHTMLArtifact(stale), false);
  assert.equal(await verifyHTMLArtifact(await artifact(dummy.replace('<main', '<img src="https://example.invalid/x.png"><main'))), false);
});
// In-process fixture plugin: no network; "dispatch" is counted and stalls on request.
function htmlFixture({ html = dummy, formats = ['text/html'] } = {}) {
  let requests = 0;
  const manifest = deepFreeze({ id: 'html-fixture', version: '0.0.0', apiVersion: '^1.0.0', kinds: ['ui-generation'], placement: 'server',
    entrypoints: { server: './fixture.js' }, configSchema: { type: 'object' }, vendor: { name: 'Fixture', url: 'https://example.test' },
    models: [{ id: '*', operations: ['generate', 'edit'], streaming: false, structured: false, efforts: ['none'], languages: ['en'],
      germanQuality: 'unverified', formats, processingLocations: ['unverified'], qualification: 'unverified', evidence: [], expiresAt: null,
      cost: { unit: 'token', inputMicro: null, outputMicro: null, reviewedAt: null } }] });
  async function run(spec, options, origin) {
    const invocation = await beginInvocation(options), scope = operationScope(options); let completed = false;
    try {
      scope.signal.throwIfAborted(); invocation.dispatch(); requests++;
      if (spec.prompt === 'fixture-stall') await new Promise((_, reject) => scope.signal.addEventListener('abort', () => reject(scope.signal.reason), { once: true }));
      invocation.usage({ inputTokens: 3, outputTokens: 5 });
      const result = await artifact(html, origin); completed = true; return result;
    } catch (error) { throw normalizedError(error, scope.signal); }
    finally { scope.dispose(); await invocation.finish(completed); }
  }
  return { requests: () => requests, plugin: { id: manifest.id, manifest, health: async () => ({ available: true }),
    generate: (spec, _feedback, options) => run(spec, options, 'ai-generated'),
    edit: (_artifact, spec, _feedback, options) => run(spec, options, 'ai-manipulated') } };
}
const kit = async (fixture, input) => uiGenerationConformance(fixture.plugin, input, { stallSpec: { prompt: 'fixture-stall' },
  stallFeedback: 'fixture-stall', requestCount: fixture.requests, expectedUsage: { inputTokens: 3, outputTokens: 5 } });
test('conformance accepts a conforming html fixture and rejects a broken one', async () => {
  const input = { spec: { prompt: 'Repair requests' }, feedback: 'Make the list denser', artifact: await artifact(dummy) };
  assert.deepEqual(await kit(htmlFixture(), input), { ok: true, failures: [] });
  for (const html of [dummy.replace('<main', '<img src="https://example.invalid/pixel.png" alt=""><main'),
    dummy.replace('</head>', '<base href="#"></head>'), dummy.replace('<script>', '<script>fetch("/collect");'),
    dummy.replace('<form id="form" novalidate>', '<form id="form" action="/collect">'), `<div>${dummy}</div>`]) {
    const result = await kit(htmlFixture({ html }), input);
    assert.equal(result.ok, false); assert.ok(result.failures.includes('generate bytes/provenance artifact'));
    assert.ok(result.failures.includes('edit bytes/provenance artifact'));
  }
  const undeclared = await kit(htmlFixture({ formats: ['image/png'] }), input);
  assert.ok(undeclared.failures.includes('generate bytes/provenance artifact'), 'html must be a declared format');
});
