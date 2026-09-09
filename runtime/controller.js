/**
 * Headless conversation controller: authenticated input → configured provider
 * → evolving understanding → unapproved proposals. Approval stays a separate
 * human review call. Incomplete streams never persist assistant turns or proposals.
 */

import { randomUUID } from 'node:crypto';

import {
  approveBaselineFromProposals,
  currentBaseline,
  rejectProposals,
} from '../lib/stream.js';
import { buildRevisionReview } from '../lib/revision-review.js';
import { exportHandoverCsv, exportHandoverJson, handoverRevisionIdentity } from '../lib/export.js';
import { exportReviewedCsv, exportReviewedHandover } from '../lib/portable.js';
import { exportReviewedHtml } from '../lib/export-html.js';
import { exportReviewedPdf } from '../lib/export-pdf.js';
import { importReviewedOwnFormat } from '../lib/intake.js';
import {
  EXTRACTION_REQUEST_BUDGET_MS,
  normalizeUploadLimits,
  PROVIDER_DOCUMENT_CHARS,
} from '../lib/extract-limits.js';
import { assertCanApproveBaseline } from '../lib/authority.js';
import { contentDispositionAttachment, reviewedExportFilename } from '../lib/text.js';

import {
  appendTurn,
  assistantTurnForPersistence,
  boundMessage,
  messagesForProvider,
} from './transcript.js';
import {
  assertApprovedModel,
  composeAbortSignals,
  CONVERSATION_SYSTEM_PROMPT,
  DOCUMENT_INTERPRET_SYSTEM_PROMPT,
  isIncompleteProviderStream,
  normalizeProviderLimits,
  rejectBrowserProviderOverride,
  UNDERSTANDING_SYSTEM_PROMPT,
} from './provider.js';
import {
  allowedSelections,
  assertCallAllowed,
  BILLING_USAGE_UNAVAILABLE,
  boundProviderId,
  effectiveProjectPolicy,
  policyDeniedError,
  spendCallId,
  spendError,
} from './policy.js';
import { mergeUnderstanding, proposeFromUnderstanding, validateUnderstanding } from './understanding.js';
import { assertHumanApprover, authorityFromActor } from './identity.js';
import { createDocumentRecord, extractDocument } from './extract.js';
import {
  assertSpeechAudio,
  boundSpeechTranscript,
  filenameForSpeechMediaType,
} from './speech.js';

export class ConversationController {
  /**
   * @param {{
   *   store: import('./store.js').SqliteProjectStore,
   *   provider: import('./provider.js').LlmProvider,
   *   providers?: Record<string, import('./provider.js').LlmProvider>,
   *   defaultProviderId?: string,
   *   policy?: object | null,
   *   mode: string,
   *   limits?: unknown,
   *   uploadLimits?: unknown,
   *   speech?: object | null,
   *   speechAdapter?: object | null,
   * }} deps
   */
  constructor(deps) {
    this.store = deps.store;
    this.provider = deps.provider;
    this.providers = Object.freeze({ ...(deps.providers ?? { [deps.provider.id]: deps.provider }) });
    this.defaultProviderId = deps.defaultProviderId ?? deps.provider.id;
    this.policy = deps.policy ?? null;
    this.mode = deps.mode;
    this.limits = normalizeProviderLimits(deps.limits);
    this.uploadLimits = normalizeUploadLimits(deps.uploadLimits);
    this.speech = deps.speech?.enabled ? deps.speech : null;
    this.speechAdapter = this.speech ? (deps.speechAdapter ?? null) : null;
    /** @type {Map<string, AbortController>} */
    this.inFlight = new Map();
    /** @type {Map<string, Promise<unknown>>} */
    this.turnLocks = new Map();
  }

  /**
   * @param {string} projectRef
   */
  selectionsFor(projectRef) {
    return allowedSelections(this.policy, projectRef, this.providers, this.defaultProviderId);
  }

  /**
   * Browser may choose only the operator-approved speech provider/model.
   * Endpoint, location, data class, credentials, and limits stay server-owned.
   * @param {string} projectRef
   */
  speechSelectionsFor(projectRef) {
    if (!this.speech) {
      return Object.freeze({
        enabled: false,
        defaultProviderId: null,
        defaultAllowed: false,
        providers: Object.freeze([]),
      });
    }
    if (this.policy) {
      const adapter = this.providers[this.speech.providerId];
      try {
        assertCallAllowed(effectiveProjectPolicy(this.policy, projectRef), {
          providerId: this.speech.providerId,
          executionLocation: this.speech.executionLocation ?? adapter?.executionLocation,
          allowedModels: this.speech.allowedModels,
          providerDataClasses: this.speech.allowedDataClasses ?? adapter?.allowedDataClasses,
        });
      } catch {
        return Object.freeze({
          enabled: false,
          defaultProviderId: this.speech.providerId,
          defaultAllowed: false,
          providers: Object.freeze([]),
        });
      }
    }
    return Object.freeze({
      enabled: true,
      defaultProviderId: this.speech.providerId,
      defaultAllowed: true,
      providers: Object.freeze([{
        id: this.speech.providerId,
        models: Object.freeze([...this.speech.allowedModels]),
      }]),
    });
  }

