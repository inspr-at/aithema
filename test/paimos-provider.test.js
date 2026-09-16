import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { createServer } from 'node:http';
import {
  chmodSync,
  mkdtempSync,
  rmSync,
  symlinkSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
  ConversationController,
  PaimosHarnessProvider,
  SqliteProjectStore,
  createProviderRegistry,
  normalizeOrgPolicy,
} from '../runtime/index.js';
import {
  classifySystemdCredentialPath,
  hasProtectedSystemdCredentialLayout,
} from '../runtime/paimos-provider.js';

const actor = Object.freeze({
  party_ref: 'party:reviewer',
  actor_kind: 'human',
  roles: Object.freeze(['requirements_approver', 'delivery_party']),
  subject: 'verified-subject',
  projects: Object.freeze([]),
});

function understanding() {
  return {
    summary: 'A bounded test understanding',
    facts: [{ key: 'need', value: 'A real answer', evidence: 'The user asked' }],
    open_questions: ['What is the acceptance check?'],
    next_question: 'What is the acceptance check?',
    candidate_requirements: [{
      requirement_ref: 'req.answer',
      statement: 'Return a real answer',
      acceptance_criteria: ['The answer is verified'],
      constraint_refs: [],
    }],
    project_kinds: ['integration'],
  };
}

function digest(text) {
  return createHash('sha256').update(Buffer.from(text, 'utf8')).digest('hex');
}

async function listen(server) {
  return new Promise((resolve, reject) => {
    const onError = (error) => reject(error);
    server.once('error', onError);
    server.listen(0, '127.0.0.1', () => {
      server.off('error', onError);
      resolve(`http://127.0.0.1:${server.address().port}`);
    });
  });
}

function callSnapshot(requestID, deadline, overrides = {}) {
  return {
    schema_version: 1,
    call_id: 'call-1',
    request_id: requestID,
    state: 'queued',
    deadline_at: deadline,
    last_sequence: 0,
    ...overrides,
  };
}

function boundedBarrier(label, timeoutMs = 1_000) {
  let signal;
  const reached = new Promise((resolve) => {
    signal = resolve;
  });
  return {
    signal,
    wait: async () => {
      let timer;
      try {
        await Promise.race([
          reached,
          new Promise((_, reject) => {
            timer = setTimeout(() => reject(new Error(`${label} was not reached`)), timeoutMs);
          }),
        ]);
      } finally {
        clearTimeout(timer);
      }
    },
  };
}

function cancellationRequests(requests) {
  return requests.filter((item) => item.method === 'POST' && item.url.endsWith('/cancel'));
}

