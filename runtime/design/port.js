import { systemClock, checkClock } from '../engine/common.js';
import { decodeInput, renderStoredDesign } from './input.js';
import { DesignError } from './validate.js';
import { ControlledRenderer } from '../engine/design.js';
import { canonicalJson } from '../../contracts/validate.js';

/** Real implementation of render({revision, attempt, deadline}). getInput
 * returns exact design.input submission bytes, with stable ids for retries.
 * The injected JournalClient appends before any HTML is produced. Rendering is
 * synchronous. A deadline terminates the returned attempt even if a host read
 * or write stalls. The in-flight guard stays held until that I/O drains; its
 * late completion cannot produce HTML, append late inputs or overlap a retry. */
// AIT-P08's port has a nominal instanceof gate. Inheriting its interface lets
// this implementation replace the stub without editing the scheduler's tree;
// the controlled plan/timer implementation is never called.
export class DesignRenderer extends ControlledRenderer {
  #journal;
  #getInput;
  #clock;
  #active = false;
  #input = null;
  constructor({ journal, getInput, clock = systemClock }) {
    super({ clock });
    checkClock(clock);
    if (typeof journal?.append !== 'function' || typeof getInput !== 'function') {
      throw new DesignError('design_input_invalid', 'Journal append port and revision input reader required');
    }
    this.#journal = journal;
    this.#getInput = getInput;
    this.#clock = clock;
  }
  get activeCount() { return Number(this.#active); }

  async render(request) {
    if (this.#active) throw new DesignError('design_overlap', 'A previous attempt is still active');
    let revision;
    let revisionKey;
    try {
      revision = structuredClone(request?.revision);
      revisionKey = canonicalJson(revision);
    } catch {
      throw new DesignError('design_input_invalid', 'A canonical captured revision is required');
    }
    if (!Number.isSafeInteger(revision?.working_rev) || revision.working_rev < 1
        || ![1, 2].includes(request?.attempt)) {
      throw new DesignError('design_input_invalid', 'A positive working revision and attempt 1 or 2 are required');
    }
    const started = this.#clock.now();
    const deadline = Math.min(request?.deadline, started + 60_000);
    let expired = false;
    const checkDeadline = () => {
      const now = this.#clock.now();
      if (expired || !Number.isFinite(request?.deadline) || !Number.isFinite(deadline)
          || !Number.isFinite(now) || now < started || now >= deadline) {
        throw new DesignError('design_deadline', 'Render attempt deadline expired');
      }
    };
    checkDeadline();
    if (request.attempt === 1 || this.#input?.revisionKey !== revisionKey) this.#input = null;
    this.#active = true;
    let timer;
    const operation = (async () => {
      try {
        if (!this.#input) {
          const raw = await this.#getInput(structuredClone(revision), { attempt: request.attempt });
          checkDeadline();
          if (!(raw instanceof Uint8Array) && typeof raw !== 'string') throw new DesignError('design_input_invalid', 'Input reader must return original UTF-8 submission bytes');
          const bytes = Buffer.from(raw);
          decodeInput(bytes);
          this.#input = { revisionKey, bytes };
        }
        checkDeadline();
        const bytes = this.#input.bytes;
        const record = await this.#journal.append(Buffer.from(bytes));
        checkDeadline();
        if (!(record?.bytes instanceof Uint8Array) || !bytes.equals(Buffer.from(record.bytes))) {
          throw new DesignError('design_input_invalid', 'Host acknowledgement changed the input bytes');
        }
        const result = renderStoredDesign(record);
        checkDeadline();
        return { ...result, working_rev: revision.working_rev,
          screen_ref: record.document.data.screen_ir.screen_ref };
      } finally {
        this.#active = false;
        this.#clock.clearTimeout(timer);
      }
    })();
    return new Promise((resolve, reject) => {
      timer = this.#clock.setTimeout(() => {
        expired = true;
        reject(new DesignError('design_deadline', 'Render attempt exceeded its deadline'));
      }, deadline - started);
      // Attach both handlers even after expiry: late I/O cannot leave an
      // unhandled rejection, reopen rendering or resolve the expired attempt.
      operation.then((value) => { this.#clock.clearTimeout(timer); resolve(value); },
        (error) => { this.#clock.clearTimeout(timer); reject(error); });
    });
  }
}
