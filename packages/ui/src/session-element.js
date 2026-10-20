import { consentTimeout } from './consent-timer.js';
import { paintConsentLine, reasonAction, reasonSeparator } from './consent-line.js';
import { ConceptView, WARNING_ICON, paintFailureLine } from './concept-view.js';
import { guardConceptControls } from './concept-guards.js';
import './html-preview.js'; // <aithema-html-preview>, the concept viewer's stage for drafts
import { applyEvent, inputRevision, activeTurns, currentQuestionCard, hasOpenReplyQuestion, openQuestionItems } from '../../core/src/session.js';
import { ReplyStream } from '../../core/src/reply.js';
import { deliverFocusedReply } from './focused-reply.js';
import { reasoningRequest } from '../../core/src/prompts.js';
import { understandingDeferred } from '../../core/src/document-context.js';
import { aiTextOrigin } from '../../core/src/text-origin.js';
import { readinessScalePercent, readinessListItems, readinessListWindow, newlyClearedFirst } from '../../core/src/readiness.js';
import { displayedReadinessPercent } from '../../core/src/understanding.js';
import { FEATURES, deviceFeatures } from '../../core/src/presets.js';
import { SETTINGS_OFF, isDynamicReason, isConsentReason, CONSENT_REASON } from '../../core/src/settings.js';
import { aiNotice } from '../../core/src/ai-notice.js';
import { recoverableVoiceEnd } from '../../core/src/voice-lifecycle.js';
import { AudioRail } from './audio-rail.js';
import { voiceTranscriptTransition, paintVoiceInterruption } from './voice-transcript.js';
import { styles } from './styles.js';
import { actorRoleStyles } from './actor-role-styles.js';
import { settingsStyles } from './settings-styles.js';
import { SettingsDialog, ICONS, PRESET_ORDER, reasonText, engineView, catalogLabel } from './settings-dialog.js';
import { LocalConnector } from './local-connector.js';
import { postJson, postForm, sameOrigin } from './post-json.js';
import { UPLOAD_LIMITS, UPLOAD_ACCEPT, UPLOAD_ICONS, uploadLimits, uploadRetryDelay, planUploads, refusalText, uploadStateText, uploadStateTexts, uploadsPossible, formatBytes, plural, limitsText, dropText } from './uploads.js';
import { voiceJournal, tabStorage, closeVoiceCall, answerVoicePings, voiceCallAbandoned } from './voice-orphan.js';
import { node, setText, reconcile } from './dom.js';
import { HostSurface } from './host-surface.js';
import { hostStyles } from './host-styles.js';
import { entranceStyles } from './entrance-styles.js';
import { orbStyles, createOrb } from './orb.js';
import { icon } from './icons.js';
import { modelDisplayName, languageFlag, formatCredits } from './display.js';
import { bandStyles } from './band-styles.js';
import { voiceSingleRowMinWidth, voiceRailMinWidth } from './first-paint.js';
import { motionPreference, rememberMotion, ConnectionTimer, ConversationFold, FooterPopups, PhoneComposerViewport } from './layout.js';
import { createReveal } from './reveal.js';
import { mountVersionDetails, renderHostVersion } from './version-display.js';
import { QuestionCard, questionCardMarkup, questionCardStyles } from './question-card.js';
import { emailAskStyles } from './email-ask-styles.js';
import { buildPaimosPayload, paimosImportUrl } from './paimos-import.js';

const PANES = '.transcript-shell, .analysis-content';
// START's understanding reveal: 560 ms of column, 100–620 ms of the pane fading in (styles.js), with a margin.
const REVEAL_MS = 700;
function clearSlack(pane) { pane.style.removeProperty('--aithema-slack-top'); pane.style.removeProperty('--aithema-slack-bottom'); }
// Empty space below a pane's content: padding fills it before it adds any scroll room.
function spareSpace(pane) {
  const last = pane.lastElementChild; if (!last) return 0;
  const end = last.getBoundingClientRect().bottom + parseFloat(getComputedStyle(last).marginBottom) + parseFloat(getComputedStyle(pane).paddingBottom);
  return Math.max(0, pane.getBoundingClientRect().top + pane.clientTop + pane.clientHeight - end);
}
// Server-sent events from a fetch body, one parsed event at a time.
async function* serverEvents(reader) {
  let buffer = ''; const decoder = new TextDecoder();
  while (true) {
    const { done, value } = await reader.read(); if (done) return;
    buffer += decoder.decode(value, { stream: true });
    if (buffer.length > 2_000_000) throw new Error('Event stream too large');
    let boundary;
    while ((boundary = buffer.indexOf('\n\n')) >= 0) {
      const block = buffer.slice(0, boundary); buffer = buffer.slice(boundary + 2);
      const data = block.split('\n').filter(l => l.startsWith('data:')).map(l => l.slice(5)).join('\n');
      if (data) yield JSON.parse(data);
    }
  }
}
// Tick's approved 16 px state glyphs (the action itself retains a 44 px target).
const CLARIFY_ICONS = Object.fromEntries(Object.entries({
  ask: '<path d="M14 7.7a5.7 5.7 0 0 1-8.3 5.1L2.2 13.8l1-3.3A5.7 5.7 0 1 1 14 7.7z"/>',
  spin: '<circle cx="8" cy="8" r="6" stroke-opacity=".22"/><path d="M14 8a6 6 0 0 0-6-6"/>',
  check: '<path d="m3.2 8.6 3 3 6.6-7.2"/>',
  pause: '<path d="M5 3v10M11 3v10" stroke-width="2.4"/>',
  consent: '<path d="M8 1.8 3 3.7v3.9c0 3 2.1 5.2 5 6.6 2.9-1.4 5-3.6 5-6.6V3.7z"/>',
  clock: '<circle cx="8" cy="8" r="6"/><path d="M8 4.8V8l2.2 1.4"/>',
}).map(([name, paths]) => [name, `<svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true" class="${name === 'spin' ? 'clarify-spin' : ''}">${paths}</svg>`]));
CLARIFY_ICONS.warn = WARNING_ICON;
const NONE = '\u0000none';
function reconnectDelay(signal) {
  if (signal.aborted) return Promise.resolve();
  return new Promise(resolve => {
    const finish = () => { clearTimeout(timer); signal.removeEventListener('abort', finish); resolve(); };
    const timer = setTimeout(finish, 1000); signal.addEventListener('abort', finish, { once: true });
  });
}
// Repeated values get distinct keys by occurrence.
function textKeys(values) {
  const seen = new Map();
  return values.map(value => { const n = seen.get(value) ?? 0; seen.set(value, n + 1); return [`${value}\u0000${n}`, value]; });
}

