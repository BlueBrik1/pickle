import { describe, it, expect, afterEach } from 'vitest';
import { JobQueue, QueueFullError, type JobCallbacks } from '../server/jobs.js';

const pools: JobQueue[] = [];
afterEach(async () => {
  await Promise.all(pools.splice(0).map((pool) => pool.dispose()));
});
const wait = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
function pool(options: ConstructorParameters<typeof JobQueue>[0] = {}) {
  // Test fixture code is controlled by the test, never supplied through the application API.
  const url = new URL(
    'data:text/javascript,' +
      encodeURIComponent(
        `import {parentPort,workerData} from 'node:worker_threads'; parentPort.postMessage({type:'stage',stage:'Working'}); setTimeout(()=>parentPort.postMessage({type:'complete',result:workerData}),500);`,
      ),
  );
  const value = new JobQueue({
    workerUrl: url,
    concurrency: 1,
    maxQueued: 2,
    timeoutMs: 3000,
    ...options,
  });
  pools.push(value);
  return value;
}
function callbacks(events: string[], name: string): JobCallbacks {
  return {
    start: () => events.push(name + ':start'),
    stage: () => events.push(name + ':stage'),
    complete: () => events.push(name + ':complete'),
    fail: (code) => events.push(name + ':' + code),
    cancel: () => events.push(name + ':cancel'),
  };
}
describe('isolated bounded jobs', () => {
  it('caps concurrency/queue, fairly alternates owners, and frees slots', async () => {
    const queue = pool();
    const events: string[] = [];
    queue.enqueue('a1', 'alice', {}, callbacks(events, 'a1'));
    queue.enqueue('a2', 'alice', {}, callbacks(events, 'a2'));
    queue.enqueue('b1', 'bob', {}, callbacks(events, 'b1'));
    expect(queue.stats).toEqual({ running: 1, queued: 2 });
    expect(() => queue.enqueue('b2', 'bob', {}, callbacks(events, 'b2'))).toThrow(QueueFullError);
    await wait(2100);
    expect(events.filter((value) => value.endsWith(':start'))).toEqual([
      'a1:start',
      'b1:start',
      'a2:start',
    ]);
    expect(queue.stats).toEqual({ running: 0, queued: 0 });
  });
  it('cancels queued and running jobs without late completion', async () => {
    const queue = pool();
    const events: string[] = [];
    queue.enqueue('running', 'alice', {}, callbacks(events, 'running'));
    queue.enqueue('queued', 'alice', {}, callbacks(events, 'queued'));
    queue.cancel('queued');
    queue.cancel('running');
    await wait(650);
    expect(events).toContain('running:cancel');
    expect(events).toContain('queued:cancel');
    expect(events.some((value) => value.endsWith(':complete'))).toBe(false);
    expect(queue.stats).toEqual({ running: 0, queued: 0 });
  });
  it('terminates jobs at timeout and removes retained work', async () => {
    const queue = pool({ timeoutMs: 60 });
    const events: string[] = [];
    queue.enqueue('slow', 'alice', {}, callbacks(events, 'slow'));
    await wait(300);
    expect(events).toContain('slow:timeout');
    expect(queue.stats).toEqual({ running: 0, queued: 0 });
    expect(events).not.toContain('slow:complete');
  });
});
