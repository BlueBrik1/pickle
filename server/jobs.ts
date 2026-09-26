import { Worker } from 'node:worker_threads';
import { existsSync } from 'node:fs';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { LIMITS } from '../src/shared/schema.js';

export interface JobCallbacks<T = unknown> {
  start(): void;
  stage(stage: string): void;
  complete(result: T): void;
  fail(code: 'timeout' | 'worker-failed'): void;
  cancel(): void;
}
interface Job {
  id: string;
  owner: string;
  payload: unknown;
  callbacks: JobCallbacks;
  worker?: Worker;
  timer?: ReturnType<typeof setTimeout>;
  settled: boolean;
}
export interface QueueOptions {
  concurrency?: number;
  maxQueued?: number;
  timeoutMs?: number;
  workerUrl?: URL;
  memoryMb?: number;
}
export class QueueFullError extends Error {}

/** Bounded worker pool. Waiting sessions alternate; each session retains FIFO order. */
export class JobQueue {
  private queue: Job[] = [];
  private running = new Map<string, Job>();
  private lastOwner = '';
  private closed = false;
  private terminating = new Set<Promise<number>>();
  private readonly options: Required<QueueOptions>;
  constructor(options: QueueOptions = {}) {
    const adjacent = new URL('./workers/worker.js', import.meta.url);
    this.options = {
      concurrency: LIMITS.workers,
      maxQueued: LIMITS.queued,
      timeoutMs: LIMITS.jobMs,
      memoryMb: LIMITS.workerMb,
      workerUrl: existsSync(adjacent)
        ? adjacent
        : pathToFileURL(resolve('dist-server/server/workers/worker.js')),
      ...options,
    };
  }
  get stats() {
    return { running: this.running.size, queued: this.queue.length };
  }
  enqueue<T>(id: string, owner: string, payload: unknown, callbacks: JobCallbacks<T>) {
    if (
      this.closed ||
      (this.running.size >= this.options.concurrency && this.queue.length >= this.options.maxQueued)
    )
      throw new QueueFullError();
    this.queue.push({ id, owner, payload, callbacks: callbacks as JobCallbacks, settled: false });
    this.pump();
  }
  cancel(id: string) {
    const job = this.running.get(id) ?? this.queue.find((item) => item.id === id);
    if (job) this.finish(job, 'cancel');
  }
  cancelOwner(owner: string) {
    for (const job of [...this.queue, ...this.running.values()])
      if (job.owner === owner) this.cancel(job.id);
  }
  private pump() {
    while (!this.closed && this.running.size < this.options.concurrency && this.queue.length) {
      const alternate = this.queue.findIndex((job) => job.owner !== this.lastOwner);
      const job = this.queue.splice(alternate < 0 ? 0 : alternate, 1)[0];
      this.lastOwner = job.owner;
      this.running.set(job.id, job);
      job.callbacks.start();
      try {
        job.worker = new Worker(this.options.workerUrl, {
          workerData: job.payload,
          resourceLimits: {
            maxOldGenerationSizeMb: this.options.memoryMb,
            maxYoungGenerationSizeMb: 32,
          },
        });
        job.payload = undefined;
        job.timer = setTimeout(() => this.finish(job, 'fail', 'timeout'), this.options.timeoutMs);
        job.worker.on('message', (message: { type: string; stage?: string; result?: unknown }) => {
          if (job.settled) return;
          if (message.type === 'stage' && typeof message.stage === 'string')
            job.callbacks.stage(message.stage);
          else if (message.type === 'complete') this.finish(job, 'complete', message.result);
          else if (message.type === 'failed') this.finish(job, 'fail', 'worker-failed');
        });
        job.worker.on('error', () => this.finish(job, 'fail', 'worker-failed'));
        job.worker.on('exit', () => {
          if (!job.settled) this.finish(job, 'fail', 'worker-failed');
        });
      } catch {
        this.finish(job, 'fail', 'worker-failed');
      }
    }
  }
  private finish(job: Job, outcome: 'complete' | 'fail' | 'cancel', value?: unknown) {
    if (job.settled) return;
    job.settled = true;
    clearTimeout(job.timer);
    job.payload = undefined;
    this.queue = this.queue.filter((item) => item !== job);
    const release = () => {
      this.running.delete(job.id);
      this.pump();
    };
    if (job.worker) {
      // Keep the slot reserved until termination actually completes.
      const termination = job.worker.terminate();
      this.terminating.add(termination);
      void termination.finally(() => {
        this.terminating.delete(termination);
        release();
      });
      job.worker = undefined;
    } else release();
    if (outcome === 'complete') job.callbacks.complete(value);
    else if (outcome === 'fail') job.callbacks.fail(value as 'timeout' | 'worker-failed');
    else job.callbacks.cancel();
  }
  async dispose() {
    this.closed = true;
    for (const job of [...this.queue, ...this.running.values()]) this.finish(job, 'cancel');
    await Promise.allSettled(this.terminating);
  }
}
