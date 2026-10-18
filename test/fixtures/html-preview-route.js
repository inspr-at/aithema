// Offline fixture transport using the production registry and response policy.
import { createHTMLPreviewCapabilities } from '../../packages/server/src/html-preview-capabilities.js';
import { previewConfiguration, previewDenied, previewResponse } from '../../packages/server/src/html-preview.js';
export function previewFixture() {
  const registry = createHTMLPreviewCapabilities();
  return async (req, res) => {
    const base = `http://${req.headers.host}`, url = new URL(req.url, base);
    let response;
    if (url.pathname === '/fixture/mint' && req.method === 'POST') {
      let html = ''; for await (const chunk of req) html += chunk;
      const cap = registry.mint({ html });
      response = Response.json({ url: `${base}/_aithema/html-preview?cap=${cap}`, expiresInMs: registry.ttlMs });
    } else if (url.pathname === '/_aithema/html-preview') {
      const scope = registry.redeem(url.searchParams.get('cap'));
      response = scope ? previewResponse({ bytes: new TextEncoder().encode(scope.html) }, previewConfiguration(`${base}/_aithema/html-preview`)) : previewDenied();
    } else return false;
    res.writeHead(response.status, Object.fromEntries(response.headers)); res.end(Buffer.from(await response.arrayBuffer())); return true;
  };
}
