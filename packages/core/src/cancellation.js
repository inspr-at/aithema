// Cancellation releases engine work even if a provider ignores AbortSignal.
// The pending promise still has rejection handlers; its late result is unused.
export function untilCancelled(promise, signal) {
  if (signal.aborted) { Promise.resolve(promise).catch(() => {}); return Promise.reject(signal.reason); }
  return new Promise((resolve, reject) => {
    const abort = () => { signal.removeEventListener('abort', abort); reject(signal.reason); };
    signal.addEventListener('abort', abort, { once: true });
    Promise.resolve(promise).then(value => {
      signal.removeEventListener('abort', abort); resolve(value);
    }, error => { signal.removeEventListener('abort', abort); reject(error); });
  });
}
export async function* cancellableStream(stream, signal) {
  const iterator = stream[Symbol.asyncIterator](); let done = false;
  try {
    while (!done) {
      const step = await untilCancelled(iterator.next(), signal); done = step.done;
      if (!done) yield step.value;
    }
  } finally {
    if (!done) Promise.resolve(iterator.return?.()).catch(() => {});
  }
}
