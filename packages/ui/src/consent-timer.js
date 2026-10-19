// Keep consent deadlines, backoff and notices identifiable as one timer domain.
// The offline evidence clock virtualizes this callback only; frame delivery,
// networking and unrelated UI timers continue on their native clocks.
export function consentTimeout(callback, delay) {
  return setTimeout(function consentTimer() { callback(); }, delay);
}