async function fixture(mode = 'success') {
  const root = mkdtempSync(join(tmpdir(), 'aithema-paimos-'));
  const credentialFile = join(root, 'conversation.key');
  writeFileSync(credentialFile, 'fixture-conversation-key\n', { mode: 0o600 });
  chmodSync(credentialFile, 0o600);
  const requests = [];
  let postAttempts = 0;
  let getAttempts = 0;
  let cancelled = 0;
  let admittedBody;
  const admissionRequest = boundedBarrier('admission request');
  const firstEventsRequest = boundedBarrier('first events request');
  let releaseAdmissionResponse;
  const admissionResponseReleased = new Promise((resolve) => {
    releaseAdmissionResponse = resolve;
  });
  const deadline = new Date(Date.now() + 60_000).toISOString();
  const server = createServer(async (req, res) => {
    const chunks = [];
    for await (const chunk of req) chunks.push(chunk);
    const raw = Buffer.concat(chunks).toString('utf8');
    const body = raw ? JSON.parse(raw) : undefined;
    requests.push({ method: req.method, url: req.url, headers: req.headers, body });
    res.setHeader('content-type', 'application/json; charset=utf-8');

    if (req.method === 'POST' && req.url.endsWith('/calls')) {
      postAttempts += 1;
      admittedBody ??= body;
      admissionRequest.signal();
      if (mode === 'pre-admission-cancel') await admissionResponseReleased;
      if (mode === 'retry' && postAttempts === 1) {
        res.statusCode = 503;
        res.end('{}');
        return;
      }
      res.statusCode = postAttempts === 1 ? 202 : 200;
      res.end(JSON.stringify(callSnapshot(body.request_id, deadline)));
      return;
    }
    if (req.method === 'POST' && req.url.endsWith('/cancel')) {
      cancelled += 1;
      res.end(JSON.stringify(callSnapshot(admittedBody.request_id, deadline, {
        state: 'cancel_requested',
      })));
      return;
    }
    if (req.method === 'GET' && req.url.includes('/events?')) firstEventsRequest.signal();
    if (mode === 'cancel') {
      res.end(JSON.stringify({
        schema_version: 1,
        call_id: 'call-1',
        events: [],
        call: callSnapshot(admittedBody.request_id, deadline),
      }));
      return;
    }

    const output = mode === 'understanding' || mode === 'malformed-json'
      ? (mode === 'malformed-json' ? '{not-json' : JSON.stringify(understanding()))
      : 'hello from Paimos';
    const outputDigest = mode === 'digest' ? '0'.repeat(64) : digest(output);
    const sequence = mode === 'sequence' ? 3 : 2;
    const events = [
      { sequence: 1, kind: 'started', thread_id: 'native-thread', turn_id: 'native-turn' },
      { sequence, kind: 'assistant_delta', text: output, thread_id: 'native-thread', turn_id: 'native-turn' },
      { sequence: sequence + 1, kind: 'completed', thread_id: 'native-thread', turn_id: 'native-turn', output_sha256: outputDigest },
    ];
    getAttempts += 1;
    if (mode === 'replay' && getAttempts === 1) {
      res.end(JSON.stringify({
        schema_version: 1,
        call_id: 'call-1',
        events: events.slice(0, 2),
        call: callSnapshot(admittedBody.request_id, deadline, {
          state: 'running',
          last_sequence: 2,
        }),
      }));
      return;
    }
    const returnedEvents = mode === 'replay' ? events.slice(1) : events;
    res.end(JSON.stringify({
      schema_version: 1,
      call_id: 'call-1',
      events: returnedEvents,
      call: callSnapshot(admittedBody.request_id, deadline, {
        state: 'completed',
        last_sequence: sequence + 1,
        output_text: output,
        output_sha256: outputDigest,
      }),
    }));
  });
  let origin;
  try {
    origin = await listen(server);
  } catch (error) {
    server.close();
    rmSync(root, { recursive: true, force: true });
    throw error;
  }
  const provider = new PaimosHarnessProvider({
    id: 'paimos',
    origin,
    credentialFile,
    projectID: 'paimos-project',
    bindingID: 'binding-1',
    bindingRevision: 7,
    trustedIssuer: 'https://issuer.example.invalid',
    modelId: 'binding-model',
    allowedModels: ['binding-model'],
    executionLocation: 'cloud',
    allowedDataClasses: ['confidential'],
    mode: 'test',
    pollIntervalMs: 2,
    retryDelayMs: 1,
    cleanupTimeoutMs: 200,
    limits: { maxDurationMs: 2_000 },
  });
  return {
    provider,
    credentialFile,
    requests,
    postAttempts: () => postAttempts,
    cancelled: () => cancelled,
    waitForAdmissionRequest: admissionRequest.wait,
    releaseAdmissionResponse,
    waitForFirstEventsRequest: firstEventsRequest.wait,
    close: async () => {
      releaseAdmissionResponse();
      await new Promise((resolve) => server.close(resolve));
      rmSync(root, { recursive: true, force: true });
    },
  };
}

