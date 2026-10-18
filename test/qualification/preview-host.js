// Offline ports; the production mint/redemption handlers, registry and CSP are unchanged.
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { once } from 'node:events';
import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { htmlPreviewHostPolicy, inspectHTML } from '@inspr/aithema-core';
import { createConceptHandlers } from '../../packages/server/src/concept-handlers.js';
import { NotFoundError } from '../../packages/server/src/storage.js';

const root = new URL('../../', import.meta.url);
const digest = bytes => `sha-256=:${createHash('sha256').update(bytes).digest('base64')}:`;
export async function qualificationHost() {
  const template = await readFile(new URL('test/fixtures/html-preview-strict-host.html', root), 'utf8');
  const startup = await readFile(new URL('test/fixtures/html-preview-strict-host-startup.js', root), 'utf8');
  const hash = createHash('sha256').update(/<script type="importmap">([^<]+)<\/script>/u.exec(template)[1]).digest('base64');
  const artifacts = new Map(), hits = [], redemptions = [], mints = [];
  const session = { id: 'qualification', ownerHash: 'fixture-owner-hash', consentRevision: 1, concepts: [] };
  let publicationAllowed = true, handlers, origin, silent = false, allowedReload = 0;
  const server = createServer(async (req, res) => {
    const path = new URL(req.url, origin).pathname;
    hits.push(path); // Count at the socket, before dispatch, independently of browser events/console.
    try {
      if (path.startsWith('/api/') || path === '/_aithema/html-preview') {
        const request = new Request(new URL(req.url, origin), { method: req.method, headers: req.headers });
        let response = path === '/_aithema/html-preview' ? await handlers.handlePreview(request) : await handlers.handle(request);
        if (!response) response = new Response('Not Found', { status: 404 });
        if (path === '/_aithema/html-preview') {
          // Keep capability values out of evidence: assign an ordinal per mint.
          const index = mints.findIndex(url => url === request.url);
          redemptions.push({ mint: index + 1, method: req.method, status: response.status });
          if (silent && response.status === 200) {
            const html = (await response.text()).replace(/<script>addEventListener\('message',[\s\S]*?<\/script>/u, '');
            const headers = new Headers(response.headers); headers.delete('content-length'); headers.delete('content-digest');
            response = new Response(html, { headers }); // Deliberately missing private-port reply: readiness negative control.
          }
        } else if (response.status === 200) mints.push((await response.clone().json()).url);
        res.writeHead(response.status, Object.fromEntries(response.headers)); return res.end(Buffer.from(await response.arrayBuffer()));
      }
      if (path === '/strict-header-only') {
        res.writeHead(200, { 'content-type': 'text/html', 'content-security-policy': policy(),
          'set-cookie': 'host-cookie=host-cookie-secret; SameSite=Strict; Path=/' });
        return res.end(template.replace('<!-- HOST_POLICY_DECLARATION -->', ''));
      }
      if (path === '/strict-host-startup.js') {
        res.writeHead(200, { 'content-type': 'text/javascript' });
        return res.end(startup + `\nlocalStorage.setItem('host-storage','host-storage-secret');sessionStorage.setItem('host-storage','host-session-secret');
window.results=[];addEventListener('message',e=>{if(e.data?.qualification)window.results.push({result:e.data,origin:e.origin});});
window.show=id=>{document.querySelector('aithema-html-preview').artifact={mediaType:'text/html',previewURL:location.origin+'/_aithema/html-preview',mint:async signal=>{const r=await fetch('/api/sessions/qualification/concepts/'+id+'/preview',{method:'POST',headers:{'X-Aithema-Session-Token':'fixture-owner'},signal});if(!r.ok)throw Error('mint refused');const source=await r.json();window.lastSource=source;return source;}};};`);
      }
      if (path.startsWith('/beacon/') || path.startsWith('/destination/')) {
        res.writeHead(200, { 'content-type': 'text/html', 'access-control-allow-origin': '*' });
        return res.end('<!doctype html><p>network control</p>');
      }
      if (/^\/packages\/(?:ui|core)\/src\/[\w-]+\.js$/u.test(path)) {
        res.writeHead(200, { 'content-type': 'text/javascript' }); return res.end(await readFile(new URL('.' + path, root)));
      }
      res.writeHead(404); res.end();
    } catch { res.writeHead(500); res.end('Fixture dispatch failed'); }
  });
  server.listen(0, '127.0.0.1'); await once(server, 'listening');
  origin = `http://127.0.0.1:${server.address().port}`;
  const policy = () => `default-src 'self'; script-src 'self' 'sha256-${hash}'; style-src 'self' 'unsafe-inline'; ${htmlPreviewHostPolicy(origin + '/_aithema/html-preview')}; object-src 'none'; base-uri 'none'; form-action 'none'`;
  handlers = createConceptHandlers({ previewURL: origin + '/_aithema/html-preview',
    ownership: { token: r => r.headers.get('x-aithema-session-token') },
    storage: {
      get: id => { if (id !== session.id || session.tombstone) throw new NotFoundError(); return session; },
      authorize: (id, token) => { if (id !== session.id || token !== 'fixture-owner') throw new NotFoundError(); return session; },
      conceptArtifact: (id, artifactId) => id === session.id && artifacts.get(artifactId) || { erased: true },
    }, runtime: { publicationAllowed: async () => publicationAllowed },
  });
  return { origin, policy, hits, redemptions, mints, session,
    allowReload() { allowedReload = mints.length; },
    get duplicateInitialLoad() {
      return mints.some((_, i) => i + 1 !== allowedReload && redemptions.filter(r => r.mint === i + 1).length > 1);
    },
    add(id, html) {
      const bytes = new TextEncoder().encode(html);
      const admission = inspectHTML(bytes);
      assert.equal(admission.ok, true, `${id} passes static admission (${admission.problems}); the browser must enforce containment`);
      artifacts.set(id, { bytes, mediaType: 'text/html', provenance: { subject: { contentDigest: digest(bytes) } } });
      session.concepts.push({ id });
    },
    publication: allowed => { publicationAllowed = allowed; },
    silent: value => { silent = value; },
    async close() { handlers.closePreviews(); server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); },
  };
}