  /**
   * @param {import('./identity.js').VerifiedActor} actor
   * @param {{ title: string, projectKinds: readonly string[] }} input
   */
  createProject(actor, input) {
    return this.store.createProject({
      title: input.title,
      projectKinds: input.projectKinds,
      actor,
    });
  }

  /**
   * @param {import('./identity.js').VerifiedActor} actor
   * @param {string} projectRef
   */
  loadProject(actor, projectRef) {
    return this.store.getProject(projectRef, actor);
  }

  /**
   * @param {{
   *   actor: import('./identity.js').VerifiedActor,
   *   projectRef: string,
   *   message: string,
   *   turnId?: string,
   *   expectedRevision?: number,
   *   model?: unknown,
   *   browserBody?: unknown,
   *   signal?: AbortSignal,
   *   onChunk?: (chunk: string) => void,
   * }} input
   */
  async submitTurn(input) {
    rejectBrowserProviderOverride(input.browserBody);
    const actor = input.actor;
    const projectRef = input.projectRef;
    this.store.getProject(projectRef, actor);
    const turnId = input.turnId || `turn:${randomUUID()}`;
    const cached = this.store.getTurnResult(projectRef, turnId);
    if (cached?.status === 'complete') {
      return this.#replayTurn(projectRef, actor, cached);
    }

    const lockKey = flightKey(projectRef, turnId);
    const inflightTurn = this.turnLocks.get(lockKey);
    if (inflightTurn) return inflightTurn;

    const work = this.#executeTurn({ ...input, turnId }).finally(() => {
      this.turnLocks.delete(lockKey);
    });
    this.turnLocks.set(lockKey, work);
    return work;
  }

  /**
   * @param {object} cached
   */
  #replayTurn(projectRef, actor, cached) {
    return {
      ...cached,
      project: this.store.getProject(projectRef, actor),
      idempotent: true,
      stream_completed: cached.stream_completed ?? true,
    };
  }

  /**
   * @param {{
   *   actor: import('./identity.js').VerifiedActor,
   *   projectRef: string,
   *   message: string,
   *   turnId: string,
   *   expectedRevision?: number,
   *   model?: unknown,
   *   providerId?: unknown,
   *   browserBody?: unknown,
   *   signal?: AbortSignal,
   *   onChunk?: (chunk: string) => void,
   * }} input
   */
  async #executeTurn(input) {
    const { actor, projectRef, turnId } = input;
    const project = this.store.getProject(projectRef, actor);
    const cached = this.store.getTurnResult(projectRef, turnId);
    if (cached?.status === 'complete') {
      return this.#replayTurn(projectRef, actor, cached);
    }

    const expectedRevision = input.expectedRevision ?? project.revision;
    if (expectedRevision !== project.revision) {
      throw Object.assign(new Error('project revision conflict'), { code: 'revision_conflict' });
    }

    const userText = boundMessage(input.message);
    if (!userText) {
      throw Object.assign(new Error('message is empty'), { code: 'empty' });
    }

    const selection = this.#pinSelection(projectRef, input);
    const { provider, modelId } = selection;
    this.#assertOutboundSpend(projectRef, turnId, 'chat');

    const userAppend = appendTurn(project.transcript, 'user', userText, undefined, {
      source: 'human',
      party_ref: actor.party_ref,
      actor_kind: actor.actor_kind,
      subject: actor.subject,
    });
    if (!userAppend.ok) {
      throw Object.assign(new Error(`cannot append turn: ${userAppend.reason}`), { code: userAppend.reason });
    }

    const afterUser = this.store.apply({
      projectRef,
      actor,
      expectedRevision: project.revision,
      mutate: () => ({
        stream: project.stream,
        transcript: userAppend.transcript,
        understanding: project.understanding,
      }),
    });

    const abort = new AbortController();
    const timeout = AbortSignal.timeout(this.limits.maxDurationMs);
    const onParentAbort = () => abort.abort(input.signal?.reason);
    if (input.signal) {
      if (input.signal.aborted) abort.abort(input.signal.reason);
      else input.signal.addEventListener('abort', onParentAbort, { once: true });
    }
    const signal = composeAbortSignals([abort.signal, timeout, input.signal]);
    this.inFlight.set(flightKey(projectRef, turnId), abort);

    let assembled = '';
    let streamCompleted = false;
    let incompleteReason = null;
    try {
      const chatRequest = {
        system: CONVERSATION_SYSTEM_PROMPT,
        messages: messagesForProvider(userAppend.transcript),
        signal,
        model: modelId,
      };
      await this.#withOutboundCall(projectRef, turnId, 'chat', async () => {
        for await (const chunk of provider.streamChat(chatRequest)) {
          assembled += chunk;
          if (assembled.length > this.limits.maxAssembledChars) {
            abort.abort();
            throw Object.assign(
              new Error('provider stream exceeded the configured text limit'),
              { code: 'incomplete_stream', reason: 'response_too_large', name: 'IncompleteProviderStreamError' },
            );
          }
          input.onChunk?.(chunk);
        }
      });
      streamCompleted = true;

      const persistable = assistantTurnForPersistence(assembled, streamCompleted);
      if (!persistable) {
        return {
          status: 'incomplete',
          turn_id: turnId,
          project: afterUser.project,
          assistant: assembled,
          stream_completed: false,
          incomplete_reason: incompleteReason || 'truncated',
          proposals_created: [],
          ...this.#billingNote(),
        };
      }

      const assistantAppend = appendTurn(userAppend.transcript, 'assistant', persistable, undefined, {
        source: 'provider',
        provider_id: provider.id,
        model_id: modelId,
        live: provider.live,
        labelled_demo: provider.labelledDemo,
        stream_completed: true,
      });
      if (!assistantAppend.ok) {
        throw Object.assign(new Error(`cannot append turn: ${assistantAppend.reason}`), {
          code: assistantAppend.reason,
        });
      }

      let understanding = afterUser.project.understanding;
      let stream = afterUser.project.stream;
      let proposalRefs = [];
      try {
        const raw = await this.#withOutboundCall(projectRef, turnId, 'understand', () => provider.understand({
          system: UNDERSTANDING_SYSTEM_PROMPT,
          messages: messagesForProvider(assistantAppend.transcript),
          signal,
          model: modelId,
        }));
        const validated = validateUnderstanding(raw);
        understanding = mergeUnderstanding(understanding, validated);
        const proposed = proposeFromUnderstanding(stream, authorityFromActor(actor), understanding);
        stream = proposed.stream;
        proposalRefs = [...proposed.proposal_refs];
      } catch (error) {
        if (isSpendOrPolicyError(error)) throw error;
        // Complete chat remains durable. Cancel, timeout, invalid, or partial
        // understanding must not mint proposals or replace a good snapshot.
      }

      const completed = this.store.apply({
        projectRef,
        actor,
        expectedRevision: afterUser.project.revision,
        turnId,
        mutate: () => ({
          stream,
          transcript: assistantAppend.transcript,
          understanding,
          turnResult: {
            status: 'complete',
            turn_id: turnId,
            assistant: persistable,
            proposals_created: proposalRefs,
            stream_completed: true,
          },
        }),
      });

      if (completed.deduped && completed.turnResult) {
        return {
          ...completed.turnResult,
          project: completed.project,
          stream_completed: true,
          idempotent: true,
          live: provider.live,
          labelled_demo: provider.labelledDemo,
          ...this.#billingNote(),
        };
      }

      return {
        status: 'complete',
        turn_id: turnId,
        project: completed.project,
        assistant: persistable,
        stream_completed: true,
        proposals_created: proposalRefs,
        idempotent: completed.deduped,
        live: provider.live,
        labelled_demo: provider.labelledDemo,
        ...this.#billingNote(),
      };
    } catch (error) {
      streamCompleted = false;
      incompleteReason = incompleteReasonFrom(error, {
        timeout,
        parent: input.signal,
        local: abort.signal,
        assembled,
      });
      if (!incompleteReason) throw error;

      const persistable = assistantTurnForPersistence(assembled, streamCompleted);
      if (!persistable) {
        return {
          status: 'incomplete',
          turn_id: turnId,
          project: afterUser.project,
          assistant: assembled,
          stream_completed: false,
          incomplete_reason: incompleteReason || 'truncated',
          proposals_created: [],
          ...this.#billingNote(),
        };
      }
      throw error;
    } finally {
      this.inFlight.delete(flightKey(projectRef, turnId));
      input.signal?.removeEventListener('abort', onParentAbort);
    }
  }

  /**
   * Pin one registry id + model for chat and understanding. Never substitute.
   * @param {string} projectRef
   * @param {{ providerId?: unknown, model?: unknown }} input
   */
  #pinSelection(projectRef, input) {
    const requestedId = input.providerId == null || input.providerId === ''
      ? null
      : boundProviderId(input.providerId);
    if (!this.policy) {
      if (requestedId && requestedId !== this.defaultProviderId && requestedId !== this.provider.id) {
        throw policyDeniedError('requested provider is not the configured default', 'provider');
      }
      const modelId = assertApprovedModel(this.provider, input.model);
      return { provider: this.provider, modelId, providerId: this.provider.id };
    }
    const providerId = requestedId || this.defaultProviderId;
    const adapter = this.providers[providerId];
    if (!adapter) {
      throw policyDeniedError('requested provider is not in the operator registry', 'provider');
    }
    const effective = effectiveProjectPolicy(this.policy, projectRef);
    assertCallAllowed(effective, {
      providerId,
      model: input.model,
      executionLocation: adapter.executionLocation,
      allowedModels: adapter.allowedModels ?? [adapter.modelId],
      providerDataClasses: adapter.allowedDataClasses,
    });
    const modelId = assertApprovedModel(adapter, input.model);
    return { provider: adapter, modelId, providerId };
  }

  /**
   * @param {string} projectRef
   * @param {{ providerId?: unknown, model?: unknown }} input
   */
  #pinSpeechSelection(projectRef, input) {
    if (!this.speech || !this.speechAdapter) {
      throw Object.assign(new Error('speech input is not configured'), { code: 'speech_disabled' });
    }
    const requestedId = input.providerId == null || input.providerId === ''
      ? null
      : boundProviderId(input.providerId);
    if (requestedId && requestedId !== this.speech.providerId) {
      throw policyDeniedError('requested speech provider is not the configured speech provider', 'provider');
    }
    const providerId = this.speech.providerId;
    const requestedModel = input.model == null || input.model === ''
      ? this.speech.model
      : input.model;
    if (typeof requestedModel !== 'string' || !this.speech.allowedModels.includes(requestedModel)) {
      throw policyDeniedError('requested speech model is not in the operator-approved registry', 'model');
    }
    if (this.policy) {
      const adapter = this.providers[providerId];
      assertCallAllowed(effectiveProjectPolicy(this.policy, projectRef), {
        providerId,
        model: requestedModel,
        executionLocation: this.speech.executionLocation ?? adapter?.executionLocation,
        allowedModels: this.speech.allowedModels,
        providerDataClasses: this.speech.allowedDataClasses ?? adapter?.allowedDataClasses,
      });
    }
    const modelId = this.speechAdapter.resolveModel(requestedModel);
    return { providerId, modelId };
  }

  /**
   * Reserve, invoke, then mark committed. Crash between reserve and invoke
   * leaves a reserved row: the same id must not be resent.
   * @param {string} projectRef
   * @param {string} turnId
   * @param {'chat' | 'understand' | 'interpret' | 'transcribe'} phase
   * @param {() => Promise<unknown>} invoke
   */
  async #withOutboundCall(projectRef, turnId, phase, invoke) {
    const effective = effectiveProjectPolicy(this.policy, projectRef);
    const ceiling = effective?.maxOutboundCallsPerProject;
    if (ceiling == null) {
      return invoke();
    }
    const callId = spendCallId(turnId, phase);
    const reservation = this.store.reserveOutboundCall({
      projectRef,
      epoch: effective.epoch,
      callId,
      ceiling,
    });
    if (reservation.uncertain) {
      throw spendError(
        'previous outbound call with this id did not finish cleanly; not retrying',
        'spend_uncertain',
      );
    }
    if (reservation.alreadyCommitted) {
      throw spendError(
        'previous outbound call with this id already completed; not retrying',
        'spend_committed',
      );
    }
    if (reservation.denied) {
      throw spendError('project outbound request ceiling reached', 'spend_denied');
    }
    try {
      return await invoke();
    } finally {
      this.store.commitOutboundCall({
        projectRef,
        epoch: effective.epoch,
        callId,
      });
    }
  }

  #billingNote() {
    if (!this.policy) return {};
    return { billing: { usage: BILLING_USAGE_UNAVAILABLE } };
  }

  /**
   * Classify a reserved/committed id before asking for a new slot. A reserved
   * row already counts; retrying it is uncertain, not a ceiling denial.
   * @param {string} projectRef
   * @param {string} turnId
   * @param {'chat' | 'understand' | 'interpret' | 'transcribe'} phase
   */
  #assertOutboundSpend(projectRef, turnId, phase) {
    this.#assertCallIdFresh(projectRef, turnId, phase);
    this.#assertSpendCapacity(projectRef);
  }

  /**
   * Refuse a new outbound attempt when the durable count is already at the
   * ceiling, before writing a user turn. Races still serialize at reserve.
   * @param {string} projectRef
   */
  #assertSpendCapacity(projectRef) {
    const effective = effectiveProjectPolicy(this.policy, projectRef);
    const ceiling = effective?.maxOutboundCallsPerProject;
    if (ceiling == null) return;
    const used = this.store.countOutboundCalls(projectRef, effective.epoch);
    if (used >= ceiling) {
      throw spendError('project outbound request ceiling reached', 'spend_denied');
    }
  }

  /**
   * Same reserved or committed call id must not be resent. Cached complete
   * replays are handled before this check.
   * @param {string} projectRef
   * @param {string} turnId
   * @param {'chat' | 'understand' | 'interpret' | 'transcribe'} phase
   */
  #assertCallIdFresh(projectRef, turnId, phase) {
    const effective = effectiveProjectPolicy(this.policy, projectRef);
    if (effective?.maxOutboundCallsPerProject == null) return;
    const status = this.store.getOutboundCall(
      projectRef,
      effective.epoch,
      spendCallId(turnId, phase),
    );
    if (status === 'reserved') {
      throw spendError(
        'previous outbound call with this id did not finish cleanly; not retrying',
        'spend_uncertain',
      );
    }
    if (status === 'committed') {
      throw spendError(
        'previous outbound call with this id already completed; not retrying',
        'spend_committed',
      );
    }
  }

  /**
   * Transcribe in-memory audio into an editable draft. Does not write revision,
   * transcript, understanding, proposal, baseline, or Flow state.
   *
   * @param {{
   *   actor: import('./identity.js').VerifiedActor,
   *   projectRef: string,
   *   file: { bytes: Uint8Array, mimeType: string, filename?: string, byteSize?: number },
   *   speechId?: string,
   *   model?: unknown,
   *   providerId?: unknown,
   *   browserBody?: unknown,
   *   signal?: AbortSignal,
   * }} input
   */
  async transcribeSpeech(input) {
    rejectBrowserProviderOverride(input.browserBody);
    if (!this.speech?.enabled || !this.speechAdapter) {
      throw Object.assign(new Error('speech input is not configured'), { code: 'speech_disabled' });
    }
    const { actor, projectRef } = input;
    this.store.getProject(projectRef, actor);
    const files = input.files;
    if (Array.isArray(files) && files.length > 1) {
      throw Object.assign(new Error('exactly one audio file is required'), { code: 'too_many' });
    }
    const file = input.file ?? files?.[0];
    if (!file) {
      throw Object.assign(new Error('exactly one audio file is required'), { code: 'empty_audio' });
    }
    const mimeType = file.mimeType;
    const bytes = file.bytes instanceof Uint8Array ? file.bytes : new Uint8Array();
    assertSpeechAudio(
      { bytes, mimeType },
      this.speech.acceptedMediaTypes,
      this.speech.limits.maxAudioBytes,
    );
    const selection = this.#pinSpeechSelection(projectRef, input);
    const speechId = typeof input.speechId === 'string' && input.speechId.trim()
      ? input.speechId.trim()
      : `speech:${randomUUID()}`;
    this.#assertOutboundSpend(projectRef, speechId, 'transcribe');

    const abort = new AbortController();
    const key = flightKey(projectRef, speechId);
    this.inFlight.set(key, abort);
    const onParentAbort = () => abort.abort(input.signal?.reason);
    if (input.signal) {
      if (input.signal.aborted) abort.abort(input.signal.reason);
      else input.signal.addEventListener('abort', onParentAbort, { once: true });
    }
    const signal = composeAbortSignals([abort.signal, input.signal]);

    try {
      const result = await this.#withOutboundCall(projectRef, speechId, 'transcribe', () => (
        this.speechAdapter.transcribe({
          bytes,
          mimeType,
          filename: filenameForSpeechMediaType(mimeType),
          model: selection.modelId,
          signal,
        })
      ));
      const project = this.store.getProject(projectRef, actor);
      return {
        text: boundSpeechTranscript(result.text, this.speech.limits.maxTranscriptChars),
        speech_id: speechId,
        providerId: selection.providerId,
        modelId: selection.modelId,
        labelled_demo: result.labelledDemo ?? this.speechAdapter.labelledDemo,
        live: result.live ?? this.speechAdapter.live,
        revision: project.revision,
        ...this.#billingNote(),
      };
    } finally {
      input.signal?.removeEventListener('abort', onParentAbort);
      this.inFlight.delete(key);
    }
  }

  /**
   * @param {string} projectRef
   * @param {string} [turnId]
   */
  cancel(projectRef, turnId) {
    if (turnId) {
      const abort = this.inFlight.get(flightKey(projectRef, turnId));
      if (abort) abort.abort();
      return Boolean(abort);
    }
    let cancelled = false;
    const prefix = `${projectRef}\0`;
    for (const [key, abort] of this.inFlight) {
      if (key === projectRef || key.startsWith(prefix)) {
        abort.abort();
        cancelled = true;
      }
    }
    return cancelled;
  }

  /**
   * @param {{
   *   actor: import('./identity.js').VerifiedActor,
   *   projectRef: string,
   *   proposalRefs: readonly string[],
   *   baselineRef?: string,
   *   expectedRevision?: number,
   *   reviewDigest?: string,
   * }} input
   */
  approveSelected(input) {
    assertHumanApprover(input.actor);
    const project = this.store.getProject(input.projectRef, input.actor);
    assertCanApproveBaseline(authorityFromActor(input.actor));
    if (typeof input.reviewDigest !== 'string' || !input.reviewDigest) {
      throw Object.assign(
        new Error('review_digest is required; refresh and review again'),
        { code: 'stale_review' },
      );
    }
    const baselineRef = input.baselineRef || `baseline:${project.revision + 1}`;
    const stream = approveBaselineFromProposals(
      project.stream,
      authorityFromActor(input.actor),
      input.proposalRefs,
      baselineRef,
      undefined,
      input.reviewDigest,
    );
    return this.store.apply({
      projectRef: input.projectRef,
      actor: input.actor,
      expectedRevision: input.expectedRevision ?? project.revision,
      mutate: () => ({
        stream,
        transcript: project.transcript,
        understanding: project.understanding,
      }),
    }).project;
  }

  /**
   * Read-only deterministic review for the current authorized project state.
   * The project revision remains the storage concurrency token; review_digest
   * binds the exact proposal and baseline content shown to the human.
   * @param {import('./identity.js').VerifiedActor} actor
   * @param {string} projectRef
   */
  reviewPending(actor, projectRef) {
    const project = this.store.getProject(projectRef, actor);
    return Object.freeze({
      project_revision: project.revision,
      ...buildRevisionReview(project.stream),
    });
  }

  /**
   * @param {{
   *   actor: import('./identity.js').VerifiedActor,
   *   projectRef: string,
   *   proposalRefs: readonly string[],
   *   note?: string,
   *   expectedRevision?: number,
   * }} input
   */
  rejectSelected(input) {
    assertHumanApprover(input.actor);
    const project = this.store.getProject(input.projectRef, input.actor);
    const stream = rejectProposals(
      project.stream,
      authorityFromActor(input.actor),
      input.proposalRefs,
      input.note,
    );
    return this.store.apply({
      projectRef: input.projectRef,
      actor: input.actor,
      expectedRevision: input.expectedRevision ?? project.revision,
      mutate: () => ({
        stream,
        transcript: project.transcript,
        understanding: project.understanding,
      }),
    }).project;
  }

  /**
   * @param {import('./identity.js').VerifiedActor} actor
   * @param {string} projectRef
   */
  handover(actor, projectRef) {
    const project = this.store.getProject(projectRef, actor);
    const json = exportHandoverJson(project.stream);
    const csv = exportHandoverCsv(project.stream);
    return {
      json,
      csv,
      identity: handoverRevisionIdentity(json),
      baseline: currentBaseline(project.stream),
    };
  }

  /**
   * Portable reviewed export at one explicit approved snapshot.
   * @param {import('./identity.js').VerifiedActor} actor
   * @param {string} projectRef
   * @param {{ format?: unknown, baseline_ref?: unknown, revision?: unknown, exportedAt?: string }} query
   */
  async exportReviewed(actor, projectRef, query) {
    const project = this.store.getProject(projectRef, actor);
    const format = String(query.format || '').toLowerCase();
    if (!['json', 'csv', 'html', 'pdf'].includes(format)) {
      throw Object.assign(new Error('export format must be json, csv, html, or pdf'), { code: 'export_format' });
    }
    const exportedAt = query.exportedAt || new Date().toISOString();
    const handover = exportReviewedHandover(
      project.stream,
      { baseline_ref: query.baseline_ref, revision: query.revision },
      exportedAt,
    );
    const identity = handoverRevisionIdentity(handover);
    const filename = reviewedExportFilename(identity.baseline_ref, identity.revision, format === 'html' ? 'html' : format);
    if (format === 'json') {
      return {
        filename,
        contentType: 'application/json; charset=utf-8',
        body: Buffer.from(`${JSON.stringify(handover, null, 2)}\n`, 'utf8'),
        identity,
        disposition: contentDispositionAttachment(filename),
      };
    }
    if (format === 'csv') {
      return {
        filename,
        contentType: 'text/csv; charset=utf-8',
        body: Buffer.from(exportReviewedCsv(project.stream, {
          baseline_ref: query.baseline_ref,
          revision: query.revision,
        }, undefined, exportedAt), 'utf8'),
        identity,
        disposition: contentDispositionAttachment(filename),
      };
    }
    if (format === 'html') {
      return {
        filename,
        contentType: 'text/html; charset=utf-8',
        body: Buffer.from(exportReviewedHtml(handover), 'utf8'),
        identity,
        disposition: contentDispositionAttachment(filename),
      };
    }
    const pdf = await exportReviewedPdf(handover);
    return {
      filename,
      contentType: 'application/pdf',
      body: pdf,
      identity,
      disposition: contentDispositionAttachment(filename),
    };
  }

  /**
   * @param {{
   *   actor: import('./identity.js').VerifiedActor,
   *   projectRef: string,
   *   files: readonly { filename: string, mimeType: string, bytes: Uint8Array, byteSize: number }[],
   *   expectedRevision?: number,
   *   browserBody?: unknown,
   *   signal?: AbortSignal,
   * }} input
   */
  async intakeDocuments(input) {
    rejectBrowserProviderOverride(input.browserBody);
    const actor = input.actor;
    const projectRef = input.projectRef;
    const project = this.store.getProject(projectRef, actor);
    const limits = this.uploadLimits;
    if (!input.files.length) {
      throw Object.assign(new Error('no files'), { code: 'no_files' });
    }
    if (input.files.length > limits.maxFilesPerRequest) {
      throw Object.assign(new Error(`too many files (limit ${limits.maxFilesPerRequest})`), { code: 'too_many' });
    }
    const rejected = [];
    const accepted = [];
    const deadlineAt = Date.now() + EXTRACTION_REQUEST_BUDGET_MS;
    const parseAbort = new AbortController();
    this.inFlight.set(flightKey(projectRef, `parse:${randomUUID()}`), parseAbort);
    const onParentAbort = () => parseAbort.abort(input.signal?.reason);
    if (input.signal) {
      if (input.signal.aborted) parseAbort.abort(input.signal.reason);
      else input.signal.addEventListener('abort', onParentAbort, { once: true });
    }
    const signal = composeAbortSignals([parseAbort.signal, input.signal]);

    try {
      for (const file of input.files) {
        if (signal?.aborted) {
          throw Object.assign(new Error('extraction cancelled'), { code: 'cancelled', name: 'AbortError' });
        }
        if (file.byteSize > limits.maxFileBytes) {
          rejected.push({ filename: file.filename, reason: 'too_large' });
          continue;
        }
        let extraction;
        try {
          extraction = await extractDocument(file.bytes, file.mimeType, {
            filename: file.filename,
            deadlineAt,
            maxPdfPages: limits.maxPdfPages,
            signal,
          });
        } catch (error) {
          if (error?.name === 'AbortError' || error?.code === 'cancelled') throw error;
          rejected.push({ filename: file.filename, reason: 'failed' });
          continue;
        }
        const record = createDocumentRecord(extraction, {
          filename: file.filename,
          mimeType: file.mimeType,
          byteSize: file.byteSize,
        });
        accepted.push({ record, extraction });
      }

      if (signal?.aborted) {
        throw Object.assign(new Error('extraction cancelled'), { code: 'cancelled', name: 'AbortError' });
      }

      const live = this.store.getProject(projectRef, actor);
      let stream = live.stream;
      let ownFormatApplied = 0;
      const documentsToAdd = [];
      const notices = [];

      for (const item of accepted) {
        const { record, extraction } = item;
        if (extraction.own_format && extraction.parsed) {
          try {
            const imported = importReviewedOwnFormat(
              stream,
              authorityFromActor(actor),
              extraction.parsed,
            );
            stream = imported.stream;
            ownFormatApplied += 1;
            notices.push(
              `${record.filename}: ${imported.added} add(s) and ${imported.updated} update(s) as unapproved proposals. Source approval is a claim only.`,
            );
          } catch (error) {
            rejected.push({
              filename: record.filename,
              reason: error instanceof Error ? error.message : 'own-format rejected',
            });
            continue;
          }
        } else if (extraction.truncated) {
          notices.push(`${record.filename}: extracted text was truncated at the configured limit.`);
        } else if (extraction.reason !== 'ok') {
          notices.push(`${record.filename}: extraction ${extraction.reason}.`);
        }
        documentsToAdd.push(record);
      }

      if (!documentsToAdd.length && !ownFormatApplied) {
        return { project: live, rejected, notices, accepted: [] };
      }

      const streamChanged = stream !== live.stream;
      if (streamChanged) {
        const expectedRevision = input.expectedRevision ?? live.revision;
        const applied = this.store.apply({
          projectRef,
          actor,
          expectedRevision,
          mutate: () => ({
            stream,
            transcript: live.transcript,
            understanding: live.understanding,
            documentsToAdd,
            maxDocuments: limits.maxDocumentsPerProject,
          }),
        });
        const committed = applied.committedDocumentRefs ?? [];
        const overflow = documentsToAdd.slice(committed.length);
        for (const extra of overflow) {
          rejected.push({ filename: extra.filename, reason: 'too_many' });
        }
        return {
          project: applied.project,
          rejected,
          notices,
          accepted: committed,
        };
      }

      const inserted = this.store.insertDocuments({
        projectRef,
        actor,
        records: documentsToAdd,
        maxDocuments: limits.maxDocumentsPerProject,
      });
      const overflow = documentsToAdd.slice(inserted.committed.length);
      for (const extra of overflow) {
        rejected.push({ filename: extra.filename, reason: 'too_many' });
      }
      return {
        project: this.store.getProject(projectRef, actor),
        rejected,
        notices,
        accepted: inserted.committed,
      };
    } finally {
      input.signal?.removeEventListener('abort', onParentAbort);
      for (const [key, abort] of this.inFlight) {
        if (abort === parseAbort) this.inFlight.delete(key);
      }
    }
  }

  /**
   * Explicit interpret of a retained generic document. Uses only the
   * server-configured provider/model. Disconnect cannot mint a late proposal.
   * @param {{
   *   actor: import('./identity.js').VerifiedActor,
   *   projectRef: string,
   *   documentRef: string,
   *   expectedRevision?: number,
   *   turnId?: string,
   *   model?: unknown,
   *   providerId?: unknown,
   *   browserBody?: unknown,
   *   signal?: AbortSignal,
   * }} input
   */
  async interpretDocument(input) {
    rejectBrowserProviderOverride(input.browserBody);
    const actor = input.actor;
    const projectRef = input.projectRef;
    const document = this.store.getDocument(projectRef, actor, input.documentRef);
    if (document.source_kind === 'own_format') {
      throw Object.assign(new Error('own-format JSON is proposed on upload; Interpret is for generic documents'), {
        code: 'interpret_own_format',
      });
    }
    if (document.extraction_reason !== 'ok' || !document.extracted_text) {
      throw Object.assign(
        new Error(`document is not readable (${document.extraction_reason || 'empty'})`),
        { code: 'interpret_unreadable' },
      );
    }

    const project = this.store.getProject(projectRef, actor);
    const expectedRevision = input.expectedRevision ?? project.revision;
    if (expectedRevision !== project.revision) {
      throw Object.assign(new Error('project revision conflict'), { code: 'revision_conflict' });
    }

    const turnId = input.turnId || `interpret:${randomUUID()}`;
    const cached = this.store.getTurnResult(projectRef, turnId);
    if (cached?.status === 'complete') {
      return {
        ...cached,
        project: this.store.getProject(projectRef, actor),
        idempotent: true,
        ...this.#billingNote(),
      };
    }

    const lockKey = flightKey(projectRef, turnId);
    const inflight = this.turnLocks.get(lockKey);
    if (inflight) return inflight;

    const work = this.#executeInterpret({ ...input, actor, projectRef, document, project, turnId })
      .finally(() => {
        this.turnLocks.delete(lockKey);
      });
    this.turnLocks.set(lockKey, work);
    return work;
  }

  /**
   * @param {object} input
   */
  async #executeInterpret(input) {
    const { actor, projectRef, document, turnId } = input;
    const project = this.store.getProject(projectRef, actor);
    const cached = this.store.getTurnResult(projectRef, turnId);
    if (cached?.status === 'complete') {
      return {
        ...cached,
        project,
        idempotent: true,
        ...this.#billingNote(),
      };
    }
    const { provider, modelId } = this.#pinSelection(projectRef, input);
    this.#assertOutboundSpend(projectRef, turnId, 'interpret');

    const abort = new AbortController();
    const timeout = AbortSignal.timeout(this.limits.maxDurationMs);
    const onParentAbort = () => abort.abort(input.signal?.reason);
    if (input.signal) {
      if (input.signal.aborted) abort.abort(input.signal.reason);
      else input.signal.addEventListener('abort', onParentAbort, { once: true });
    }
    const signal = composeAbortSignals([abort.signal, timeout, input.signal]);
    this.inFlight.set(flightKey(projectRef, turnId), abort);

    try {
      if (signal?.aborted) {
        return { status: 'incomplete', incomplete_reason: 'cancelled', project, proposals_created: [], ...this.#billingNote() };
      }
      const bounded = document.extracted_text.slice(0, PROVIDER_DOCUMENT_CHARS);
      const truncatedForProvider = document.extracted_text.length > PROVIDER_DOCUMENT_CHARS || document.truncated;
      const envelope = [
        `[Untrusted document filename=${document.filename} media_type=${document.media_type} source_ref=${document.document_ref} extraction=${document.extraction_reason} truncated=${truncatedForProvider}]`,
        truncatedForProvider
          ? 'Extracted text was truncated at the configured limit. Do not invent the omitted remainder.'
          : '',
        bounded,
      ].filter(Boolean).join('\n');

      const raw = await this.#withOutboundCall(projectRef, turnId, 'interpret', () => provider.understand({
        system: DOCUMENT_INTERPRET_SYSTEM_PROMPT,
        messages: [{ role: 'user', content: envelope }],
        signal,
        model: modelId,
      }));
      if (signal?.aborted) {
        return { status: 'incomplete', incomplete_reason: 'cancelled', project, proposals_created: [], ...this.#billingNote() };
      }
      const validated = validateUnderstanding(raw);
      const understanding = mergeUnderstanding(project.understanding, validated);
      const proposed = proposeFromUnderstanding(project.stream, authorityFromActor(actor), understanding);

      const note = `Interpreted document ${document.filename} (${document.document_ref}).`;
      const userAppend = appendTurn(project.transcript, 'user', note, undefined, {
        source: 'document',
        document_ref: document.document_ref,
        party_ref: actor.party_ref,
        actor_kind: actor.actor_kind,
        subject: actor.subject,
      });
      const transcript = userAppend.ok ? userAppend.transcript : project.transcript;
      const proposalRefs = [...proposed.proposal_refs];

      const completed = this.store.apply({
        projectRef,
        actor,
        expectedRevision: project.revision,
        turnId,
        mutate: () => ({
          stream: proposed.stream,
          transcript,
          understanding,
          turnResult: {
            status: 'complete',
            turn_id: turnId,
            proposals_created: proposalRefs,
            stream_completed: true,
          },
        }),
      });
      if (completed.deduped && completed.turnResult) {
        return {
          ...completed.turnResult,
          project: completed.project,
          idempotent: true,
          live: provider.live,
          labelled_demo: provider.labelledDemo,
          ...this.#billingNote(),
        };
      }
      return {
        status: 'complete',
        turn_id: turnId,
        project: completed.project,
        proposals_created: proposalRefs,
        live: provider.live,
        labelled_demo: provider.labelledDemo,
        ...this.#billingNote(),
      };
    } catch (error) {
      const reason = incompleteReasonFrom(error, {
        timeout,
        parent: input.signal,
        local: abort.signal,
      });
      if (reason) {
        return {
          status: 'incomplete',
          incomplete_reason: reason,
          project: this.store.getProject(projectRef, actor),
          proposals_created: [],
          ...this.#billingNote(),
        };
      }
      throw error;
    } finally {
      this.inFlight.delete(flightKey(projectRef, turnId));
      input.signal?.removeEventListener('abort', onParentAbort);
    }
  }
}

