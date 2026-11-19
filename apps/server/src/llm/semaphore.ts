import { LlmError } from './errors';

/** Counting semaphore with a wait timeout, used for per-use-case concurrency budgets. */
export class Semaphore {
  private active = 0;
  private readonly waiters: Array<() => void> = [];

  constructor(private max: number) {}

  setMax(max: number) {
    this.max = Math.max(1, max);
    this.drain();
  }

  get inUse() {
    return this.active;
  }

  /** Resolves to a release function, or rejects with LlmError('busy') after `timeoutMs`. */
  acquire(timeoutMs: number, signal?: AbortSignal): Promise<() => void> {
    const makeRelease = () => {
      let released = false;
      return () => {
        if (released) return;
        released = true;
        this.active -= 1;
        this.drain();
      };
    };
    if (this.active < this.max) {
      this.active += 1;
      return Promise.resolve(makeRelease());
    }
    return new Promise((resolve, reject) => {
      const waiter = () => {
        clearTimeout(timer);
        signal?.removeEventListener('abort', onAbort);
        this.active += 1;
        resolve(makeRelease());
      };
      const remove = () => {
        const i = this.waiters.indexOf(waiter);
        if (i >= 0) this.waiters.splice(i, 1);
      };
      const timer = setTimeout(() => {
        remove();
        signal?.removeEventListener('abort', onAbort);
        reject(new LlmError('busy', 'concurrency budget exhausted'));
      }, Math.max(0, timeoutMs));
      const onAbort = () => {
        clearTimeout(timer);
        remove();
        reject(new LlmError('aborted', 'aborted while waiting for a slot'));
      };
      signal?.addEventListener('abort', onAbort, { once: true });
      this.waiters.push(waiter);
    });
  }

  private drain() {
    while (this.active < this.max && this.waiters.length) this.waiters.shift()!();
  }
}
