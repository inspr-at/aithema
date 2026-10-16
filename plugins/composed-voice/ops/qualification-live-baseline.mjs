// The production agent calls start2's custom-LLM facade with its visitor call
// identity. A loopback host has neither that facade nor cloud reachability.
// Keep a hard refusal for stale account wrappers; no mint or socket may start.
export async function startBaselineSample() {
  throw new Error('Loopback baseline refused; use binding.baselineOrigin in the production browser lane');
}
