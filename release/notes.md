# Aithema 2026.10

Version **261019003029.0.0**. Licensed under **AGPL-3.0-only**.

Seventh October release: HTML drafts now show on sites with strict security settings.

## What START and visitors notice

- **HTML drafts work on strict hosts (AIT-341; AIT-352/353/354):** drafts now load
  through a same-host route and work under a strict script policy. Loading has
  a time budget before the page arrives. When a draft cannot show, visitors get
  a plain reason and an alert icon; operators get the policy detail needed to fix it.
- **Steady credits (AIT-357):** the footer reserves its width, so the first
  spending receipt moves nothing.
- **Grok groundwork (AIT-344/345/346):** Grok voice is not available yet; its STT/TTS components remain source-only, outside the release closure and unselectable, with publication deferred to RC8.
- **Checks (AIT-355/359):** test and CI robustness improved; strict-host preview qualification covers Chromium, Firefox and WebKit (AIT-354).

## For hosts

### Preview setup (AIT-341)

Executable drafts now use `/_aithema/html-preview` instead of `srcdoc`. Configure
one canonical public URL on both server and component; no raw `srcdoc` fallback:

```js
import { htmlPreviewHostPolicy } from '@inspr/aithema-core';
const previewURL = 'https://start.example.test/_aithema/html-preview';
const handlers = createHandlers({ /* storage, runtime, ownership, ... */
  concepts: { previewURL }
});
element.configure({ copy: en, session, sessionToken: token, concepts: { previewURL } });
const previewFramePolicy = htmlPreviewHostPolicy(previewURL);
// frame-src https://start.example.test/_aithema/html-preview; child-src 'none'
```

Merge those exact frame/child directives into the page's enforced response CSP,
retaining its strict script policy. Use the exact URL without a query, fragment,
credentials or trailing slash. For an external-module page without an import map:

```http
Content-Security-Policy: default-src 'self'; script-src 'self'; frame-src https://start.example.test/_aithema/html-preview; child-src 'none'; object-src 'none'; base-uri 'self'
```

An inline import map additionally needs a hash of its exact bytes in `script-src`,
as shown in the embedding guide. No head-meta declaration is required. Remove
any legacy `frame-src 'none'` meta policy: enforced policies intersect and would
still deny the route. Broad `frame-src 'self'` and report-only policies fail the
component's check. Missing server configuration disables minting; invalid
configuration fails at startup. The component probes policy before loading and
bounds both pre-load waiting and readiness; it never falls back to raw HTML.

The parent calls `POST /api/sessions/:id/concepts/:artifactId/preview` with its
normal owner authentication (header-token or host cookie adapter). No body is
required. A successful `200` JSON response is `{ url, expiresInMs: 60000 }` with
`Cache-Control: no-store`. Missing/wrong owners or artifacts return `404`;
publication/consent refusal returns `403`; methods other than POST return `405`.
A registry full of live tokens refuses minting with a plain `503`,
`Cache-Control: private, no-store` and `Retry-After: 60`; retry with a fresh mint.
The parent mounts that URL in an iframe with `sandbox="allow-scripts"` and
`referrerpolicy="no-referrer"`, retaining powerful-feature denials. Never add
`allow-same-origin`, top navigation, forms, popups or downloads.

`GET /_aithema/html-preview?cap=…` accepts only the capability, bypassing
owner cookies/headers and application session-auth middleware. A surrounding
reverse-proxy basic-auth gate still applies, as shown below. Tokens contain 256
CSPRNG bits, are stored only as hashes in a bounded process-local registry
(default 1024 entries), and expire in 60 seconds measured by a monotonic clock.
GET consumes the token before asynchronous checks. HEAD always returns `405`
with `Allow: GET` and `private, no-store`, without checking or consuming a token,
redirecting or setting cookies. Expired registry entries are purged first;
a full live registry refuses new mints instead of evicting live tokens.
Each session holds at most eight live tokens by default; exceeding that share
replaces only that session's oldest token. Ownership, consent revision, publication,
erasure and the artifact's digest/static policy are checked on redemption;
current ownership/consent/erasure/bytes are checked again after publication.
Restart, another instance, reuse, expiry or replacement at the session's own
quota requires a fresh mint.
The parent must re-mint on every retry/reload: **no network; a self-reload is refused**.
Already delivered bytes cannot be revoked, so lifecycle events must remove frames.