export const hostile = origin => `<!doctype html><html><head><title>Containment</title></head><body><button id="interact">Click</button><script>
(async()=>{const w=self,base='ht'+'tp:/'+'/127.0.0.1:${new URL(origin).port}',r={qualification:true,origin:String(w.origin)};
const blocked=(key,fn)=>{try{r[key]=fn();}catch(e){r[key]='blocked '+e.name;}};
blocked('parentDom',()=>w['par'+'ent'].document.body.textContent);
blocked('parentCookie',()=>w['par'+'ent'].document['coo'+'kie']);
blocked('cookie',()=>document['coo'+'kie']);
blocked('storage',()=>w['local'+'Storage'].getItem('host-storage'));
blocked('session'+'Storage',()=>w['session'+'Storage'].getItem('host-storage'));
blocked('parentStorage',()=>w['par'+'ent']['local'+'Storage'].getItem('host-storage'));
try{await w['fe'+'tch'](base+'/beacon/fetch');r.fetch='reached';}catch(e){r.fetch='blocked '+e.name;}
r.image=await new Promise(resolve=>{const i=new Image();i.onload=()=>resolve('reached');i.onerror=()=>resolve('blocked');i['sr'+'c']=base+'/beacon/image';});
blocked('popup',()=>w['op'+'en'](base+'/beacon/popup')===null?'blocked':'opened');
blocked('form',()=>{const f=document.createElement('form');f['act'+'ion']=base+'/beacon/form';f['meth'+'od']='post';document.body.append(f);f.submit();return 'attempted';});
blocked('top',()=>{w['to'+'p']['loc'+'ation']=base+'/beacon/top';return 'attempted';});
document.getElementById('interact').onclick=e=>{e.target.textContent='Changed';};w['par'+'ent'].postMessage(r,'*');})();
</script></body></html>`;
export const leaving = (origin, delayed) => `<!doctype html><html><head><title>Navigation</title><script>
const leave=()=>{self['loc'+'ation']['hr'+'ef']='ht'+'tp:/'+'/127.0.0.1:${new URL(origin).port}/destination/${delayed ? 'delayed' : 'immediate'}';};
${delayed ? "addEventListener('load',()=>setTimeout(leave,100));" : 'leave();'}
</script></head><body>Navigation probe</body></html>`;