export class AithemaSession extends HTMLElement {
  #consentRefresh;
  #concept; #rail; #voiceClient; #voiceClients; #voicePlayback; #deviceReasoning; #deviceController; #copy; #session; #sessionToken; #abort; #cursor = 0; #invalidatedAt = 0; #base; #partials = new Map(); #reasoningRevision = 0; #pending;
  #clarify = null; #clarifyRequest = null; #clarifyReplies = new Map(); #clarifyAsked = new Set(); #clarifyNoticeTimer; #clarifyNotice = false; #clarifyAnnouncement = '';
  #open = []; #cleared = []; #failure = false; #failureLane = null; #sending = false;
  #pointer = null; #onTranscript = false; #follow = true; #latestScrollTop = null; #connection = ''; #notice = ''; #journal; #orphan; #pings; #pausePrompt = false; #composerResuming = false;
  #postCallMatrix = null;
  #voiceResumeProjection = null;
  #voiceResumeRevision = 0;
  #voiceTranscript = { pending: null };
  #reconcilingPoll = null; #reconcilingLongTimer = null; #reconcilingLong = false;
  #deferredAnalysis = null; #analysisRecovery = null; #laneStatusPending = null;
  #creditEnding = false; #creditEndTimer = null; #creditAnnounced = false; #creditWasUsedUp = false;
  #dialog; #connector; #createDevice; #deviceEndpoint; #chooser = { choice: null, busy: false, error: '' }; #aiNotice; #host; #creditLayoutScope; #options; #refocus = null;
  #introOrb = null; #reveal = null; #fold; #phoneViewport; #timer; #popups; #motion = true; #motionMedia; #motionListener;
  #orb = null; #started = false; #inputMode = null; #microphone = 'unknown'; #permission = null;
  #localeChanging = Promise.resolve(); #copyLocale;
  #paneObserver; #scrollTimers = new Map();
  #savedTimer; #saved = false; #savedAnnouncement = false; #savedAnnouncedAt = -Infinity; #sendFailed = false;
  #questionCard; #disposeVersion; #footerMedia; #footerListener; #brandObserver;
  #uploadAt = new Map(); #uploading = false; #uploadNotice = ''; #reading = ''; #limits = UPLOAD_LIMITS; #limitsLoad = null; #dragDepth = 0;
  #uploadController; #uploadRetryTimer = null; #retryFiles = [];
  constructor() {
    super(); this.attachShadow({ mode: 'open' });
    // Track the resting pointer so updates can keep the element under it in place.
    this.addEventListener('pointermove', e => { this.#pointer = { x: e.clientX, y: e.clientY }; }, { passive: true });
    this.addEventListener('pointerleave', () => {
      this.#pointer = null;
      for (const pane of this.shadowRoot.querySelectorAll(PANES)) clearSlack(pane);
    });
  }
  /**
   * `deviceConnector` is the browser device plugin factory for the settings Advanced tab;
   * `voiceClients` maps host voice option ids to browser clients (else `voiceClient`).
   * `voicePresentation` supplies the selected adapter label and localized presentation.
   * `concepts.previewURL` is the canonical same-host HTML preview route admitted by the host CSP.
   * `aiNotice` ({text?, voice?}) rewords the AI notice ahead of `copy.aiNotice`; it cannot remove it.
   * `copyForLocale(locale)` supplies host copy for in-place locale changes before interaction.
   * `paimosImportUrl` and `paimosImportVersion: 1` enable creating a Paimos project via form POST.
   * `host` ({library, verification, handover, credits, locale, operator}) turns on the host surface (AIT-104 B2):
   * the conversation library, email verification, handover and credits; see the README.
   */
  configure(options) {
    const { copy, baseUrl = '', session, sessionToken, deviceReasoning, deviceConnector, deviceEndpoint, voiceClient, voiceClients, voicePlayback, aiNotice } = options ?? {};
    if (!copy || !session) throw new TypeError('Host copy and session required');
    this.#cancelUploads();
    clearTimeout(this.#clarifyNoticeTimer); this.#clarify = null; this.#clarifyRequest = null; this.#clarifyReplies.clear(); this.#clarifyAsked.clear(); this.#clarifyNotice = false; this.#clarifyAnnouncement = '';
    this.#copyLocale = session.locale; this.#aiNotice = aiNotice; this.#options = { ...options }; delete this.#options.session;
    this.#stopReconciling(); this.#reconcilingLong = false; this.#deferredAnalysis = null; this.#analysisRecovery = null;
    this.#postCallMatrix = null; this.#laneStatusPending = null;
    clearTimeout(this.#creditEndTimer); this.#creditEnding = false; this.#creditAnnounced = false; this.#creditWasUsedUp = false;
    this.#disposeVersion?.(); this.#disposeVersion = null;
    this.#footerMedia?.removeEventListener?.('change', this.#footerListener); this.#brandObserver?.disconnect();
    // Carry only the host's layout contract across sibling switches, never a receipt.
    this.#creditLayoutScope = this.#base === baseUrl.replace(/\/$/u, '') && this.#sessionToken === sessionToken ? this.#host?.creditScope : null;
    this.#host?.destroy(); this.#host = null; this.#reveal?.destroy(); this.#timer?.destroy(); this.#phoneViewport?.destroy(); this.#popups?.destroy();
    this.#questionCard?.destroy();
    clearTimeout(this.#savedTimer); this.#saved = false; this.#savedAnnouncement = false; this.#savedAnnouncedAt = -Infinity; this.#sendFailed = false;
    this.#motionMedia?.removeEventListener?.('change', this.#motionListener);
    this.#paneObserver?.disconnect(); for (const timer of this.#scrollTimers.values()) clearTimeout(timer); this.#scrollTimers.clear();
    const reopen = this.#dialog?.element.open;
    clearTimeout(this.#consentRefresh?.timer); clearTimeout(this.#consentRefresh?.retryTimer); clearTimeout(this.#consentRefresh?.documentTimer); this.#consentRefresh = null;
    this.#concept?.destroy(); this.#rail?.destroy(); this.#rail = null; this.#orb?.destroy(); this.#orb = null; this.#introOrb?.destroy(); this.#introOrb = null;
    this.#abort?.abort(); this.#deviceController?.abort(); this.#deviceReasoning = deviceReasoning; this.#copy = copy; this.#base = baseUrl.replace(/\/$/u, '');
    // The local connection belongs to this tab, not to a conversation: it survives a new session.
    if (deviceConnector !== this.#createDevice || deviceEndpoint !== this.#deviceEndpoint) {
      this.#connector?.clear();
      this.#connector = deviceConnector ? new LocalConnector({ copy, create: deviceConnector, endpoint: deviceEndpoint,
        onChange: () => { this.#render('features'); this.#render('transcript'); this.#dialog?.sync(); } }) : null;
    }
    // clear() may render the old tree; keep its binding signal until that render finishes.
    this.#voiceClient = voiceClient; this.#voiceClients = voiceClients; this.#voicePlayback = voicePlayback;
    this.#createDevice = deviceConnector; this.#deviceEndpoint = deviceEndpoint;
    this.#session = structuredClone(session); this.#sessionToken = sessionToken; this.#cursor = session.seq; this.#partials.clear(); this.#voiceTranscript = { pending: null }; this.#reasoningRevision = 0;
    this.#syncClarify(); this.#restoreFailure(); this.#pending = null; this.#sending = false;
    this.#invalidatedAt = 0; this.#chooser = { choice: null, busy: false, error: '' }; this.#started = false; this.#inputMode = null;
    this.#open = []; this.#cleared = []; this.#follow = true; this.#onTranscript = false; this.#notice = ''; this.#connection = '';
    this.#uploadAt.clear(); this.#retryFiles = []; this.#uploading = false; this.#uploadNotice = ''; this.#reading = ''; this.#limits = UPLOAD_LIMITS; this.#limitsLoad = null; this.#dragDepth = 0;
    // A page that loads paused stays paused until the person resumes it (AIT-116 D4).
    this.#pausePrompt = Boolean(session.paused); this.#composerResuming = false; this.#voiceResumeProjection = null;
    // Every conversation keeps a journal: a choice at conversation start can switch it out of
    // On my device in place, and a device conversation never starts a call, so its journal stays empty.
    this.#journal = voiceJournal(tabStorage(), session.id);
    this.#mount();
    this.setAttribute('data-aithema-mounted', '');
    this.#syncRailFit();
    this.#pings ??= answerVoicePings(() => this.#rail?.session?.callId ?? null);
    this.#orphan = this.#endOrphanedCall();
    if (this.isConnected) { this.#connect(); this.#watchPage(true); this.#offerResume(); this.#host?.connect(); }
    if (reopen) this.shadowRoot.querySelector('.settings-open').focus();
    if (this.#refocus) { this.shadowRoot.querySelector(this.#refocus)?.focus(); this.#refocus = null; }
  }
  connectedCallback() {
    if (!this.#session) return;
    this.#disposeVersion?.();
    this.#disposeVersion = mountVersionDetails(this.shadowRoot.querySelector('#build-info'), this.#options.host?.version ?? {}, { locale: this.#session.locale });
    this.#watchBrand(); this.#footerMedia?.addEventListener?.('change', this.#footerListener); this.#footerListener?.();
    this.#pings ??= answerVoicePings(() => this.#rail?.session?.callId ?? null);
    this.#concept?.connect(); this.#connect();
    if (this.#consentRefresh) { this.#consentRefresh.retryTimer = null; void this.#refreshFeatures(); }
    this.#watchPage(true); this.#offerResume(); this.#host?.connect(); this.#placeOrb();
    this.#phoneViewport?.connect(); this.#popups?.connect(); this.#motionMedia?.addEventListener?.('change', this.#motionListener);
    this.#rail?.connect(); this.#reveal?.connect();
    this.#questionCard?.connect();
    this.#observePanes(); this.#syncReconciling();
    this.#render('composer');
  }
  disconnectedCallback() {
    clearTimeout(this.#consentRefresh?.timer); clearTimeout(this.#consentRefresh?.retryTimer); clearTimeout(this.#consentRefresh?.documentTimer);
    if (this.#consentRefresh) { this.#consentRefresh.attempt = null; this.#consentRefresh.failed = true; this.#concept?.failClosedConsent(); }
    clearTimeout(this.#clarifyNoticeTimer);
    this.#cancelUploads();
    this.#stopReconciling();
    this.#disposeVersion?.(); this.#disposeVersion = null;
    this.#footerMedia?.removeEventListener?.('change', this.#footerListener); this.#brandObserver?.disconnect();
    this.#timer?.setConnected(false); this.#reveal?.disconnect();
    this.#questionCard?.destroy();
    clearTimeout(this.#savedTimer); this.#saved = false; this.#savedAnnouncement = false;
    this.#phoneViewport?.destroy(); this.#popups?.destroy(); this.#motionMedia?.removeEventListener?.('change', this.#motionListener);
    clearTimeout(this.#creditEndTimer); this.#host?.disconnect(); this.#watchPage(false); this.#concept?.suspend(); this.#rail?.disconnect(); this.#orb?.destroy(); this.#introOrb?.destroy(); this.#abort?.abort(); this.#deviceController?.abort();
    this.#paneObserver?.disconnect(); for (const timer of this.#scrollTimers.values()) clearTimeout(timer); this.#scrollTimers.clear();
    this.#pings?.close(); this.#pings = null;
  }
  reportVoicePlaybackBlocked() { this.#rail?.reportPlaybackBlocked(); }
  get session() { return structuredClone(this.#session); }
  get openQuestionItems() { return openQuestionItems(this.#session); }
  /** Select an open point without creating a person turn. Refusals remain structured. */
  async focusQuestion(questionId) {
    if (this.#clarifyBusy()) throw Object.assign(new Error('reply-in-flight'), { reason: 'reply-in-flight', status: 409 });
    const item = this.openQuestionItems.find(item => item.id === questionId);
    const sessionId = this.#session.id, revision = inputRevision(this.#session);
    const attempt = {}; this.#clarifyRequest = attempt;
    this.#clarify = { questionId, question: item?.question, inputRevision: revision, state: 'requesting', pending: true };
    this.#render('aside');
    try {
      const response = await postJson(`${this.#base}/api/sessions/${sessionId}/focus-question`,
        { questionId, inputRevision: revision }, { sessionToken: this.#sessionToken });
      const result = await response.json();
      if (!response.ok) throw Object.assign(new Error(result.reason ?? result.error), result, { status: response.status });
      if (sessionId === this.#session.id && revision === inputRevision(this.#session)) this.receive(result.event);
      return result;
    } catch (error) {
      if (sessionId === this.#session.id && revision === inputRevision(this.#session)) await this.#clarifyRefused(error);
      throw error;
    } finally {
      if (this.#clarifyRequest === attempt) {
        this.#clarifyRequest = null;
        if (this.#clarify?.inputRevision === revision) this.#clarify.pending = false;
        this.#render('aside');
      }
    }
  }
  #clarifyBusy() {
    return Boolean(this.#clarifyRequest) || this.#clarify?.pending || ['requesting', 'selected'].includes(this.#clarify?.state) ||
      this.#session.operations?.inputRevision === inputRevision(this.#session) && this.#session.operations.running.includes('reaction');
  }
  async #clarifyRefused(error) {
    if (['stale-question', 'stale-revision'].includes(error.reason)) {
      this.#clarify = null;
      await this.#restore();
      this.#clarifyNotice = true;
      clearTimeout(this.#clarifyNoticeTimer);
      this.#clarifyNoticeTimer = setTimeout(() => { this.#clarifyNotice = false; this.#render('aside'); }, 4000);
    } else if (error.reason === 'reply-in-flight') {
      this.#clarify.state = 'requesting'; this.#clarify.waitingForReply = true;
    } else if (error.reason === 'paused' || error.reason === 'consent-required' || error.admissionReason === 'one-hour') {
      this.#clarify.state = 'refused';
      this.#clarify.reason = error.reason === 'paused' ? 'paused' : error.reason === 'consent-required' ? 'consent' : 'deadline';
    } else {
      // Other admission/transport failures use the existing availability notice.
      this.#clarify = null; this.#status(this.#copy.reasoningFailed);
    }
    this.#render('aside');
  }
  async #retryClarify() {
    if (this.#clarify?.state !== 'retry' || this.#clarify.pending) return;
    const focus = this.#clarify, sessionId = this.#session.id;
    focus.pending = true; focus.state = 'requesting';
    // Retire the failure being retried before sending, so a newer failure that
    // arrives ahead of the HTTP acknowledgement cannot be erased by that ack.
    const operations = this.#session.operations;
    if (operations) {
      operations.failures = (operations.failures ?? []).filter(f => f.lane !== 'reaction');
      operations.lastFailure = operations.failures.at(-1) ?? null;
    }
    this.#failure = Boolean(operations?.lastFailure); this.#render('aside');
    try {
      const response = await postJson(`${this.#base}/api/sessions/${sessionId}/retry`, {}, { sessionToken: this.#sessionToken });
      if (sessionId !== this.#session.id || this.#clarify !== focus) return;
      if (!response.ok) {
        const result = await response.json();
        throw Object.assign(new Error(result.reason ?? result.error), result);
      }
    } catch (error) {
      if (sessionId === this.#session.id && this.#clarify === focus) {
        if (['paused', 'consent-required'].includes(error.reason) || error.admissionReason === 'one-hour') await this.#clarifyRefused(error);
        else { focus.state = 'retry'; this.#clarifyAnnouncement = ''; }
      }
    } finally {
      if (sessionId === this.#session.id && this.#clarify === focus) { focus.pending = false; this.#render('aside'); }
    }
  }
  #syncClarify() {
    const revision = inputRevision(this.#session), chosen = this.#session.questionFocus;
    if (this.#clarify && this.#clarify.inputRevision !== revision) this.#clarify = null;
    // A completed command is history, never the pending click's identity.
    const answered = chosen && this.#session.transcript.some(t => t.role === 'assistant' && t.focusRequestId === chosen.requestId);
    if (chosen?.inputRevision === revision && this.#session.focusedQuestion && answered) {
      this.#clarifyReplies.set(chosen.requestId, this.#session.focusedQuestion);
      this.#clarifyAsked.add(this.#session.focusedQuestion);
    }
    if (chosen?.inputRevision === revision && this.#session.focusedQuestion && !answered && chosen.requestId !== this.#clarify?.requestId) {
      const question = this.#session.focusedQuestion;
      this.#clarify = { ...chosen, question, state: 'requesting', pending: Boolean(this.#clarifyRequest) };
      this.#clarifyReplies.set(chosen.requestId, question);
    }
    const focus = this.#clarify;
    if (!focus) return;
    // A refused click owns no future reply. Keep requesting only while the
    // existing reaction or spoken reply is actually in flight.
    if (focus.waitingForReply && !focus.pending &&
      !(this.#session.operations?.inputRevision === revision && this.#session.operations.running.includes('reaction')) &&
      this.#rail?.state !== 'speaking') { this.#clarify = null; return; }
    if (focus.requestId && !this.#session.understanding.openQuestions.includes(focus.question)) { this.#clarify = null; return; }
    if (this.#session.transcript.some(t => !t.erased && !t.withdrawn && t.focusRequestId === focus.requestId && focus.requestId)) {
      focus.state = 'asked'; this.#clarifyAsked.add(focus.question);
    }
    const failures = this.#session.operations?.inputRevision === revision ? this.#session.operations.failures ?? [] : [];
    if (focus.requestId && !focus.pending && focus.state !== 'asked' && failures.some(f => f.lane === 'reaction' && f.retryable !== false)) focus.state = 'retry';
    if (focus.state === 'refused' && focus.reason === 'paused' && !this.#session.paused && focus.resuming) this.#clarify = null;
    if (focus.state === 'refused' && focus.reason === 'consent' && this.#feature('text').available && focus.reviewing) this.#clarify = null;
  }
  #renderQuestions() {
    this.#syncClarify();
    const root = this.shadowRoot, copy = this.#copy.clarify, focus = this.#clarify;
    const terminal = focus?.reason === 'deadline' || this.#host?.usedUp ||
      ['ending', 'ended'].includes(this.#session.credits?.status);
    if (terminal && focus) { focus.state = 'refused'; focus.reason = 'deadline'; }
    const available = this.openQuestionItems, questions = this.#session.understanding.openQuestions;
    reconcile(root.querySelector('.questions'), questions.length ? textKeys(questions) : [[NONE, null]], value => {
      const row = node('li', value === null ? 'none-yet' : 'open-question');
      if (value !== null) {
        row.innerHTML = '<span class="question-text"></span><span class="question-state"><span class="question-status"></span><span class="question-separator" aria-hidden="true">·</span><button class="clarify-action" type="button"><span class="clarify-icon"></span><span class="clarify-label"></span></button></span>';
        row.querySelector('button').addEventListener('click', e => {
          const button = e.currentTarget;
          if (button.getAttribute('aria-disabled') === 'true') return;
          const state = row.dataset.state;
          if (state === 'retry') void this.#retryClarify();
          else if (state === 'refused' && this.#clarify?.reason === 'paused') {
            this.#clarify.resuming = true; void this.#setPaused(false).catch(() => {});
          } else if (state === 'refused' && this.#clarify?.reason === 'consent') {
            this.#clarify.reviewing = true; this.#dialog.openConsent('text', button);
          } else void this.focusQuestion(row.dataset.questionId).catch(() => {});
        });
      }
      return row;
    }, (row, question) => {
      if (question === null) { setText(row, this.#copy.noneYet); return; }
      const item = available.find(item => item.question === question);
      row.dataset.questionId = item?.id ?? '';
      row.id = `open-${item?.id ?? questions.indexOf(question)}`;
      const text = row.querySelector('.question-text'); text.id = `${row.id}-text`; setText(text, question);
      const own = focus?.question === question;
      const state = own ? focus.state : terminal ? 'none' : this.#clarifyAsked.has(question) ? 'asked' : this.#clarifyBusy() ? 'disabled' : item ? 'rest' : 'none';
      row.dataset.state = state;
      const button = row.querySelector('button'), status = row.querySelector('.question-status'), separator = row.querySelector('.question-separator');
      const reason = own && state === 'refused' ? focus.reason : null;
      const withReason = state === 'retry' || Boolean(reason);
      status.hidden = !withReason; separator.hidden = !withReason || reason === 'deadline';
      button.hidden = state === 'none' || reason === 'deadline';
      button.setAttribute('aria-describedby', text.id);
      button.setAttribute('aria-disabled', String(['requesting', 'selected', 'asked', 'disabled'].includes(state)));
      button.setAttribute('aria-busy', String(state === 'requesting'));
      if (state === 'retry') button.setAttribute('aria-label', `${copy.failed}${reasonSeparator}${copy.retry}`); else button.removeAttribute('aria-label');
      const label = { requesting: copy.asking, selected: copy.chosen, asked: copy.asked, retry: copy.retry }[state] ??
        (reason === 'paused' ? this.#copy.resume : reason === 'consent' ? copy.review : copy.action);
      setText(button.querySelector('.clarify-label'), label);
      const glyph = withReason ? '' : CLARIFY_ICONS[{ requesting: 'spin', selected: 'check', asked: 'check' }[state] ?? 'ask'];
      if (button.querySelector('.clarify-icon').innerHTML !== glyph) button.querySelector('.clarify-icon').innerHTML = glyph;
      if (withReason) {
        const signature = `${state}/${reason}/${this.#copyLocale}`;
        if (status.dataset.state !== signature) {
          status.replaceChildren(); status.insertAdjacentHTML('beforeend', CLARIFY_ICONS[reason === 'deadline' ? 'clock' : reason === 'paused' ? 'pause' : reason ?? 'warn']);
          if (state === 'retry') {
            status.append(node('span', 'sr-only', `${copy.chosen}, `));
            const why = node('span', 'question-why');
            why.append(node('span', 'question-failed-long', copy.failed));
            const short = node('span', 'question-failed-short', copy.failedShort); short.setAttribute('aria-hidden', 'true'); why.append(short); status.append(why);
          } else status.append(node('span', null, copy[reason]));
          status.dataset.state = signature;
        }
      }
    });
    const notice = root.querySelector('.question-notice');
    notice.toggleAttribute('data-on', this.#clarifyNotice); setText(notice.querySelector('span'), copy.stale);
    const signature = this.#clarifyNotice ? 'stale' : focus ? `${focus.requestId ?? focus.questionId}/${focus.state}/${focus.reason ?? ''}` : '';
    if (signature !== this.#clarifyAnnouncement) {
      this.#clarifyAnnouncement = signature;
      const say = this.#clarifyNotice ? copy.stale : focus ? copy.say[focus.reason ?? focus.state] : '';
      setText(root.querySelector('.clarify-announcement'), (say ?? '').replace('{q}', focus?.question ?? ''));
    }
  }
  /** Change an unstarted conversation in place. Calls, turns and drafts keep their identity. */
  changeLocale(locale) {
    if (!this.#session) return Promise.resolve(false);
    const sessionId = this.#session.id;
    const changing = this.#localeChanging.then(async () => {
      if (sessionId !== this.#session.id || !['en', 'de'].includes(locale) || !this.#options.copyForLocale?.(locale)) return false;
      if (locale === this.#session.locale) return true;
      if (this.#hasInput() || this.#sending || this.#uploading || this.#rail?.root.dataset.call === 'active') return false;
      try {
        const response = await postJson(`${this.#base}/api/sessions/${sessionId}/locale`, { locale }, { sessionToken: this.#sessionToken });
        if (!response.ok || sessionId !== this.#session.id) return false;
        const ack = await response.json();
        if (sessionId !== this.#session.id) return false;
        // Apply only the journal event. Its snapshot may predate a first turn or a later SSE event.
        if (ack.event) this.receive(ack.event);
        return this.#session.locale === locale;
      } catch { return false; }
    });
    this.#localeChanging = changing.catch(() => false);
    return changing;
  }
  #repaintLocale() {
    if (this.#copyLocale === this.#session.locale) return;
    const copy = this.#options.copyForLocale?.(this.#session.locale);
    if (!copy) return;
    this.#copyLocale = this.#session.locale;
    const previous = this.#copy, root = this.shadowRoot;
    this.#copy = copy; this.#options.copy = copy; this.#fold?.setCopy(copy); this.#paintMotion(); this.#paintNotice();
    for (const key of ['connecting', 'connected', 'reconnecting']) if (this.#connection === previous[key]) { this.#connection = copy[key]; break; }
    this.#notice = ''; this.#chooser.error = '';
    // The current refusal and retained count are rebuilt in the new locale by the composer.
    this.#uploadNotice = '';
    this.#anchored(() => {
      for (const n of root.querySelectorAll('[data-copy]')) setText(n, copy[n.dataset.copy]);
      const promise = root.querySelector('.promise');
      // Keep the promise's spans, like the composer and every control.
      for (const [index, n] of [...promise.querySelectorAll('span')].entries()) setText(n, copy.entrance?.promise?.[index] ?? '');
      setText(root.querySelector('.promise__lead'), copy.entrance?.lead ?? '');
      setText(root.querySelector('.send .visually-hidden'), copy.send);
      setText(root.querySelector('.settings-open span'), copy.settings.open); root.querySelector('.settings-open').title = copy.settings.open;
      root.querySelector('.scale').setAttribute('aria-label', `${copy.talk} — ${copy.build}`);
      if (this.#rail) this.#rail.copy = copy; this.#renderVoice();
      this.#dialog.setCopy(copy); this.#connector?.setCopy(copy); this.#concept.setCopy(copy); this.#host?.setCopy(copy);
      this.#mountReveal();
      this.#paint('features'); this.#paint('transcript'); this.#paint('aside'); this.#paint('composer');
    });
    this.dispatchEvent(new CustomEvent('aithema-locale', { detail: { locale: this.#session.locale }, bubbles: true, composed: true }));
  }
  // A visitor-connected local model takes precedence over a host-supplied device client.
  get #device() { return this.#connector?.client ?? this.#deviceReasoning; }
  #voiceClientFor(session = this.#session) {
    const voice = engineView(session).voice;
    return this.#voiceClients?.[voice?.id] ?? this.#voiceClient;
  }
  // Host binding, independent of the selected preset, consent, pause or transient provider verdict.
  // voiceClients contains allowed catalog option IDs; an off-only/unconfigured host supplies none.
  get #voiceBound() { return Boolean(this.#voiceClient || Object.entries(this.#voiceClients ?? {}).some(([id, client]) => id !== SETTINGS_OFF && client)); }
  /** Opens the settings dialog; `preset` preselects a preset (the chooser's Custom path). */
  openSettings(opener = this.shadowRoot.querySelector('.settings-open'), { tab = 'model', continueLabel = false, preset, anchor } = {}) {
    if (anchor) { this.#dialog.openAt(tab, anchor, opener); if (anchor === '#email') this.#host?.verification?.focusEntry(); }
    else this.#dialog.open(opener, { tab, continueLabel, preset });
  }
  #mount() {
    const root = this.shadowRoot;
    // Static trusted markup only. All host/model/user copy is assigned through textContent.
    // START's shell (app.css .shell, index.astro .v2__workspace): a top row, the conversation and,
    // once there is input, the understanding beside it. The entrance (promise, orb and processing
    // choice, then readiness) fills the conversation column until the conversation starts.
    root.innerHTML = `<style>${styles}${orbStyles}${entranceStyles}${settingsStyles}${actorRoleStyles}${hostStyles}${bandStyles}${questionCardStyles}${emailAskStyles}</style><div class="workspace" data-stage="entrance" data-understanding="absent">
      <header class="toolbar band"><div class="band-identity"><div class="band-orb"></div><div class="wordmark visually-hidden"><slot name="brand">Aithema</slot></div></div>${this.#voiceBound ? '<div class="audio-rail"></div>' : ''}<div class="header-actions">
        <div class="host-bar" role="group" data-reveal hidden><div class="conversations-wrap"><button class="conversations-toggle" type="button" aria-haspopup="menu" aria-controls="conversations-menu" aria-expanded="false"></button>
          <div class="conversations-menu" id="conversations-menu" role="menu" hidden><button class="conversations-new" type="button" role="menuitem" tabindex="-1" aria-describedby="ai-notice"></button>
            <div class="conversations-recent" role="group"></div><button class="library-open-dialog" type="button" role="menuitem" tabindex="-1" aria-haspopup="dialog"></button></div></div></div>
        <div class="host-account" data-reveal><slot name="account"></slot></div><button data-reveal class="settings-open" type="button" aria-haspopup="dialog">${icon('settings')}<span class="visually-hidden"></span></button></div>
        <div class="edge-column"><button class="motion-toggle" type="button" aria-pressed="true"><svg viewBox="0 0 28 28" aria-hidden="true"><path d="M14 3c1.1 7.6 3.4 9.9 11 11-7.6 1.1-9.9 3.4-11 11C12.9 17.4 10.6 15.1 3 14c7.6-1.1 9.9-3.4 11-11Z"/></svg></button>
          <button class="fold" type="button" aria-expanded="true" aria-controls="conversation-middle"><svg viewBox="0 0 24 24" aria-hidden="true" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"><path d="m6 11 6-5 6 5m-12 7 6-5 6 5"/></svg></button></div></header>
      <section class="conversation" id="conversation-middle" aria-labelledby="conversation-title"><header class="head"><h2 class="visually-hidden" id="conversation-title" data-copy="conversation"></h2>
</header>
        <div class="intro" hidden><div class="intro__prompt"><div class="intro__orb"></div><div class="intro__promise"><slot name="promise"><h2 class="promise"></h2><p class="promise__lead"></p></slot></div></div>
          <div class="intro__card"></div></div>
        <div class="concept-bar"><div class="concept-access"><div class="concept-rail"></div><div class="concept-preview-slot"></div><span class="concept-withdrawn" role="status" tabindex="-1"></span></div>${this.#voiceBound ? '<div class="voice-notices"></div>' : ''}</div>
        <div class="concept-thread"><div class="concept-backdrop" aria-hidden="true"><img alt="" aria-hidden="true" decoding="async"><img alt="" aria-hidden="true" decoding="async"></div><div class="concept-bottom"><span class="concept-bottom-label" role="status"></span><progress max="100" value="0" aria-hidden="true"></progress></div><div class="transcript-shell"><ol aria-live="polite"></ol><button class="transcript-latest" type="button" data-copy="transcriptLatest" style="visibility:hidden"></button></div><span class="concept-backdrop-hint" aria-hidden="true"></span></div>
        <div class="phone-dock-backdrop" aria-hidden="true"></div><div class="composer-dock">${questionCardMarkup}<div class="composer-shell"><form class="composer"><label for="message" data-copy="composer"></label><textarea id="message" maxlength="8000" rows="2"></textarea><div class="composer-paused" hidden><span></span> <button class="composer-resume" type="button"></button></div><div class="purpose-pause-copy" role="status" hidden></div>
          <div class="composer-actions"><button class="attach" type="button" aria-describedby="attach-limits ai-notice">${UPLOAD_ICONS.attach}<span class="attach__label"></span></button>
            <span class="sr-only" id="attach-limits"></span><input class="attach-input" type="file" multiple hidden tabindex="-1" accept="${UPLOAD_ACCEPT}">
            <span class="composer-feedback"><span class="sr-only" id="upload-retry-reason"></span><small class="composer-reason" role="status" id="composer-reason"></small><small class="composer-saved-sizer" aria-hidden="true">${icon('check')}<span></span></small><small class="composer-saved" aria-hidden="true">${icon('check')}<span></span></small><small class="composer-saved-announcement sr-only" role="status" aria-live="polite" aria-atomic="true"></small></span><button class="send" aria-describedby="ai-notice">${icon('arrowRight')}<span class="visually-hidden"></span></button></div></form>
          <div class="composer-out" aria-hidden="true" inert><p class="composer-out__title"><span></span></p><p class="composer-out__body"><span></span></p>
            <div class="composer-out__bar"><span class="composer-out__steps"><span class="composer-out__give" data-next="give"></span><span class="composer-out__confirm" data-next="confirm"></span><span class="composer-out__none" data-next="none"></span></span>
              <span class="composer-out__actions"><button class="composer-out__upgrade" type="button" aria-haspopup="dialog"><span data-next="give"></span><span data-next="confirm"></span></button>
                <a class="composer-out__export">${icon('download')}<span></span></a></span></div></div><button class="purpose-new" type="button" hidden></button></div>
        <div class="email-ask-dock"></div><p class="credit-announcement sr-only" role="status" aria-live="polite"></p><p class="email-ask-announcement sr-only" role="status" aria-live="polite"></p></div>
        <div class="drop-overlay" aria-hidden="true"><p><strong></strong><span></span></p></div></section>
      <aside class="understanding" aria-labelledby="understanding-title"><header class="head"><h2 id="understanding-title" data-copy="understanding"></h2><button class="concept-tab" type="button" data-copy="conceptTab"></button></header>
        <section class="readiness"><div class="scale" role="progressbar" aria-valuemin="0" aria-valuemax="100"><span class="fill"></span><span class="marker"></span></div>
          <div class="scale-labels" aria-hidden="true"><span data-copy="talk"></span><span data-copy="build"></span></div></section>
        <div class="analysis-stack"><div class="analysis-content" tabindex="0"><p class="notice" role="status"><span class="notice-text"></span><button class="overview-retry" type="button" hidden></button></p><div class="verify-lock" hidden></div><section class="summary" aria-labelledby="summary-title"><h3 id="summary-title" data-copy="summary"></h3><p class="summary-text"></p></section>
          <section class="signals-section"><h3 data-copy="signals"></h3><ul class="signals"></ul></section><section class="open-questions"><div class="questions-heading"><h3 id="open-questions-title" data-copy="questions"></h3><p class="question-notice">${icon('refresh')}<span></span></p></div><ul class="questions" aria-labelledby="open-questions-title"></ul><p class="clarify-announcement sr-only" role="status" aria-live="polite" aria-atomic="true"></p></section>
          <section><h3 data-copy="missing"></h3><ul class="missing"></ul><p class="overflow"></p></section>
          <section><div class="cleared-head"><h3 data-copy="clarified"></h3><button class="expand" type="button"></button></div><div class="cleared"></div></section>
          <div class="handover" role="region" aria-labelledby="handover-title" hidden><h3 id="handover-title"></h3><p class="handover__offer"><slot name="handover-offer"></slot></p>
            <div class="handover__row"><button class="handover-request" type="button" aria-describedby="handover-state"></button><p class="handover__state" id="handover-state" role="status"></p></div></div></div><div class="email-ask-pane"></div><button class="email-ask-fold" type="button" inert></button></div>
        <footer class="foot"><a class="export">${icon('download')}<span data-copy="export"></span></a><button class="retry" type="button" data-copy="retry" hidden></button><small class="export-reason" id="export-reason" data-copy="deviceExportUnavailable"></small></footer></aside>
      <section class="fold-view" hidden><button class="fold-strip" type="button"><span class="fold-identity"><i class="speaker-sign" aria-hidden="true"></i><span class="fold-who"></span></span><span class="fold-text"></span><span class="fold-question" hidden></span></button>
        <section class="drafts-canvas" aria-label=""><div class="canvas-empty">${icon('concept')}<span></span></div><aithema-html-preview class="canvas-html" fill hidden></aithema-html-preview><img class="canvas-image" alt="" hidden><p class="canvas-status" role="status"></p></section></section>
      <footer class="display-foot"><div class="display-foot__row">
        <div class="footer-left"><div class="footer-info" data-footer-popup><button class="ai-notice" type="button" aria-label="Aithema 2026.10" aria-describedby="ai-notice build-info"><i class="speaker-sign" aria-hidden="true"></i><span class="display-version"></span><span class="ai-notice__label"></span><span class="ai-notice__short"></span>${this.#voiceBound ? '<span class="ai-notice__voice"></span>' : ''}</button>
          <div class="footer-popup" role="tooltip"><p id="ai-notice"></p><div class="version-details"><div id="build-info"></div><p class="host-version" hidden><span class="host-version__label"></span><span class="host-version__value"></span></p></div><p class="phone-status"><span class="phone-status__label"></span></p><div class="host-foot" hidden><slot name="footer"></slot></div></div></div></div>
        <div class="host-credits" data-footer-popup hidden><button class="host-credits__button" type="button" aria-expanded="false" aria-controls="credits-popup"><span class="host-credits__stack"><span class="host-credits__text"><strong class="host-credits__amount"><span class="host-credits__value"></span></strong><span class="host-credits__total"></span><span class="host-credits__unit"></span></span>
          <span class="host-credits__low" aria-hidden="true"><span class="host-credits__low-full"></span><span class="host-credits__low-short"></span></span>
          <span class="host-credits__measure" aria-hidden="true"><strong class="host-credits__measure-amount"></strong><span class="host-credits__measure-total"></span><span class="host-credits__measure-unit"></span></span>
          <span class="host-credits__measure-low" aria-hidden="true"><span class="host-credits__measure-low-full"></span><span class="host-credits__measure-low-short"></span></span>
          <span class="host-credits__measure-cap" aria-hidden="true"></span><span class="host-credits__used-up" aria-hidden="true"><span class="host-credits__used-up-full"></span><span class="host-credits__used-up-short"></span></span></span><span class="host-credits__track" role="meter" aria-valuemin="0"><i></i></span></button>
          <div class="footer-popup credits-popup" id="credits-popup" role="group" aria-labelledby="credits-balance"><p class="host-credits__scope" id="credits-balance"></p>
            <p class="host-credits__current"><span class="credits-check" aria-hidden="true">${ICONS.check}</span><span></span></p>
            <p class="host-credits__next"></p><a class="credits-email" href="#email"></a>
            <p class="host-credits__daily-cap" hidden></p><span class="host-credits__deadline" hidden></span><span class="host-credits__limit" hidden><slot name="credits-limit"></slot><span class="host-credits__demo"></span></span><p class="host-credits__equivalence"></p></div></div>
        <div class="footer-right"><section class="preset-panel"><div class="engine" data-footer-popup><button class="engine-info" type="button" aria-describedby="model-info"><span class="engine__value"></span><span class="engine__flag"></span></button><span class="engine__detail footer-popup" id="model-info" role="tooltip"></span></div><ul class="features"></ul></section>
          <span class="status" role="status" aria-live="off"><span class="status__group"><span class="status__dot" role="img"></span><span class="status__label" aria-hidden="true"></span><span class="status__placeholder" aria-hidden="true" hidden></span></span><span class="status__live visually-hidden" role="status" aria-live="polite" aria-atomic="true"></span><span class="status__sizer" aria-hidden="true"></span><time class="connection-timer">0:00</time></span><div class="host-legal" hidden><slot name="legal"></slot></div></div></div></footer></div>
      <dialog class="settings"></dialog><dialog class="library"></dialog><dialog class="verify-dialog"></dialog>`;
    this.#questionCard = new QuestionCard({ root, send: text => { void this.#send(text); },
      followsTranscript: () => this.#follow && !this.#onTranscript,
      onResize: ({ following }) => { if (following && !this.#onTranscript) this.#scrollToLatest(); } });
    // The promise is host content when the host slots it; otherwise START's three lines (contract: AIT-128/129).
    const promise = root.querySelector('.promise');
    for (const [index, line] of (this.#copy.entrance?.promise ?? []).entries()) { if (index) promise.append(' '); promise.append(node('span', '', line)); }
    root.querySelector('.promise__lead').textContent = this.#copy.entrance?.lead ?? '';
    root.querySelector('.send .visually-hidden').textContent = this.#copy.send;
    root.querySelector('.settings-open span').textContent = this.#copy.settings.open; root.querySelector('.settings-open').title = this.#copy.settings.open;
    root.querySelector('.settings-open').addEventListener('click', event => {
      if (!this.#host?.openRoleSettings(event.currentTarget)) this.openSettings(event.currentTarget);
    });
    this.#timer = new ConnectionTimer(root.querySelector('.connection-timer'));
    this.#footerMedia = this.ownerDocument.defaultView?.matchMedia?.('(width < 600px)');
    this.#footerListener = () => (this.#footerMedia?.matches ? root.querySelector('.phone-status') : root.querySelector('.status')).append(this.#timer.element);
    this.#footerMedia?.addEventListener?.('change', this.#footerListener); this.#footerListener();
    const legal = root.querySelector('slot[name="legal"]');
    const syncLegal = () => { legal.parentElement.hidden = !legal.assignedElements().length; };
    legal.addEventListener('slotchange', syncLegal); syncLegal();
    root.querySelector('slot[name="brand"]').addEventListener('slotchange', () => this.#watchBrand());
    this.#watchBrand();
    this.#fold = new ConversationFold({ root, copy: this.#copy, canFold: () => this.#concept?.canShowCanvas() ?? false, onChange: folded => {
      if (folded) void this.#concept?.paintCanvas();
      else this.#concept?.suspendCanvas();
      this.#syncBandScroll(); this.#syncPanes();
    } });
    root.querySelector('.drafts-canvas').setAttribute('aria-label', this.#copy.layout.canvas);
    this.#mountMotion();
    const version = { ...this.#options.host?.version, product: 'Aithema 2026.10' };
    setText(root.querySelector('.display-version'), version.product);
    this.#disposeVersion = mountVersionDetails(root.querySelector('#build-info'), version, { locale: this.#session.locale });
    this.#placeOrb();
    this.#dialog = new SettingsDialog({ dialog: root.querySelector('dialog.settings'), copy: this.#copy, operator: this.#options.host?.operator, ports: {
      // Withdrawn turns still mark a started conversation (the server's device lock agrees).
      state: () => ({ session: this.#session, voiceActive: Boolean(this.#rail?.session), hasTurns: this.#session.transcript.length > 0 || this.#partials.size > 0,
        running: this.#session.operations?.inputRevision === inputRevision(this.#session) && (this.#session.operations?.running?.length ?? 0) > 0,
        consent: this.#consentState() }),
      consentPresentation: this.#options.consentPresentation ?? this.#options.voicePresentation,
      consentDocument: async () => {
        const response = await fetch(`${this.#base}/api/sessions/${this.#session.id}/consent`, { headers: this.#headers() });
        if (!response.ok) throw new Error('Consent document unavailable');
        return response.json();
      },
      saveConsent: body => this.#saveConsent(body),
      generalShown: () => this.#host?.verification?.email.beginSettings?.(),
      closed: () => this.#host?.verification?.email.endSettings?.(),
      catalog: () => this.#loadCatalog(), save: body => this.#saveSettings(body),
      endCall: () => this.#rail?.close(), connector: this.#connector,
      newConversation: detail => this.#newConversation(detail), consent: (reason, features) => this.#requestConsent(reason, features),
      // The re-rendered twin of a replaced opener, else the settings button, which is never replaced.
      focusFallback: opener => [...root.querySelectorAll('[data-focus-key]')].find(node => opener?.dataset?.focusKey && node.dataset.focusKey === opener.dataset.focusKey &&
        !node.closest('[hidden]')) ?? root.querySelector('.settings-open'),
    } });
    this.#concept = new ConceptView({ root, previewURL: this.#options.concepts?.previewURL, copy: this.#copy, baseUrl: this.#base, sessionToken: this.#sessionToken,
      // The host's visual kind decides which feature verdict gates requests: images or clickable drafts.
      consent: (opener, kind) => this.#dialog.openConsent((kind ?? this.#session.conceptVisualKind) === 'html' ? 'html' : 'images', opener),
      retry: () => this.#refreshFeatures(),
      settings: opener => this.#dialog.openAt('model', this.#session.processingPreset === 'device'
        ? '.presets' : '[data-select="visuals"]', opener),
      receive: event => this.receive(event), feature: options => this.#feature(this.#session.conceptVisualKind === 'html' ? 'html' : 'images', true, options) });
    this.#concept.update(this.#session);
    this.#render('features');
    for (const node of root.querySelectorAll('[data-copy]')) node.textContent = this.#copy[node.dataset.copy];
    root.querySelector('.transcript-latest').addEventListener('click', () => this.#scrollToLatest());
    root.querySelector('textarea').setAttribute('aria-describedby', 'composer-reason ai-notice');
    root.querySelector('.scale').setAttribute('aria-label', `${this.#copy.talk} — ${this.#copy.build}`);
    if (paimosImportUrl(this.#options)) {
      const create = node('button', 'create-project'); create.type = 'button';
      create.innerHTML = `${icon('plus')}<span data-copy="createProject"></span>`;
      create.querySelector('span').textContent = this.#copy.createProject;
      create.addEventListener('click', () => this.#createProject());
      root.querySelector('.understanding > .foot').append(create);
    }
    this.#renderMode();
    root.querySelector('.export').addEventListener('click', e => {
      if (!this.#sessionToken || this.#session.processingPreset === 'device') return;
      e.preventDefault(); void this.#export();
    });
    root.querySelector('.composer-out__upgrade').addEventListener('click', event => this.openSettings(event.currentTarget, { tab: 'general', anchor: '#email' }));
    root.querySelector('.composer-out__export').addEventListener('click', event => { event.preventDefault(); if (this.#session.processingPreset !== 'device') void this.#export(); });
    root.querySelector('.purpose-new').addEventListener('click', () => this.#newConversation({ processingPreset: this.#session.processingPreset, settings: this.#session.settings }));
    root.querySelector('form').addEventListener('submit', e => { e.preventDefault(); if (this.#composerPaused) void this.#resumeComposer(); else void this.#send(); });
    root.querySelector('.composer-resume').addEventListener('click', () => { void this.#resumeComposer(); });
    root.querySelector('textarea').addEventListener('keydown', e => {
      const mac = /Mac|iPhone|iPad/u.test(globalThis.navigator?.platform ?? '');
      if (e.key === 'Enter' && (mac ? e.metaKey && !e.ctrlKey : e.ctrlKey && !e.metaKey) && !e.altKey && !e.shiftKey && !e.isComposing) { e.preventDefault(); void this.#send(); }
    });
    root.querySelector('textarea').addEventListener('input', () => { if (this.#uploadNotice && !this.#retryFiles.length) { this.#uploadNotice = ''; this.#render('composer'); } });
    this.#mountUploads();
    root.querySelector('.expand').addEventListener('click', () => {
      const details = [...root.querySelectorAll('.cleared details')];
      const expand = !details.every(d => d.open);
      details.forEach(d => { d.open = expand; }); this.#expandLabel();
    });
    root.querySelector('.overview-retry').addEventListener('click', () => root.querySelector('.retry').click());
    root.querySelector('.retry').addEventListener('click', async () => {
      if (!this.#feature('analysis').available) return;
      try {
        const response = await postJson(`${this.#base}/api/sessions/${this.#session.id}/retry`, {}, { sessionToken: this.#sessionToken });
        if (!response.ok) throw new Error(); this.#failure = false; this.#render('aside');
      } catch { this.#status(this.#copy.reasoningFailed); }
    });
    if (this.#voiceBound) {
      this.#rail = new AudioRail({ root: root.querySelector('.audio-rail'), copy: this.#copy, client: this.#voiceClientFor(),
        noticesRoot: root.querySelector('.voice-notices'),
        waitingCall: this.#session.voiceLifecycle,
        replyVisible: (text, turnId) => Boolean(text && this.#session.transcript.some(t => (!turnId || t.id === turnId) && t.role === 'assistant' && !t.erased && !t.withdrawn && t.content === text &&
          [...root.querySelectorAll('.turn:not(.user):not(.partial)')].some(row => row.dataset.id === t.id && row.querySelector('.turn-text')?.textContent === text))),
        replyTarget: (text, turnId) => {
          const turn = this.#session.transcript.findLast(t => t.role === 'assistant' && !t.erased && !t.withdrawn && t.content);
          if (!turn || turn.id !== turnId || turn.content !== text) return null;
          return [...root.querySelectorAll('.turn:not(.user):not(.partial)')].find(row => row.dataset.id === turn.id && row.querySelector('.turn-text')?.textContent === text);
        },
        replies: () => {
          const turns = new Map(this.#session.transcript.filter(t => t.role === 'assistant' && !t.erased && !t.withdrawn && t.content).map(t => [t.id, t]));
          return [...root.querySelectorAll('.turn:not(.user):not(.partial)')].flatMap(target => {
            const turn = turns.get(target.dataset.id);
            return turn && target.querySelector('.turn-text')?.textContent === turn.content ? [{ target, turnId: turn.id, text: turn.content }] : [];
          });
        },
        lastReply: () => {
          if (this.#session.paused || this.#session.tombstone || this.#session.consentWithdrawn) return null;
          const turn = this.#session.transcript.findLast(t => t.role === 'assistant' && !t.erased && !t.withdrawn && t.content);
          return turn && { turnId: turn.id, text: turn.content };
        },
        consent: opener => this.#dialog.openConsent('voice', opener),
        feature: () => this.#feature('voice', true), usedUp: () => this.#host?.usedUp ?? false, endReason: () => this.#host?.endReason, creditReason: () => this.#host?.creditStatusReason, nextTier: () => this.#host?.nextTier ?? null, lowCredit: () => this.#host?.low ?? false, ending: () => this.#creditEnding, playback: this.#voicePlayback, journal: this.#journal ?? undefined,
        ready: () => this.#orphan, onLevel: level => this.#orb?.setEnergy(level),
        onRender: rail => {
          // Preserve held space from takeover through startup. The internal
          // connecting state can still paint as paused in the public rail.
          const resuming = rail.takeoverController || rail.state === 'connecting' && rail.waitingCall;
          if (resuming && !root.querySelector('.composer-reason').hasAttribute('data-shortcut')) {
            root.querySelector('.composer-feedback').setAttribute('data-voice-space', '');
          }
          this.#syncVoicePause(rail); this.#syncRailFit();
        },
        onPartial: event => {
          if (this.#session.paused || this.#session.consentWithdrawn || this.#session.tombstone) return;
          this.#updateVoiceTranscript(event);
          this.#render('transcript');
        },
        onFinal: event => {
          this.#updateVoiceTranscript(event);
          // A provider echo can refer to an already saved typed turn under another id.
          const saved = event.role === 'user' && this.#session.transcript.find(t => t.id === event.turnId ||
            t.role === 'user' && t.voiceCallId === event.callId && !t.erased && !t.withdrawn &&
            t.content.trim().replace(/\s+/gu, ' ') === event.text.trim().replace(/\s+/gu, ' '));
          if (saved) this.#updateVoiceTranscript({ type: 'turn.final', data: { ...saved,
            callId: event.callId, providerSessionId: event.providerSessionId, userTurnOrdinal: event.userTurnOrdinal }, providerTurnId: event.turnId });
          this.#render('transcript');
        },
        // A call that starts, ends or fails moves the stage and the avatar with it.
        onState: state => {
          if (this.#clarify?.waitingForReply) this.#render('aside');
          if (state === 'speaking') this.#updateVoiceTranscript({ type: 'speaking' });
          if (['paused', 'recovering', 'waiting', 'closing', 'idle', 'failed'].includes(state)) this.#updateVoiceTranscript({ type: 'reset' });
          // A call the visitor started keeps the conversation open after it ends. Only a running call counts:
          // an invalidation closes the rail without one, and its brief closing state starts nothing.
          if (this.#rail?.session) this.#started = true;
          this.#orb?.setVoice(state); this.#clearNotice(); this.#render('transcript'); this.#render('composer');
          this.#host?.update();
        },
        context: () => ({ understanding: this.#session.understanding, focusedQuestion: this.#session.understanding.openQuestions.includes(this.#session.focusedQuestion) ? this.#session.focusedQuestion : null }),
        onEnd: () => {
          this.#voiceResumeProjection = null;
          this.#updateVoiceTranscript({ type: 'reset' }); this.#render('transcript');
          // The in-call verdict cannot describe post-call admission. Keep it closed
          // with waiting copy until a generation-fenced server snapshot replaces it.
          if (this.#rail?.endedCall) this.#postCallMatrix = this.#session.featureMatrix;
          this.#render('composer'); this.#render('features'); this.#render('aside');
          if (this.#pending) { delete this.#pending.voiceCallId; delete this.#pending.providerSessionId; }
          // Journal invalidation refreshes after applying its event; do not read its older snapshot here.
          if (this.isConnected && !this.#rail?.unloading && this.#invalidatedAt <= this.#cursor) void this.#refreshFeatures();
        },
        onPause: (paused, { resuming = false } = {}) => {
          if (paused) this.#voiceResumeProjection = null;
          else if (resuming) {
            this.#voiceResumeRevision++;
            this.#voiceResumeProjection = { generation: this.#rail.generation, revision: this.#rail.pauseRevision };
            // The acknowledged Resume lifts only cached pause wrappers. Keep
            // every underlying budget/consent refusal from the server verdict.
            const matrix = this.#session.featureMatrix?.[this.#session.processingPreset ?? 'best'];
            for (const [feature, verdict] of Object.entries(matrix ?? {})) {
              if (verdict.reason === 'session paused' && verdict.unpaused) matrix[feature] = verdict.unpaused;
            }
          }
          if (paused) { this.#updateVoiceTranscript({ type: 'reset' }); this.#render('transcript'); }
          this.#session.paused = paused; this.#clearNotice();
          this.#render('features'); this.#render('composer'); this.#render('aside');
          this.#host?.update();
          if (this.isConnected) void this.#refreshFeatures();
        } });
      // Screen readers hear the AI notice with every control that begins an interaction (Art. 50(1)),
      // after the control's own description: here Start and Retry call, the composer above, and the
      // chooser and ready card where they are built.
      for (const name of ['start', 'retry']) root.querySelector(`.voice-${name}`).setAttribute('aria-describedby', 'ai-notice');
      // One pause for the conversation and its call, in the rail's pause cell (START's single capsule):
      // it drives the call when one runs and the acknowledged conversation pause otherwise.
      const pause = node('button', 'pause'); pause.type = 'button';
      pause.innerHTML = `<span class="voice-icon">${icon('pause')}</span><span class="voice-icon voice-icon--resume">${icon('play')}</span><span class="voice-label"></span>`;
      pause.dataset.reveal = ''; root.querySelector('.voice-cell--pause').prepend(pause); root.querySelector('.audio-rail').tabIndex = -1;
      root.querySelector('.pause').addEventListener('click', async () => {
        if (this.#host?.usedUp) return;
        const button = root.querySelector('.pause');
        if (this.#rail.moved || this.#rail.waitingCall) { await this.#rail.start(); return; }
        if (this.#rail.session) { await this.#rail.pause(!this.#rail.pauseIntent); return; }
        button.disabled = true;
        try { await this.#setPaused(!this.#session.paused); }
        finally { button.disabled = false; }
      });
    }
    // Updates render at once (AIT-116 D2). Fixed outer sizes and internal scrolling keep
    // composer/export targets stable; #anchored keeps the element under the pointer in place.
    const shell = root.querySelector('.transcript-shell');
    shell.addEventListener('scroll', () => {
      this.#follow = shell.scrollTop + shell.clientHeight >= shell.scrollHeight - 8 || this.#latestScrollTop !== null && Math.abs(shell.scrollTop - this.#latestScrollTop) <= 1;
      this.#questionCard.scheduleReserve();
      if (this.#follow) root.querySelector('.transcript-latest').style.visibility = 'hidden';
    }, { passive: true });
    shell.addEventListener('pointerenter', () => { this.#onTranscript = true; });
    shell.addEventListener('pointerleave', () => {
      this.#onTranscript = false;
      this.#questionCard.reserve();
      if (this.#follow) this.#scrollToLatest();
    });
    for (const pane of root.querySelectorAll(PANES)) pane.addEventListener('pointerleave', () => clearSlack(pane));
    if (this.#options.host) this.#host = new HostSurface({ root, initialCreditScope: this.#creditLayoutScope, copy: this.#copy, options: this.#options.host, baseUrl: this.#base, sessionToken: this.#sessionToken,
      openSettings: (opener, options) => options?.processing ? this.openSettings(opener) : this.openSettings(root.querySelector('.host-credits__button'), { tab: 'general', anchor: '#email' }), onCredits: info => this.#creditsChanged(info), creditEnding: () => this.#creditEnding, creditContext: () => this.#rail?.endedCall,
      admissionDenied: () => Boolean(this.#rail?.allowanceDenied || !this.#hasLiveCall() &&
        ['budget denied', 'budget reconciling'].includes(this.#feature('text').reason)),
      streaming: () => this.#sending || this.#partials.size > 0 || activeTurns(this.#session).at(-1)?.role === 'user',
      replyInFlight: () => this.#sending || this.#partials.size > 0 || this.#session.operations?.running.includes('reaction'),
      session: () => this.#session, status: text => this.#status(text), adopt: (session, reason) => this.#adopt(session, reason),
      beforeVerifyDialog: () => this.#dialog.closeForVerification(), verificationOpener: () => root.querySelector('.settings-open'),
      onLock: info => { this.#render('aside'); this.#render('transcript'); if (info?.saved) this.#dialog?.acknowledgeSave(); else this.#dialog?.sync(); },
      // Focus follows the visible stage control: Continue at the entrance, Start at readiness; live,
      // unlocking keeps a deliberate pause (Resume is offered), else the composer takes focus.
      focusAfterUnlock: () => {
        const stage = this.#stage(), input = root.querySelector('textarea');
        (stage === 'entrance' ? root.querySelector('.chooser__continue') : stage === 'ready' ? root.querySelector('.ready__start')
          : this.#composerUsedUp ? root.querySelector('.composer-out__export')
          : this.#session.paused || input.disabled ? root.querySelector('.pause, .composer-resume') : input)?.focus();
      } });
    this.#phoneViewport = new PhoneComposerViewport(root, { onCompactChange: () => this.#render('composer'), followsTranscript: () => this.#follow, onNoticesChange: () => {
      // Growth preserves the upload target; shrink reservations release on row exit or scrolling.
      if (this.#follow && !this.#hovered()?.closest('.upload') && !this.#fold.folded) this.#scrollToLatest();
    } });
    this.#popups = new FooterPopups(root);
    this.#render('transcript'); this.#render('aside'); this.#render('composer');
    this.#observePanes();
    if (this.#rail) this.#rail.motion = this.#motion;
    this.#mountReveal(version);
    // Recompute with the assigned rail, visible command and host credit surface.
    this.#renderVoice();
  }
  #mountReveal(version = { ...this.#options.host?.version, product: 'Aithema 2026.10' }) {
    const root = this.shadowRoot;
    this.#reveal?.destroy();
    this.#reveal = createReveal({ band: root.querySelector('.band'), orb: this.#orb,
      controls: [...root.querySelectorAll('.band [data-reveal]')],
      links: this.#copy.reveal.links,
      version, copy: this.#copy, motion: this.#motion });
  }
  // A conversation from the library (open, new, reset, or the replacement of a deleted one). The host
  // usually handles it (its voice clients belong to one conversation); otherwise this element switches.
  #adopt(session, reason) {
    const event = new CustomEvent('aithema-open-conversation', { detail: { session: structuredClone(session), reason, previousSessionId: this.#session.id },
      bubbles: true, composed: true, cancelable: true });
    this.#refocus = '.conversations-toggle';
    if (this.dispatchEvent(event)) this.configure({ ...this.#options, session });
  }
  async #setPaused(paused) {
    if (this.#session.pauseReason === 'purpose') return;
    const sessionId = this.#session.id;
    try {
      const response = await postJson(`${this.#base}/api/sessions/${sessionId}/pause`, { paused }, { sessionToken: this.#sessionToken });
      if (!response.ok) throw new Error();
      const ack = await response.json();
      if (sessionId === this.#session.id) this.receive(ack.event);
    } catch { if (sessionId === this.#session.id) this.#status(this.#copy.controlFailed); }
  }
  // A reload cannot drive the call the previous page started. End it through the
  // owner-authenticated close route only when it is provably abandoned; otherwise (another
  // live tab answers, or there is no BroadcastChannel) the server lease ends it. A pause
  // is never lifted here: the person resumes with one click on the focused Resume.
  async #endOrphanedCall() {
    const record = this.#journal?.read(), sessionId = this.#session.id;
    if (!record) return;
    // A copied journal cannot authorize another document as the controlling tab.
    // Epoch-bound calls use server takeover/leases; channel pongs are advisory.
    if (record.tabId) { this.#journal.clear(); return; }
    if (this.#session.voiceLifecycle?.state === 'waiting' && this.#session.voiceLifecycle.callId === record.callId) return;
    try {
      const abandoned = await voiceCallAbandoned(record.callId);
      if (sessionId !== this.#session.id) return;
      if (!abandoned) { this.#journal.clear(); return; }
      const response = await closeVoiceCall({ baseUrl: this.#base, sessionId, sessionToken: this.#sessionToken, record, reason: 'page-reloaded' });
      if ((response.ok || response.status === 404) && sessionId === this.#session.id) this.#journal.clear();
    } catch { /* The server lease still ends the call; Start reports a conflict precisely. */ }
  }
  // Terminal allowance wins over pause, including a paused server verdict's
  // unpaused budget denial. Resuming cannot reveal a different composer panel.
  get #composerUsedUp() {
    return !this.#creditEnding && this.#session.pauseReason !== 'purpose' &&
      (Boolean(this.#host?.usedUp) || !this.#hasLiveCall() && this.#feature('text', true, { ignorePause: true }).rawReason === 'budget denied');
  }
  get #composerPaused() { return !this.#voiceBound && this.#session.paused && this.#session.pauseReason !== 'purpose' && !this.#composerUsedUp; }
  async #resumeComposer() {
    if (!this.#composerPaused || this.#composerResuming) return;
    const sessionId = this.#session.id;
    this.#composerResuming = true; this.#render('composer');
    try {
      await this.#setPaused(false);
      if (sessionId === this.#session.id && !this.#session.paused) {
        // Restored snapshots may still carry a paused feature verdict. Wait for
        // the existing server refresh before placing focus in the unlocked field.
        if (this.isConnected && this.shadowRoot.querySelector('textarea').disabled) await this.#refreshFeatures();
        if (sessionId === this.#session.id && !this.#session.paused) this.shadowRoot.querySelector('textarea').focus();
      }
    } finally {
      if (sessionId === this.#session.id) { this.#composerResuming = false; this.#render('composer'); }
    }
  }
  #offerResume() {
    if (this.#pausePrompt && this.#session.paused && !this.#composerUsedUp) this.shadowRoot.querySelector('.pause, .composer-resume')?.focus();
  }
  #pagehide = () => {
    const record = this.#journal?.read(), rail = this.#rail;
    if (!rail || !rail.session && !rail.waitingCall && rail.state !== 'connecting') return;
    rail.unloading = true;
    // Unloading may enter the back/forward cache. Local media and pending Resume
    // must end immediately, even without storage or a working keepalive POST.
    void rail.close('page-hidden');
    if (!record) return;
    void closeVoiceCall({ baseUrl: this.#base, sessionId: this.#session.id, sessionToken: this.#sessionToken, record, reason: 'page-hidden' }).catch(() => {});
  };
  #pageshow = () => { if (this.#rail) this.#rail.unloading = false; this.#syncBandScroll(); };
  #syncBandScroll = () => {
    const band = this.shadowRoot.querySelector('.band'), workspace = this.shadowRoot.querySelector('.workspace');
    if (!band || !workspace) return;
    // The document can scroll before sticky engages; also cover an embedding scroll container.
    const scrolled = (this.ownerDocument.defaultView?.scrollY ?? 0) > 0 || band.getBoundingClientRect().top > workspace.getBoundingClientRect().top;
    band.toggleAttribute('data-scrolled', scrolled);
    const shell = this.shadowRoot.querySelector('.transcript-shell');
    if (!shell?.getClientRects().length || workspace.hasAttribute('data-folded')) {
      shell?.style.removeProperty('--transcript-top-inset');
      return;
    }
    // Page/embedding scroll can carry the bounded pane behind the sticky band.
    // Give up only the occluded part of its grid cell; the composer stays put.
    const inset = parseFloat(shell.style.getPropertyValue('--transcript-top-inset')) || 0;
    const bounds = shell.getBoundingClientRect();
    const next = Math.max(0, Math.min(bounds.height + inset, band.getBoundingClientRect().bottom - bounds.top + inset));
    if (next !== inset) shell.style.setProperty('--transcript-top-inset', `${next}px`);
  };
  #watchPage(on) {
    const view = this.ownerDocument.defaultView, listen = on ? 'addEventListener' : 'removeEventListener';
    view?.[listen]('pagehide', this.#pagehide); view?.[listen]('pageshow', this.#pageshow);
    view?.[listen]('scroll', this.#syncBandScroll, { passive: true, capture: true });
    view?.[listen]('resize', this.#syncBandScroll);
    if (on) this.#syncBandScroll();
  }
  // The status line shows the latest action until the connection, pause or call state changes.
  #status(value) { this.#notice = value; this.#paintStatus(); }
  #confirmSaved() {
    clearTimeout(this.#savedTimer); this.#saved = true;
    // Successful sent turns only: keep repeated saves quiet for ten seconds.
    const now = Date.now();
    this.#savedAnnouncement = now - this.#savedAnnouncedAt >= 10_000;
    if (this.#savedAnnouncement) this.#savedAnnouncedAt = now;
    this.#notice = ''; this.#paintStatus(); this.#render('composer');
    this.#savedTimer = setTimeout(() => { this.#saved = false; this.#savedAnnouncement = false; this.#render('composer'); }, 1600);
  }
  #connectionStatus(value) { this.#connection = value; this.#notice = ''; this.#paintStatus(); }
  #clearNotice() { this.#notice = ''; this.#paintStatus(); }
  #paintStatus() {
    const root = this.shadowRoot, status = root.querySelector('.status'), connected = this.#connection === this.#copy.connected;
    const words = this.#rail?.moved ? this.#copy.voiceInAnotherTab : this.#notice || this.#connection || this.#copy.connecting;
    // Reserve every short label in this font/language, including before voice
    // binds, so its slightly wider tablet label cannot move the flag or dot.
    const states = ['connecting', 'connected', 'reconnecting', 'paused', 'voiceInAnotherTab'];
    const labels = this.#copy.connectionLabels;
    const key = states.find(key => this.#copy[key] === words);
    reconcile(status.querySelector('.status__sizer'), states.map(key => [key, labels[key]]),
      words => node('span', '', words), (span, words) => setText(span, words));
    // Keep the same live message node, anchored to the dock while it is a toast.
    // Keep the short label's own box as well as the footer's steady-width sizer.
    const label = root.querySelector('.status__label'), message = !this.#rail?.moved && Boolean(this.#notice);
    const toast = message && root.querySelector('.workspace').dataset.stage === 'live';
    const placeholder = status.querySelector('.status__placeholder');
    const connectionKey = states.find(key => this.#copy[key] === this.#connection) || 'connecting';
    setText(placeholder, labels[connectionKey]); placeholder.hidden = !message;
    const parent = toast ? root.querySelector('.composer-dock') : status.querySelector('.status__group');
    if (label.parentNode !== parent) parent.append(label);
    if (toast) label.setAttribute('role', 'status'); else label.removeAttribute('role');
    label.setAttribute('aria-hidden', String(!toast));
    setText(label, key && !message ? labels[key] : words); status.title = words;
    // One stable polite node changes only when the full message changes.
    setText(status.querySelector('.status__live'), toast ? this.#connection || this.#copy.connecting : words);
    const dot = status.querySelector('.status__dot');
    dot.setAttribute('aria-label', key && !message ? words : this.#connection || this.#copy.connecting);
    dot.dataset.state = connected ? 'connected' : 'connecting';
    setText(root.querySelector('.phone-status__label'), this.#connection || this.#copy.connecting);
    status.toggleAttribute('data-connected', connected);
    status.toggleAttribute('data-message', !this.#rail?.moved && Boolean(this.#notice));
    root.querySelector('.connection-timer').setAttribute('aria-hidden', 'true');
    // Late host replies can repaint after removal; they must not restart a clock.
    this.#timer?.setConnected(this.isConnected && connected);
  }
  #scrollToLatest() {
    if (this.#fold?.folded) return;
    const shell = this.shadowRoot.querySelector('.transcript-shell');
    // Measure the visible card before finding the latest reply.
    this.#follow = true; this.#questionCard?.reserve();
    shell.scrollTop = shell.scrollHeight;
    const latest = shell.querySelector('.turn:last-child');
    for (const row of shell.querySelectorAll('[data-start-only]')) row.removeAttribute('data-start-only');
    const readFull = latest?.querySelector('.turn-read-full'), signal = this.shadowRoot.querySelector('.voice-signal');
    let mini = signal?.querySelector('.voice-read-full-mini');
    if (readFull) readFull.hidden = true;
    if (mini) mini.hidden = true;
    signal?.removeAttribute('data-read-full');
    if (latest && !this.shadowRoot.querySelector('.qcard').hidden) {
      const top = shell.getBoundingClientRect().top + parseFloat(this.ownerDocument.defaultView.getComputedStyle(shell).paddingTop);
      const room = shell.getBoundingClientRect().bottom - top;
      if (latest.getBoundingClientRect().height > room) {
        latest.toggleAttribute('data-start-only', room < 88);
        const openFullReply = row => {
          this.shadowRoot.querySelector('.voice-reply-text').textContent = row.querySelector('.turn-text').textContent;
          const dialog = this.shadowRoot.querySelector('.voice-reply-dialog');
          if (!dialog.open) dialog.showModal();
        };
        if (room < 88 && signal) {
          // The band already has a 44px status slot; use it when the keyboard
          // leaves only a line of transcript. Neither dock nor card changes size.
          if (!mini) {
            mini = node('button', 'voice-read-full-mini'); mini.type = 'button'; mini.setAttribute('aria-haspopup', 'dialog');
            mini.addEventListener('click', () => openFullReply(shell.querySelector('.turn:last-child')));
            signal.append(mini);
          }
          mini.hidden = false; setText(mini, this.#copy.voiceReadFullReply); signal.setAttribute('data-read-full', '');
        } else {
          let button = readFull;
          if (!button) {
            button = node('button', 'turn-read-full'); button.type = 'button'; button.setAttribute('aria-haspopup', 'dialog');
            button.addEventListener('click', () => openFullReply(latest));
            latest.append(button);
          }
          button.hidden = false; setText(button, this.#copy.voiceReadFullReply);
        }
        shell.scrollTop += latest.getBoundingClientRect().top - top;
      }
    }
    this.#latestScrollTop = shell.scrollTop;
    this.shadowRoot.querySelector('.transcript-latest').style.visibility = 'hidden';
  }
  #hovered() {
    const point = this.#pointer;
    return point ? this.shadowRoot.elementFromPoint?.(point.x, point.y) ?? null : null;
  }
  // Scroll anchoring done by hand (panes set overflow-anchor:none): keep the element under
  // a resting pointer at the same viewport position while content above it changes. Keyed
  // nodes survive updates, so this is the hovered element itself, not a surviving parent.
  // When a pane cannot scroll far enough, temporary padding (slack) makes room until the
  // pointer leaves. Slack is derived afresh on every update, so it never accumulates.
  #anchored(update) {
    const hovered = this.#hovered();
    if (!hovered) { update(); return; }
    // Host content in a slot belongs to the page: its chain ends at the document, never at this root.
    const chain = [];
    for (let node = hovered; node?.nodeType === 1; node = node.parentNode) chain.push([node, node.getBoundingClientRect().top]);
    update();
    const [node, top] = chain.find(([n]) => n.isConnected && n.getRootNode() === this.shadowRoot) ?? [];
    const pane = node?.closest?.(PANES);
    if (!pane) return;
    const slack = { top: 0, bottom: 0 };
    const apply = () => {
      for (const side of ['top', 'bottom']) {
        if (slack[side] > 0) pane.style.setProperty(`--aithema-slack-${side}`, `${slack[side]}px`);
        else pane.style.removeProperty(`--aithema-slack-${side}`);
      }
    };
    apply();
    // Bottom slack first fills any spare space, then adds scroll room; measure until it holds.
    for (let round = 0; round < 4; round++) {
      const delta = node.getBoundingClientRect().top - top;
      if (Math.abs(delta) < .5) break;
      const target = pane.scrollTop + delta, max = pane.scrollHeight - pane.clientHeight;
      if (target < 0) slack.top += -target;
      else if (target > max) slack.bottom += target - max + (max < 1 ? spareSpace(pane) : 0);
      apply(); pane.scrollTop = Math.max(0, target);
    }
    // Chrome can round a pane's scroll boundary down by a fractional pixel.
    // Preserve the remaining upward displacement with padding, including while
    // an assessment is pending and its notice temporarily has a visual row.
    const residual = node.getBoundingClientRect().top - top;
    if (pane.matches('.analysis-content') && residual <= -.5) {
      slack.top -= residual; apply();
    }
    // The phone notice observer runs after this render. Its reading position
    // must include the pointer anchor's compensation for changed transcript rows.
    if (pane.matches('.transcript-shell')) this.#phoneViewport?.recordTranscriptAnchor();
  }
  #headers(headers = {}) {
    return { ...headers, ...(this.#sessionToken ? { 'x-aithema-session-token': this.#sessionToken } : {}) };
  }
  async #export() {
    const sessionId = this.#session.id;
    let url;
    try {
      const response = await fetch(`${this.#base}/api/sessions/${sessionId}/export`, { headers: this.#headers() });
      if (!response.ok) throw new Error();
      const blob = await response.blob();
      if (sessionId !== this.#session.id) return;
      url = URL.createObjectURL(blob);
      const link = document.createElement('a'); link.href = url; link.download = 'aithema-session.zip'; link.click();
    } catch { if (sessionId === this.#session.id) this.#status(this.#copy.controlFailed); }
    finally { if (url) URL.revokeObjectURL(url); }
  }
  #createProject() {
    if (this.#session.processingPreset === 'device' || this.shadowRoot.querySelector('.understanding').dataset.overview !== 'current') return;
    const action = paimosImportUrl(this.#options); if (!action) return;
    const document = this.ownerDocument, form = document.createElement('form');
    try {
      const payload = buildPaimosPayload(this.#session, { host: document.location.host, fallbackTitle: this.#copy.understanding });
      form.method = 'post'; form.action = action; form.target = '_blank'; form.rel = 'noopener';
      form.acceptCharset = 'UTF-8'; form.hidden = true;
      const field = document.createElement('input'); field.type = 'hidden'; field.name = 'payload'; field.value = JSON.stringify(payload);
      form.append(field); document.body.append(form); form.submit();
    } catch { this.#status(this.#copy.controlFailed); }
    finally { form.remove(); }
  }
  #creditsChanged({ allowanceChanged = false, settledCall, receiptFailed = false } = {}) {
    if (!this.#host) return;
    if (settledCall) this.#rail?.settleLedger(settledCall);
    const usedUp = this.#host.usedUp, recovered = this.#creditWasUsedUp && !usedUp; this.#creditWasUsedUp = usedUp;
    const textReason = this.#session.featureMatrix?.[this.#session.processingPreset ?? 'best']?.text?.reason;
    const deniedText = !this.#hasLiveCall() && ['budget denied', 'budget reconciling'].includes(textReason);
    // A failed receipt can resolve fallback copy, but supplies no new admission facts.
    const refresh = !receiptFailed && (allowanceChanged || recovered || deniedText || this.#rail?.allowanceDenied) && this.isConnected ? this.#refreshFeatures() : null;
    if (usedUp && this.#rail?.session && !this.#rail.moved && !this.#creditEnding) {
      this.#creditEnding = true;
      void this.#rail.close(this.#host.endReason ?? 'host-limit');
      this.#creditEndTimer = setTimeout(() => { this.#creditEnding = false; this.#creditsChanged(); }, 600);
    }
    if (!usedUp) { clearTimeout(this.#creditEndTimer); this.#creditEnding = false; this.#creditAnnounced = false; setText(this.shadowRoot.querySelector('.credit-announcement'), ''); }
    this.#host.update();
    const announcement = this.#host.limitCopy.announce;
    if (usedUp && !this.#creditEnding && announcement && this.#creditAnnounced !== announcement) {
      this.#creditAnnounced = announcement; setText(this.shadowRoot.querySelector('.credit-announcement'), announcement);
    }
    if (usedUp && this.shadowRoot.querySelector('.workspace').dataset.stage !== 'live') this.#render('transcript');
    this.#render('composer'); this.#render('transcript'); this.#rail?.render(); this.#dialog?.sync();
    return refresh;
  }
  #hasLiveCall() { return Boolean(this.#rail?.session || this.#rail?.waitingCall || this.#rail?.state === 'connecting'); }
  #feature(feature, visitor = false, { ignorePause = false } = {}) {
    const preset = this.#session.processingPreset ?? 'best';
    if (this.#host?.usedUp && preset !== 'device') return { available: false,
      reason: this.#copy.voiceStates[this.#host.endReason === 'one-hour' ? 'timeExpired' : 'usedUp'], rawReason: 'host-limit' };
    // Held voice commands need the server verdict too: a local pause must not hide
    // a budget or consent refusal behind the explicit take-back exception.
    const continuation = visitor && feature === 'voice' && (this.#rail?.moved || this.#rail?.waitingCall);
    if (!ignorePause && this.#session.pauseReason === 'purpose') return { available: false, reason: this.#copy.paused };
    if (!ignorePause && this.#session.paused && !continuation) return { available: false, reason: this.#copy.paused };
    if (this.#session.consentWithdrawn || this.#session.tombstone) return { available: false,
      reason: visitor ? reasonText(this.#copy, CONSENT_REASON, feature) : this.#copy.consentRequired };
    const matrix = this.#session.featureMatrix?.[preset] ?? (preset === 'device' ? deviceFeatures() : {});
    let value = matrix[feature] ?? { available: false, reason: this.#copy.notConfigured };
    if (ignorePause && value.reason === 'session paused' && value.unpaused) value = value.unpaused;
    if (!this.#hasLiveCall() && this.#postCallMatrix === this.#session.featureMatrix && value.reason === 'budget denied') {
      value = { ...value, reason: 'budget reconciling' };
    }
    // Shown verdicts speak the page language; decisions keep the server's machine reasons.
    const reason = value.reason === 'budget denied' && this.#hasLiveCall() ? this.#copy.voiceBudgetDenied : reasonText(this.#copy, value.reason, feature);
    return visitor ? { ...value, rawReason: value.reason, reason } : value;
  }
  // The visitor's consent position for the acknowledged choice, from the server verdicts.
  #consentState() {
    if ((this.#session.processingPreset ?? 'best') === 'device') return 'device';
    if (this.#session.consentWithdrawn) return 'withdrawn';
    const matrix = this.#session.featureMatrix?.[this.#session.processingPreset ?? 'best'] ?? {};
    // Drafts have an optional grant; their verdict never makes conversation consent missing.
    return FEATURES.some(feature => feature !== 'html' && isConsentReason(matrix[feature]?.reason)) ? 'missing' : 'granted';
  }
  // Mode-dependent controls; a choice made at conversation start can switch the mode in place.
  #renderMode() {
    const exported = this.shadowRoot.querySelector('.export'), device = this.#session.processingPreset === 'device';
    const create = this.shadowRoot.querySelector('.create-project');
    // Keep the footer's space while removing the device handoff from sight and interaction.
    if (create) { create.style.visibility = device ? 'hidden' : ''; create.inert = device || this.shadowRoot.querySelector('.understanding').dataset.overview !== 'current'; }
    const reason = this.shadowRoot.querySelector('.export-reason');
    setText(reason, this.#copy.deviceExportUnavailable);
    reason.style.visibility = device ? 'visible' : 'hidden'; reason.setAttribute('aria-hidden', String(!device));
    exported.setAttribute('aria-label', this.#copy.export);
    exported.setAttribute('role', 'link'); exported.tabIndex = 0;
    if (device) {
      exported.removeAttribute('href'); exported.setAttribute('aria-disabled', 'true');
      exported.setAttribute('aria-describedby', reason.id); exported.title = this.#copy.deviceExportUnavailable;
    } else {
      exported.href = `${this.#base}/api/sessions/${this.#session.id}/export`; exported.removeAttribute('aria-disabled');
      exported.removeAttribute('aria-describedby'); exported.title = '';
    }
    if (this.#rail) { const client = this.#voiceClientFor(); if (!this.#rail.session && this.#rail.client !== client) { this.#rail.client = client; this.#renderVoice(); } }
  }
  async #loadCatalog() {
    const sessionId = this.#session.id;
    const response = await fetch(`${this.#base}/api/sessions/${sessionId}/settings`, { headers: this.#headers() });
    if (!response.ok) throw new Error('Settings unavailable');
    const catalog = await response.json();
    if (sessionId !== this.#session.id) throw new Error('Session changed');
    return catalog;
  }
  /** Sends ids only; the component shows what the server acknowledges. */
  async #saveSettings(body) {
    const sessionId = this.#session.id;
    let response, value = null;
    try { response = await postJson(`${this.#base}/api/sessions/${sessionId}/settings`, body, { sessionToken: this.#sessionToken }); }
    catch { return { ok: false, error: 'network', body: {} }; }
    try { value = await response.json(); } catch { /* A body-less failure is retried by the visitor. */ }
    if (sessionId !== this.#session.id) return { ok: false, error: 'stale', body: {} };
    if (!response.ok || !value) return { ok: false, error: value?.error ?? 'network', body: value ?? {} };
    this.#applySettings(value);
    return { ok: true, ack: value };
  }
  #applySettings(ack) {
    if (ack.event) this.receive(ack.event);
    if (this.#session.settings?.revision === ack.settings.revision && this.#session.processingPreset === ack.processingPreset) {
      this.#session.featureMatrix = ack.featureMatrix; this.#session.engine = ack.engine;
    }
    this.#renderMode();
    this.#render('features'); this.#render('composer'); this.#render('aside'); this.#render('transcript'); this.#renderVoice();
  }
  #modeChanged(before) {
    if (this.#session.processingPreset === 'device') { this.#abort?.abort(); this.#abort = null; }
    else if (before === 'device' && this.isConnected) this.#connect();
  }
  #newConversation({ processingPreset, settings }) {
    this.#dialog.close();
    this.dispatchEvent(new CustomEvent('aithema-new-conversation', { detail: { processingPreset, settings: structuredClone(settings ?? {}),
      previousSessionId: this.#session.id, confirm: true }, bubbles: true, composed: true }));
  }
  async #saveConsent(body) {
    const sessionId = this.#session.id;
    const response = await postJson(`${this.#base}/api/sessions/${sessionId}/consent`, { ...body, intent: 'settings-save' }, { sessionToken: this.#sessionToken });
    const ack = await response.json();
    if (!response.ok) throw Object.assign(new Error('Consent save failed'), { code: response.status === 409 ? ack.error : undefined });
    if (sessionId !== this.#session.id || ack.granted !== body.granted) throw new Error('Consent acknowledgement missing');
    // The current server document confirms the exact decision; HTTP success alone is not consent.
    const current = await fetch(`${this.#base}/api/sessions/${sessionId}/consent`, { headers: this.#headers() });
    if (!current.ok) throw new Error('Consent confirmation unavailable');
    const doc = await current.json(), items = body.granted ? body.processing.items : [];
    // Older backends expose only the original contract/items confirmation.
    const confirmed = doc.consentRevision === undefined
      ? doc.contract === body.processing.contract
      : Number.isSafeInteger(ack.consentRevision) && doc.consentRevision === ack.consentRevision &&
        (body.processing.revision === undefined || ack.consentRevision === body.processing.revision + 1);
    if (!confirmed ||
      !Array.isArray(doc.selected) || doc.selected.length !== items.length ||
      !items.every(item => doc.selected.includes(item))) throw new Error('Consent decision unconfirmed');
    if (ack.event) this.receive(ack.event);
    await this.#refreshFeatures();
  }
  #requestConsent(reason, features = FEATURES.filter(f => isConsentReason(this.#feature(f).reason))) {
    // The host's consent interface lies outside this modal dialog.
    this.#dialog.close();
    this.dispatchEvent(new CustomEvent('aithema-consent', { detail: { sessionId: this.#session.id, reason, features: [...features] },
      bubbles: true, composed: true }));
  }
  #restoreFailure() {
    const operations = this.#session.operations;
    if (operations?.inputRevision === inputRevision(this.#session)) this.#laneStatusPending = null;
    const failure = operations?.inputRevision === inputRevision(this.#session) ? operations.lastFailure : null;
    this.#recordFailure(failure);
  }
  #recordFailure(failure) {
    const reconciling = failure && (failure.reason === 'budget reconciling' ||
      this.#session.featureMatrix?.[this.#session.processingPreset ?? 'best']?.analysis?.reason === 'budget reconciling');
    if (reconciling) {
      if (this.#analysisRecovery !== inputRevision(this.#session)) this.#deferredAnalysis = inputRevision(this.#session);
      this.#failure = false;
    } else {
      this.#failure = Boolean(failure); this.#failureLane = failure?.lane ?? null;
      if (failure) { this.#analysisRecovery = null; this.#laneStatusPending = null; }
    }
  }
  #stopReconciling() {
    clearInterval(this.#reconcilingPoll); this.#reconcilingPoll = null;
    clearTimeout(this.#reconcilingLongTimer); this.#reconcilingLongTimer = null;
  }
  #syncReconciling() {
    const revision = inputRevision(this.#session);
    if (this.#deferredAnalysis !== null && this.#deferredAnalysis !== revision) this.#deferredAnalysis = null;
    if (this.#analysisRecovery !== null && this.#analysisRecovery !== revision) this.#analysisRecovery = null;
    const blocked = this.#feature('text').reason === 'budget reconciling';
    const analysisBlocked = this.#feature('analysis').reason === 'budget reconciling';
    const understanding = this.#session.understanding;
    if (analysisBlocked && this.#analysisRecovery !== revision && (understanding.inputRevision !== revision || understanding.draft)) this.#deferredAnalysis = revision;
    // Retain denied analysis for a later refresh without polling a settled denial.
    const waiting = blocked || analysisBlocked || (this.#deferredAnalysis !== null && this.#feature('analysis').available);
    if (!this.isConnected || !waiting) this.#stopReconciling();
    else {
      // Admission belongs to the session, including hosts that do not display credits.
      if (!this.#reconcilingPoll) {
        let reading = false;
        this.#reconcilingPoll = setInterval(async () => {
          if (reading || this.ownerDocument.visibilityState === 'hidden') return;
          reading = true;
          try { await this.#refreshFeatures(); } finally { reading = false; }
        }, 15_000);
        this.#reconcilingPoll.unref?.();
      }
      if (blocked && !this.#reconcilingLong && !this.#reconcilingLongTimer) {
        this.#reconcilingLongTimer = setTimeout(() => {
          this.#reconcilingLongTimer = null; this.#reconcilingLong = true; this.#render('composer');
        }, 60_000);
        this.#reconcilingLongTimer.unref?.();
      }
    }
    if (!blocked) {
      clearTimeout(this.#reconcilingLongTimer); this.#reconcilingLongTimer = null; this.#reconcilingLong = false;
    }
  }
  async #resumeDeferredAnalysis() {
    const revision = this.#deferredAnalysis;
    if (revision === null || !this.isConnected || !this.#feature('analysis').available) return;
    this.#deferredAnalysis = null;
    if (revision !== inputRevision(this.#session)) return;
    const sessionId = this.#session.id;
    this.#analysisRecovery = revision; this.#failure = false;
    try {
      const response = await postJson(`${this.#base}/api/sessions/${sessionId}/retry`, {}, { sessionToken: this.#sessionToken });
      if (!response.ok) throw new Error();
    } catch {
      // A transport refusal stays deferred; the next admission check can retry safely.
      if (sessionId === this.#session.id && revision === inputRevision(this.#session)) this.#deferredAnalysis = revision;
    } finally {
      if (sessionId === this.#session.id) { this.#render('aside'); this.#render('composer'); }
    }
  }
  #renderVoice() { this.#anchored(() => this.#rail?.render()); }
  #render(part) {
    if (['features', 'transcript', 'aside'].includes(part)) { this.#anchored(() => this.#paint(part)); return; }
    this.#paint(part);
  }
  #syncVoicePause(rail = this.#rail) {
    const pause = this.shadowRoot.querySelector('.pause');
    if (!pause) return;
    const purposePaused = this.#session.pauseReason === 'purpose', root = this.shadowRoot;
    root.querySelector('.audio-rail').toggleAttribute('data-purpose-paused', purposePaused);
    const start = root.querySelector('.voice-start');
    if (purposePaused) {
      pause.disabled = true;
      start.disabled = true; start.title = this.#copy.purposePausedDescription;
      start.setAttribute('aria-description', this.#copy.purposePausedDescription);
      root.querySelector('.voice-state').textContent = '';
      for (const name of ['input', 'output', 'playback', 'retry', 'close']) this.#rail?.button(name).setAttribute('disabled', '');
      return;
    }
    start.removeAttribute('aria-description');
    // The session pause speaks once in the composer, including an idle rail.
    const railState = root.querySelector('.voice-state');
    if (this.#session.paused && [this.#copy.paused, this.#copy.voiceStates.paused].includes(railState.textContent)) railState.textContent = '';
    if (rail?.session || rail?.waitingCall || ['connecting', 'failed'].includes(rail?.state)) {
      const command = rail.button('pause'); pause.dataset.voiceCommand = '';
      // Waiting can stay Waiting while a takeover receipt changes its command.
      // Mirror every rail render instead of waiting for a state transition.
      pause.disabled = command.disabled; pause.title = command.title;
      setText(pause.querySelector('.voice-label'), command.querySelector('.voice-label').textContent);
      pause.setAttribute('aria-pressed', command.getAttribute('aria-pressed'));
    } else {
      pause.disabled = false; delete pause.dataset.voiceCommand;
    }
    if (this.#host?.usedUp || rail?.allowanceDenied) {
      pause.disabled = true; pause.title = this.#copy.voiceStates[this.#host?.endReason === 'one-hour' ? 'timeExpired' : 'usedUp'];
    }
  }
  #paint(part) {
    const root = this.shadowRoot, copy = this.#copy;
    this.#paintStatus(); this.#paintNotice(); this.#fold?.update(this.#session, hasOpenReplyQuestion(this.#session));
    this.#questionCard?.update(currentQuestionCard(this.#session), copy, !this.#feature('text').available, this.#sending);
    const pause = root.querySelector('.pause');
    if (pause) {
      const voicePaused = this.#rail?.session || this.#rail?.waitingCall ? this.#rail.pauseIntent : this.#session.paused;
      setText(pause.querySelector('.voice-label'), this.#rail?.requiresTakeover || this.#rail?.moved ? copy.voiceTakeover : voicePaused ? copy.resume : copy.pause); pause.title = pause.textContent;
      pause.setAttribute('aria-pressed', String(Boolean(voicePaused)));
      this.#syncVoicePause();
    }
    const element = (tag, value, className) => {
      const node = document.createElement(tag); if (value !== undefined) node.textContent = value;
      if (className) node.className = className; return node;
    };
    if (part === 'composer') {
      this.#syncReconciling();
      const text = this.#feature('text', true), input = root.querySelector('textarea');
      input.disabled = !text.available && text.rawReason !== 'budget reconciling';
      // Invite speech only while the call can listen; held calls invite the next typed message.
      const listening = this.#rail?.session && !this.#rail.paused && !['recovering', 'waiting'].includes(this.#rail.state);
      const voicePlaceholder = this.#host?.fullHold ? copy.placeholderFullHold ?? copy.placeholderVoice : copy.placeholderVoice;
      const placeholder = root.querySelector('.workspace').hasAttribute('data-phone-short') ? copy.placeholderCompact ?? copy.placeholder
        : listening ? voicePlaceholder ?? copy.placeholder : copy.placeholder;
      input.placeholder = this.#session.pauseReason === 'purpose' ? copy.purposePaused : placeholder;
      const paused = this.#composerPaused, send = root.querySelector('.send'), resume = root.querySelector('.composer-resume');
      const pausedLine = root.querySelector('.composer-paused');
      pausedLine.hidden = !paused; setText(pausedLine.querySelector('span'), copy.composerPaused);
      setText(resume, copy.resume); resume.disabled = this.#composerResuming;
      root.querySelector('.composer').toggleAttribute('data-paused', paused);
      const command = paused ? copy.resume : copy.send;
      setText(send.querySelector('.visually-hidden'), command); send.setAttribute('aria-label', command);
      send.title = command;
      if (send.dataset.command !== (paused ? 'resume' : 'send')) {
        send.querySelector('svg').outerHTML = icon(paused ? 'play' : 'arrowRight');
        send.dataset.command = paused ? 'resume' : 'send';
      }
      send.disabled = paused ? this.#composerResuming : this.#sending || !text.available;
      // A blocking verdict supersedes the failed attempt, including after it becomes available again.
      if (!text.available || this.#rail?.moved) this.#sendFailed = false;
      const reason = root.querySelector('.composer-reason');
      reason.toggleAttribute('data-shortcut', text.available && !this.#rail?.moved && !this.#uploadNotice && !this.#retryFiles.length && !this.#sendFailed);
      const mac = /Mac|iPhone|iPad/u.test(globalThis.navigator?.platform ?? '');
      const feedback = root.querySelector('.composer-feedback');
      const showSaved = this.#saved && reason.hasAttribute('data-shortcut') && !this.#composerPaused;
      feedback.toggleAttribute('data-saved', showSaved);
      setText(root.querySelector('.composer-saved-sizer span'), copy.saved);
      setText(root.querySelector('.composer-saved span'), showSaved ? copy.saved : '');
      // Always mounted and exposed to AT, including while another notice wins visually.
      setText(root.querySelector('.composer-saved-announcement'), this.#savedAnnouncement ? copy.saved : '');
      reason.setAttribute('aria-live', showSaved ? 'off' : 'polite');
      // Retained busy files keep their retry action available while the person types.
      const unavailable = this.#session.pauseReason === 'purpose' ? copy.paused : this.#rail?.moved ? copy.voiceInAnotherTab : text.rawReason === 'budget reconciling' && this.#reconcilingLong ? copy.reconcilingLong : text.reason;
      const words = this.#composerPaused ? '' : !text.available || this.#rail?.moved ? unavailable : this.#sendFailed ? copy.failed
        : this.#uploadNotice || copy.shortcut.replace('{key}', copy.shortcutKeys?.[mac ? 'mac' : 'other'] ?? '');
      setText(root.querySelector('#upload-retry-reason'), this.#retryFiles.length ? plural(copy.uploads.notUploaded, this.#retryFiles.length) : '');
      if (this.#retryFiles.length) {
        const refusal = this.#retryRefusal();
        if (!reason.querySelector('.upload-discard')) {
          const label = node('span'), discard = reasonAction('', () => {
            this.#retryFiles = []; this.#uploadNotice = ''; this.#render('composer');
          });
          label.classList.add('upload-retry-copy'); label.tabIndex = 0; discard.classList.add('upload-discard');
          discard.setAttribute('aria-describedby', 'upload-retry-reason');
          const actions = node('span', 'upload-retry-actions'); actions.append(discard);
          delete reason.dataset.consentFeature;
          reason.replaceChildren(label, actions);
        }
        let action = reason.querySelector('.upload-retry');
        const discard = reason.querySelector('.upload-discard');
        if (refusal && action) action.parentNode.remove();
        else if (!refusal && !action) {
          action = reasonAction('', () => { void this.#attach(this.#retryFiles, true); });
          action.classList.add('upload-retry'); action.setAttribute('aria-describedby', 'upload-retry-reason');
          // Buttons form atomic inline boxes; keep the following separator in the same no-wrap span.
          const joined = node('span'); joined.style.whiteSpace = 'nowrap';
          joined.append(action, document.createTextNode(reasonSeparator)); discard.before(joined);
        }
        // Failure replaces the notice, never the retained selection's actions. Consent keeps its opener too.
        const facts = !text.available && !this.#session.paused || this.#rail?.moved ? unavailable : this.#sendFailed ? copy.failed
          : refusal || [this.#uploadNotice, plural(copy.uploads.notUploaded, this.#retryFiles.length)].filter(Boolean).join(reasonSeparator);
        const retryLabel = reason.querySelector('.upload-retry-copy');
        paintConsentLine(retryLabel, { copy, feature: 'text', text: `${facts}${this.#sendFailed ? '' : reasonSeparator}`,
          verdict: text, open: opener => this.#dialog.openConsent('text', opener) });
        const consentCopy = retryLabel.querySelector('.consent-line-copy');
        if (consentCopy) consentCopy.tabIndex = 0; else retryLabel.tabIndex = 0;
        if (!refusal) setText(action, copy.uploads.tryAgain);
        setText(discard, copy.uploads.discard);
      } else {
        if (reason.querySelector('.upload-retry-copy')) reason.replaceChildren();
        paintConsentLine(reason, { copy, feature: 'text', text: words,
          verdict: text,
          open: opener => this.#dialog.openConsent('text', opener) });
      }
      reason.toggleAttribute('data-send-failed', this.#sendFailed && text.available && !this.#rail?.moved);
      if (reason.hasAttribute('data-send-failed')) {
        const line = reason.querySelector('.upload-retry-copy') ?? reason;
        // The default sentence and phone short copy need not share a prefix.
        // Keep the full polite announcement and reuse its nodes on repaints.
        if (!line.querySelector('.send-failure-detail') || line.dataset.failureCopy !== copy.failed) {
          paintFailureLine(line, copy.failed);
          const why = line.querySelector('.question-why'), first = why.textContent;
          const detail = node('span', 'send-failure-detail', copy.failed.slice(first.length));
          line.lastChild.replaceWith(detail);
          if (copy.failedShort && copy.failedShort !== first) {
            const full = node('span', 'send-failure-first', first);
            const short = node('span', 'send-failure-short'); short.dataset.text = copy.failedShort; short.setAttribute('aria-hidden', 'true');
            why.replaceChildren(full, short);
          }
          line.dataset.failureCopy = copy.failed;
        }
      }
      if (reason.hasAttribute('data-shortcut') && words) {
        const parts = copy.shortcut.split('{key}'), modifier = node('kbd', '', copy.shortcutKeys?.[mac ? 'mac' : 'other'] ?? '');
        const enter = node('kbd', '', 'Enter'), suffix = (parts[1] ?? '').split('Enter');
        reason.replaceChildren(parts[0] ?? '', modifier, suffix[0], enter, suffix.slice(1).join('Enter'));
      }
      reason.title = !text.available || this.#rail?.moved ? unavailable : '';
      input.toggleAttribute('data-purpose-paused', this.#session.pauseReason === 'purpose');
      const purposePause = root.querySelector('.purpose-pause-copy');
      purposePause.hidden = this.#session.pauseReason !== 'purpose'; setText(purposePause, copy.purposePaused);
      input.style.visibility = purposePause.hidden && !paused ? '' : 'hidden';
      const newConversation = root.querySelector('.purpose-new');
      newConversation.hidden = purposePause.hidden; setText(newConversation, copy.settings.newConversation);
      root.querySelector('.composer-shell').toggleAttribute('data-purpose-paused', !purposePause.hidden);
      this.#paintAttach();
      const out = root.querySelector('.composer-out'), usedUp = this.#composerUsedUp;
      const shell = root.querySelector('.composer-shell'), form = root.querySelector('form.composer'), u = copy.hostSurface.usedUp, credits = copy.hostSurface.credits;
      shell.toggleAttribute('data-used-up', usedUp); form.inert = usedUp; form.setAttribute('aria-hidden', String(usedUp));
      out.inert = !usedUp; out.setAttribute('aria-hidden', String(!usedUp));
      const limit = this.#host?.limitCopy ?? u;
      const next = this.#host?.nextTier, kind = next === 'emailGiven' ? 'give' : next === 'emailConfirmed' ? 'confirm' : 'none';
      const newAction = this.#host?.newConversationAction, noAction = this.#host?.noDailyAction;
      const newConversationEnabled = this.#options.host?.usedUp?.newConversation?.enabled === true;
      out.toggleAttribute('data-host-limit', ['host-limit', 'session'].includes(this.#host?.endReason) || usedUp && newConversationEnabled ||
        this.#host?.dailyCapped === true && (noAction || this.#options.host?.credits?.dailyCapReset === true));
      if (this.#options.host?.credits?.dailyCapReset) {
        let deadline = out.querySelector('.composer-out__deadline');
        if (!deadline) { deadline = node('span', 'composer-out__deadline'); out.append(deadline); out.setAttribute('data-reset-slot', ''); }
        setText(deadline, this.#host?.dailyCapResetLabel ?? '');
        deadline.hidden = !this.#host?.dailyCapped;
      }
      let start = out.querySelector('.composer-out__new');
      if (this.#options.host?.usedUp?.newConversation?.enabled && !start) {
        start = node('button', 'composer-out__new'); start.type = 'button';
        start.addEventListener('click', () => this.#newConversation({ processingPreset: this.#session.processingPreset, settings: this.#session.settings }));
        out.querySelector('.composer-out__actions').append(start);
      }
      if (start) { start.hidden = !newAction; start.inert = !newAction; setText(start, credits.ended.newConversationAction); }
      if (newAction || noAction) out.setAttribute('data-credit-actions', newAction ? 'new' : 'none');
      else out.removeAttribute('data-credit-actions');
      out.querySelector('.composer-out__steps').setAttribute('aria-hidden', String(out.hasAttribute('data-host-limit')));
      out.dataset.next = kind; out.dataset.delivery = String(this.#host?.verification?.delivery === true);
      out.querySelector('.composer-out__bar').dataset.upgradeMeasure = out.dataset.delivery === 'true' ? credits.confirm : credits.give;
      out.querySelector('.composer-out__bar').dataset.exportMeasure = u.export;
      out.querySelector('.composer-out__title').dataset.hostTitle = credits.ended['host-limit'].title;
      setText(out.querySelector('.composer-out__title span'), limit.title);
      const delta = this.#host?.deltaCredits ?? '';
      // Tick spec v1 (AIT-406, 2026-10-20): the tallest localized variant
      // reserves the credit line. Hidden grid peers never enter the AX tree.
      const allowances = this.#host?.tiers?.allowancesMicro;
      const tierDelta = (from, to) => allowances?.[from] !== undefined && allowances?.[to] !== undefined
        ? formatCredits(Math.max(0, allowances[to] - allowances[from]), this.#session.locale ?? 'en') : delta;
      const bodies = [
        ['active', limit.body], ['default', u.body],
        ['host-give-measure', u.hostGiveMeasure.replace('{delta}', tierDelta('anonymous', 'emailGiven'))],
        ['host-give', u.hostGive.replace('{delta}', tierDelta('anonymous', 'emailGiven'))],
        ['host-confirm', u.hostConfirm.replace('{delta}', tierDelta('emailGiven', 'emailConfirmed'))],
        ['host-confirm-anonymous', u.hostConfirm.replace('{delta}', tierDelta('anonymous', 'emailConfirmed'))],
        ...Object.entries(credits.ended).filter(([, value]) => value && typeof value === 'object')
          .map(([key, value]) => [key, value.body]), ['daily-cap', credits.dailyCap],
      ].map(([key, text]) => [key, { text, option: false }]);
      // Keep v1 and AIT-422's original-offer peer intact. O1/O7 share their grid
      // cell, including both possible upgrade allowances before a tier changes.
      // These hidden b elements have inherited typography and no AX presence.
      bodies.push(...[
        ['new-conversation', credits.ended.newConversationHint],
        ...['emailGiven', 'emailConfirmed'].map(tier => [`session-${tier}`,
          credits.ended.sessionUpgrade.replace('{next}', allowances?.[tier] === undefined ? ''
            : formatCredits(allowances[tier], this.#session.locale ?? 'en'))]),
      ].map(([key, text]) => [`option-${key}`, { text, option: true }]));
      reconcile(out.querySelector('.composer-out__body'), bodies, body => node(body.option ? 'b' : 'span'), (span, { text, option }) => {
        const key = span.dataset.key;
        setText(span, text);
        if (option) span.dataset.creditOptionVariant = key;
        else span.dataset.creditVariant = key;
        span.dataset.active = String(key === 'active');
        span.toggleAttribute('data-host-body', option || key.startsWith('host-') || key === 'active' && out.hasAttribute('data-host-limit'));
        span.setAttribute('aria-hidden', String(!usedUp || key !== 'active'));
      });
      setText(out.querySelector('.composer-out__give'), u.give.replace('{delta}', delta)); setText(out.querySelector('.composer-out__confirm'), u.confirm.replace('{delta}', delta));
      const footer = out.querySelector('.composer-out__none');
      footer.hidden = limit.footer === false; setText(footer, limit.footer === false ? '' : u.none);
      setText(out.querySelector('.composer-out__upgrade [data-next="give"]'), credits.give); setText(out.querySelector('.composer-out__upgrade [data-next="confirm"]'), credits.confirm);
      setText(out.querySelector('.composer-out__export span'), u.export);
      out.querySelector('.composer-out__export').href = `${this.#base}/api/sessions/${this.#session.id}/export`;
      for (const node of out.querySelectorAll('[data-next]')) { const shown = node.dataset.next === kind && !node.hidden; node.setAttribute('aria-hidden', String(!shown)); node.inert = !shown; }
      const exportLink = out.querySelector('.composer-out__export'), exportShown = !noAction && (kind === 'none' || newConversationEnabled || ['host-limit', 'session'].includes(this.#host?.endReason));
      exportLink.toggleAttribute('data-export', exportShown); exportLink.inert = !exportShown; exportLink.setAttribute('aria-hidden', String(!exportShown));
      const upgrade = out.querySelector('.composer-out__upgrade'); upgrade.inert = kind === 'none' || noAction; upgrade.setAttribute('aria-hidden', String(kind === 'none' || noAction));
      if (noAction) out.querySelector('.composer-out__actions').setAttribute('aria-hidden', 'true');
      else out.querySelector('.composer-out__actions').removeAttribute('aria-hidden');
      const card = root.querySelector('.qcard'); card.inert = usedUp; card.toggleAttribute('data-used-up', usedUp);
      this.#host?.emailAsk?.paint();
      this.#paintStatus();
      return;
    }
    if (part === 'features') {
      this.#renderEngine();
      reconcile(root.querySelector('.features'), FEATURES.map(feature => [feature, feature]), () => {
        const row = element('li'); row.append(document.createTextNode('')); return row;
      }, (row, feature) => {
        const value = this.#feature(feature, true);
        row.className = value.available ? '' : 'unavailable'; row.firstChild.nodeValue = copy.features[feature];
        const reason = row.querySelector('span');
        if (value.available || this.#session.pauseReason === 'purpose') reason?.remove(); else (reason ?? row.appendChild(element('span'))).textContent = this.#rail?.moved ? copy.voiceInAnotherTab : value.reason;
      });
      return;
    }
    if (part === 'transcript') {
      this.#renderIntro();
      // Rows are keyed by turn id (uploads by "upload:" and their id) and updated in place: new turns
      // append below, and focus and the hovered row survive updates. Superseded partials lose their rows.
      const list = root.querySelector('ol'), shell = root.querySelector('.transcript-shell');
      const entries = this.#transcriptEntries(this.#session.transcript.filter(t => !t.erased || t.role === 'user'));
      const rows = new Map([...list.children].map(row => [row.dataset.id, row]));
      const hovered = this.#onTranscript, count = list.children.length, kept = new Set(entries.map(entry => entry.key));
      // Rows that go are removed first, so a surviving row never moves past them: moving a node drops its focus.
      for (const [key, row] of rows) if (!kept.has(key)) { row.remove(); rows.delete(key); }
      let next = list.firstElementChild;
      for (const { key, turn: t, upload, lowLine } of entries) {
        let row = rows.get(key); rows.delete(key);
        if (lowLine) {
          if (!row) { row = node('li', lowLine.reserved ? 'email-low-reserve' : 'email-low-line'); row.dataset.id = key; }
          this.#host.emailAsk.paintLine(row, lowLine);
          row.className = lowLine.reserved ? 'email-low-reserve' : 'email-low-line';
          row.inert = Boolean(lowLine.reserved);
          if (lowLine.reserved) row.setAttribute('aria-hidden', 'true'); else row.removeAttribute('aria-hidden');
          if (row !== next) list.insertBefore(row, next); else next = next.nextElementSibling;
          continue;
        }
        if (upload) {
          if (!row) { row = this.#uploadRow(upload.id); row.dataset.id = key; }
          this.#paintUpload(row, upload);
          if (row !== next) list.insertBefore(row, next); else next = next.nextElementSibling;
          continue;
        }
        if (!row) {
          row = element('li'); row.dataset.id = t.id;
          const speaker = element('strong'); speaker.innerHTML = '<i class="speaker-sign" aria-hidden="true"></i><b class="speaker-name"></b>';
          row.append(speaker, element('span', undefined, 'turn-text'));
        }
        const voicePartial = t === this.#voiceTranscript.pending && t.partial;
        // Corrections keep the largest provisional footprint; final text
        // takes over the same node with normal bubble sizing.
        if (row.classList.contains('partial') && row.dataset.voiceTranscript) {
          const { height, width } = row.getBoundingClientRect();
          row.style.setProperty('--voice-min-height', `${Math.max(parseFloat(row.style.getPropertyValue('--voice-min-height')) || 0, height)}px`);
          row.style.setProperty('--voice-min-width', `${Math.max(parseFloat(row.style.getPropertyValue('--voice-min-width')) || 0, width)}px`);
        }
        if (voicePartial) { row.dataset.voiceTranscript = 'partial'; row.setAttribute('aria-hidden', 'true'); row.setAttribute('aria-live', 'off'); }
        else if (row.dataset.voiceTranscript) {
          row.dataset.voiceTranscript = 'final';
          row.style.removeProperty('--voice-min-height'); row.style.removeProperty('--voice-min-width');
          row.querySelector('.voice-provisional')?.remove();
        }
        row.className = `turn ${t.role === 'user' ? 'user' : ''} ${t.partial ? 'partial' : ''}`;
        // Redacted rows keep their height only while the pointer rests on the transcript.
        if (!hovered) row.style.minHeight = '';
        row.querySelector('.speaker-name').textContent = t.role === 'user' ? copy.you : copy.assistant;
        if (voicePartial) {
          let label = row.querySelector('.voice-provisional');
          if (!label) { label = node('span', 'voice-provisional'); label.setAttribute('aria-hidden', 'true'); row.querySelector('strong').append(label); }
          label.textContent = copy.voiceProvisional;
        }
        const sign = row.querySelector('.speaker-sign');
        if (t.role === 'user' && !sign.firstChild) sign.innerHTML = icon('person');
        row.querySelector('.turn-text').textContent = t.erased ? copy.withdrawn : t.content;
        row.querySelector('.turn-text').removeAttribute('tabindex');
        paintVoiceInterruption(row, t, copy);
        const focusQuestion = !t.erased && !t.withdrawn && t.role === 'assistant' && this.#clarifyReplies.get(t.focusRequestId);
        let meta = row.querySelector('.clarify-meta');
        if (focusQuestion) {
          if (!meta) {
            meta = node('a', 'clarify-meta');
            meta.innerHTML = '<span class="clarify-dot" aria-hidden="true"></span><span class="clarify-meta-label"></span><span class="clarify-meta-question"></span>';
            row.insertBefore(meta, row.querySelector('.turn-text'));
            meta.addEventListener('click', event => {
              event.preventDefault();
              const item = [...root.querySelectorAll('.open-question')].find(item => item.querySelector('.question-text').textContent === meta.dataset.question);
              item?.scrollIntoView?.({ block: 'nearest', behavior: this.#motion ? 'smooth' : 'instant' });
              item?.querySelector('button')?.focus({ preventScroll: true });
            });
          }
          meta.href = `#open-${this.openQuestionItems.find(item => item.question === focusQuestion)?.id ?? ''}`;
          meta.dataset.question = focusQuestion;
          setText(meta.querySelector('.clarify-meta-label'), copy.clarify.clarifies);
          setText(meta.querySelector('.clarify-meta-question'), focusQuestion);
        } else meta?.remove();
        const withdrawable = t.role === 'user' && !t.erased && !t.partial && t !== this.#voiceTranscript.pending;
        if (withdrawable && !row.querySelector('.withdraw')) row.append(this.#withdrawButton(row));
        const withdraw = row.querySelector('.withdraw');
        if (withdraw) { withdraw.title = copy.display.withdraw; withdraw.setAttribute('aria-label', copy.display.withdraw); }
        if (!withdrawable) row.querySelector('.withdraw')?.remove();
        // Expose only the final bytes, after the entire row has been updated.
        if (!voicePartial) { row.removeAttribute('aria-hidden'); row.removeAttribute('aria-live'); }
        if (row !== next) list.insertBefore(row, next); else next = next.nextElementSibling;
      }
      for (const row of rows.values()) row.remove();
      this.#rail?.notices.render();
      const grew = list.children.length > count;
      if (this.#follow && !hovered && !this.#fold.folded) this.#scrollToLatest();
      else if (this.#follow && grew && shell.scrollHeight > shell.clientHeight) root.querySelector('.transcript-latest').style.visibility = '';
      this.#syncPanes();
      return;
    }
    this.#renderQuestions();
    const unpausedAnalysis = this.#feature('analysis', true, { ignorePause: true });
    const analysis = isConsentReason(unpausedAnalysis.rawReason) ? unpausedAnalysis : this.#feature('analysis', true), locked = this.#host?.locked ?? false;
    const reconciling = analysis.rawReason === 'budget reconciling';
    const cached = reconciling || this.#session.paused && this.#session.pauseReason !== 'purpose' ||
      (this.#session.paused || this.#host?.usedUp) && this.#session.understanding.inputRevision !== null;
    for (const node of root.querySelectorAll('.analysis-content [data-redacted]')) {
      node.style.minHeight = ''; delete node.dataset.redacted;
    }
    // A pane that holds the host's own controls (the verification form, handover) is never marked
    // disabled as a whole: only its unavailable parts are, through the notice and the hidden, inert content.
    const aside = root.querySelector('.understanding');
    if (this.#host?.holdsControls || isConsentReason(analysis.rawReason)) aside.removeAttribute('aria-disabled'); else aside.setAttribute('aria-disabled', String(!analysis.available));
    // Keep the outer pane and readiness row in the grid when analysis is unavailable.
    // A host verification lock (AIT-104 B2) replaces the assessment in place with the email form.
    root.querySelector('.readiness').style.visibility = !locked && (analysis.available || cached) ? '' : 'hidden';
    root.querySelector('.readiness').toggleAttribute('inert', locked);
    root.querySelector('.notice').hidden = locked;
    const u = this.#session.understanding, stale = u.inputRevision !== inputRevision(this.#session);
    // Assessments reveal only populated summary/signals; hidden sections own no grid space.
    for (const section of root.querySelectorAll('.analysis-content section')) section.hidden = locked || !analysis.available && !cached || !u.readinessAssessed;
    const summary = u.summary.trim();
    root.querySelector('.summary').hidden ||= !summary;
    root.querySelector('.signals-section').hidden ||= !u.signals.length;
    const percent = u.readinessAssessed ? readinessScalePercent(u.progress, this.#session.preset) : 0;
    const scale = root.querySelector('.scale');
    const readiness = u.readinessAssessed ? [
      copy.talkProgress.replace('{percent}', displayedReadinessPercent(u.progress.talk.value)),
      copy.buildProgress.replace('{percent}', displayedReadinessPercent(u.progress.build.value)),
    ].join(reasonSeparator) : copy.notAssessed;
    scale.setAttribute('aria-valuenow', percent);
    scale.setAttribute('aria-valuetext', readiness);
    scale.title = readiness;
    root.querySelector('.fill').style.width = `${percent}%`;
    root.querySelector('.marker').style.left = `${this.#session.preset.talkMarker}%`;
    const revision = inputRevision(this.#session), operations = this.#session.operations;
    const running = operations?.inputRevision === revision && operations.running.length > 0;
    const turns = activeTurns(this.#session), person = turns.findLast(t => t.role === 'user');
    const hasPersonTurn = Boolean(person);
    const missingReply = hasPersonTurn && !turns.some(t => t.role === 'assistant' && t.inputRevision === revision);
    // A facade reply has no reaction job. Its accepted person turn remains
    // pending until the assistant final or an authoritative end of that call.
    const voice = this.#rail?.ownershipState;
    const liveVoice = Boolean(this.#rail?.session) || voice && !['idle', 'ended'].includes(voice.state);
    const facadeCallId = person?.voiceCallId ?? person?.callId;
    const facadePending = turns.at(-1) === person && facadeCallId &&
      !(voice?.callId === facadeCallId && voice.state === 'ended');
    const waiting = liveVoice || facadePending || this.#laneStatusPending === revision ||
      this.#deferredAnalysis === revision || this.#analysisRecovery === revision;
    root.querySelector('.retry').disabled = !analysis.available;
    if (!this.#host?.usedUp) root.querySelector('.retry').hidden = locked || !analysis.available || (waiting && !this.#failure) || Boolean(running) || !(this.#failure || hasPersonTurn &&
      (missingReply || !understandingDeferred(this.#session) && (stale || u.draft)));
    // Real pending work owns the slot before failure; an existing assessment
    // keeps its draft/stale copy while its replacement runs.
    const analysisRunning = operations?.inputRevision === revision && operations.running.includes('understanding');
    const scheduledAnalysis = this.#deferredAnalysis === revision || this.#analysisRecovery === revision || missingReply && waiting;
    const preparing = !u.readinessAssessed && (analysisRunning || (analysis.available || cached) && scheduledAnalysis && !this.#failure);
    const consentMissing = hasPersonTurn && isConsentReason(analysis.rawReason);
    // A purpose stop deliberately schedules no replacement reply after consent
    // invalidates old replies; that idle state has no missing work to retry.
    const stuck = missingReply && this.#session.pauseReason !== 'purpose' &&
      !running && !waiting && !this.#failure && (analysis.available || this.#session.paused);
    const failures = operations?.inputRevision === revision ? operations.failures ?? [operations.lastFailure].filter(Boolean) : [];
    const replyFailed = failures.some(f => f.lane === 'reaction');
    const overviewFailed = failures.some(f => f.lane === 'understanding');
    let replyNotice = root.querySelector('.reaction-failure');
    if (!replyNotice) {
      replyNotice = node('p', 'reaction-failure'); replyNotice.setAttribute('role', 'status');
      replyNotice.append(node('span', 'reaction-failure-text'));
      root.querySelector('.transcript-shell ol').after(replyNotice);
    }
    const itemRetry = this.#clarify?.state === 'retry';
    const identityReplyFailed = failures.some(f => f.lane === 'reaction' && f.reason === 'identity-changed');
    const replyRetry = replyFailed && (overviewFailed || identityReplyFailed && (!analysis.available || locked)) && !itemRetry;
    if (identityReplyFailed && !itemRetry && !this.#host?.usedUp) {
      root.querySelector('.retry').hidden = Boolean(running);
      root.querySelector('.retry').disabled = !this.#feature('text').available || Boolean(running);
    }
    if (itemRetry) root.querySelector('.retry').hidden = true;
    replyNotice.hidden = !replyFailed;
    // Several failed lanes share one action at the first failure in reading
    // order. Keep its handler and node while the project action keeps its slot.
    const retry = root.querySelector('.retry'), retrySlot = replyRetry ? replyNotice : root.querySelector('.understanding > .foot');
    if (retry.parentNode !== retrySlot) retrySlot.insertBefore(retry, replyRetry ? null : retrySlot.querySelector('.export-reason'));
    setText(replyNotice.querySelector('.reaction-failure-text'), replyFailed
      ? `${copy.reasoningFailed}${replyRetry && !retry.hidden && !this.#host?.usedUp ? reasonSeparator : ''}` : '');
    const failedOverview = hasPersonTurn && !consentMissing && !preparing &&
      (this.#failure && (overviewFailed || this.#failureLane === 'understanding') || stuck) &&
      !locked && !reconciling && !this.#host?.usedUp;
    // Project creation follows the overview, independently of Retry placement.
    // Keep its measured slot while failed, stale or unfinished work is replaced.
    const currentOverview = u.readinessAssessed && !stale && !u.draft && !overviewFailed && !failedOverview &&
      !analysisRunning && !scheduledAnalysis && !locked;
    aside.dataset.overview = currentOverview ? 'current' : 'unavailable';
    const create = root.querySelector('.create-project');
    if (create) create.inert = !currentOverview || this.#session.processingPreset === 'device';
    const overviewText = !hasPersonTurn ? copy.empty : preparing ? copy.preparingOverview
      : failedOverview ? `${copy.understandingFailed}${replyFailed ? '.' : reasonSeparator}`
      : this.#failure && !replyFailed && !reconciling ? copy.reasoningFailed
      : !analysis.available && !cached && this.#session.pauseReason !== 'purpose' && !reconciling ? analysis.reason
      : !u.readinessAssessed && replyFailed && missingReply && this.#session.pauseReason !== 'purpose' ? copy.overviewPendingReply
      : !u.readinessAssessed ? copy.noProjectDetails
      : stale && this.#session.pauseReason !== 'purpose' ? copy.stale : u.draft ? copy.draft : copy.final;
    const notice = root.querySelector('.notice'), overviewRetry = root.querySelector('.overview-retry');
    // Assessment labels have no visual slot; consent, pending and failure notices stay visible.
    const blocked = !this.#host?.usedUp && paintConsentLine(root.querySelector('.notice-text'), {
      copy, feature: 'analysis', verdict: hasPersonTurn ? analysis : { available: true }, text: overviewText,
      open: opener => this.#dialog.openConsent('analysis', opener),
    });
    notice.toggleAttribute('data-current', !blocked && overviewText === copy.final);
    notice.toggleAttribute('data-assessment', !blocked && (overviewText === copy.final || overviewText === copy.draft));
    overviewRetry.hidden = itemRetry || !failedOverview || replyFailed;
    overviewRetry.disabled = !analysis.available || Boolean(running);
    setText(overviewRetry, failedOverview && !replyFailed ? copy.understandingRetry : '');
    // Keep the same Retry node across live renders, and leave the consent
    // slot with exactly its own action when no inline retry is shown.
    if (failedOverview && !replyFailed) {
      if (overviewRetry.parentNode !== notice) notice.append(overviewRetry);
      root.querySelector('.retry').hidden = true;
    } else if (overviewRetry.parentNode === notice) notice.after(overviewRetry);
    root.querySelector('.retry').style.visibility = this.#host?.usedUp ? 'hidden' : '';
    root.querySelector('.retry').inert = Boolean(this.#host?.usedUp);
    root.querySelector('.summary-text').textContent = summary ? u.summary : '';
    reconcile(root.querySelector('.signals'), textKeys(u.signals),
      () => element('li'), (row, value) => setText(row, value));
    const items = readinessListItems(u.constraints, u.questionHistory, u.openQuestions, copy.constraints, this.#session.preset);
    const cleared = newlyClearedFirst(this.#open, this.#cleared, items.cleared);
    this.#open = items.open.map(i => i.key); this.#cleared = cleared.map(i => i.key);
    const window = readinessListWindow(items.open);
    reconcile(root.querySelector('.missing'), window.rows.length ? window.rows.map(i => [i.key, i]) : [[NONE, null]],
      i => i ? element('li') : element('li', copy.noneYet, 'none-yet'), (row, i) => {
        if (!i) { setText(row, copy.noneYet); return; }
        const label = row.querySelector('strong');
        if (i.label) setText(label ?? row.insertBefore(element('strong'), row.firstChild), i.label); else label?.remove();
        setText(row.querySelector('span') ?? row.appendChild(element('span')), i.detail);
      });
    root.querySelector('.overflow').textContent = window.remainder ? copy.more.replace('{count}', window.remainder) : '';
    // Summaries keep their nodes, so keyboard focus survives unsolicited updates.
    reconcile(root.querySelector('.cleared'), cleared.length ? cleared.map(i => [i.key, i]) : [[NONE, null]], i => {
      if (!i) return element('p', copy.noneYet, 'none-yet');
      const details = element('details'); details.append(element('summary'), element('p'));
      details.addEventListener('toggle', () => this.#expandLabel()); return details;
    }, (details, i) => {
      if (!i) { setText(details, copy.noneYet); return; }
      setText(details.querySelector('summary'), i.label ?? i.detail);
      const value = details.querySelector('p'), evidence = i.evidence ? element('blockquote', i.evidence) : null;
      evidence?.setAttribute('aria-label', copy.evidence);
      if (value.firstChild?.nodeValue !== (i.label ? i.detail : copy.none) || value.querySelector('blockquote')?.textContent !== i.evidence) {
        value.replaceChildren(i.label ? i.detail : copy.none, ...evidence ? [evidence] : []);
      }
    });
    this.#expandLabel();
    this.#syncPanes();
  }
  // Art. 50(1): the footer notice stands from the first paint; its full sentence remains the
  // accessible description of interaction controls. Host wording and voice-offered gating stay intact.
  #paintNotice() {
    const root = this.shadowRoot, pick = part => [this.#aiNotice?.[part], this.#copy.aiNotice?.[part]].find(value => typeof value === 'string' && value.trim());
    const notice = aiNotice(this.#session.locale, { text: pick('text'), voice: pick('voice') });
    setText(root.querySelector('#ai-notice'), this.#voiceOffered() ? `${notice.text} ${notice.voice}` : notice.text);
    setText(root.querySelector('.ai-notice__label'), this.#copy.assistant);
    setText(root.querySelector('.ai-notice__short'), this.#copy.layout.aiShort);
    root.querySelector('.ai-notice').setAttribute('aria-label', `Aithema 2026.10${reasonSeparator}${this.#copy.layout.aiShort}`);
    if (this.#voiceBound) setText(root.querySelector('.ai-notice__voice'), this.#copy.layout.syntheticVoice);
    setText(root.querySelector('.phone-status__label'), this.#connection || this.#copy.connecting);
  }
  // Replies can be spoken here: voice is available now, or once consent, a resume or the provider allows it.
  #voiceOffered() {
    const preset = this.#session.processingPreset ?? 'best', voice = this.#session.featureMatrix?.[preset]?.voice;
    return this.#voiceBound && preset !== 'device' && Boolean(this.#voiceClientFor()) && Boolean(voice?.available || isDynamicReason(voice?.reason));
  }
  #watchBrand() {
    this.#brandObserver?.disconnect();
    const root = this.shadowRoot, slot = root.querySelector('slot[name="brand"]');
    const sync = () => {
      const brand = slot.assignedElements()[0];
      root.querySelector('.wordmark').classList.toggle('visually-hidden', !brand);
      root.querySelector('.band').toggleAttribute('data-branded', Boolean(brand));
      const text = brand?.textContent.replace(/\s+/gu, ' ').trim() || 'Host';
      setText(root.querySelector('.host-version__label'), text);
      root.querySelector('.host-version').hidden = !renderHostVersion(root.querySelector('.host-version__value'), this.#options.host?.version ?? {});
    };
    const Observer = this.ownerDocument.defaultView?.MutationObserver;
    if (Observer) {
      this.#brandObserver = new Observer(sync);
      for (const brand of slot.assignedElements()) this.#brandObserver.observe(brand, { subtree: true, childList: true, characterData: true });
    }
    sync();
  }
  #engineDetail() {
    const copy = this.#copy, preset = this.#session.processingPreset ?? 'best', view = engineView(this.#session);
    const d = copy.display, name = copy.presets[preset] ?? d.presetUnknown;
    const scope = preset === 'device' ? d.device : preset === 'eu' ? d.eu : d.international;
    const servedName = route => modelDisplayName(route, copy, route === view.model?.id ? view.model?.label : undefined);
    const reply = preset === 'device' ? d.localModel : servedName(view.model?.reply ?? view.model?.id);
    const understanding = preset === 'device' ? d.localModel : servedName(view.model?.understanding ?? view.model?.id);
    const provider = { openrouter: 'OpenRouter', mistral: 'Mistral', mock: d.testProvider }[view.model?.provider] ?? d.hostProvider;
    const presentation = typeof this.#options.voicePresentation === 'function'
      ? this.#options.voicePresentation(this.#session.locale, view.voice)
      : this.#options.voicePresentation ?? this.#voiceClientFor()?.manifest?.presentation;
    const voice = view.voice === SETTINGS_OFF ? copy.engine.off
      : presentation?.translations?.find(item => item.locale === this.#session.locale)?.label
        ?? presentation?.label ?? view.voice?.label ?? this.#voiceClientFor()?.manifest?.vendor?.name ?? d.hostProvider;
    return [`${name}, ${scope}`, `${d.reply}: ${reply}`, `${d.understanding}: ${understanding}`,
      `${d.via.replace('{provider}', preset === 'device' ? d.deviceProvider : provider)}${this.#voiceBound ? `${reasonSeparator}${d.voice}: ${voice}` : ''}`].join('\n');
  }
  #renderEngine() {
    const root = this.shadowRoot, preset = this.#session.processingPreset ?? 'best';
    root.querySelector('.engine__value').textContent = this.#copy.presets[preset] ?? this.#copy.display.presetUnknown;
    root.querySelector('.engine__detail').textContent = this.#engineDetail();
    root.querySelector('.engine-info').setAttribute('aria-label', this.#copy.display.modelInfo);
    const kind = this.#session.locale;
    const flag = root.querySelector('.engine__flag');
    if (flag.dataset.kind !== kind) { flag.dataset.kind = kind; flag.innerHTML = languageFlag(kind); }
  }
  #syncPanes() {
    for (const pane of this.shadowRoot.querySelectorAll(PANES)) {
      pane.toggleAttribute('data-top', pane.scrollTop > 4);
      pane.toggleAttribute('data-bottom', pane.scrollTop + pane.clientHeight < pane.scrollHeight - 4);
    }
  }
  // Measure the actual brand and reserved actions, so host copy/account changes
  // reserve controls and a complete status in the single row. Row placement does not
  // change either measurement and therefore cannot oscillate.
  #syncRailFit() {
    const root = this.shadowRoot, band = root.querySelector('.band');
    // The host stylesheet hides unmounted components. A zero-width measurement
    // must not select a second row that would flash before the first visible fit.
    if (!band?.querySelector('.audio-rail') || !band.clientWidth) return;
    const view = this.ownerDocument.defaultView;
    const style = view.getComputedStyle(band), rail = band.querySelector('.audio-rail');
    const label = rail.querySelector('.voice-state');
    const range = this.ownerDocument.createRange(); range.selectNodeContents(label);
    const labelStyle = view.getComputedStyle(label), railStyle = view.getComputedStyle(rail);
    // A message bubble does not consume the inline status track. Measure the
    // rendered text (not the capped label box) for host-supplied inline labels.
    const textWidth = rail.hasAttribute('data-message') ? 0 : range.getBoundingClientRect().width;
    const required = Math.max(voiceRailMinWidth, Math.ceil(textWidth + parseFloat(labelStyle.paddingLeft)
      + parseFloat(labelStyle.paddingRight) + 4 * (44 + parseFloat(railStyle.columnGap))));
    const tracks = style.gridTemplateColumns.split(' ').map(Number.parseFloat);
    const railTrack = tracks.length === 3 ? tracks[1] : 0;
    // Honor the CSS reservation, but keep older hosts with wider actions safe.
    // The computed track ignores flex-content gaps and does not change with
    // row placement, so this fallback cannot oscillate.
    const reserved = style.getPropertyValue('--aithema-header-rail-row').trim();
    if (reserved) {
      band.toggleAttribute('data-rail-row', reserved === '2' || this.ownerDocument.defaultView.innerWidth < voiceSingleRowMinWidth || railTrack < required);
      return;
    }
    const available = Math.min(railTrack, band.clientWidth - parseFloat(style.paddingLeft) - parseFloat(style.paddingRight)
      - root.querySelector('.band-identity').getBoundingClientRect().width
      - root.querySelector('.header-actions').getBoundingClientRect().width - 2 * parseFloat(style.columnGap));
    band.toggleAttribute('data-rail-row', this.ownerDocument.defaultView.innerWidth < voiceSingleRowMinWidth || available < required);
  }
  #observePanes() {
    this.#paneObserver?.disconnect();
    const Observer = this.ownerDocument.defaultView?.ResizeObserver;
    if (Observer) {
      this.#paneObserver = new Observer(() => {
        const band = this.shadowRoot.querySelector('.band');
        this.#syncRailFit();
        this.shadowRoot.querySelector('.edge-column').style.setProperty('--band-height', `${band.getBoundingClientRect().height}px`);
        this.#syncPanes();
      });
      for (const selector of ['.band', '.band-identity', '.header-actions']) this.#paneObserver.observe(this.shadowRoot.querySelector(selector));
      this.#syncRailFit();
      for (const pane of this.shadowRoot.querySelectorAll(PANES)) {
        this.#paneObserver.observe(pane); for (const child of pane.children) this.#paneObserver.observe(child);
      }
    }
    for (const pane of this.shadowRoot.querySelectorAll(PANES)) {
      if (pane.dataset.scrollBound) continue;
      pane.dataset.scrollBound = 'true';
      pane.addEventListener('scroll', () => {
        this.#syncPanes(); pane.setAttribute('data-scrolling', ''); clearTimeout(this.#scrollTimers.get(pane));
        this.#scrollTimers.set(pane, setTimeout(() => { pane.removeAttribute('data-scrolling'); this.#scrollTimers.delete(pane); }, 700));
      }, { passive: true });
    }
    this.#syncPanes();
  }
  // Anything the visitor contributed (or its withdrawal) means the conversation has begun.
  #hasInput() {
    const session = this.#session;
    return Boolean(session.transcript.length || session.uploads?.length || this.#partials.size || session.tombstone);
  }
  // START's journey (index.astro data-entry, data-choosing-preset): the entrance with the processing
  // choice, readiness once a choice is confirmed, then the live conversation after an explicit start or
  // once the conversation has input. A pause or a running call also shows the live view (its controls).
  #stage() {
    if (this.#host?.usedUp) return 'live';
    if (this.#hasInput() || this.#started || this.#session.paused || this.#rail?.root.dataset.call === 'active') return 'live';
    return this.#chooser.confirmed || (this.#session.settings?.origin ?? 'default') === 'chosen' ? 'ready' : 'entrance';
  }
  #renderIntro() {
    const root = this.shadowRoot, workspace = root.querySelector('.workspace'), intro = root.querySelector('.intro'), active = root.activeElement;
    const focus = active && intro.contains(active) ? active.dataset.focusKey : null;
    const stage = this.#stage(), mode = { entrance: 'chooser', ready: 'ready' }[stage] ?? '';
    workspace.dataset.stage = stage;
    // Understanding is absent before the first input, then opens beside the conversation (START, ~560 ms).
    // A host verification lock holds its email form there, so the pane is present while it is locked.
    const understanding = this.#hasInput() || this.#host?.locked ? 'present' : 'absent';
    // Only an opening on screen animates (data-reveal): the first paint of a conversation that already has input does not.
    if (understanding === 'present' && workspace.dataset.understanding === 'absent' && intro.hasAttribute('data-mode')) {
      workspace.dataset.reveal = ''; setTimeout(() => workspace.removeAttribute('data-reveal'), REVEAL_MS);
    }
    workspace.dataset.understanding = understanding; root.querySelector('.understanding').inert = understanding === 'absent';
    // Before the start only the entrance is operable: the call and concept rails wait for it.
    for (const control of root.querySelectorAll('.audio-rail')) control.inert = stage !== 'live';
    guardConceptControls(root);
    this.#placeOrb(stage);
    intro.dataset.mode = mode; intro.hidden = !mode;
    const card = intro.querySelector('.intro__card');
    if (!mode) { card.replaceChildren(); return; }
    // The card is built once per mode and its controls are keyed and updated in place, so a
    // live update keeps the hovered and focused nodes, and #anchored keeps them still (AIT-116 D2).
    if (card.firstElementChild?.className !== mode) card.replaceChildren(mode === 'ready' ? this.#readyCard() : this.#chooserCard());
    if (mode === 'ready') this.#paintReady(card.firstElementChild); else this.#paintChooser(card.firstElementChild);
    if (focus && !intro.contains(root.activeElement)) intro.querySelector(`[data-focus-key="${focus}"]`)?.focus();
  }
  // AIT-140's 40 px orb stays the first band item. START's entrance retains its large, quiet object.
  #placeOrb() {
    this.#orb ??= createOrb(this.ownerDocument, { motion: this.#motion });
    const dock = this.shadowRoot.querySelector('.band-orb');
    if (this.#orb.element.parentNode !== dock) dock.append(this.#orb.element);
    this.#introOrb ??= createOrb(this.ownerDocument, { motion: this.#motion });
    const intro = this.shadowRoot.querySelector('.intro__orb');
    if (this.#introOrb.element.parentNode !== intro) intro.append(this.#introOrb.element);
    if (this.isConnected) {
      this.#orb.mount();
      this.#introOrb.mount();
    }
  }
  #mountMotion() {
    const view = this.ownerDocument.defaultView;
    this.#motionMedia = view?.matchMedia?.('(prefers-reduced-motion: reduce)');
    let storage; try { storage = view?.localStorage; } catch { /* Private browsing. */ }
    this.#motion = motionPreference(storage, this.#motionMedia?.matches);
    this.#motionListener = () => { this.#motion = motionPreference(storage, this.#motionMedia.matches); this.#applyMotion(); };
    this.#motionMedia?.addEventListener?.('change', this.#motionListener);
    this.shadowRoot.querySelector('.motion-toggle').addEventListener('click', () => {
      this.#motion = !this.#motion; rememberMotion(storage, this.#motion); this.#applyMotion();
    });
    this.#applyMotion();
  }
  #paintMotion() {
    const button = this.shadowRoot.querySelector('.motion-toggle'); if (!button) return;
    button.setAttribute('aria-pressed', String(this.#motion));
    button.title = this.#motion ? this.#copy.layout.motionOff : this.#copy.layout.motionOn;
    button.setAttribute('aria-label', button.title);
  }
  #applyMotion() {
    this.setAttribute('motion', this.#motion ? 'on' : 'off'); this.#paintMotion();
    for (const orb of [this.#orb, this.#introOrb]) orb?.setMotion(this.#motion);
    this.#reveal?.setMotion(this.#motion);
    if (this.#rail) this.#rail.motion = this.#motion;
  }
  // Host refusals apply to every preset; consent and temporary limits remain selectable.
  #presetRefusal(preset) {
    const verdict = this.#session.featureMatrix?.[preset]?.text;
    const refused = preset !== (this.#session.processingPreset ?? 'best') && verdict && !verdict.available && !isDynamicReason(verdict.reason);
    return refused ? verdict.reason : null;
  }
  // START LandingPresets: four choices, a summary area that reserves its longest text and a Continue
  // whose position never changes.
  #chooserCard() {
    const copy = this.#copy, c = copy.chooser;
    const section = node('section', 'chooser'); section.setAttribute('aria-labelledby', 'chooser-title');
    const title = node('h3', '', c.title); title.id = 'chooser-title';
    const cards = node('div', 'chooser__list');
    cards.addEventListener('keydown', event => {
      if (!['ArrowDown', 'ArrowUp', 'ArrowLeft', 'ArrowRight', 'Home', 'End'].includes(event.key)) return;
      const options = [...cards.querySelectorAll('.chooser-option')].filter(card => card.getAttribute('aria-disabled') !== 'true');
      if (!options.length) return;
      event.preventDefault();
      const index = options.indexOf(event.target.closest('.chooser-option'));
      const next = event.key === 'Home' ? 0 : event.key === 'End' ? options.length - 1
        : (index + (['ArrowDown', 'ArrowRight'].includes(event.key) ? 1 : -1) + options.length) % options.length;
      options[next].focus(); options[next].click();
    }); cards.setAttribute('role', 'group'); cards.setAttribute('aria-labelledby', 'chooser-title');
    const summary = node('div', 'chooser__summary');
    const live = node('strong'); live.setAttribute('role', 'status');
    summary.append(live, ...[c.choose, c.saving, ...PRESET_ORDER.map(p => c.summary[p])].map(text => {
      const measure = node('strong', 'chooser__measure', text); measure.setAttribute('aria-hidden', 'true'); return measure;
    }));
    const hint = node('div', 'chooser__hint');
    hint.append(summary, node('span'));
    const go = node('button', 'chooser__continue'); go.type = 'button'; go.dataset.focusKey = 'continue'; go.setAttribute('aria-describedby', 'ai-notice');
    const arrow = node('span', 'chooser__arrow'); arrow.setAttribute('aria-hidden', 'true'); arrow.innerHTML = icon('arrowRight');
    go.append(node('span', '', c.continue), arrow);
    go.addEventListener('click', () => void this.#confirmChoice(go));
    const action = node('div', 'chooser__action'); action.append(hint, go);
    const error = node('p', 'chooser__error'); error.setAttribute('role', 'alert');
    section.append(title, cards, action, error);
    return section;
  }
  #chooserOption(preset) {
    const copy = this.#copy, c = copy.chooser;
    const card = node('button', 'chooser-option'); card.type = 'button'; card.dataset.focusKey = preset; card.dataset.preset = preset;
    const detail = node('span', 'chooser-option__detail'); detail.id = `chooser-${preset}-detail`;
    detail.append(node('span', '', c.lead[preset]), node('span', '', c.detail[preset]));
    card.setAttribute('aria-describedby', `${detail.id} ai-notice`);
    const glyph = node('span', 'chooser-option__icon'); glyph.setAttribute('aria-hidden', 'true'); glyph.innerHTML = ICONS[preset];
    const radio = node('span', 'radio'); radio.setAttribute('aria-hidden', 'true');
    card.append(glyph, radio, node('strong', '', copy.presets[preset]), detail, node('small', 'chooser-option__note'));
    // The verdict is read at click time: it may have changed since the card was built.
    card.addEventListener('click', () => {
      if (this.#chooser.busy) return;
      const refusal = this.#presetRefusal(preset);
      this.#chooser.error = refusal ? `${this.#copy.presets[preset]}: ${reasonText(this.#copy, refusal, 'text')}` : '';
      if (!refusal) this.#chooser.choice = preset;
      this.#render('transcript');
    });
    return card;
  }
  #paintChooser(section) {
    const copy = this.#copy, c = copy.chooser;
    setText(section.querySelector('#chooser-title'), c.title);
    setText(section.querySelector('.chooser__continue > span'), c.continue);
    const measures = [c.choose, c.saving, ...PRESET_ORDER.map(p => c.summary[p])];
    section.querySelectorAll('.chooser__measure').forEach((n, i) => setText(n, measures[i]));
    const choice = this.#chooser.choice ?? this.#session.processingPreset ?? 'best';
    reconcile(section.querySelector('.chooser__list'), PRESET_ORDER.map(preset => [preset, preset]), preset => this.#chooserOption(preset), (card, preset) => {
      setText(card.querySelector('strong'), copy.presets[preset]);
      const details = card.querySelectorAll('.chooser-option__detail > span');
      setText(details[0], c.lead[preset]); setText(details[1], c.detail[preset]);
      const refusal = this.#presetRefusal(preset);
      card.tabIndex = refusal ? -1 : 0;
      card.setAttribute('aria-pressed', String(choice === preset)); card.setAttribute('aria-disabled', String(Boolean(refusal)));
      if (refusal) card.title = reasonText(copy, refusal, 'text'); else card.removeAttribute('title');
      setText(card.querySelector('.chooser-option__note'), refusal ? c.unavailable : '');
    });
    setText(section.querySelector('.chooser__summary [role=status]'), this.#chooser.busy ? c.saving : c.summary[choice] ?? c.choose);
    setText(section.querySelector('.chooser__hint > span'), (this.#session.settings?.origin === 'last' ? `${c.lastChoice} ` : '') + c.later);
    section.querySelector('.chooser__continue').disabled = this.#chooser.busy;
    setText(section.querySelector('.chooser__error'), this.#chooser.error);
  }
  async #confirmChoice(button) {
    if (this.#chooser.busy) return;
    const copy = this.#copy, current = this.#session.processingPreset ?? 'best', choice = this.#chooser.choice ?? current;
    if (this.#presetRefusal(choice)) return;
    if (choice === 'custom') {
      const custom = this.#session.featureMatrix?.custom?.text;
      this.openSettings(button, { continueLabel: true, preset: custom && (custom.available || isDynamicReason(custom.reason)) ? 'custom' : undefined });
      return;
    }
    const sessionId = this.#session.id, view = engineView(this.#session), settings = this.#session.settings ?? {};
    const body = { processingPreset: choice, baseRevision: settings.revision ?? 0, confirm: true };
    const id = value => value === SETTINGS_OFF ? SETTINGS_OFF : value?.id;
    // Confirming the offered preset keeps the offered (possibly last) choice exactly.
    if (choice === current && choice !== 'device') Object.assign(body, { model: view.model?.id, effort: view.effort ?? undefined,
      voice: id(view.voice), visuals: id(view.visuals) });
    for (const key of Object.keys(body)) if (body[key] === undefined || body[key] === null) delete body[key];
    this.#chooser = { ...this.#chooser, busy: true, error: '' }; this.#render('transcript');
    const result = await this.#saveSettings(body);
    if (sessionId !== this.#session.id) return;
    this.#chooser.busy = false;
    if (result.ok) this.#chooser.confirmed = true;
    if (!result.ok) {
      this.#chooser.error = result.error === 'setting-not-allowed' ? copy.settings.notAllowed.replace('{reason}', reasonText(copy, result.body.reason, 'text'))
        : result.error === 'settings-conflict' ? copy.settings.conflict : copy.chooser.failed;
    }
    this.#render('transcript');
    if (result.ok) {
      // Readiness follows; Start takes focus. START continues into consent when the choice is not covered yet.
      this.shadowRoot.querySelector('.ready__start')?.focus();
      if (result.ack.consent?.required) this.#requestConsent('chooser', result.ack.consent.features);
    } else this.shadowRoot.querySelector('.chooser__continue')?.focus();
  }
  // START ConversationReadiness and the readiness card around it (index.astro .v2__consent): the model,
  // consent, microphone and speaker states, a reversible choice to speak or to type, and an explicit start.
  #readyCard() {
    const copy = this.#copy, r = copy.ready, section = node('section', 'ready'); section.setAttribute('aria-labelledby', 'ready-title');
    const title = node('h3', '', r.title); title.id = 'ready-title';
    const route = node('p', 'ready__route'); route.id = 'ready-route';
    const modes = node('div', 'ready__input-slot');
    const start = node('button', 'ready__start'); start.type = 'button'; start.dataset.focusKey = 'start';
    start.setAttribute('aria-describedby', 'ready-route ai-notice');
    const arrow = node('span', 'ready__arrow'); arrow.setAttribute('aria-hidden', 'true'); arrow.innerHTML = icon('arrowRight');
    start.append(node('span', '', r.start), arrow);
    start.addEventListener('click', () => this.#start());
    section.append(title, node('dl'), node('div', 'ready__actions'), route, modes, start);
    if (this.#voiceBound) this.#watchMicrophone();
    return section;
  }
  #readyInput() {
    const r = this.#copy.ready;
    if (!this.#voiceBound) {
      const line = node('p', 'ready__input');
      const glyph = node('span', 'ready__icon'); glyph.setAttribute('aria-hidden', 'true'); glyph.innerHTML = icon('keyboard');
      line.append(glyph, node('span', '', r.textOnly));
      return line;
    }
    const modes = node('div', 'ready__modes'); modes.setAttribute('role', 'group'); modes.setAttribute('aria-label', r.inputMode);
    for (const [mode, glyph, label] of [['voice', 'mic', r.voice], ['type', 'keyboard', r.type]]) {
      const choice = node('button', 'ready__mode'); choice.type = 'button'; choice.dataset.mode = mode; choice.dataset.focusKey = `mode-${mode}`;
      choice.innerHTML = icon(glyph); choice.append(node('span', '', label));
      choice.addEventListener('click', () => { if (choice.getAttribute('aria-disabled') !== 'true') { this.#inputMode = mode; this.#render('transcript'); } });
      modes.append(choice);
    }
    return modes;
  }
  // Voice is offered here only when a voice client exists and the selection allows it (or will, after consent).
  #voiceChoice() {
    const voice = this.#feature('voice'), device = this.#session.processingPreset === 'device';
    return !device && Boolean(this.#voiceClientFor()) && engineView(this.#session).voice !== SETTINGS_OFF && (voice.available || isDynamicReason(voice.reason));
  }
  #mode() { return this.#voiceChoice() ? this.#inputMode ?? 'voice' : 'type'; }
  // Read-only, as START: a permission query never acquires the microphone or starts a provider.
  #watchMicrophone() {
    if (this.#permission) return;
    this.#permission = Promise.resolve().then(() => globalThis.navigator?.permissions?.query?.({ name: 'microphone' })).then(status => {
      if (!status) return;
      const update = () => { this.#microphone = status.state; if (this.shadowRoot.querySelector('.ready')) this.#render('transcript'); };
      status.addEventListener?.('change', update); update();
    }).catch(() => { this.#microphone = 'unknown'; });
  }
  #paintReady(section) {
    const copy = this.#copy, r = copy.ready, device = this.#session.processingPreset === 'device', view = engineView(this.#session);
    setText(section.querySelector('#ready-title'), r.title);
    setText(section.querySelector('.ready__start > span'), r.start);
    const slot = section.querySelector('.ready__input-slot');
    if (Boolean(slot.querySelector('.ready__modes')) !== this.#voiceBound || !slot.firstElementChild) slot.replaceChildren(this.#readyInput());
    slot.querySelector('.ready__modes')?.setAttribute('aria-label', r.inputMode);
    const textOnly = slot.querySelector('.ready__input > span:last-child');
    if (textOnly) setText(textOnly, r.textOnly);
    for (const button of section.querySelectorAll('.ready__mode')) setText(button.querySelector('span'), r[button.dataset.mode]);
    const consent = this.#consentState(), local = this.#device?.model, mode = this.#mode(), voiceMode = mode === 'voice';
    const visuals = device ? SETTINGS_OFF : view.visuals;
    const effort = view.effort, model = modelDisplayName(view.model?.id, copy, view.model?.label);
    const microphone = { granted: [r.micGranted, 'confirmed'], denied: [r.micDenied, 'pending'], prompt: [r.micPrompt, 'pending'] }[this.#microphone] ?? [r.checkOnStart, 'pending'];
    const rows = [
      ['model', 'settings', r.model, device ? local ? `${copy.engine.localModel}: ${local}` : r.notConnected
        : [model, effort && effort !== 'none' ? copy.settings.efforts[effort] ?? effort : null].filter(Boolean).join(reasonSeparator), device && !local ? 'pending' : 'selected'],
      ['consent', 'info', r.consent, consent === 'device' ? r.notNeeded : consent === 'granted' ? r.granted : r.missing, ['device', 'granted'].includes(consent) ? 'confirmed' : 'pending'],
      ...this.#voiceBound ? [
        ['microphone', 'mic', r.microphone, voiceMode ? microphone[0] : r.off, voiceMode ? microphone[1] : 'off'],
        ['speaker', 'volume', r.speaker, voiceMode ? r.onOnStart : r.off, voiceMode ? 'selected' : 'off'],
      ] : [],
      ['visuals', 'concept', r.visuals, visuals !== SETTINGS_OFF ? r.on : r.off, visuals !== SETTINGS_OFF ? 'selected' : 'off'],
    ];
    reconcile(section.querySelector('dl'), rows.map(row => [row[0], row]), ([id, glyph]) => {
      const row = node('div', 'ready__row'); row.dataset.ready = id;
      const dt = node('dt'), dd = node('dd'), mark = node('span', 'ready__icon'), check = node('span', 'ready__check');
      mark.setAttribute('aria-hidden', 'true'); mark.innerHTML = icon(glyph);
      check.setAttribute('aria-hidden', 'true'); check.innerHTML = icon('check');
      dt.append(mark, node('span')); dd.append(check, node('span')); row.append(dt, dd); return row;
    }, (row, [, , label, value, state]) => {
      row.dataset.state = state; setText(row.querySelector('dt > span:last-child'), label); setText(row.querySelector('dd > span:last-child'), value);
    });
    const actions = ['change', ...['missing', 'withdrawn'].includes(consent) ? ['consent'] : []];
    reconcile(section.querySelector('.ready__actions'), actions.map(action => [action, action]), action => {
      const button = node('button', `ready__${action}`, action === 'change' ? r.change : copy.settings.reviewConsent); button.type = 'button'; button.dataset.focusKey = action;
      button.setAttribute('aria-describedby', 'ai-notice');
      button.addEventListener('click', () => { if (action === 'change') this.openSettings(button); else this.#requestConsent('ready'); });
      return button;
    }, (button, action) => setText(button, action === 'change' ? r.change : copy.settings.reviewConsent));
    setText(section.querySelector('.ready__route'), copy.chooser.summary[this.#session.processingPreset ?? 'best'] ?? '');
    const offered = this.#voiceChoice();
    for (const choice of section.querySelectorAll('.ready__mode')) {
      choice.setAttribute('aria-pressed', String(choice.dataset.mode === mode));
      const unavailable = choice.dataset.mode === 'voice' && !offered;
      choice.setAttribute('aria-disabled', String(unavailable));
      if (unavailable) choice.title = this.#feature('voice', true).reason ?? copy.notConfigured; else choice.removeAttribute('title');
    }
  }
  // The explicit start: typing opens the composer; speaking starts the call, the only path to the
  // microphone. A start the current consent does not cover goes to the host's consent first.
  #start() {
    const mode = this.#mode(), feature = this.#feature(mode === 'voice' ? 'voice' : 'text');
    if (!feature.available && isConsentReason(feature.reason)) { this.#requestConsent('ready'); return; }
    this.#started = true; this.#render('transcript'); this.#render('composer');
    // Focus lands where the conversation continues: the composer, or the call's own group (no key there ends it).
    if (mode === 'voice') { void this.#rail.start(); this.shadowRoot.querySelector('.audio-rail').focus(); }
    else this.shadowRoot.querySelector('textarea').focus();
  }
  #withdrawButton(row) {
    const copy = this.#copy, button = document.createElement('button');
    button.className = 'withdraw'; button.type = 'button'; button.innerHTML = icon('close');
    button.title = copy.display.withdraw; button.setAttribute('aria-label', copy.display.withdraw);
    button.addEventListener('click', async () => {
      const sessionId = this.#session.id, turnId = row.dataset.id; button.disabled = true;
      try {
        if (this.#session.processingPreset === 'device') {
          this.#deviceController?.abort();
          this.receive({ sessionId, seq: this.#cursor + 1, type: 'turn.withdrawn',
            data: { turnId, reason: 'withdrawal', at: new Date().toISOString() } });
          return;
        }
        const response = await postJson(`${this.#base}/api/sessions/${sessionId}/withdraw`, { turnId }, { sessionToken: this.#sessionToken });
        if (!response.ok) throw new Error();
        const ack = await response.json(); if (sessionId === this.#session.id) this.receive(ack.event);
      } catch { if (sessionId === this.#session.id) this.#status(copy.controlFailed); }
      finally { button.disabled = false; }
    });
    return button;
  }
  #updateVoiceTranscript(event) {
    const { state, replacement } = voiceTranscriptTransition(this.#voiceTranscript, event);
    if (replacement) {
      const rows = [...this.shadowRoot.querySelectorAll('.turn')];
      const row = rows.find(row => row.dataset.id === replacement.from);
      if (row) {
        if (rows.some(other => other !== row && other.dataset.id === replacement.to)) row.remove();
        else row.dataset.id = replacement.to;
      }
    }
    this.#voiceTranscript = state;
  }
  // Uploads sit in the transcript where they arrived: before the first turn saved after them, and
  // ahead of a running reply. A withdrawn upload keeps the place it had on this page; one already
  // withdrawn when the page loaded has no time left (it was erased) and stands before the turns.
  #transcriptEntries(turns) {
    // Files of one request share a time; the order they were first seen breaks the tie (a state change
    // moves an upload to the end of the session's list).
    const uploads = (this.#session.uploads ?? []).map(upload => {
      if (upload.at && !this.#uploadAt.has(upload.id)) this.#uploadAt.set(upload.id, { at: upload.at, order: this.#uploadAt.size });
      const seen = this.#uploadAt.get(upload.id);
      return { key: `upload:${upload.id}`, upload, at: seen?.at ?? '', order: seen?.order ?? -1 };
    }).sort((a, b) => a.at < b.at ? -1 : a.at > b.at ? 1 : a.order - b.order);
    const entries = []; let next = 0;
    for (const turn of turns) {
      if (turn.at) while (next < uploads.length && uploads[next].at < turn.at) entries.push(uploads[next++]);
      entries.push({ key: turn.id, turn });
      const lowLine = this.#host?.emailAsk?.lowLine ?? this.#host?.emailAsk?.reservedLowLine;
      if (lowLine?.at === turn.id) entries.push({ key: `email-low:${turn.id}`, lowLine });
    }
    entries.push(...uploads.slice(next));
    if (this.#voiceTranscript.pending) entries.push({ key: this.#voiceTranscript.pending.id, turn: this.#voiceTranscript.pending });
    for (const turn of this.#partials.values()) entries.push({ key: turn.id, turn });
    return entries;
  }
  // GUI-27, not a pill: a plain line with a file glyph, the name and Withdraw upload, then the muted
  // size and the state. Every part has its own slot, so no state change moves or resizes the row:
  // the name is one line, the action slot keeps the width of its label after withdrawal, and the
  // state slot is as tall as the longest state of this language (invisible copies stacked under it).
  // Names are text, never markup; the file's contents never reach the page.
  #uploadRow(id) {
    const copy = this.#copy, row = node('li', 'upload'); row.tabIndex = -1;
    const glyph = node('span', 'upload__glyph'); glyph.innerHTML = UPLOAD_ICONS.file;
    const name = node('span', 'upload__name'); name.id = `upload-name-${id}`;
    const sizer = text => { const n = node('small', 'upload__sizer', text); n.setAttribute('aria-hidden', 'true'); return n; };
    const action = node('span', 'upload__action'); action.append(sizer(copy.uploads.withdraw));
    const status = node('span', 'upload__status'); status.append(node('small', 'upload__state'), ...uploadStateTexts(copy).map(sizer));
    row.append(glyph, name, action, node('small', 'upload__size'), status);
    return row;
  }
  #paintUpload(row, upload) {
    const copy = this.#copy, gone = upload.state === 'withdrawn' || Boolean(upload.erased);
    row.dataset.state = gone ? 'withdrawn' : upload.state;
    const name = row.querySelector('.upload__name');
    setText(name, gone ? copy.uploads.withdrawn : upload.filename ?? ''); name.title = gone ? '' : upload.filename ?? '';
    setText(row.querySelector('.upload__size'), gone || !Number.isFinite(upload.bytes) ? '' : formatBytes(upload.bytes, this.#session.locale));
    setText(row.querySelector('.upload__state'), gone ? '' : uploadStateText(copy, upload));
    const button = row.querySelector('.upload-withdraw');
    if (!gone && !button) row.querySelector('.upload__action').prepend(this.#uploadWithdrawButton(row, upload.id));
    if (gone && button) {
      // Focus stays where it was: on the row, never dropped to the page.
      const focused = this.shadowRoot.activeElement === button;
      button.remove(); if (focused) row.focus({ preventScroll: true });
    }
  }
  #uploadWithdrawButton(row, uploadId) {
    const copy = this.#copy, button = node('button', 'upload-withdraw', copy.uploads.withdraw);
    button.type = 'button'; button.setAttribute('aria-describedby', `upload-name-${uploadId}`);
    // Busy is aria-disabled, not disabled: a disabled button would drop keyboard focus to the page.
    button.addEventListener('click', async () => {
      if (button.getAttribute('aria-disabled') === 'true') return;
      const sessionId = this.#session.id; button.setAttribute('aria-disabled', 'true');
      try {
        const path = `${this.#base}/api/sessions/${sessionId}/uploads/${encodeURIComponent(uploadId)}/withdraw`;
        const response = await postJson(sameOrigin(this.ownerDocument.defaultView, path), {}, { sessionToken: this.#sessionToken });
        if (!response.ok) throw new Error();
        const ack = await response.json(); if (sessionId === this.#session.id) this.receive(ack.event);
      } catch { if (sessionId === this.#session.id) this.#status(copy.uploads.withdrawFailed); }
      finally { button.removeAttribute('aria-disabled'); }
    });
    return button;
  }
  // The attach button opens the native picker; files dropped anywhere on the conversation (the
  // transcript or the composer) go the same way. The overlay is absolutely placed: it never moves layout.
  #mountUploads() {
    const root = this.shadowRoot, input = root.querySelector('.attach-input'), zone = root.querySelector('.conversation');
    root.querySelector('.attach__label').textContent = this.#copy.uploads.attach;
    root.querySelector('.drop-overlay strong').textContent = this.#copy.uploads.dropActive;
    root.querySelector('.attach').addEventListener('click', () => {
      const refusal = this.#attachRefusal();
      if (refusal) { this.#uploadRefusal(refusal); return; }
      void this.#loadLimits(); input.click();
    });
    input.addEventListener('change', () => { const files = [...input.files ?? []]; input.value = ''; void this.#attach(files); });
    const carriesFiles = event => [...event.dataTransfer?.types ?? []].includes('Files');
    zone.addEventListener('dragenter', event => {
      if (!carriesFiles(event)) return;
      event.preventDefault(); this.#dragDepth++; this.#dropping(true);
    });
    zone.addEventListener('dragover', event => {
      if (!carriesFiles(event)) return;
      event.preventDefault(); event.dataTransfer.dropEffect = 'copy';
    });
    zone.addEventListener('dragleave', event => {
      if (!carriesFiles(event)) return;
      this.#dragDepth = Math.max(0, this.#dragDepth - 1); if (!this.#dragDepth) this.#dropping(false);
    });
    // A dropped file never navigates the page away, also when uploading is unavailable.
    zone.addEventListener('drop', event => {
      if (!carriesFiles(event)) return;
      event.preventDefault(); this.#dragDepth = 0; this.#dropping(false);
      void this.#attach([...event.dataTransfer.files ?? []]);
    });
  }
  #dropping(on) {
    const zone = this.shadowRoot.querySelector('.conversation'), feature = this.#feature('uploads', true);
    if (on) {
      if (feature.available) void this.#loadLimits();
      setText(zone.querySelector('.drop-overlay strong'), this.#session.pauseReason === 'purpose' ? this.#copy.purposePaused : feature.available ? this.#copy.uploads.dropActive : this.#copy.uploads.unavailable.replace('{reason}', feature.reason));
      setText(zone.querySelector('.drop-overlay span'), feature.available ? dropText(this.#copy, this.#limits, this.#session.locale) : '');
    }
    zone.toggleAttribute('data-dropping', on);
  }
  // Why nothing can be attached right now, or '' when it can. Attach is aria-disabled exactly then, and
  // every way in (the button, the picker's files, a drop) is refused by it before anything is sent.
  #attachRefusal() {
    const copy = this.#copy, feature = this.#feature('uploads', true);
    if (this.#session.pauseReason === 'purpose') return copy.purposePaused;
    if (!feature.available) return copy.uploads.unavailable.replace('{reason}', feature.reason);
    if (this.#uploading) return copy.uploads.busy;
    return uploadsPossible(this.#limits) ? '' : copy.uploads.impossible;
  }
  // Unavailable (consent, preset, extractors, pause) stays focusable and says why when pressed.
  #paintAttach() {
    const root = this.shadowRoot, attach = root.querySelector('.attach'), feature = this.#feature('uploads', true);
    const limits = limitsText(this.#copy, this.#limits, this.#session.locale);
    const unavailable = this.#session.pauseReason === 'purpose' ? this.#copy.purposePaused : feature.available ? '' : this.#copy.uploads.unavailable.replace('{reason}', feature.reason);
    attach.setAttribute('aria-disabled', String(Boolean(this.#attachRefusal())));
    attach.title = unavailable || limits;
    setText(root.querySelector('#attach-limits'), unavailable || limits);
  }
  // Recheck the retained selection without consuming it. Holds clear only the retry action,
  // so a later resume or withdrawal restores a manual retry without uploading anything.
  #retryRefusal() {
    const refusal = this.#attachRefusal();
    if (refusal) return refusal;
    return refusalText(this.#copy, planUploads(this.#retryFiles, { limits: this.#limits, uploads: this.#session.uploads }), this.#session.locale);
  }
  #uploadRefusal(text) {
    if (!this.#retryFiles.length) this.#uploadNotice = text;
    this.#render('composer');
  }
  // Limits are the host's (possibly lowered) values; the route defaults hold until they arrive.
  #loadLimits() {
    if (this.#limitsLoad) return this.#limitsLoad;
    const sessionId = this.#session.id, path = `${this.#base}/api/sessions/${sessionId}/uploads`;
    // Started on the next microtask, so a refusal before sending (another origin) can clear it.
    const load = Promise.resolve().then(async () => {
      try {
        const response = await fetch(sameOrigin(this.ownerDocument.defaultView, path), { headers: this.#headers(), cache: 'no-store', signal: AbortSignal.timeout(5000) });
        if (!response.ok) throw new Error();
        const body = await response.json();
        if (sessionId === this.#session.id && this.isConnected) { this.#limits = uploadLimits(body.limits); this.#render('composer'); }
      } catch { if (this.#limitsLoad === load) this.#limitsLoad = null; }
    });
    this.#limitsLoad = load;
    return load;
  }
  async #attach(files, retry = false) {
    if (!files.length || !this.isConnected) return;
    const copy = this.#copy, sessionId = this.#session.id, refusal = retry ? this.#retryRefusal() : this.#attachRefusal();
    if (refusal) { this.#uploadRefusal(refusal); return; }
    const controller = new AbortController(); this.#uploadController = controller;
    const current = () => !controller.signal.aborted && sessionId === this.#session.id && this.isConnected;
    // An admitted new pick replaces the retained set explicitly; a retry reuses that set.
    const replacement = !retry && this.#retryFiles.length ? copy.uploads.replaced : '';
    this.#retryFiles = []; this.#uploading = true; this.#uploadNotice = replacement; this.#render('composer');
    try {
      await this.#loadLimits();
      if (!current()) return;
      // The host's limits may have arrived just now and leave no room: nothing is sent.
      if (!uploadsPossible(this.#limits)) { this.#uploadNotice = [replacement, copy.uploads.impossible].filter(Boolean).join(reasonSeparator); return; }
      const plan = planUploads(files, { limits: this.#limits, uploads: this.#session.uploads });
      const notices = [replacement, refusalText(copy, plan, this.#session.locale)], count = plan.batches.flat().length;
      if (count) {
        this.#status(plural(copy.uploads.uploading, count));
        let sent = 0;
        for (const batch of plan.batches) {
          const failure = await this.#postUploads(batch, controller.signal);
          if (!current()) return;
          if (failure) {
            // Earlier batches are already attached; keep only the refused and unattempted files.
            if (failure === 'upload-rate-limit') this.#retryFiles = plan.batches.flat().slice(sent);
            else notices.push(failure);
            break;
          }
          sent += batch.length;
        }
        if (sent && this.#session.uploads.some(u => u.state === 'pending')) { this.#reading = plural(copy.uploads.received, sent); this.#status(this.#reading); }
        else this.#clearNotice();
      }
      this.#uploadNotice = notices.filter(Boolean).join(reasonSeparator);
    } finally {
      if (this.#uploadController === controller) {
        this.#uploadController = null; this.#uploading = false;
        if (this.isConnected) this.#render('composer');
      }
    }
  }
  #cancelUploads() {
    clearTimeout(this.#uploadRetryTimer); this.#uploadRetryTimer = null;
    this.#retryFiles = []; this.#uploadController?.abort();
  }
  #waitForUploadRetry(delay, signal) {
    if (signal.aborted) return Promise.resolve();
    return new Promise(resolve => {
      const finish = () => {
        clearTimeout(timer); this.#uploadRetryTimer = null;
        signal.removeEventListener('abort', finish); resolve();
      };
      const timer = setTimeout(finish, delay); this.#uploadRetryTimer = timer;
      signal.addEventListener('abort', finish, { once: true });
    });
  }
  /** One multipart request, with at most three attempts for busy; keep the same receipt ID on retries. */
  async #postUploads(files, signal) {
    const copy = this.#copy, sessionId = this.#session.id, form = new FormData();
    const current = () => !signal.aborted && sessionId === this.#session.id && this.isConnected;
    form.append('clientEventId', crypto.randomUUID());
    for (const file of files) form.append('files', file, file.name);
    let response, body = null;
    try {
      const path = `${this.#base}/api/sessions/${sessionId}/uploads`;
      // A 202 retains its reservation through extraction, so even sequential batches can be busy.
      // Keep the uploading state and notice unchanged until a retry succeeds or all attempts fail.
      for (let attempt = 0; attempt < 3; attempt++) {
        if (!current()) return '';
        response = await postForm(sameOrigin(this.ownerDocument.defaultView, path), form, { sessionToken: this.#sessionToken, signal });
        body = await response.json().catch(() => null);
        if (!current()) return '';
        if (response.status !== 429 || body?.error !== 'upload-rate-limit' || attempt === 2) break;
        await this.#waitForUploadRetry(uploadRetryDelay(response, attempt), signal);
      }
    } catch { return current() ? copy.uploads.failed : ''; }
    if (!current()) return '';
    if (response.ok && body) {
      if (body.limits) this.#limits = uploadLimits(body.limits);
      for (const event of body.events ?? []) this.receive(event);
      return '';
    }
    if (response.status === 409 && body?.reason === 'purpose') return copy.purposePaused;
    if (response.status === 413) return copy.uploads.overLimit;
    if (response.status === 429) return 'upload-rate-limit';
    if (response.status === 403 && typeof body?.reason === 'string') return copy.uploads.unavailable.replace('{reason}', reasonText(copy, body.reason, 'uploads'));
    return copy.uploads.failed;
  }
  #expandLabel() {
    const details = [...this.shadowRoot.querySelectorAll('.cleared details')], button = this.shadowRoot.querySelector('.expand');
    button.textContent = details.length && details.every(d => d.open) ? this.#copy.collapse : this.#copy.expand;
    button.disabled = !details.length;
  }
  async #send(answer) {
    const root = this.shadowRoot, input = root.querySelector('textarea'), button = root.querySelector('.send');
    const option = typeof answer === 'string', content = option ? answer : input.value;
    if (this.#sending || !this.#feature('text').available || !content.trim()) return;
    this.#rail?.notices.clear();
    if (this.#session.processingPreset === 'device') { await this.#sendDevice(content, !option); return; }
    const sessionId = this.#session.id;
    const voiceSession = this.#rail && !this.#rail.paused && !['recovering', 'waiting'].includes(this.#rail.state) ? this.#rail.session : null;
    if (!this.#pending || this.#pending.content !== content) this.#pending = { clientEventId: crypto.randomUUID(), content,
      ...(voiceSession ? { voiceCallId: voiceSession.callId, providerSessionId: voiceSession.providerSessionId } : {}) };
    clearTimeout(this.#savedTimer); this.#saved = false; this.#savedAnnouncement = false;
    this.#sending = true; button.disabled = true; this.#render('composer'); this.#status(this.#copy.sending);
    try {
      const response = await postJson(`${this.#base}/api/sessions/${sessionId}/turns`, this.#pending, { sessionToken: this.#sessionToken });
      if (!response.ok) throw new Error();
      const event = await response.json();
      if (sessionId !== this.#session.id) return;
      this.receive(event);
      const voiceText = voiceSession && voiceSession === this.#rail.session && event.data.voiceCallId === voiceSession.callId;
      if (voiceText) {
        await this.#rail.sendText(content, { deliveryId: this.#pending.clientEventId });
        if (sessionId !== this.#session.id) return;
      }
      if (!option && input.value === content) input.value = '';
      this.#pending = null; this.#sendFailed = false;
      if (voiceText) this.#status(this.#copy.voiceTextSent); else this.#confirmSaved();
    } catch { if (sessionId === this.#session.id) { this.#sendFailed = true; this.#clearNotice(); } }
    finally { if (sessionId === this.#session.id) { this.#sending = false; button.disabled = !this.#feature('text').available; this.#render('composer'); this.#host?.update(); } }
  }
  async #sendDevice(content, clearInput = true) {
    const root = this.shadowRoot, button = root.querySelector('.send'), input = root.querySelector('textarea'), device = this.#device;
    if (!device) { this.#status(this.#copy.deviceConnectFirst); return; }
    this.#sending = true; button.disabled = true; const controller = new AbortController(); this.#deviceController = controller;
    this.#render('composer');
    const sessionId = this.#session.id, deadlineAt = Date.now() + 180_000;
    const current = () => !controller.signal.aborted && sessionId === this.#session.id;
    try {
      await device.connect({ signal: controller.signal, deadlineAt });
      if (!current()) return;
      this.receive({ seq: this.#cursor + 1, type: 'turn.final', data: { id: crypto.randomUUID(), role: 'user', content } });
      if (clearInput && input.value === content) input.value = '';
      const id = crypto.randomUUID(), revision = inputRevision(this.#session), origin = aiTextOrigin({ model: device.model, plugin: device.id }), reply = new ReplyStream();
      // The device has no assessment lane: retain its canonical-turns-only context contract.
      const request = { ...reasoningRequest(this.#session, 'reaction'), documentMessageIndex: null,
        messages: activeTurns(this.#session).map(({ role, content }) => ({ role, content })) };
      for await (const delta of device.stream(request,
        { signal: controller.signal, deadlineAt })) {
        if (!current()) return;
        const text = reply.push(delta);
        if (text) this.receive({ type: 'turn.partial', data: { id, delta: text, ...origin, inputRevision: revision } });
      }
      if (current()) this.receive({ seq: this.#cursor + 1, type: 'turn.final', data: { id, role: 'assistant', ...reply.finish(), ...origin, inputRevision: revision } });
      if (current()) this.#status(this.#copy.deviceConversation);
    } catch { if (current()) { this.#partials.clear(); this.#render('transcript'); this.#status(this.#copy.deviceUnavailable); } }
    finally { if (sessionId === this.#session.id) { this.#sending = false; button.disabled = !this.#feature('text').available; this.#render('composer'); } }
  }
  receive(event) { this.#anchored(() => this.#receive(event)); }
  #receive(event) {
    if (event.sessionId && event.sessionId !== this.#session.id) return;
    if (event.seq) {
      if (event.seq <= this.#cursor) return;
      // A withdrawn upload revokes what was derived from it, like a withdrawn statement. (A replayed
      // earlier state whose content is gone is only a tombstone; its withdrawal follows in the journal.)
      // Draft-only saves advance consent without invalidating the conversation,
      // matching the core reducer's checks before preserving browser processing.
      const consentRevised = event.type === 'consent.revised';
      if (consentRevised) { this.#watchConsentRefresh(event.data.granted, event.data.changed, event.data.removed); this.#concept.reviseConsent(event.data.changed, event.data.granted, event.data.removed); }
      const conversationUnchanged = consentRevised && event.data.granted &&
        event.data.conversationUnchanged === true && !this.#session.consentWithdrawn;
      const invalidation = ['turn.withdrawn', 'session.erased'].includes(event.type) ||
        consentRevised && !conversationUnchanged ||
        event.type === 'upload.state' && event.data.state === 'withdrawn';
      if (invalidation) {
        this.#clarify = null; this.#clarifyReplies.clear(); this.#clarifyAsked.clear();
        this.#updateVoiceTranscript({ type: 'reset' });
        this.#invalidatedAt = Math.max(this.#invalidatedAt, event.seq);
        this.#deviceController?.abort();
        void this.#rail?.close(event.type === 'turn.withdrawn' ? 'turn-withdrawn' : event.type === 'session.erased' ? 'session-erased'
          : consentRevised ? 'consent-revised' : 'upload-withdrawn');
        this.#partials.clear(); this.#failure = false;
        // Redact sensitive content immediately, holding row heights while the pointer rests there.
        for (const row of this.shadowRoot.querySelectorAll('.turn')) {
          const turn = this.#session.transcript.find(t => t.id === row.dataset.id);
          if (event.type === 'session.erased' || turn?.role === 'assistant' || row.dataset.id === event.data.turnId || row.classList.contains('partial')) {
            row.style.minHeight = `${row.getBoundingClientRect().height}px`;
            row.querySelector('.turn-text').textContent = this.#copy.withdrawn;
          }
        }
        for (const selector of ['.summary-text', '.signals', '.questions', '.missing', '.cleared', '.overflow']) {
          const node = this.shadowRoot.querySelector(selector);
          node.style.minHeight = `${node.getBoundingClientRect().height}px`; node.dataset.redacted = '';
          node.textContent = '';
        }
      }
      if (event.seq !== this.#cursor + 1) {
        if (invalidation) {
          this.#session = applyEvent(this.#session, event);
          this.#concept.update(this.#session); this.#render('transcript'); this.#render('aside');
        }
        this.#abort?.abort(); void this.#restore(); return;
      }
      const presetBefore = this.#session.processingPreset, settingsBefore = this.#session.settings;
      this.#session = applyEvent(this.#session, event); this.#cursor = event.seq;
      // Every acknowledged journal event is a floor for older snapshot responses, including
      // the locale acknowledgement and a first turn arriving while that response is in flight.
      this.#invalidatedAt = Math.max(this.#invalidatedAt, event.seq);
      if (event.type === 'session.locale-changed') this.#repaintLocale();
      if (event.type === 'session.paused') {
        this.#notice = '';
        if (this.#rail && event.data.reason !== 'purpose' && !this.#rail.syncPause(event.data.paused, event.data.pauseRequestId, event.data.resumeRequestId)) {
          this.#session.paused = Boolean(this.#rail.paused);
        }
        if (this.#session.paused) this.#deviceController?.abort(); else this.#pausePrompt = false;
      }
      this.#concept.update(this.#session);
      if (event.type === 'settings.changed') {
        // A changed model, effort or preset supersedes the running reply on the server:
        // its partial text goes, and late fragments tagged with an older revision are ignored.
        const after = this.#session.settings;
        if (settingsBefore?.voice !== after.voice) void this.#rail?.close('provider-changed');
        if (presetBefore !== this.#session.processingPreset || settingsBefore?.model !== after.model || settingsBefore?.effort !== after.effort) {
          this.#partials.clear(); this.#reasoningRevision = after.revision ?? 0;
        }
        // Labels and verdicts belong to the old choice until the snapshot refresh confirms them.
        if (presetBefore !== this.#session.processingPreset) this.#modeChanged(presetBefore);
        this.#renderMode(); this.#dialog?.sync();
        if (this.isConnected) void this.#refreshFeatures();
      }
      if ((invalidation || consentRevised || ['session.paused', 'identity.state', 'identity.unlocked'].includes(event.type)) && this.isConnected) void this.#refreshFeatures();
      if (event.type === 'turn.final') {
        this.#updateVoiceTranscript(event);
        void deliverFocusedReply(this.#rail, event.data).catch(() => {});
        this.#partials.delete(event.data.id);
        if (event.data.role === 'user') {
          this.#partials.clear(); this.#failure = false;
          // turn.final and lane.status are separate events; only a status or
          // snapshot for this revision can confirm that no work was scheduled.
          if (this.#session.processingPreset !== 'device') this.#laneStatusPending = inputRevision(this.#session);
        }
      }
      // Every upload state is new input: a running reply belongs to the input before it.
      if (event.type === 'upload.state') {
        this.#partials.clear(); this.#failure = false;
        // "Reading them…" ends with the last pending file; each chip then says how it went.
        if (this.#reading && this.#notice === this.#reading && !this.#session.uploads.some(u => u.state === 'pending')) this.#notice = '';
      }
      if (['understanding.updated', 'question.focused', 'turn.corrected'].includes(event.type)) {
        void this.#rail?.updateContext().catch(() => {});
      }
      if (event.type === 'turn.corrected') {
        for (const selector of ['.summary-text', '.signals', '.questions', '.missing', '.cleared', '.overflow']) {
          const node = this.shadowRoot.querySelector(selector);
          node.style.minHeight = `${node.getBoundingClientRect().height}px`; node.dataset.redacted = ''; node.textContent = '';
        }
        const row = [...this.shadowRoot.querySelectorAll('.turn')].find(n => n.dataset.id === event.data.id);
        if (row) { row.style.minHeight = `${row.getBoundingClientRect().height}px`; row.querySelector('span').textContent = event.data.content; }
      }
      if (event.type === 'understanding.updated') {
        this.#deferredAnalysis = null; this.#analysisRecovery = null;
        if (this.#session.operations?.lastFailure?.lane !== 'reaction') this.#failure = false;
      }
      this.#host?.receive(event);
      this.dispatchEvent(new CustomEvent('aithema-event', { detail: event, bubbles: true, composed: true }));
    } else if (event.type === 'voice.state') {
      this.#receiveVoiceState(event.data);
      this.#host?.receive(event);
      if (['closing', 'ended'].includes(event.data.state) && this.isConnected) void this.#refreshFeatures();
    } else if (event.type === 'turn.partial' && event.data.inputRevision === inputRevision(this.#session) &&
      (event.data.settingsRevision === undefined || event.data.settingsRevision >= this.#reasoningRevision)) {
      const existing = this.#partials.get(event.data.id);
      this.#partials.set(event.data.id, { id: event.data.id, role: 'assistant', partial: true,
        content: (existing?.content ?? '') + event.data.delta,
        ...(this.#clarify?.requestId && this.#clarify.inputRevision === inputRevision(this.#session) ? { focusRequestId: this.#clarify.requestId } : {}) });
      if (this.#clarify?.requestId && !['selected', 'asked', 'refused'].includes(this.#clarify.state)) {
        this.#clarify.state = 'selected';
        if (globalThis.matchMedia?.('(max-width: 599px)').matches) this.shadowRoot.querySelector('.transcript-shell').scrollIntoView?.({ block: 'start', behavior: 'instant' });
      }
    } else if (event.type === 'lane.status' && event.data.inputRevision === inputRevision(this.#session)) {
      this.#session.operations = event.data; this.#restoreFailure();
    } else if (event.type === 'lane.failed' && (!event.data.inputRevision || event.data.inputRevision === inputRevision(this.#session))) {
      this.#analysisRecovery = null; this.#recordFailure(event.data); this.#partials.clear();
      if (this.#clarify?.requestId && event.data.lane === 'reaction') {
        if (event.data.retryable === false) this.#clarify = null;
        else this.#clarify.state = 'retry';
      }
      this.#host?.receive(event);
    }
    this.#syncClarify();
    this.#render('features'); this.#render('transcript'); this.#render('aside'); this.#render('composer'); this.#renderVoice();
    this.#host?.updateStreaming();
  }
  #receiveVoiceState(state) {
    const voice = this.#rail?.session;
    this.#rail?.receiveState(state);
    if (voice && state.state === 'waiting' && voice.callId === state.callId &&
      voice.providerSessionId === state.providerSessionId && !['tab-takeover', 'server-restart'].includes(state.reason)) voice.lifecycle?.wait(state.reason);
    if (voice && ['closing', 'ended'].includes(state.state) && !recoverableVoiceEnd(state.reason) &&
      voice.callId === state.callId && voice.providerSessionId === state.providerSessionId) void this.#rail.close(state.reason);
    this.#rail?.settlement(state);
  }
  #restoreVoiceEffects(before) {
    if (!this.#rail) return;
    const session = this.#session, lifecycle = session.voiceLifecycle;
    if (lifecycle && JSON.stringify(lifecycle) !== JSON.stringify(before.voiceLifecycle)) this.#receiveVoiceState(lifecycle);
    // Snapshot reads carry no Resume intent. Keep the same media/command fences
    // as a durable pause event, and apply the hold before any context or speech.
    if (session.pauseReason !== 'purpose' &&
      (session.paused !== before.paused || session.paused !== Boolean(this.#rail.paused)) &&
      !this.#rail.syncPause(session.paused)) session.paused = Boolean(this.#rail.paused);
    if (session.paused || session.consentWithdrawn || session.tombstone ||
      ['waiting', 'recovering', 'closing', 'ended'].includes(lifecycle?.state)) return;
    if (JSON.stringify([before.understanding, before.focusedQuestion, before.transcript]) !==
      JSON.stringify([session.understanding, session.focusedQuestion, session.transcript])) void this.#rail?.updateContext().catch(() => {});
    // Only the newly discovered, still-current clarify completion is pending.
    // Adoption precedes delivery, so concurrent restores and late SSE see it as
    // already known even while speech is in flight. Historical replies stay silent.
    const reply = activeTurns(session).at(-1), focus = session.questionFocus;
    if (reply?.role === 'assistant' && focus?.requestId && focus.inputRevision === inputRevision(session) && reply.focusRequestId === focus.requestId &&
      reply.inputRevision === inputRevision(session) && !before.transcript.some(turn => turn.id === reply.id)) {
      void deliverFocusedReply(this.#rail, reply).catch(() => {});
    }
  }
  #watchConsentRefresh(granted, changed, removed) {
    // Missing or unknown scopes retain AIT-364 exactly. Only an explicitly
    // scoped grant may wait for a lagging host ledger under E3.
    const scoped = Array.isArray(changed) && changed.every(scope =>
      FEATURES.some(feature => (feature === 'html' ? 'html-drafts' : feature) === scope));
    const removalOnly = scoped && Array.isArray(removed) && removed.length > 0 && changed.every(scope => removed.includes(scope));
    const scopedGrant = granted === true && scoped && !removalOnly;
    // Repeated saves cannot extend the window or restore a legacy/withdrawal window's grant wait.
    if (this.#consentRefresh) { this.#consentRefresh.scopedGrant &&= scopedGrant; return; }
    const pending = { sessionId: this.#session.id, retries: 0, scopedGrant };
    this.#consentRefresh = pending;
    // Coverage is bounded from the event, including snapshot and document reads.
    pending.timer = consentTimeout(() => this.#failConsentRefresh(pending), 2000);
    pending.timer.unref?.();
  }
  #failConsentRefresh(pending) {
    if (!pending || pending !== this.#consentRefresh || pending.sessionId !== this.#session.id) return;
    clearTimeout(pending.timer); clearTimeout(pending.documentTimer); pending.documentTimer = null;
    pending.failed = true; pending.attempt = null;
    this.#concept.failClosedConsent();
    if (pending.retryTimer || !this.isConnected) return;
    if (pending.retries >= 3) { pending.exhausted = true; return; }
    const delay = [2000, 4000, 8000][pending.retries++];
    pending.retryTimer = consentTimeout(() => {
      pending.retryTimer = null;
      if (pending === this.#consentRefresh && this.isConnected) void this.#refreshFeatures(true);
    }, delay);
    pending.retryTimer.unref?.();
  }
  #retryStaleConsentRefresh(pending) {
    if (!pending || pending !== this.#consentRefresh || pending.sessionId !== this.#session.id) return;
    // Journal activity can overtake either read. Retry the current cursor once
    // immediately, without extending the event's original verification deadline.
    // A persistently stale host or a failed window uses the bounded backoff.
    if (!pending.failed && pending.staleCursor !== this.#cursor) {
      pending.staleCursor = this.#cursor;
      void this.#refreshFeatures(true);
    } else this.#failConsentRefresh(pending);
  }
  async #refreshFeatures(consentRetry = false) {
    if (this.#session.processingPreset === 'device') return;
    const sessionId = this.#session.id, voiceGeneration = this.#rail?.generation, revision = this.#session.consentRevision, pending = this.#consentRefresh;
    // A read begun before the local listening acknowledgement cannot repaint
    // its cached paused verdict afterward, even within the same rail generation.
    const projectionRevision = this.#voiceResumeRevision, resume = this.#voiceResumeProjection;
    const currentResume = () => resume && resume === this.#voiceResumeProjection &&
      resume.generation === this.#rail?.generation && resume.revision === this.#rail?.pauseRevision;
    const restorePaused = () => {
      if (!currentResume()) return;
      this.#voiceResumeProjection = null; this.#session.paused = true;
      this.#rail?.syncPause(true);
      this.#render('features'); this.#render('composer'); this.#render('aside');
      this.#host?.update();
    };
    if (consentRetry && pending?.exhausted) return;
    // Ordinary refresh triggers remain useful after the automatic budget ends.
    if (pending) { clearTimeout(pending.retryTimer); pending.retryTimer = null; }
    const attempt = {};
    if (pending) {
      pending.attempt = attempt;
      // Retries must also time out: a stalled attempt cannot hold the budget open.
      if (pending.failed) {
        clearTimeout(pending.timer);
        pending.timer = consentTimeout(() => this.#failConsentRefresh(pending), 2000);
        pending.timer.unref?.();
      }
    }
    const active = () => sessionId === this.#session.id && projectionRevision === this.#voiceResumeRevision &&
      pending === this.#consentRefresh && (!pending || pending.attempt === attempt);
    const fail = () => { if (active()) { restorePaused(); this.#failConsentRefresh(pending); } };
    try {
      const response = await fetch(`${this.#base}/api/sessions/${sessionId}`, { headers: this.#headers() });
      if (!active()) return;
      if (!response.ok) { fail(); return; }
      const session = await response.json();
      if (!active()) return;
      if (revision !== this.#session.consentRevision || session.consentRevision !== revision ||
        session.seq !== this.#cursor || session.id !== sessionId || voiceGeneration !== this.#rail?.generation) {
        this.#retryStaleConsentRefresh(pending); return;
      }
      // Older reads cannot confirm or roll back a superseding visitor command.
      if (resume && !currentResume()) return;
      if (currentResume()) {
        if (session.paused) restorePaused();
        else this.#voiceResumeProjection = null;
      }
      this.#session.featureMatrix = session.featureMatrix;
      if (typeof session.visualsBound === 'boolean') this.#session.visualsBound = session.visualsBound;
      if (session.operations) { this.#session.operations = session.operations; this.#restoreFailure(); }
      // A credit read can beat the close acknowledgement. Its older waiting
      // projection cannot undo the visitor's local terminal intent.
      if (session.voiceLifecycle && session.voiceLifecycle.callId !== this.#rail?.endedCall?.callId) this.#rail?.receiveState(session.voiceLifecycle);
      if (session.engine) this.#session.engine = session.engine;
      // A changed visuals choice can switch between images and drafts, and their cost.
      if (session.conceptVisualKind) this.#session.conceptVisualKind = session.conceptVisualKind;
      if ('conceptCost' in session) this.#session.conceptCost = session.conceptCost;
      void this.#resumeDeferredAnalysis();
      this.#rail?.reconcileAdmission();
      this.#renderMode(); this.#renderVoice(); this.#concept.update(this.#session); this.#dialog?.sync();
      this.#render('features'); this.#render('aside'); this.#render('composer'); this.#render('transcript');
      this.dispatchEvent(new CustomEvent('aithema-features', { bubbles: true, composed: true }));
      // Feature refusals redact immediately. A slow consent read must never
      // keep a refused artifact alive while the host document is refreshed.
      try {
        const consent = await fetch(`${this.#base}/api/sessions/${sessionId}/consent`, { headers: this.#headers() });
        const doc = consent.ok ? await consent.json() : null;
        if (!active()) return;
        if (revision !== this.#session.consentRevision || session.seq !== this.#cursor) {
          this.#retryStaleConsentRefresh(pending); return;
        }
        if (doc?.consentRevision === revision && Array.isArray(doc.selected) && doc.features) {
          clearTimeout(pending?.timer); clearTimeout(pending?.retryTimer); clearTimeout(pending?.documentTimer);
          this.#consentRefresh = null;
          this.#concept.update(this.#session, doc, true);
        } else if (pending?.scopedGrant && !session.consentWithdrawn && Number.isSafeInteger(doc?.consentRevision) && doc.consentRevision >= 0 && doc.consentRevision < revision && !pending.failed) {
          // A grant can lead its host ledger. Withdrawals retain AIT-364
          // rejection in this response tick; only grants may use the original
          // 2 s watchdog to wait without hiding covered bytes.
          clearTimeout(pending.documentTimer);
          pending.documentTimer = consentTimeout(() => {
            pending.documentTimer = null;
            if (active() && this.isConnected) void this.#refreshFeatures(true);
          }, 100);
          pending.documentTimer.unref?.();
        } else fail();
      } catch { fail(); }
    } catch { fail(); }
  }
  async #restore() {
    const sessionId = this.#session.id, requestedCursor = this.#cursor;
    try {
      const response = await fetch(`${this.#base}/api/sessions/${sessionId}`, { headers: this.#headers() });
      if (!response.ok) throw new Error();
      const session = await response.json();
      if (sessionId !== this.#session.id) return;
      // A restore already in flight cannot overwrite a newer locale acknowledgement or first
      // turn, any more than it may restore withdrawn content. Resume from the newer cursor.
      if (session.seq < this.#invalidatedAt) {
        // Reconnect only when another event advanced us during this fetch. Repeating a gap
        // against the same stale snapshot must not create a synchronous restore loop.
        if (this.#cursor > requestedCursor && this.isConnected) this.#connect();
        return;
      }
      // An accepted snapshot protects its state from older responses to concurrent restores.
      this.#invalidatedAt = Math.max(this.#invalidatedAt, session.seq);
      const before = this.#session;
      this.#session = session; this.#cursor = this.#session.seq; this.#partials.clear(); this.#updateVoiceTranscript({ type: 'reset' });
      this.#restoreVoiceEffects(before);
      this.#repaintLocale();
      this.#syncClarify(); this.#restoreFailure(); this.#concept.update(this.#session); this.#renderMode(); this.#dialog?.sync(); this.#host?.resync();
      this.#render('features'); this.#render('transcript'); this.#render('aside'); this.#render('composer');
      if (this.isConnected) {
        this.#connect();
        if (this.#consentRefresh) void this.#refreshFeatures();
      }
    } catch {
      if (sessionId !== this.#session.id) return;
      this.#connectionStatus(this.#copy.reconnecting);
      const controller = new AbortController(); this.#abort?.abort(); this.#abort = controller;
      await reconnectDelay(controller.signal);
      if (!controller.signal.aborted && sessionId === this.#session.id && this.isConnected) this.#connect();
    }
  }
  #connect() {
    if (this.#session.processingPreset === 'device') return;
    this.#abort?.abort(); const controller = new AbortController(); this.#abort = controller;
    void this.#events(controller.signal);
  }
  async #events(signal) {
    let attempt = 0;
    while (!signal.aborted) {
      let reader;
      try {
        this.#connectionStatus(attempt ? this.#copy.reconnecting : this.#copy.connecting);
        const response = await fetch(`${this.#base}/api/sessions/${this.#session.id}/events`, {
          signal, headers: this.#headers({ 'Last-Event-ID': String(this.#cursor) }),
        });
        if (signal.aborted) return;
        if (response.status === 400) { await this.#restore(); return; }
        if (!response.ok) { if (response.status === 404) void this.#rail?.close(); throw new Error(); }
        this.#connectionStatus(this.#copy.connected); reader = response.body.getReader();
        // A reconnect may follow a host restart: grants held in memory may be gone (D6).
        if (attempt++ > 0) void this.#refreshFeatures();
        for await (const event of serverEvents(reader)) { if (signal.aborted) break; this.receive(event); }
      } catch { if (signal.aborted) return; }
      finally { await reader?.cancel().catch(() => {}); }
      if (signal.aborted) return;
      if (this.#session.operations) this.#session.operations.running = [];
      attempt ||= 1;
      this.#partials.clear(); this.#render('transcript'); this.#render('aside'); this.#connectionStatus(this.#copy.reconnecting);
      await reconnectDelay(signal);
    }
  }
}
if (!customElements.get('aithema-session')) customElements.define('aithema-session', AithemaSession);