Successful preview responses carry exactly this policy contract (plus content
length and a digest of the served representation, including the trusted
`aithema-html-preview-ready` private-port bootstrap):

```http
Content-Type: text/html; charset=utf-8
Cache-Control: private, no-store
Content-Security-Policy: sandbox allow-scripts; default-src 'none'; script-src 'unsafe-inline'; style-src 'unsafe-inline'; img-src data:; font-src data:; connect-src 'none'; frame-src 'none'; child-src 'none'; worker-src 'none'; object-src 'none'; form-action 'none'; base-uri 'none'; frame-ancestors https://start.example.test
Referrer-Policy: no-referrer
X-Content-Type-Options: nosniff
```

Denials are direct plain `403/404` responses with `private, no-store`,
`no-referrer`, `nosniff` and a script-disabled sandbox policy. No preview response
redirects or sets cookies. Keep the exact path ahead of login/SPA fallbacks;
strip cookies/owner headers and `Set-Cookie` at the reverse proxy, preserve the
application CSP, and redact `cap` from access logs/analytics. Do not append the
host page's script policy to preview responses or cache capability URLs.
For the OPS Caddy deployment, put the **exact-path** preview handler inside the
existing basic-auth gate, before the generic proxy. This example keeps that gate
on every path; supply the existing password hash through Caddy's environment and
retain the host's request-body limit. Set the host page CSP per page route,
never as a global header that also lands on the preview response.

```caddyfile
start.example.test {
    log {
        format filter {
            wrap json
            fields {
                request>uri query {
                    replace cap REDACTED
                }
                request>headers>X-Aithema-Session-Token delete
            }
        }
    }
    handle {
        basic_auth {
            operator {$BASIC_AUTH_HASH}
        }
        request_body {
            max_size 32MB
        }
        handle /_aithema/html-preview {
            reverse_proxy 127.0.0.1:8093 {
                header_up -Cookie
                header_up -Authorization
                header_up -X-Aithema-Session-Token
                header_down -Set-Cookie
                flush_interval -1
            }
        }
        handle {
            reverse_proxy 127.0.0.1:8093 {
                flush_interval -1
            }
        }
    }
}
```

Do not use `handle_path` (it strips the path), a wildcard path matcher, a login
redirect or an SPA fallback for this route. `Authorization` is checked at the
outer basic-auth gate and removed before proxying the preview; `Cookie` and the
owner token are removed too. The log filter redacts the `cap` query value in
`request.uri` and deletes the custom session-token header, which Caddy does not
redact by default. Apply equivalent redaction to any other access logs, traces or
analytics; never log the full capability URL. No new signing secret is needed.

The registry belongs to one server process. A restart invalidates outstanding
capabilities. Multiple instances must send mint and redemption to the same
process (for example with routing affinity); a capability minted elsewhere is
refused, and the parent must request a new mint on retry. Do not solve routing
misses or browser retries by making capabilities reusable. An already delivered
draft cannot have its bytes recalled: the host must propagate withdrawal,
consent revocation, erasure and session changes so the component removes it.
The security guarantee is **no network; a self-reload is refused**. The initial
capability redemption and an explicitly attempted self-reload reach the preview
route; the latter receives a plain `403`. The sandbox and page CSP block outbound
draft fetches, images, forms, popups, top navigation and other-page navigation.

### Supported coordinator and relay layout

`@inspr/aithema-server/composed-voice` is the supported coordinator export,
including `createComposedVoiceCoordinator` and `callDurationSeconds`. It coordinates
separately admitted STT, reasoning and TTS through trusted server ports; it does
not qualify a new live pipeline. The duration ceiling defaults to 900 seconds
and accepts integers from 1 to 86400; hosts supply their own ceiling explicitly.

Composed relay modules now live under `packages/server/src/composed/`, with
supported `@inspr/aithema-server/composed-voice/*` subpaths. Existing source-path
shims are kept. Provider prototypes remain outside the fifteen module tarballs;
there is no new selectable voice provider in this release.

## Breaking for hosts

