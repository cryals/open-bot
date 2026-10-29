/** Modules must honor the signal for their I/O. A stuck event loop is handled by the process watchdog. */
export async function within<T>(milliseconds: number, task: (signal: AbortSignal) => Promise<T>): Promise<T> {
  const signal = AbortSignal.timeout(milliseconds);
  let abort = () => {};
  const deadline = new Promise<never>((_resolve, reject) => {
    abort = () => reject(signal.reason);
    signal.addEventListener('abort', abort, { once: true });
  });
  try {
    return await Promise.race([task(signal), deadline]);
  } finally {
    signal.removeEventListener('abort', abort);
  }
}
