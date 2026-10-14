// Bound protocol calls too: Puppeteer's page timeout does not cover evaluate,
// screenshots, launch or close. Keep failures attributable to one matrix cell.
export function adminSteps(signal) {
  let context = { state: 'setup', locale: 'de', theme: 'light', width: 390 };
  const at = (state, cell = {}) => { context = { ...context, ...cell, state }; };
  const run = async (operation, work, { timeout = 5_000, cleanup = false } = {}) => {
    const { state, locale, theme, width } = context;
    const label = `admin state=${state} locale=${locale} theme=${theme} width=${width}: ${operation}`;
    const controller = new AbortController();
    const operationSignal = !cleanup && signal ? AbortSignal.any([signal, controller.signal]) : controller.signal;
    let timer, abort;
    try {
      return await Promise.race([
        Promise.resolve().then(() => {
          if (!cleanup) signal?.throwIfAborted();
          return work(operationSignal);
        }),
        new Promise((_, reject) => {
          timer = setTimeout(() => {
            const error = new Error(`deadline exceeded (${timeout} ms)`);
            reject(error);
            // A Promise.race alone abandons launch, leaving its child and handles
            // alive even though the test failed. Abort the operation as well.
            controller.abort(error);
          }, timeout);
          if (!cleanup && signal) {
            abort = () => reject(new Error('test cancelled', { cause: signal.reason }));
            signal.addEventListener('abort', abort, { once: true });
          }
        }),
      ]);
    } catch (cause) {
      controller.abort(cause);
      throw new Error(`${label}: ${cause.message}`, { cause });
    } finally {
      clearTimeout(timer);
      if (abort) signal.removeEventListener('abort', abort);
    }
  };
  return { at, run };
}
