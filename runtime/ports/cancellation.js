/**
 * Race a local waiter with cancellation while also notifying the underlying
 * operation. Transport calls must still receive the signal themselves.
 * @template T
 * @param {() => Promise<T>} operation
 * @param {AbortSignal | undefined} signal
 * @param {(signal: AbortSignal) => Error} errorForSignal
 * @param {() => void} [onAbort]
 * @returns {Promise<T>}
 */
export async function withCancellation(operation, signal, errorForSignal, onAbort) {
  if (!signal) return operation();
  if (signal.aborted) {
    onAbort?.();
    throw errorForSignal(signal);
  }
  let abort;
  const cancelled = new Promise((_, reject) => {
    abort = () => {
      onAbort?.();
      reject(errorForSignal(signal));
    };
    signal.addEventListener('abort', abort, { once: true });
  });
  try {
    const result = await Promise.race([operation(), cancelled]);
    if (signal.aborted) throw errorForSignal(signal);
    return result;
  } finally {
    signal.removeEventListener('abort', abort);
  }
}

/** Cancel the stream itself, including a pending read, before rejecting. */
export function readWithCancellation(reader, signal, errorForSignal) {
  return withCancellation(
    () => reader.read(), signal, errorForSignal,
    () => { void reader.cancel().catch(() => {}); },
  );
}

/** A stalled cancel acknowledgement must not keep a cancelled caller waiting. */
export async function cancelReader(reader, signal, errorForSignal) {
  const cleanup = reader.cancel().catch(() => {});
  await withCancellation(() => cleanup, signal, errorForSignal).catch(() => {});
  reader.releaseLock();
}

/** Abortable delay; always remove the listener on normal completion too. */
export async function delayWithCancellation(ms, signal, errorForSignal) {
  let timer;
  try {
    await withCancellation(
      () => new Promise((resolve) => { timer = setTimeout(resolve, ms); }),
      signal, errorForSignal,
    );
  } finally {
    clearTimeout(timer);
  }
}
