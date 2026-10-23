/** FIFO, one-at-a-time task queue with per-task abort. Pure. */

export const abortError = (): Error => Object.assign(new Error('aborted'), { name: 'AbortError' });

export class SerialQueue {
  private tail: Promise<unknown> = Promise.resolve();
  private pending = 0;

  /** tasks queued or running */
  get size(): number {
    return this.pending;
  }

  /** The task receives `signal`; a task aborted before its turn never starts and rejects with AbortError. */
  run<T>(task: (signal: AbortSignal | undefined) => Promise<T>, signal?: AbortSignal): Promise<T> {
    this.pending++;
    const exec = async (): Promise<T> => {
      try {
        if (signal?.aborted) throw abortError();
        return await task(signal);
      } finally {
        this.pending--;
      }
    };
    const p = this.tail.then(exec, exec);
    this.tail = p.catch(() => undefined);
    return p;
  }
}