async function timeoutFixture() {
  const root = mkdtempSync(join(tmpdir(), 'aithema-paimos-timeout-'));
  const credentialFile = join(root, 'conversation.key');
  writeFileSync(credentialFile, 'fixture-conversation-key\n', { mode: 0o600 });
  chmodSync(credentialFile, 0o600);
  const requests = [];
  const firstEventsRequest = boundedBarrier('first events request');
  let releaseFirstEventsResponse;
  const firstEventsResponseReleased = new Promise((resolve) => {
    releaseFirstEventsResponse = resolve;
  });
  const deadline = new Date(Date.now() + 60_000).toISOString();
  let admittedBody;
  let cancelled = 0;
  const fetchImpl = async (target, options) => {
    const body = options.body ? JSON.parse(options.body) : undefined;
    requests.push({ method: options.method, url: `${target.pathname}${target.search}`, body });
    if (options.method === 'POST' && target.pathname.endsWith('/calls')) {
      admittedBody = body;
      return Response.json(callSnapshot(body.request_id, deadline), { status: 202 });
    }
    if (options.method === 'POST' && target.pathname.endsWith('/cancel')) {
      cancelled += 1;
      return Response.json(callSnapshot(admittedBody.request_id, deadline, {
        state: 'cancel_requested',
      }));
    }
    if (options.method === 'GET' && target.pathname.endsWith('/events')) {
      firstEventsRequest.signal();
      await firstEventsResponseReleased;
      return Response.json({
        schema_version: 1,
        call_id: 'call-1',
        events: [],
        call: callSnapshot(admittedBody.request_id, deadline),
      });
    }
    throw new Error('unexpected timeout fixture request');
  };
  const provider = new PaimosHarnessProvider({
    id: 'paimos',
    origin: 'https://paimos.example.invalid',
    credentialFile,
    projectID: 'paimos-project',
    bindingID: 'binding-1',
    bindingRevision: 7,
    trustedIssuer: 'https://issuer.example.invalid',
    modelId: 'binding-model',
    allowedModels: ['binding-model'],
    executionLocation: 'cloud',
    allowedDataClasses: ['confidential'],
    fetchImpl,
    cleanupTimeoutMs: 200,
    limits: { maxDurationMs: 30 },
  });
  return {
    provider,
    requests,
    cancelled: () => cancelled,
    waitForFirstEventsRequest: firstEventsRequest.wait,
    releaseFirstEventsResponse,
    close: () => {
      releaseFirstEventsResponse();
      rmSync(root, { recursive: true, force: true });
    },
  };
}

function request(purpose, signal) {
  return {
    system: 'Dynamic operator business context',
    messages: [{ role: 'user', content: 'hello' }],
    model: 'binding-model',
    signal,
    executionContext: {
      actor,
      projectRef: 'project:aithema',
      conversationId: 'project:aithema',
      turnId: 'turn:one',
      purpose,
      requestId: `c:turn:one:${purpose}`,
    },
  };
}

async function collect(iterable) {
  let text = '';
  for await (const chunk of iterable) text += chunk;
  return text;
}

function statFixture({
  type,
  uid = 0,
  gid = 0,
  mode,
  size = 32,
  symlink = false,
}) {
  return {
    uid,
    gid,
    mode,
    size,
    isDirectory: () => type === 'directory',
    isFile: () => type === 'file',
    isSymbolicLink: () => symlink,
  };
}

