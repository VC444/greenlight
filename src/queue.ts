/**
 * Minimal in-memory FIFO with an awaitable pop. Single-process only; swap for
 * a persistent queue (Redis/BullMQ) later without changing receiver/worker —
 * they only see push() and pop().
 */
export class JobQueue<T> {
  private items: T[] = [];
  private waiters: Array<(job: T) => void> = [];

  push(job: T): void {
    const waiter = this.waiters.shift();
    if (waiter) {
      waiter(job);
    } else {
      this.items.push(job);
    }
  }

  /** Resolves with the next job, waiting if the queue is empty. */
  pop(): Promise<T> {
    const job = this.items.shift();
    if (job !== undefined) return Promise.resolve(job);
    return new Promise((resolve) => this.waiters.push(resolve));
  }

  get size(): number {
    return this.items.length;
  }
}

/** A PR event the worker should process. */
export interface PullRequestJob {
  installationId: number;
  owner: string;
  repo: string;
  prNumber: number;
  headSha: string;
  action: "opened" | "synchronize";
}

export const queue = new JobQueue<PullRequestJob>();
