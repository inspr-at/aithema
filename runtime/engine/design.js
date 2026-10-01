import { EngineError, checkClock, json, normalizeError, ref, runtimeCall, systemClock } from './common.js';
import { validateDesignResults } from './metadata.js';
import { canonicalJson } from '../../contracts/validate.js';

/**
 * Explicitly injected, controlled timer-backed stub for scheduler tests.
 * A plan is synchronous and returns {duration_ms:0..60000, fail:boolean, output?}.
 * No attempt can continue behind a timed-out promise; no real renderer runs.
 */
export class ControlledRenderer {
  #clock;
  #plan;
  #active = 0;
  #calls = [];
  constructor(options = {}) {
    runtimeCall(() => {
      const { clock = systemClock, plan = () => ({ duration_ms: 0, fail: false }) } = options;
      checkClock(clock);
      if (typeof plan !== 'function') throw new EngineError('invalid_renderer', 'Controlled renderer requires a plan');
      this.#clock = clock;
      this.#plan = plan;
    });
  }
  get activeCount() { return this.#active; }
  get calls() { return structuredClone(this.#calls); }
  render(input) {
    return runtimeCall(() => {
      const request = json(input);
      const started = this.#clock.now();
      const deadline = request.deadline ?? started + 60_000;
      if (!Number.isFinite(deadline) || started >= deadline) throw new EngineError('renderer_deadline', 'An expired controlled attempt cannot start rendering');
      const plan = json(this.#plan(request));
      if (!Number.isFinite(plan.duration_ms) || plan.duration_ms < 0 || plan.duration_ms > 60_000
          || typeof plan.fail !== 'boolean') throw new EngineError('invalid_renderer', 'Stub attempt must terminate within 60 seconds');
      if (started + plan.duration_ms > deadline) throw new EngineError('renderer_deadline', 'Stub plan exceeds the remaining attempt deadline');
      if (this.#active) throw new EngineError('renderer_overlap', 'Controlled renderer attempts cannot overlap');
      this.#calls.push({ ...request, started_at: this.#clock.now() });
      this.#active++;
      return new Promise((resolve, reject) => {
        this.#clock.setTimeout(() => {
          this.#active--;
          if (plan.fail) reject(new EngineError('render_failed', 'Controlled render attempt failed', { status: 502 }));
          else resolve(plan.output ?? { working_rev: request.revision.working_rev });
        }, plan.duration_ms);
      });
    });
  }
}

/**
 * One scheduler per engine session. Retry serves the same captured revision and
 * same intents. New intents wait for the entire run (including retry) to end.
 * waitMs is inside the fixed 30 s window; audio uses at most its first 20 s.
 * execute may wrap the renderer with the engine's admission/claim gate. It must
 * finish within the attempt deadline. Only compact bindings enter completions;
 * HTML and CSS are regenerated from the acknowledged immutable design.input.
 */
export class DesignScheduler {
  #clock;
  #renderer;
  #execute;
  #revision;
  #wait;
  #pending = [];
  #intents = new Map();
  #runs = [];
  #active = null;
  #endedAt = -Infinity;
  #audio = false;
  #timer = null;
  #stopped = false;
  #onError;
  #onComplete;
  #lastNow = -Infinity;
  #completions = new Map();
  #completionFlight = null;
  #completionTimer = null;
  #observerErrors = 0;

  constructor(options = {}) {
    runtimeCall(() => {
      const { clock = systemClock, renderer, getRevision, execute, waitMs = 30_000, onError = () => {}, onComplete = () => {} } = options;
      checkClock(clock);
      if (!(renderer instanceof ControlledRenderer) || typeof getRevision !== 'function'
          || (execute !== undefined && typeof execute !== 'function') || typeof onError !== 'function' || typeof onComplete !== 'function'
          || !Number.isFinite(waitMs) || waitMs < 0 || waitMs > 30_000) {
        throw new EngineError('invalid_scheduler', 'Controlled renderer, revision reader and wait <=30 seconds required');
      }
      this.#clock = clock;
      this.#renderer = renderer;
      this.#execute = execute ?? ((request) => renderer.render(request));
      this.#revision = getRevision;
      this.#wait = waitMs;
      this.#onError = onError;
      this.#onComplete = onComplete;
    });
  }

  get state() {
    return runtimeCall(() => json({ busy: this.#active !== null, stopped: this.#stopped,
      intents: [...this.#intents.values()], runs: this.#runs,
      pending_completions: [...this.#completions.values()], error_observer_failures: this.#observerErrors }));
  }

  #time() {
    const value = this.#clock.now();
    if (!Number.isFinite(value) || value < this.#lastNow) throw new EngineError('invalid_clock', 'Scheduler clock must be finite and monotonic');
    this.#lastNow = value;
    return value;
  }

  intent(input) {
    return runtimeCall(() => {
      const { intent_id, working_rev } = json(input);
      if (!ref(intent_id) || !Number.isSafeInteger(working_rev) || working_rev < 1) throw new EngineError('invalid_intent', 'Design intent identity and revision required');
      const prior = this.#intents.get(intent_id);
      if (prior) {
        if (prior.working_rev !== working_rev) throw new EngineError('invalid_intent', 'Intent ids are immutable', { code: 'idempotency_conflict', status: 409 });
        return json(prior);
      }
      if (this.#stopped) throw new EngineError('scheduler_stopped', 'Design scheduling is stopped', { status: 409 });
      if (this.#intents.size >= 400) throw new EngineError('intent_bound', 'Session design-intent bound reached', { status: 413 });
      const intent = { intent_id, working_rev, arrived_at: this.#time(), state: 'queued' };
      this.#intents.set(intent_id, intent);
      this.#pending.push(intent);
      this.#schedule();
      return json(intent);
    });
  }

  /** Restore served/failed ids for display without re-admitting their runs. */
  restore(input) {
    return runtimeCall(() => {
      const results = json(input);
      validateDesignResults(results);
      for (const result of results) {
        const prior = this.#intents.get(result.intent_id);
        if (prior) {
          if (['state', 'working_rev', 'rendered_rev', 'attempts'].some((key) => prior[key] !== result[key])
              || canonicalJson(prior.screen ?? null) !== canonicalJson(result.screen ?? null)) {
            throw new EngineError('invalid_intent', 'Restored completion disagrees with scheduler', { code: 'idempotency_conflict', status: 409 });
          }
        } else this.#intents.set(result.intent_id, result);
        this.#completions.delete(result.intent_id);
      }
      if (!this.#completions.size) this.#clock.clearTimeout(this.#completionTimer);
    });
  }

  /** Retry completion writes, never renderer attempts or paid claims. Called
   * after host journal recovery, outside the engine's snapshot queue. */
  recoverCompletions() {
    return runtimeCall(() => {
      if (this.#completionFlight) return this.#completionFlight;
      this.#clock.clearTimeout(this.#completionTimer);
      this.#completionTimer = null;
      if (!this.#completions.size) return Promise.resolve();
      const results = json([...this.#completions.values()]);
      const operation = Promise.resolve().then(async () => {
        await this.#onComplete(results);
        for (const result of results) this.#completions.delete(result.intent_id);
      });
      this.#completionFlight = operation;
      const finished = () => {
        this.#completionFlight = null;
        this.#retryCompletions();
      };
      operation.then(finished, finished);
      return operation;
    });
  }

  #report(error) {
    try {
      Promise.resolve(this.#onError(normalizeError(error))).catch(() => { this.#observerErrors++; });
    } catch { this.#observerErrors++; }
  }

  #retryCompletions() {
    if (this.#stopped || !this.#completions.size || this.#completionTimer !== null) return;
    this.#completionTimer = this.#clock.setTimeout(() => {
      this.#completionTimer = null;
      void this.recoverCompletions().catch((error) => this.#report(error));
    }, 3000);
  }

  setAudioBusy(busy) {
    return runtimeCall(() => {
      if (typeof busy !== 'boolean') throw new EngineError('invalid_audio_state', 'Audio busy must be boolean');
      this.#audio = busy;
      this.#schedule();
    });
  }

  /** Stops new starts only. An active run and its one retry are never cancelled. */
  stop() {
    return runtimeCall(() => {
      this.#stopped = true;
      this.#clock.clearTimeout(this.#timer);
      this.#timer = null;
      this.#clock.clearTimeout(this.#completionTimer);
      this.#completionTimer = null;
    });
  }

  #schedule() {
    if (this.#active || this.#stopped || !this.#pending.length) return;
    this.#clock.clearTimeout(this.#timer);
    const base = Math.max(this.#pending[0].arrived_at, this.#endedAt);
    const start = base + Math.max(this.#wait, this.#audio ? 20_000 : 0);
    this.#timer = this.#clock.setTimeout(() => {
      this.#timer = null;
      void this.#start().catch((error) => {
        this.#stopped = true;
        this.#report(error);
      });
    }, Math.max(0, start - this.#time()));
  }

  #attempt(request) {
    // A slow admission/settlement wrapper cannot extend the rendering window.
    // ControlledRenderer refuses expired starts, and its already-started timer
    // always ends by this deadline. Thus a late wrapper cannot overlap a retry.
    return new Promise((resolve, reject) => {
      let settled = false;
      let expiry;
      const timer = this.#clock.setTimeout(() => {
        // At the exact deadline, let an already-due stub completion resolve
        // before declaring the wrapper late. No additional clock time passes.
        expiry = this.#clock.setTimeout(() => finish(new EngineError('renderer_deadline', 'Controlled attempt exceeded 60 seconds')), 0);
      }, Math.max(0, request.deadline - this.#time()));
      const finish = (error, result) => {
        if (settled) return;
        settled = true;
        this.#clock.clearTimeout(timer);
        this.#clock.clearTimeout(expiry);
        if (error) reject(error); else resolve(result);
      };
      Promise.resolve().then(() => this.#execute(json(request))).then((result) => finish(null, result), (error) => finish(error));
    });
  }

  async #start() {
    if (this.#active || this.#stopped || !this.#pending.length) return;
    const revision = json(this.#revision());
    if (!Number.isSafeInteger(revision.working_rev) || this.#pending.some((i) => i.working_rev > revision.working_rev)) {
      throw new EngineError('stale_design_revision', 'Render must start on the newest working revision');
    }
    const intents = this.#pending.splice(0);
    const run = { started_at: this.#time(), working_rev: revision.working_rev,
      intent_ids: intents.map((i) => i.intent_id), attempts: 0, state: 'rendering' };
    this.#active = run;
    this.#runs.push(run);
    for (const intent of intents) { intent.state = 'rendering'; intent.started_at = run.started_at; }
    let screen;
    try {
      for (let attempt = 1; attempt <= 2; attempt++) {
        run.attempts = attempt;
        const started = this.#time();
        try {
          const result = await this.#attempt({ revision, attempt, deadline: started + 60_000 });
          if (this.#time() - started > 60_000) throw new EngineError('renderer_deadline', 'Controlled attempt exceeded 60 seconds');
          run.state = result?.status === 'denied' || result?.status === 'discarded' ? 'blocked' : 'rendered';
          if (run.state === 'rendered') {
            const output = result?.status === 'ok' ? result.output : result;
            if (['screen_ref', 'design_input_seq', 'design_rev'].some((key) => Object.hasOwn(output ?? {}, key))) {
              if (output.working_rev !== revision.working_rev) throw new EngineError('invalid_output', 'Renderer binding must name the captured working revision');
              const binding = { screen_ref: output.screen_ref, design_input_seq: output.design_input_seq, design_rev: output.design_rev };
              validateDesignResults([{ intent_id: intents[0].intent_id, state: 'rendered',
                working_rev: intents[0].working_rev, rendered_rev: revision.working_rev, attempts: attempt, screen: binding }]);
              screen = binding;
            }
          }
          break;
        } catch (error) {
          run.error = normalizeError(error).reason;
          if (error.code === 'budget_denied' || error.code === 'revoked' || error.code === 'fenced_generation') {
            run.state = 'blocked';
            break;
          }
          if (attempt === 2) run.state = 'render_failed';
        }
      }
    } finally {
      run.ended_at = this.#time();
      for (const intent of intents) {
        intent.state = run.state;
        intent.served_at = run.ended_at;
        intent.rendered_rev = run.working_rev;
        intent.attempts = run.attempts;
        if (screen) intent.screen = json(screen);
      }
      for (const { intent_id, state, working_rev, rendered_rev, attempts } of intents) {
        if (screen) this.#completions.set(intent_id, { intent_id, state, working_rev, rendered_rev, attempts, screen: json(screen) });
        else {
          this.#completions.set(intent_id, { intent_id, state, working_rev, rendered_rev, attempts });
        }
      }
      this.#active = null;
      this.#endedAt = run.ended_at;
      this.#schedule();
      // Rendering has terminated. A failed completion write retains its bytes
      // for retry/recovery; it must never latch off future runs or reactions.
      await this.recoverCompletions().catch((error) => this.#report(error));
    }
  }
}
