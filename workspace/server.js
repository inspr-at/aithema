import { createServer } from 'node:http';
import { randomBytes, randomUUID } from 'node:crypto';
import { join } from 'node:path';

import { validateProjectKinds } from '../lib/validate.js';
import { ConversationController } from '../runtime/controller.js';
import { createIdentityVerifier, isLoopbackHost } from '../runtime/identity.js';
import { createProviderRegistry } from '../runtime/provider.js';
import { SqliteProjectStore } from '../runtime/store.js';
import { normalizeWorkspaceConfig } from './config.js';
import { readAllowedStatic, resolveWorkspaceStatic } from './flow-assets.js';
import { buildWorkspaceFlowState, handleHostFlowIntent } from './flow-context.js';
import { renderWorkspacePage } from './page.js';

const COOKIE = 'aithema_demo';
const MAX_BODY = 32_000;
const SECURITY_HEADERS = Object.freeze({
  'x-content-type-options': 'nosniff',
  'x-frame-options': 'SAMEORIGIN',
  // strict-origin-when-cross-origin preserves same-origin Origin on form POSTs;
  // no-referrer forces Origin:null and breaks cookie-session CSRF checks.
  'referrer-policy': 'strict-origin-when-cross-origin',
  'cache-control': 'no-store',
  'content-security-policy': [
    "default-src 'none'",
    "script-src 'self'",
    "style-src 'self' 'unsafe-inline'",
    "img-src 'self'",
    "form-action 'self'",
    "base-uri 'self'",
    "frame-ancestors 'self'",
  ].join('; '),
});

/**
 * @param {import('./config.js').normalizeWorkspaceConfig extends Function ? object : never} rawConfig
 * @param {{ fetchImpl?: typeof fetch }} [options]
 */
