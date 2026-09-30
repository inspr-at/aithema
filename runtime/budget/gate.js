import { createHash } from 'node:crypto';
import { BudgetError, budgetBytes, findOpenHold } from './port.js';

/** Exact outbound bytes, not a JSON reserialization of a request. */
export function requestSha256(bytes) {
  return createHash('sha256').update(budgetBytes(bytes)).digest('hex');
}

/**
 * The service's only provider-opening boundary. open receives the immutable
 * snapshot of request bytes and must send those bytes once, with no internal
 * retry. It returns {output, actual_micro} only after the provider finishes.
 * A throw means unknown usage. Streaming adapters must withhold late output
 * themselves; this gate returns output only after the final authority check.
 *
 * No caller-supplied claim_id is accepted. Each invocation obtains a fresh
 * claim before open; the durable host UNIQUE(hold_id) prevents reuse across
 * gates, service restarts and concurrent hosts. The local set also catches
 * a broken adapter returning the same claim_id on different holds.
 */
export function createOutboundGate({ budget, open }) {
  if (['claim', 'settle', 'isCurrent', 'listOpen', 'recover'].some((method) => typeof budget?.[method] !== 'function')) {
    throw new TypeError('Outbound gate requires a BudgetClient');
  }
  if (typeof open !== 'function') throw new TypeError('Outbound gate requires a provider-opening function');
  const consumed = new Set();
  return async function dispatch({ hold_id, request_bytes, ...extra }) {
    if (Object.keys(extra).length) throw new BudgetError(400, 'Outbound gate accepts only hold_id and request_bytes');
    const bytes = budgetBytes(request_bytes); // copy before claim's first await
    const digest = requestSha256(bytes);
    const authority = budget.authority;
    const { claim_id } = await budget.claim({ hold_id, request_sha256: digest,
      worker_generation: authority.gen, auth_epoch: authority.auth_epoch });
    // Client/host validated the response contract; still fail closed if a
    // custom adapter bypasses BudgetClient or repeats a previously used id.
    if (typeof claim_id !== 'string' || !/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/.test(claim_id)) {
      throw new BudgetError(502, 'Provider opening requires a fresh valid claim_id');
    }
    if (consumed.has(claim_id)) throw new BudgetError(409, 'Dispatch claim has already been consumed', 'already_claimed');
    consumed.add(claim_id); // burn before open, including synchronous throws
    // Token refresh can change exp without changing claim ownership. A new
    // generation/epoch cannot finish the old owner's claim, so retain that
    // owner across takeover/revocation. Resolve at EVERY finishing call.
    const claimOwner = () => {
      const current = budget.authority;
      return ['sid', 'gen', 'auth_epoch'].every((key) => current[key] === authority[key]) ? current : authority;
    };
    const finishUnknown = async () => {
      let hold;
      try { hold = await findOpenHold((query) => budget.listOpen(query), hold_id); }
      catch (error) {
        // Revocation/purge can close the read route to the captured token.
        // Its committed-claim settlement exception still permits finishing.
        if (error.code !== 'revoked') throw error;
        return budget.settle({ claim_id, outcome: 'unknown' }, claimOwner());
      }
      if (hold) {
        try { return await budget.settle({ claim_id, outcome: 'unknown' }, claimOwner()); }
        catch (error) {
          // Another finisher may have closed it after enumeration. Recovery
          // returns that durable result, without changing settlement bytes.
          if (error.code !== 'idempotency_conflict') throw error;
        }
      }
      // An actual settlement may have committed before its response was
      // lost. Never send different settlement bytes to that closed claim.
      const current = budget.authority;
      return budget.recover({ hold_id, worker_generation: current.gen, auth_epoch: current.auth_epoch });
    };
    const finishError = (error, settlementError, providerResult) => {
      const failure = new AggregateError([error, settlementError], 'Provider attempt and settlement failed; recover from the ledger');
      failure.provider_result = providerResult;
      failure.claim_id = claim_id;
      failure.hold_id = hold_id;
      return failure;
    };
    let result;
    try {
      // There is deliberately no second pre-send authority check: committed
      // claims may send even when takeover landed during the claim response.
      result = await open({ bytes: Buffer.from(bytes), claim_id, request_sha256: digest });
      if (!result || !Number.isSafeInteger(result.actual_micro) || result.actual_micro < 0) {
        throw new BudgetError(502, 'Provider did not return a valid final cost');
      }
    } catch (error) {
      try { await budget.settle({ claim_id, outcome: 'unknown' }, claimOwner()); }
      catch (settlementError) {
        throw finishError(error, settlementError, result);
      }
      throw error;
    }
    let current = false;
    let authorityError = null;
    try { current = await budget.isCurrent(claimOwner()); }
    catch (error) { authorityError = error; } // unavailable authority means discard, never publish
    let settlement;
    let settlementError = null;
    try {
      settlement = await budget.settle(current
        ? { claim_id, outcome: 'settled', actual_micro: result.actual_micro }
        : { claim_id, outcome: 'unknown' }, claimOwner());
    } catch (error) {
      settlementError = error;
      try { settlement = await finishUnknown(); }
      catch (unknownError) { throw finishError(error, unknownError, result); }
    }
    // Takeover may also have committed between the output check and settle.
    // The ledger's settlement is authoritative about that race.
    try { current = current && await budget.isCurrent(claimOwner()); }
    catch (error) { current = false; authorityError = error; }
    const discarded = !current || settlement.closed_reason === 'unknown' || settlementError !== null;
    return { claim_id, settlement, discarded, output: discarded ? null : result.output,
      authority_error: authorityError, settlement_error: settlementError };
  };
}