/**
 * Pending proposals are those without any decision.
 * @param {import('../lib/types.js').RequirementsStream} stream
 */
export function pendingProposalList(stream) {
  return stream.proposals.filter(
    (proposal) => !stream.decisions.some((decision) => decision.proposal_ref === proposal.proposal_ref),
  );
}

/**
 * @param {string} projectRef
 * @param {string} turnId
 */
function flightKey(projectRef, turnId) {
  return `${projectRef}\0${turnId}`;
}

function isSpendOrPolicyError(error) {
  const code = error && typeof error === 'object' ? error.code : undefined;
  return code === 'policy_denied' || code === 'spend_denied' || code === 'spend_uncertain' || code === 'spend_committed';
}

/**
 * @param {unknown} error
 * @param {{ timeout?: AbortSignal, parent?: AbortSignal, local?: AbortSignal, assembled?: string }} signals
 */
function incompleteReasonFrom(error, signals) {
  if (isIncompleteProviderStream(error)) return error.reason || 'truncated';
  if (error?.name === 'TimeoutError') return 'timeout';
  if (signals.timeout?.aborted && !signals.parent?.aborted) return 'timeout';
  if (error?.name === 'AbortError') return 'cancelled';
  if (signals.parent?.aborted || signals.local?.aborted) return 'cancelled';
  if (signals.assembled && isTransportTermination(error)) return 'truncated';
  return null;
}

/**
 * @param {unknown} error
 */
function isTransportTermination(error) {
  if (!error) return false;
  const candidates = [error];
  if (error instanceof Error && error.cause) candidates.push(error.cause);
  for (const item of candidates) {
    const code = typeof item === 'object' && item && 'code' in item ? item.code : undefined;
    if (code === 'ECONNRESET' || code === 'UND_ERR_SOCKET' || code === 'UND_ERR_ABORTED') return true;
    const name = item instanceof Error ? item.name : '';
    const message = item instanceof Error ? item.message : String(item);
    if (name === 'TypeError' && /terminated|closed|socket|fetch failed/i.test(message)) return true;
    if (/ECONNRESET|socket hang up|other side closed/i.test(message)) return true;
  }
  return false;
}