describe('Paimos credential source boundary', () => {
  const credentialsDirectory = '/run/credentials/aithema-workspace.service';
  const credentialFile = `${credentialsDirectory}/paimos-conversation-api-key`;

  it('admits only the observed root-owned systemd LoadCredential layout', () => {
    const directory = statFixture({ type: 'directory', mode: 0o550 });
    const parent = statFixture({ type: 'directory', mode: 0o755 });
    const credential = statFixture({ type: 'file', mode: 0o440 });
    assert.deepEqual(
      classifySystemdCredentialPath(credentialFile, credentialsDirectory),
      { kind: 'systemd', directory: credentialsDirectory },
    );
    assert.equal(hasProtectedSystemdCredentialLayout(directory, parent, credential), true);
  });

  it('rejects root/group-readable ordinary files and unsafe systemd metadata', () => {
    const directory = statFixture({ type: 'directory', mode: 0o550 });
    const parent = statFixture({ type: 'directory', mode: 0o755 });
    assert.equal(
      hasProtectedSystemdCredentialLayout(directory, parent, statFixture({ type: 'file', mode: 0o640 })),
      false,
    );
    assert.equal(
      hasProtectedSystemdCredentialLayout(
        statFixture({ type: 'directory', mode: 0o550, symlink: true }),
        parent,
        statFixture({ type: 'file', mode: 0o440 }),
      ),
      false,
    );
    assert.equal(
      hasProtectedSystemdCredentialLayout(
        directory,
        statFixture({ type: 'directory', mode: 0o775 }),
        statFixture({ type: 'file', mode: 0o440 }),
      ),
      false,
    );
  });

  it('rejects alternate names and reference/path escapes below CREDENTIALS_DIRECTORY', () => {
    assert.deepEqual(
      classifySystemdCredentialPath(`${credentialsDirectory}/other`, credentialsDirectory),
      { kind: 'invalid' },
    );
    assert.deepEqual(
      classifySystemdCredentialPath(`${credentialsDirectory}/../other/paimos-conversation-api-key`, credentialsDirectory),
      { kind: 'invalid' },
    );
    assert.deepEqual(
      classifySystemdCredentialPath('/operator-owned/credential', credentialsDirectory),
      { kind: 'generic' },
    );
    assert.deepEqual(
      classifySystemdCredentialPath(
        '/root/forged/paimos-conversation-api-key',
        '/root/forged',
      ),
      { kind: 'invalid' },
    );
    assert.deepEqual(
      classifySystemdCredentialPath(
        credentialFile,
        '/run/credentials/../credentials/aithema-workspace.service',
      ),
      { kind: 'invalid' },
    );
  });

  it('keeps generic credentials owner-only and refuses symlinks before egress', async () => {
    const groupReadable = await fixture();
    try {
      chmodSync(groupReadable.credentialFile, 0o640);
      await assert.rejects(
        () => collect(groupReadable.provider.streamChat(request('chat'))),
        /Paimos credential is unavailable/,
      );
      assert.equal(groupReadable.postAttempts(), 0);
    } finally {
      await groupReadable.close();
    }

    const linked = await fixture();
    try {
      const target = `${linked.credentialFile}.target`;
      writeFileSync(target, 'fixture-conversation-key\n', { mode: 0o600 });
      chmodSync(target, 0o600);
      unlinkSync(linked.credentialFile);
      symlinkSync(target, linked.credentialFile);
      await assert.rejects(
        () => collect(linked.provider.streamChat(request('chat'))),
        /Paimos credential is unavailable/,
      );
      assert.equal(linked.postAttempts(), 0);
    } finally {
      await linked.close();
    }
  });
});