export function createWorkspaceServer(rawConfig, options = {}) {
  const config = normalizeWorkspaceConfig(rawConfig);
  const identityConfig = { ...(config.identity ?? {}) };
  if (config.labelledDemo && (identityConfig.demoHmacSecret == null || identityConfig.demoHmacSecret === '')) {
    identityConfig.demoHmacSecret = randomBytes(32).toString('hex');
  }
  const identity = createIdentityVerifier(identityConfig, config.mode);
  const registry = createProviderRegistry(config, {
    mode: config.mode,
    fetchImpl: options.fetchImpl ?? rawConfig.fetchImpl,
    limits: config.limits,
    instantiateAll: Boolean(config.policy),
  });
  const provider = registry.defaultProvider;
  const dbFile = config.dataDir === ':memory:'
    ? ':memory:'
    : (config.databaseFile || join(config.dataDir, 'aithema-workspace.sqlite'));
  const store = new SqliteProjectStore(dbFile);
  const controller = new ConversationController({
    store,
    provider,
    providers: registry.byId,
    defaultProviderId: registry.defaultId,
    policy: config.policy,
    mode: config.mode,
    limits: config.limits,
    uploadLimits: config.uploadLimits,
  });

  const server = createServer((req, res) => {
    handle(req, res).catch((error) => {
      if (!res.headersSent) {
        html(res, 500, pageModel({ error: error instanceof Error ? error.message : 'server error' }));
      }
    });
  });

  async function handle(req, res) {
    const host = req.headers.host ?? '';
    if ((config.mode === 'demo' || config.mode === 'test') && !isLoopbackHost(host)) {
      json(res, 403, { error: 'demo/test mode is loopback-only' });
      return;
    }
    const url = new URL(req.url ?? '/', `http://${host || '127.0.0.1'}`);
    if (req.method !== 'GET' && req.method !== 'HEAD' && url.pathname !== '/health') {
      try {
        assertSameOriginMutation(req, url, config.publicOrigin);
      } catch (error) {
        const status = 403;
        if (wantsJson(req)) json(res, status, { error: messageOf(error) });
        else html(res, status, pageModel({ error: messageOf(error) }));
        return;
      }
    }
    let actor = null;
    try {
      actor = await identity.verify(req.headers.authorization, readCookie(req, COOKIE));
    } catch {
      actor = null;
    }

    if (url.pathname === '/health') {
      json(res, 200, { ok: true, ready: true });
      return;
    }

    if (req.method === 'GET' || req.method === 'HEAD') {
      const asset = resolveWorkspaceStatic(url.pathname);
      if (asset) {
        serveAllowedStatic(res, asset, req.method === 'HEAD');
        return;
      }
      if (url.pathname.startsWith('/flow-shell/') || url.pathname === '/workspace-flow-host.js') {
        json(res, 404, { error: 'static asset is not on the closed allowlist' });
        return;
      }
    }

    if (req.method === 'POST' && url.pathname === '/session/demo') {
      if (!config.labelledDemo) {
        html(res, 403, pageModel({ error: 'demo identity is disabled in production' }));
        return;
      }
      if (!isLoopbackHost(host)) {
        html(res, 403, pageModel({ error: 'demo identity is loopback-only' }));
        return;
      }
      const body = await readForm(req);
      const subject = String(body.subject || identity.defaultSubject);
      try {
        const cookie = identity.issueCookie(subject);
        redirect(res, '/', { 'set-cookie': `${COOKIE}=${cookie}; Path=/; HttpOnly; SameSite=Lax` });
      } catch (error) {
        html(res, 400, pageModel({ error: error instanceof Error ? error.message : 'demo identity failed', demoSubjects: demoSubjects() }));
      }
      return;
    }

    if (url.pathname === '/' && req.method === 'GET') {
      if (!actor && !config.labelledDemo) {
        html(res, 401, pageModel({ error: 'Verified identity required.' }));
        return;
      }
      const projects = actor ? store.listProjects(actor) : [];
      html(res, 200, pageModel({ actor, projects, demoSubjects: demoSubjects() }));
      return;
    }

    if (url.pathname === '/flow-state' && (req.method === 'GET' || req.method === 'HEAD')) {
      if (!actor) {
        json(res, 401, { error: config.labelledDemo ? 'Sign in with labelled demo identity first.' : 'Verified identity required.' });
        return;
      }
      json(res, 200, flowStateFor(actor, null));
      return;
    }

    if (req.method === 'POST' && url.pathname === '/flow-intents') {
      if (!actor) {
        json(res, 401, { error: config.labelledDemo ? 'Sign in with labelled demo identity first.' : 'Verified identity required.' });
        return;
      }
      await respondFlowIntent(req, res, actor, null);
      return;
    }

    if (!actor) {
      html(res, 401, pageModel({
        error: config.labelledDemo ? 'Sign in with labelled demo identity first.' : 'Verified identity required.',
        demoSubjects: demoSubjects(),
      }));
      return;
    }

    if (req.method === 'POST' && url.pathname === '/projects') {
      const body = await readForm(req);
      const kinds = asList(body.project_kinds);
      try {
        validateProjectKinds(kinds);
        const project = controller.createProject(actor, {
          title: String(body.title || '').trim() || 'Untitled project',
          projectKinds: kinds,
        });
        redirect(res, `/projects/${encodeURIComponent(project.project_ref)}`);
      } catch (error) {
        html(res, 400, pageModel({ actor, projects: store.listProjects(actor), error: messageOf(error) }));
      }
      return;
    }

    const projectMatch = url.pathname.match(/^\/projects\/([^/]+)(?:\/(.*))?$/);
    if (!projectMatch) {
      html(res, 404, pageModel({ actor, projects: store.listProjects(actor), error: 'Not found' }));
      return;
    }
    const projectRef = decodeURIComponent(projectMatch[1]);
    const rest = projectMatch[2] ?? '';

    let project;
    try {
      project = controller.loadProject(actor, projectRef);
    } catch (error) {
      html(res, error?.code === 'forbidden' ? 403 : 404, pageModel({
        actor,
        projects: store.listProjects(actor),
        error: messageOf(error),
      }));
      return;
    }

    if (req.method === 'GET' && rest === '') {
      const notice = pageNotice(url.searchParams);
      html(res, 200, pageModel({ actor, projects: store.listProjects(actor), project, notice }));
      return;
    }

    if ((req.method === 'GET' || req.method === 'HEAD') && rest === 'flow-state') {
      json(res, 200, flowStateFor(actor, project));
      return;
    }

    if (req.method === 'POST' && rest === 'flow-intents') {
      await respondFlowIntent(req, res, actor, project);
      return;
    }

    if (req.method === 'GET' && rest === 'handover.json') {
      const handover = controller.handover(actor, projectRef);
      res.writeHead(200, { ...SECURITY_HEADERS, 'content-type': 'application/json; charset=utf-8' });
      res.end(JSON.stringify(handover.json, null, 2));
      return;
    }
    if (req.method === 'GET' && rest === 'handover.csv') {
      const handover = controller.handover(actor, projectRef);
      res.writeHead(200, { ...SECURITY_HEADERS, 'content-type': 'text/csv; charset=utf-8' });
      res.end(handover.csv);
      return;
    }
    if (req.method === 'GET' && rest === 'export') {
      try {
        const exported = await controller.exportReviewed(actor, projectRef, {
          format: url.searchParams.get('format'),
          baseline_ref: url.searchParams.get('baseline_ref'),
          revision: url.searchParams.get('revision'),
        });
        res.writeHead(200, {
          ...SECURITY_HEADERS,
          'content-type': exported.contentType,
          'content-disposition': exported.disposition,
        });
        res.end(exported.body);
      } catch (error) {
        const status = exportStatus(error);
        if (wantsJson(req)) json(res, status, { error: messageOf(error) });
        else html(res, status, pageModel({ actor, projects: store.listProjects(actor), project, error: messageOf(error) }));
      }
      return;
    }

    if (req.method === 'POST' && rest === 'turns') {
      const body = await readForm(req);
      const abort = new AbortController();
      const onClose = () => {
        if (!res.writableEnded) abort.abort();
      };
      req.on('close', onClose);
      try {
        const result = await controller.submitTurn({
          actor,
          projectRef,
          message: String(body.message ?? ''),
          turnId: String(body.turn_id || `turn:${randomUUID()}`),
          expectedRevision: body.expected_revision ? Number(body.expected_revision) : undefined,
          model: body.model,
          providerId: body.providerId,
          browserBody: body,
          signal: abort.signal,
        });
        if (wantsJson(req)) {
          json(res, result.status === 'incomplete' ? 202 : 200, {
            status: result.status,
            turn_id: result.turn_id,
            revision: result.project.revision,
            labelled_demo: result.labelled_demo ?? provider.labelledDemo,
            live: result.live ?? provider.live,
            stream_completed: result.stream_completed,
            incomplete_reason: result.incomplete_reason,
            ...(result.billing ? { billing: result.billing } : {}),
          });
          return;
        }
        if (result.status === 'incomplete') {
          const reason = encodeURIComponent(result.incomplete_reason || 'truncated');
          redirect(res, `/projects/${encodeURIComponent(projectRef)}?incomplete=${reason}`);
        } else {
          redirect(res, `/projects/${encodeURIComponent(projectRef)}`);
        }
      } catch (error) {
        const status = mutationStatus(error);
        if (wantsJson(req)) json(res, status, mutationErrorBody(actor, projectRef, project, error));
        else html(res, status, mutationErrorPage(actor, projectRef, project, {
          error: messageOf(error),
          draftMessage: String(body.message ?? ''),
        }));
      } finally {
        req.off('close', onClose);
      }
      return;
    }

    if (req.method === 'POST' && rest === 'cancel') {
      const body = await readForm(req);
      const turnId = typeof body.turn_id === 'string' && body.turn_id ? body.turn_id : undefined;
      controller.cancel(projectRef, turnId);
      if (wantsJson(req)) json(res, 200, { cancelled: true });
      else redirect(res, `/projects/${encodeURIComponent(projectRef)}`);
      return;
    }

    if (req.method === 'POST' && rest === 'documents') {
      const abort = new AbortController();
      const onClose = () => {
        if (!res.writableEnded) abort.abort();
      };
      try {
        const contentLength = Number(req.headers['content-length']);
        if (Number.isFinite(contentLength) && contentLength > config.uploadLimits.maxUploadRequestBytes) {
          json(res, 413, { error: 'request body too large' });
          return;
        }
        const uploaded = await readMultipart(req, config.uploadLimits.maxUploadRequestBytes);
        res.on('close', onClose);
        const result = await controller.intakeDocuments({
          actor,
          projectRef,
          files: uploaded.files,
          expectedRevision: uploaded.fields.expected_revision
            ? Number(uploaded.fields.expected_revision)
            : undefined,
          browserBody: uploaded.fields,
          signal: abort.signal,
        });
        if (wantsJson(req)) {
          json(res, 200, {
            accepted: result.accepted,
            rejected: result.rejected,
            notices: result.notices,
            revision: result.project.revision,
          });
          return;
        }
        redirect(res, buildDocumentIntakeRedirect(projectRef, result));
      } catch (error) {
        const status = intakeStatus(error);
        if (wantsJson(req)) json(res, status, { error: messageOf(error) });
        else html(res, status, pageModel({ actor, projects: store.listProjects(actor), project, error: messageOf(error) }));
      } finally {
        res.off('close', onClose);
      }
      return;
    }

    const interpretMatch = rest.match(/^documents\/([^/]+)\/interpret$/);
    if (req.method === 'POST' && interpretMatch) {
      const documentRef = decodeURIComponent(interpretMatch[1]);
      const abort = new AbortController();
      const onClose = () => {
        if (!res.writableEnded) abort.abort();
      };
      try {
        const body = await readForm(req);
        res.on('close', onClose);
        const result = await controller.interpretDocument({
          actor,
          projectRef,
          documentRef,
          expectedRevision: body.expected_revision ? Number(body.expected_revision) : undefined,
          turnId: typeof body.turn_id === 'string' && body.turn_id ? String(body.turn_id) : undefined,
          model: body.model,
          providerId: body.providerId,
          browserBody: body,
          signal: abort.signal,
        });
        if (wantsJson(req)) {
          json(res, result.status === 'incomplete' ? 202 : 200, {
            status: result.status,
            revision: result.project.revision,
            proposals_created: result.proposals_created,
            incomplete_reason: result.incomplete_reason,
            ...(result.billing ? { billing: result.billing } : {}),
          });
          return;
        }
        if (result.status === 'incomplete') {
          redirect(res, `/projects/${encodeURIComponent(projectRef)}?incomplete=${encodeURIComponent(result.incomplete_reason || 'cancelled')}`);
        } else {
          redirect(res, `/projects/${encodeURIComponent(projectRef)}`);
        }
      } catch (error) {
        const status = mutationStatus(error);
        if (wantsJson(req)) json(res, status, mutationErrorBody(actor, projectRef, project, error));
        else html(res, status, mutationErrorPage(actor, projectRef, project, { error: messageOf(error) }));
      } finally {
        res.off('close', onClose);
      }
      return;
    }

    if (req.method === 'POST' && rest === 'review') {
      const body = await readForm(req);
      const refs = asList(body.proposal_refs);
      try {
        const next = body.action === 'reject'
          ? controller.rejectSelected({
            actor,
            projectRef,
            proposalRefs: refs,
            expectedRevision: body.expected_revision ? Number(body.expected_revision) : undefined,
          })
          : controller.approveSelected({
            actor,
            projectRef,
            proposalRefs: refs,
            expectedRevision: body.expected_revision ? Number(body.expected_revision) : undefined,
          });
        if (wantsJson(req)) json(res, 200, { revision: next.revision, baseline: next.stream.baselines.at(-1) ?? null });
        else redirect(res, `/projects/${encodeURIComponent(projectRef)}`);
      } catch (error) {
        const status = /human actor may approve|requirements_approver/.test(messageOf(error)) ? 403 : 400;
        if (wantsJson(req)) json(res, status, { error: messageOf(error) });
        else html(res, status, pageModel({ actor, projects: store.listProjects(actor), project, error: messageOf(error) }));
      }
      return;
    }

    html(res, 404, pageModel({ actor, projects: store.listProjects(actor), project, error: 'Not found' }));
  }

  function demoSubjects() {
    if (!identity.memberships) return [];
    return [...identity.memberships.values()].map((entry) => ({
      subject: entry.subject,
      actor_kind: entry.actor_kind,
    }));
  }

  function mutationErrorPage(actor, projectRef, staleProject, extra = {}) {
    let current = staleProject;
    try {
      current = controller.loadProject(actor, projectRef);
    } catch {
      current = staleProject;
    }
    const keepDraft = extra.draftMessage != null && current?.revision === staleProject?.revision;
    return pageModel({
      actor,
      projects: store.listProjects(actor),
      project: current,
      error: extra.error,
      draftMessage: keepDraft ? extra.draftMessage : undefined,
    });
  }

  function mutationErrorBody(actor, projectRef, staleProject, error) {
    let revision = staleProject?.revision;
    try {
      revision = controller.loadProject(actor, projectRef).revision;
    } catch { /* keep */ }
    return { error: messageOf(error), code: error?.code, revision };
  }

  function flowStateFor(currentActor, currentProject) {
    return buildWorkspaceFlowState({
      actor: currentActor,
      project: currentProject,
      labelledDemo: config.labelledDemo,
      identityConfig: config.identity,
    });
  }

  async function respondFlowIntent(req, res, currentActor, currentProject) {
    try {
      const body = await readForm(req);
      const result = handleHostFlowIntent({
        actor: currentActor,
        project: currentProject,
        labelledDemo: config.labelledDemo,
        identityConfig: config.identity,
        intent: body,
      });
      json(res, 200, result);
    } catch (error) {
      const status = error?.status
        || (error?.code === 'unauthorized' ? 401 : error?.code === 'forbidden' ? 403 : error?.code === 'stale_context' ? 409 : 400);
      json(res, status, { error: messageOf(error), executed: false, issues: error?.issues });
    }
  }

  function pageModel(extra) {
    const project = extra.project;
    const actor = extra.actor ?? null;
    return renderWorkspacePage({
      mode: config.mode,
      labelledDemo: config.labelledDemo,
      providerLive: provider.live,
      providerId: provider.id,
      demoSubjects: demoSubjects(),
      policyActive: Boolean(config.policy),
      ...extra,
      flowState: extra.flowState ?? flowStateFor(actor, project ?? null),
      allowedSelections: project
        ? controller.selectionsFor(project.project_ref)
        : extra.allowedSelections,
    });
  }

  return {
    server,
    config,
    store,
    controller,
    provider,
    identity,
    listen() {
      return new Promise((resolve) => {
        server.listen(config.listenPort, config.listenHost, () => {
          const address = server.address();
          resolve({
            url: `http://${config.listenHost}:${address.port}`,
            port: address.port,
          });
        });
      });
    },
    async close() {
      await new Promise((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
      store.close();
    },
  };
}

function wantsJson(req) {
  return (req.headers.accept ?? '').includes('application/json')
    || (req.headers['content-type'] ?? '').includes('application/json');
}

function json(res, status, body) {
  res.writeHead(status, { ...SECURITY_HEADERS, 'content-type': 'application/json; charset=utf-8' });
  res.end(JSON.stringify(body));
}

function html(res, status, body) {
  res.writeHead(status, { ...SECURITY_HEADERS, 'content-type': 'text/html; charset=utf-8' });
  res.end(body);
}

function serveAllowedStatic(res, asset, headOnly = false) {
  const body = readAllowedStatic(asset.path);
  res.writeHead(200, {
    ...SECURITY_HEADERS,
    'content-type': asset.contentType,
    'content-length': body.length,
  });
  res.end(headOnly ? undefined : body);
}

function redirect(res, location, extra = {}) {
  res.writeHead(303, { ...SECURITY_HEADERS, location, ...extra });
  res.end();
}

function assertSameOriginMutation(req, url, publicOrigin) {
  const expectedOrigin = publicOrigin ?? url.origin;
  const originHeader = req.headers.origin;
  if (originHeader) {
    if (originHeader === 'null' || originHeader !== expectedOrigin) {
      throw Object.assign(new Error('request origin is not allowed'), { code: 'forbidden' });
    }
    return;
  }
  const referer = req.headers.referer;
  if (referer) {
    let refererUrl;
    try {
      refererUrl = new URL(referer);
    } catch {
      throw Object.assign(new Error('request origin is not allowed'), { code: 'forbidden' });
    }
    if (refererUrl.origin !== expectedOrigin) {
      throw Object.assign(new Error('request origin is not allowed'), { code: 'forbidden' });
    }
    return;
  }
  const hasBearer = /^Bearer\s+\S+/i.test(req.headers.authorization ?? '');
  const hasCookie = Boolean(readCookie(req, COOKIE));
  if (hasCookie && !hasBearer) {
    throw Object.assign(new Error('request origin is not allowed'), { code: 'forbidden' });
  }
}

function readCookie(req, name) {
  const header = req.headers.cookie;
  if (!header) return null;
  for (const part of header.split(';')) {
    const [key, ...rest] = part.trim().split('=');
    if (key === name) return rest.join('=');
  }
  return null;
}

async function readForm(req) {
  const chunks = [];
  let size = 0;
  for await (const chunk of req) {
    size += chunk.length;
    if (size > MAX_BODY) throw new Error('request body too large');
    chunks.push(chunk);
  }
  const raw = Buffer.concat(chunks).toString('utf8');
  const type = req.headers['content-type'] ?? '';
  if (type.includes('application/json')) {
    const parsed = raw ? JSON.parse(raw) : {};
    if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
      throw new Error('JSON body must be an object');
    }
    return assignNullPrototype(parsed);
  }
  const params = new URLSearchParams(raw);
  /** @type {Record<string, string | string[]>} */
  const body = Object.create(null);
  for (const [key, value] of params.entries()) {
    if (key in body) {
      const current = body[key];
      body[key] = Array.isArray(current) ? [...current, value] : [current, value];
    } else {
      body[key] = value;
    }
  }
  return body;
}

function assignNullPrototype(source) {
  const body = Object.create(null);
  for (const key of Object.keys(source)) {
    body[key] = source[key];
  }
  return body;
}

function asList(value) {
  if (Array.isArray(value)) return value.filter(Boolean);
  if (typeof value === 'string' && value) return [value];
  return [];
}

function messageOf(error) {
  return error instanceof Error ? error.message : String(error);
}

const MAX_DOCUMENT_INTAKE_LOCATION_BYTES = 4096;
const UNAPPROVED_PROPOSAL_NOTICE = 'Imported own-format content as unapproved proposals.';
/** @type {Readonly<Record<string, string>>} */
const REJECTED_REASON_LABELS = Object.freeze({
  too_large: 'file too large',
  too_many: 'project document limit reached',
  failed: 'extraction failed',
});

/**
 * Replace lone UTF-16 surrogates so encodeURIComponent and HTML display stay safe.
 * @param {unknown} value
 */
function sanitizeDisplayText(value) {
  return String(value).replace(
    /[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/g,
    '\uFFFD',
  );
}

/**
 * @param {unknown} value
 * @returns {string[]}
 */
function codePoints(value) {
  return Array.from(sanitizeDisplayText(value));
}

/**
 * @param {unknown} value
 * @param {number} maxPoints
 * @param {string} [suffix]
 */
function truncateCodePoints(value, maxPoints, suffix = '…') {
  const points = codePoints(value);
  if (points.length <= maxPoints) return points.join('');
  return `${points.slice(0, maxPoints).join('')}${suffix}`;
}

/**
 * @param {unknown} reason
 * @param {number} [maxPoints]
 */
function rejectedReasonLabel(reason, maxPoints = 120) {
  const key = sanitizeDisplayText(reason ?? 'failed');
  if (Object.hasOwn(REJECTED_REASON_LABELS, key)) return REJECTED_REASON_LABELS[key];
  return truncateCodePoints(key, maxPoints);
}

/**
 * Closed category for the final intake notice when raw reasons no longer fit.
 * @param {unknown} reason
 */
function closedReasonCategory(reason) {
  const key = String(reason ?? 'failed');
  if (Object.hasOwn(REJECTED_REASON_LABELS, key)) return REJECTED_REASON_LABELS[key];
  return 'validation failed';
}

/**
 * @param {readonly unknown[]} accepted
 */
function retentionHeader(accepted) {
  if (accepted.length === 1) return '1 document retained.';
  if (accepted.length > 1) return `${accepted.length} documents retained.`;
  return 'No documents were retained.';
}

/**
 * @param {{ filename?: string, reason?: string }} item
 * @param {number} filenameLimit
 * @param {number} reasonLimit
 */
function formatRejectionLine(item, filenameLimit, reasonLimit) {
  const filename = truncateCodePoints(item.filename ?? 'file', filenameLimit);
  return `${filename}: not retained (${rejectedReasonLabel(item.reason, reasonLimit)}).`;
}

/**
 * @param {unknown} notice
 * @param {number} filenameLimit
 */
function formatControllerNotice(notice, filenameLimit) {
  const text = sanitizeDisplayText(notice);
  const separator = ': ';
  const separatorIndex = text.indexOf(separator);
  if (separatorIndex > 0) {
    return `${truncateCodePoints(text.slice(0, separatorIndex), filenameLimit)}${text.slice(separatorIndex)}`;
  }
  return truncateCodePoints(text, filenameLimit + 160);
}

/**
 * @param {readonly { filename?: string, reason?: string }[]} rejected
 * @param {number} reasonLimit
 */
function compactRejectionSummary(rejected, reasonLimit) {
  /** @type {Map<string, number>} */
  const grouped = new Map();
  for (const item of rejected) {
    const reason = rejectedReasonLabel(item.reason, reasonLimit);
    grouped.set(reason, (grouped.get(reason) ?? 0) + 1);
  }
  return [...grouped.entries()].map(([reason, count]) => {
    const noun = count === 1 ? 'file' : 'files';
    return `${count} ${noun}: not retained (${reason}).`;
  }).join(' ');
}

/**
 * @param {readonly { filename?: string, reason?: string }[]} rejected
 */
function minimalRejectionSummary(rejected) {
  /** @type {Map<string, number>} */
  const grouped = new Map();
  for (const item of rejected) {
    const reason = closedReasonCategory(item.reason);
    grouped.set(reason, (grouped.get(reason) ?? 0) + 1);
  }
  return [...grouped.entries()].map(([reason, count]) => {
    const noun = count === 1 ? 'file' : 'files';
    return `${count} ${noun}: not retained (${reason}).`;
  }).join(' ');
}

/**
 * @param {string} header
 * @param {readonly unknown[]} notices
 * @param {readonly { filename?: string, reason?: string }[]} rejected
 * @param {number} filenameLimit
 * @param {number} reasonLimit
 */
function joinDocumentIntakeNotice(header, notices, rejected, filenameLimit, reasonLimit) {
  const parts = [header];
  for (const notice of notices) {
    if (notice) parts.push(formatControllerNotice(notice, filenameLimit));
  }
  for (const item of rejected) {
    parts.push(formatRejectionLine(item, filenameLimit, reasonLimit));
  }
  return parts.join(' ');
}

/**
 * @param {string} projectRef
 * @param {string} notice
 */
function documentIntakeLocation(projectRef, notice) {
  const safeNotice = sanitizeDisplayText(notice);
  return `/projects/${encodeURIComponent(projectRef)}?notice=${encodeURIComponent(safeNotice)}`;
}

/**
 * @param {string} projectRef
 * @param {string} notice
 */
function documentIntakeLocationFits(projectRef, notice) {
  return Buffer.byteLength(documentIntakeLocation(projectRef, notice), 'utf8')
    <= MAX_DOCUMENT_INTAKE_LOCATION_BYTES;
}

/**
 * Bounded, browser-safe intake summary for HTML redirects. Retained and
 * rejected counts stay explicit; only filenames and other optional detail
 * shrink under an encoded Location budget.
 * @param {{ accepted?: readonly unknown[], rejected?: readonly { filename?: string, reason?: string }[], notices?: readonly string[] }} result
 * @param {string} projectRef
 */
function formatDocumentIntakeNotice(result, projectRef) {
  const accepted = result.accepted ?? [];
  const rejected = result.rejected ?? [];
  const notices = (result.notices ?? []).filter(Boolean);
  const header = retentionHeader(accepted);
  const hasUnapproved = notices.some((notice) => /unapproved proposals/i.test(String(notice)));

  /** @type {Array<() => string>} */
  const attempts = [];

  for (const [filenameLimit, reasonLimit] of [
    [240, 120],
    [120, 60],
    [60, 30],
    [30, 16],
    [16, 8],
    [8, 4],
    [4, 4],
  ]) {
    attempts.push(() => joinDocumentIntakeNotice(header, notices, rejected, filenameLimit, reasonLimit));
  }

  for (const reasonLimit of [40, 16, 8]) {
    attempts.push(() => {
      const parts = [header];
      if (hasUnapproved) parts.push(UNAPPROVED_PROPOSAL_NOTICE);
      for (const notice of notices) {
        if (notice && !/unapproved proposals/i.test(String(notice))) {
          parts.push(formatControllerNotice(notice, 4));
        }
      }
      if (rejected.length) parts.push(compactRejectionSummary(rejected, reasonLimit));
      return parts.join(' ');
    });
  }

  attempts.push(() => {
    const parts = [header];
    if (hasUnapproved) parts.push(UNAPPROVED_PROPOSAL_NOTICE);
    if (rejected.length) parts.push(minimalRejectionSummary(rejected));
    return parts.join(' ');
  });

  for (const build of attempts) {
    const text = build();
    if (documentIntakeLocationFits(projectRef, text)) return text;
  }

  return header;
}

/**
 * @param {string} projectRef
 * @param {{ accepted?: readonly unknown[], rejected?: readonly { filename?: string, reason?: string }[], notices?: readonly string[] }} result
 */
function buildDocumentIntakeRedirect(projectRef, result) {
  return documentIntakeLocation(projectRef, formatDocumentIntakeNotice(result, projectRef));
}

/**
 * @param {URLSearchParams} params
 */
function incompleteTurnNotice(params) {
  const reason = params.get('incomplete');
  if (!reason) return undefined;
  const label = reason.replaceAll('_', ' ');
  return `The assistant reply did not complete (${label}). Your message was saved; no proposals were created.`;
}

/**
 * @param {URLSearchParams} params
 */
function pageNotice(params) {
  const incomplete = incompleteTurnNotice(params);
  if (incomplete) return incomplete;
  const notice = params.get('notice');
  return notice || undefined;
}

function mutationStatus(error) {
  if (error?.code === 'revision_conflict') return 409;
  if (error?.code === 'spend_uncertain' || error?.code === 'spend_committed') return 409;
  if (error?.code === 'forbidden' || error?.code === 'policy_denied' || error?.code === 'spend_denied') return 403;
  return 400;
}

function exportStatus(error) {
  if (error?.code === 'forbidden') return 403;
  if (error?.code === 'export_revision_unknown' || error?.code === 'export_no_baseline') return 404;
  if (error?.code === 'export_pdf_unsupported_script') return 400;
  return 400;
}

function intakeStatus(error) {
  if (error?.code === 'too_large' || /too large/i.test(messageOf(error))) return 413;
  if (error?.code === 'revision_conflict') return 409;
  if (error?.code === 'forbidden') return 403;
  if (error?.code === 'cancelled' || error?.name === 'AbortError') return 400;
  return 400;
}

async function readBoundedBody(req, maxBytes) {
  const chunks = [];
  let size = 0;
  for await (const chunk of req) {
    size += chunk.length;
    if (size > maxBytes) {
      throw Object.assign(new Error('request body too large'), { code: 'too_large' });
    }
    chunks.push(chunk);
  }
  return Buffer.concat(chunks);
}

/**
 * @param {import('node:http').IncomingMessage} req
 * @param {number} maxBytes
 */
async function readMultipart(req, maxBytes) {
  const type = req.headers['content-type'] ?? '';
  if (!type.includes('multipart/form-data')) {
    throw Object.assign(new Error('multipart form data is required'), { code: 'malformed' });
  }
  const buf = await readBoundedBody(req, maxBytes);
  const request = new Request('http://127.0.0.1/documents', {
    method: 'POST',
    headers: { 'content-type': type },
    body: buf,
  });
  let form;
  try {
    form = await request.formData();
  } catch {
    throw Object.assign(new Error('malformed multipart body'), { code: 'malformed' });
  }
  const files = [];
  const fields = Object.create(null);
  for (const [key, value] of form.entries()) {
    if (typeof value === 'string') {
      if (key in fields) {
        const current = fields[key];
        fields[key] = Array.isArray(current) ? [...current, value] : [current, value];
      } else {
        fields[key] = value;
      }
      continue;
    }
    if (key !== 'files' && key !== 'file') continue;
    const bytes = new Uint8Array(await value.arrayBuffer());
    files.push({
      filename: value.name || 'upload',
      mimeType: value.type || 'application/octet-stream',
      bytes,
      byteSize: bytes.byteLength,
    });
  }
  return { files, fields };
}

export { COOKIE as DEMO_COOKIE_NAME };