**HTML preview embedding changes (AIT-341):** hosts upgrading from `srcdoc` must
add and proxy the same-host route, configure its canonical URL on server and
component, allow that exact URL in the page's `frame-src`, and remove the old
head-meta `frame-src 'none'` requirement. Keep the preview response's own headers
and re-mint for every retry. Existing embedders need these changes before drafts
can run, so this is a host integration break. The raw download and standalone
export remain script-disabled attachments.

## What is included

Aithema provides embeddable conversation modules: core state and plugin contracts,
server Web Request handlers and a Node HTTP adapter with SQLite persistence,
and UI components including `<aithema-session>` and isolated HTML previews.
Hosts supply authentication, ownership, storage, consent and budget policy.

The fifteen packages are `@inspr/aithema-core`, `@inspr/aithema-server`,
`@inspr/aithema-ui`, and
`@inspr/aithema-plugin-{openrouter,mistral,device,elevenlabs,openai-images,claude-html,codex-imagegen,extract-text,extract-pdf,extract-ooxml,mail-smtp,zitadel-oidc}`.
They cover text reasoning, voice, image and HTML generation, bounded offline
text/PDF/OOXML extraction, mail and identity integration. Provider credentials
are supplied by the host; none are bundled. The device preset supports browser
text only. EU processing requires qualification of the specific account and
route, plus current consent.

Release assets include module tarballs, a source/workspace archive, dependency
locks, an SPDX SBOM inside the workspace archive, and `release-set.json` with
source provenance and artifact digests. The workspace root is not installable.

## Verify and install

Download the assets for `v261019003029.0.0` into a clean directory:

```sh
gh release download v261019003029.0.0 --repo inspr-at/aithema
for asset in SHA256SUMS release-set.json consumer-evidence.json \
  consumer-package-lock.json deployment-pin.json *.tgz; do
  gh attestation verify "$asset" --repo inspr-at/aithema
done
sha256sum --check SHA256SUMS
```

Require every verification command to succeed before installing. On macOS, use
`shasum -a 256 --check SHA256SUMS` for the checksum step. These checks apply to
**the published assets**. `consumer-evidence.json` binds the tested package
digests to the published manifest and source commit; earlier preparation
artifacts are not release checksums.

Install all fifteen module URLs together so their exact internal dependencies
resolve without registry publication. From the directory containing the verified
manifest, run this in your host project (adjust the manifest path as needed):

```sh
node --input-type=module <<'NODE'
import { readFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
const manifest = JSON.parse(readFileSync('./release-set.json', 'utf8'));
const base = 'https://github.com/inspr-at/aithema/releases/download/v261019003029.0.0/';
const urls = manifest.artifacts.filter(a => a.kind === 'module').map(a => base + a.path);
execFileSync('npm', ['install', '--save-exact', ...urls], { stdio: 'inherit' });
NODE
```

Commit the host's `package-lock.json`: its release URLs and `sha512` integrity
values pin the downloaded tarball bytes. The verified
`consumer-package-lock.json` records the release consumer's tarball integrity
values for comparison. Use `npm ci` for subsequent installs. Retain the verified
assets, manifest and deployment pin for rollback to those exact bytes.

## Compatibility and known follow-ups

The split modules replace the private 0.10.1 monolith and break its API. There is
no automatic legacy API or database conversion. Adapt host integrations to the
module handlers and components, and retain the previous deployment and database
backup separately. The plugin protocol `apiVersion: ^1.0.0` is independent of
the product version.

- A 60-minute German/English live voice soak has not been measured. Offline
  qualification does not establish live latency or disruption recovery.
- A second independent voice pipeline remains unproven. The new component API and offline
  kits do not qualify a second live pipeline; provider prototypes remain source-only.
- Browser consumers need a bundler or import map and module JSON support.
  Consumer smoke checks do not establish host-specific layout, CSP enforcement
  or live provider quality.
- Further legal formalisation remains follow-up work; this release grants no
  rights beyond its included licence and rights/provenance notices.

See the [embedding guide](https://github.com/inspr-at/aithema/blob/v261019003029.0.0/docs/embedding.md)
for host integration and supported exports, and the published `SHA256SUMS`,
attestations and `consumer-evidence.json` for verification of this release.