describe('Paimos harness HTTP provider', () => {
  it('executes the bounded protocol through the configured fetch boundary', async () => {
    const root = mkdtempSync(join(tmpdir(), 'aithema-paimos-fetch-'));
    const credentialFile = join(root, 'conversation.key');
    writeFileSync(credentialFile, 'fixture-key\n', { mode: 0o600 });
    const deadline = new Date(Date.now() + 60_000).toISOString();
    let requestID;
    const fetchImpl = async (target, options) => {
      if (options.method === 'POST' && target.pathname.endsWith('/calls')) {
        requestID = JSON.parse(options.body).request_id;
        return Response.json(callSnapshot(requestID, deadline), { status: 202 });
      }
      const text = 'verified';
      const hash = digest(text);
      return Response.json({
        schema_version: 1,
        call_id: 'call-1',
        events: [
          { sequence: 1, kind: 'started', thread_id: 'thread', turn_id: 'turn' },
          { sequence: 2, kind: 'assistant_delta', text, thread_id: 'thread', turn_id: 'turn' },
          { sequence: 3, kind: 'completed', output_sha256: hash, thread_id: 'thread', turn_id: 'turn' },
        ],
        call: callSnapshot(requestID, deadline, {
          state: 'completed', last_sequence: 3, output_text: text, output_sha256: hash,
        }),
      });
    };
    try {
      const provider = new PaimosHarnessProvider({
        id: 'paimos', origin: 'https://paimos.example.invalid', credentialFile,
        projectID: 'project', bindingID: 'binding', bindingRevision: 1,
        trustedIssuer: 'https://issuer.example.invalid', modelId: 'binding-model',
        allowedModels: ['binding-model'], allowedDataClasses: ['confidential'], fetchImpl,
      });
      assert.equal(await collect(provider.streamChat(request('chat'))), 'verified');
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('streams completed chat and preserves system/message roles as bounded inference input', async () => {
    const fx = await fixture();
    try {
      assert.equal(await collect(fx.provider.streamChat(request('chat'))), 'hello from Paimos');
      const post = fx.requests[0];
      assert.equal(post.headers.authorization, 'Bearer fixture-conversation-key');
      assert.equal(post.headers['x-paimos-actor-issuer'], 'https://issuer.example.invalid');
      assert.equal(post.headers['x-paimos-actor-subject'], actor.subject);
      assert.deepEqual(Object.keys(post.body).sort(), [
        'actor', 'binding_id', 'binding_revision', 'conversation_id', 'messages', 'project_ref',
        'purpose', 'request_id', 'schema_version', 'system', 'timeout_ms', 'turn_id',
      ]);
      assert.equal(post.body.system, 'Dynamic operator business context');
      assert.deepEqual(post.body.messages, [{ role: 'user', content: 'hello' }]);
      assert.equal('model' in post.body, false);
    } finally {
      await fx.close();
    }
  });

  it('returns validated JSON understanding and retries an identical admission once', async () => {
    const understood = await fixture('understanding');
    try {
      const result = await understood.provider.understand(request('understand'));
      assert.equal(result.candidate_requirements[0].requirement_ref, 'req.answer');
    } finally {
      await understood.close();
    }
    const retried = await fixture('retry');
    try {
      assert.equal(await collect(retried.provider.streamChat(request('chat'))), 'hello from Paimos');
      assert.equal(retried.postAttempts(), 2);
      assert.deepEqual(retried.requests[0].body, retried.requests[1].body);
    } finally {
      await retried.close();
    }
  });

  it('accepts an exact duplicate event replay without duplicating output', async () => {
    const fx = await fixture('replay');
    try {
      assert.equal(await collect(fx.provider.streamChat(request('chat'))), 'hello from Paimos');
    } finally {
      await fx.close();
    }
  });

  for (const [mode, pattern] of [
    ['sequence', /event sequence/],
    ['digest', /completion digest/],
  ]) {
    it(`fails closed on ${mode} mismatch and sends bounded cleanup cancellation`, async () => {
      const fx = await fixture(mode);
      try {
        await assert.rejects(collect(fx.provider.streamChat(request('chat'))), pattern);
        assert.equal(fx.cancelled(), 1);
      } finally {
        await fx.close();
      }
    });
  }

  it('uses an immutable timeout and a separate cleanup deadline', async (context) => {
    let now = Date.now();
    const requestedTimeouts = [];
    const timeoutControllers = [];
    context.mock.method(Date, 'now', () => now);
    context.mock.method(AbortSignal, 'timeout', (duration) => {
      const controller = new AbortController();
      requestedTimeouts.push(duration);
      timeoutControllers.push(controller);
      return controller.signal;
    });
    const fx = await timeoutFixture();
    try {
      const rejected = assert.rejects(
        collect(fx.provider.streamChat(request('chat'))),
        (error) => error.code === 'incomplete_stream' && error.reason === 'timeout',
      );
      await fx.waitForFirstEventsRequest();
      assert.equal(requestedTimeouts[0], 30);
      now += 30;
      timeoutControllers.at(-1).abort(new DOMException('deadline exceeded', 'TimeoutError'));
      fx.releaseFirstEventsResponse();
      await rejected;
      assert.equal(fx.cancelled(), 1);
      assert.equal(fx.requests[0].body.timeout_ms, 30);
      assert.equal(cancellationRequests(fx.requests).length, 1);
      assert.equal(requestedTimeouts.at(-1), 200);
    } finally {
      fx.releaseFirstEventsResponse();
      fx.close();
      context.mock.restoreAll();
    }
  });

  it('cancels admitted work when the caller aborts', async () => {
    const fx = await fixture('cancel');
    const abort = new AbortController();
    try {
      const work = collect(fx.provider.streamChat(request('chat', abort.signal)));
      const rejected = assert.rejects(work, (error) => error.name === 'AbortError');
      await fx.waitForFirstEventsRequest();
      abort.abort();
      await rejected;
      assert.equal(cancellationRequests(fx.requests).length, 1);
      assert.deepEqual(cancellationRequests(fx.requests)[0].body, {});
    } finally {
      abort.abort();
      await fx.close();
    }
  });

  it('does not claim remote cancellation when the caller aborts before admission', async () => {
    const fx = await fixture('pre-admission-cancel');
    const abort = new AbortController();
    try {
      const work = collect(fx.provider.streamChat(request('chat', abort.signal)));
      const rejected = assert.rejects(work, (error) => error.name === 'AbortError');
      await fx.waitForAdmissionRequest();
      abort.abort();
      await rejected;
      assert.equal(cancellationRequests(fx.requests).length, 0);
    } finally {
      abort.abort();
      fx.releaseAdmissionResponse();
      await fx.close();
    }
  });

  it('rejects malformed understanding JSON without fabricating a snapshot', async () => {
    const fx = await fixture('malformed-json');
    try {
      await assert.rejects(fx.provider.understand(request('understand')), /was not JSON/);
    } finally {
      await fx.close();
    }
  });

  it('requires verified actor context before contacting the service', async () => {
    const fx = await fixture();
    try {
      const missing = request('chat');
      delete missing.executionContext.actor;
      await assert.rejects(collect(fx.provider.streamChat(missing)), /verified actor/);
      assert.equal(fx.requests.length, 0);
    } finally {
      await fx.close();
    }
  });
});

class ContextProvider {
  constructor() {
    this.id = 'paimos';
    this.modelId = 'binding-model';
    this.allowedModels = Object.freeze(['binding-model']);
    this.live = true;
    this.labelledDemo = false;
    this.executionLocation = 'cloud';
    this.allowedDataClasses = Object.freeze(['confidential']);
    this.contexts = [];
  }

  resolveModel(model) {
    if (!model || model === this.modelId) return this.modelId;
    throw new Error('unapproved');
  }

  async *streamChat(requestValue) {
    this.contexts.push(requestValue.executionContext);
    yield 'A completed answer';
  }

  async understand(requestValue) {
    this.contexts.push(requestValue.executionContext);
    return understanding();
  }
}

async function controllerContexts(policy) {
  const provider = new ContextProvider();
  const store = new SqliteProjectStore(':memory:');
  const controller = new ConversationController({
    store,
    provider,
    providers: { paimos: provider },
    defaultProviderId: 'paimos',
    policy,
    mode: 'test',
  });
  const project = controller.createProject(actor, { title: 'Paimos', projectKinds: ['integration'] });
  await controller.submitTurn({
    actor,
    projectRef: project.project_ref,
    message: 'Use the enrolled account',
    turnId: 'turn:stable',
  });
  store.close();
  return provider.contexts;
}

describe('trusted controller context and policy integration', () => {
  it('derives distinct stable phase request IDs with and without a spend ceiling', async () => {
    const noPolicy = await controllerContexts(null);
    const policy = normalizeOrgPolicy({
      epoch: 1,
      execution: 'cloud',
      allowedProviders: ['paimos'],
      allowedDataClasses: ['confidential'],
      dataClass: 'confidential',
      maxOutboundCallsPerProject: 4,
    }, {
      defaultProvider: 'paimos',
      providers: {
        paimos: {
          kind: 'paimos-harness',
          executionLocation: 'cloud',
          allowedDataClasses: ['confidential'],
        },
      },
    });
    const budgeted = await controllerContexts(policy);
    for (const contexts of [noPolicy, budgeted]) {
      assert.deepEqual(contexts.map((item) => item.requestId), [
        'c:turn:stable:chat',
        'c:turn:stable:understand',
      ]);
      assert.equal(contexts[0].actor, actor);
      assert.equal(contexts[0].projectRef, contexts[0].conversationId);
    }
  });

  it('plumbs a separate trusted interpret context from the verified actor', async () => {
    const provider = new ContextProvider();
    const store = new SqliteProjectStore(':memory:');
    const controller = new ConversationController({ store, provider, mode: 'test' });
    try {
      const project = controller.createProject(actor, { title: 'Document', projectKinds: ['integration'] });
      const intake = await controller.intakeDocuments({
        actor,
        projectRef: project.project_ref,
        files: [{
          filename: 'brief.txt',
          mimeType: 'text/plain',
          bytes: Buffer.from('A bounded customer brief', 'utf8'),
          byteSize: Buffer.byteLength('A bounded customer brief'),
        }],
      });
      await controller.interpretDocument({
        actor,
        projectRef: project.project_ref,
        documentRef: intake.accepted[0],
        turnId: 'turn:interpret',
      });
      assert.equal(provider.contexts[0].purpose, 'interpret');
      assert.equal(provider.contexts[0].requestId, 'c:turn:interpret:interpret');
      assert.equal(provider.contexts[0].actor, actor);
    } finally {
      store.close();
    }
  });

  it('retains completed chat and creates no proposal when understanding fails', async () => {
    class MalformedUnderstandingProvider extends ContextProvider {
      async understand(requestValue) {
        this.contexts.push(requestValue.executionContext);
        throw new Error('provider understanding response was not JSON');
      }
    }
    const provider = new MalformedUnderstandingProvider();
    const store = new SqliteProjectStore(':memory:');
    const controller = new ConversationController({ store, provider, mode: 'test' });
    try {
      const project = controller.createProject(actor, { title: 'Retain chat', projectKinds: ['integration'] });
      const result = await controller.submitTurn({
        actor,
        projectRef: project.project_ref,
        message: 'Keep this answer',
        turnId: 'turn:malformed-understanding',
      });
      assert.equal(result.status, 'complete');
      assert.equal(result.assistant, 'A completed answer');
      assert.deepEqual(result.proposals_created, []);
      assert.equal(result.project.transcript.at(-1).content, 'A completed answer');
    } finally {
      store.close();
    }
  });

  it('registers only an exact binding model and preserves cloud policy classification', () => {
    assert.throws(() => createProviderRegistry({
      mode: 'test',
      defaultProvider: 'paimos',
      providers: {
        paimos: {
          kind: 'paimos-harness',
          origin: 'http://127.0.0.1:9',
          credentialFile: '/does/not/need/to/exist/until-call',
          projectID: 'project',
          bindingID: 'binding',
          bindingRevision: 1,
          trustedIssuer: 'https://issuer.example.invalid',
          modelId: 'approved',
          allowedModels: ['approved', 'browser-choice'],
          executionLocation: 'cloud',
          allowedDataClasses: ['confidential'],
        },
      },
    }), /exactly its binding-approved model/);

    const registry = createProviderRegistry({
      mode: 'test',
      defaultProvider: 'paimos',
      defaultModel: 'global-override-is-not-the-binding',
      providers: {
        paimos: {
          kind: 'paimos-harness',
          origin: 'http://127.0.0.1:9',
          credentialFile: '/does/not/need/to/exist/until-call',
          projectID: 'project',
          bindingID: 'binding',
          bindingRevision: 1,
          trustedIssuer: 'https://issuer.example.invalid',
          modelId: 'approved',
          allowedModels: ['approved'],
          executionLocation: 'cloud',
          allowedDataClasses: ['confidential'],
        },
      },
    });
    assert.equal(registry.defaultProvider.modelId, 'approved');
    assert.equal(registry.defaultProvider.executionLocation, 'cloud');

    assert.throws(() => normalizeOrgPolicy({
      epoch: 1,
      execution: 'local',
      allowedProviders: ['paimos'],
      allowedDataClasses: ['confidential'],
      dataClass: 'confidential',
    }, {
      defaultProvider: 'paimos',
      providers: {
        paimos: {
          kind: 'paimos-harness',
          executionLocation: 'local',
          allowedDataClasses: ['confidential'],
        },
      },
    }), /must be cloud/);
  });
});
