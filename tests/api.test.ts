import { afterEach, describe, expect, it } from 'vitest';
import { request } from 'node:http';
import { pathToFileURL } from 'node:url';
import { resolve } from 'node:path';
import { createApp, type AppOptions } from '../server/app.js';
import type { AnalysisView, RepositoryView } from '../src/shared/schema.js';
import { renderExport } from '../server/analysis/exports.js';

const cleanups: (() => Promise<void>)[] = [];
afterEach(async () => {
  for (const cleanup of cleanups.splice(0)) await cleanup();
});
const wait = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
async function service(options: AppOptions = {}) {
  const app = createApp({
    allowedHosts: ['localhost'],
    allowedOrigins: ['http://localhost'],
    ...options,
  });
  const server = app.listen(0, '127.0.0.1');
  await new Promise<void>((resolve) => server.on('listening', resolve));
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('No test server.');
  cleanups.push(async () => {
    await app.dispose();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  });
  const url = `http://127.0.0.1:${address.port}`;
  function client() {
    let cookie = '';
    return async (
      path: string,
      method = 'GET',
      body?: unknown,
      extra: Record<string, string> = {},
    ) => {
      const response = await new Promise<Response>((resolve, reject) => {
        const wire = body === undefined ? undefined : JSON.stringify(body);
        const req = request(
          url + path,
          {
            method,
            headers: {
              Host: 'localhost',
              ...(cookie ? { Cookie: cookie } : {}),
              ...(wire !== undefined
                ? { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(wire) }
                : {}),
              ...extra,
            },
          },
          (incoming) => {
            const chunks: Buffer[] = [];
            incoming.on('data', (chunk) => chunks.push(chunk));
            incoming.on('end', () => {
              const headers = new Headers();
              for (const [key, value] of Object.entries(incoming.headers))
                if (value !== undefined)
                  headers.set(key, Array.isArray(value) ? value.join(', ') : value);
              resolve(
                new Response(incoming.statusCode === 204 ? null : Buffer.concat(chunks), {
                  status: incoming.statusCode,
                  headers,
                }),
              );
            });
          },
        );
        req.on('error', reject);
        req.end(wire);
      });
      const issued = response.headers.get('set-cookie');
      if (issued) cookie = issued.split(';')[0];
      return response;
    };
  }
  return { client, url };
}
const snapshot = {
  name: 'Safety fixture',
  files: [
    { relativePath: 'account.ts', content: 'export const account = 1;' },
    {
      relativePath: 'screen.ts',
      content: 'import { account } from "./account"; export const settings = account;',
    },
    { relativePath: '.env.example', content: 'UPLOAD_BUCKET=DO_NOT_RETAIN_THIS_VALUE' },
  ],
};
type Client = ReturnType<Awaited<ReturnType<typeof service>>['client']>;
async function ready(client: Client, initial: RepositoryView): Promise<RepositoryView> {
  for (let attempt = 0; attempt < 80; attempt++) {
    const response = await client(`/api/repositories/${initial.id}`);
    const value = (await response.json()) as RepositoryView;
    if (value.state === 'completed') return value;
    if (value.state === 'failed') throw new Error(value.error);
    await wait(100);
  }
  throw new Error('Index timeout');
}
async function complete(client: Client, initial: AnalysisView): Promise<AnalysisView> {
  for (let attempt = 0; attempt < 80; attempt++) {
    const value = (await (await client(`/api/analyses/${initial.id}`)).json()) as AnalysisView;
    if (value.state === 'completed') return value;
    if (value.state === 'failed') throw new Error(value.error);
    await wait(100);
  }
  throw new Error('Analysis timeout');
}
describe('API ownership, real workers, and safety', () => {
  it('loads sample and analyzes actual source, exports review separately, denies all foreign access, then clears', async () => {
    const { client } = await service();
    const owner = client();
    const foreign = client();
    const imported = await owner('/api/repositories/sample', 'POST', {});
    expect(imported.status).toBe(202);
    const repo = await ready(owner, await imported.json());
    expect(repo.scan!.acceptedFiles).toBeGreaterThan(10);
    const matched = await owner(`/api/repositories/${repo.id}/candidates`, 'POST', {
      requestText: 'Add account deletion to settings and remove profile data.',
    });
    const { candidates } = await matched.json();
    expect(candidates.length).toBeGreaterThan(0);
    const started = await owner('/api/analyses', 'POST', {
      repositoryId: repo.id,
      requestText: 'Add account deletion to settings and remove profile data.',
      seedFileIds: [candidates[0].fileId],
      settings: { maxDepth: 3, includeTypeOnly: true },
    });
    expect(started.status).toBe(202);
    const result = await complete(owner, await started.json());
    expect(result.result!.evidence.length).toBeGreaterThan(0);
    const task = result.result!.plan[0];
    expect(
      (
        await owner(`/api/analyses/${result.id}/review`, 'PATCH', {
          [task.id]: { completed: true, note: 'Human review note' },
        })
      ).status,
    ).toBe(200);
    for (const format of ['markdown', 'json', 'bob']) {
      renderExport(result.result!, {}, format as 'markdown' | 'json' | 'bob');
      const exported = await owner(`/api/analyses/${result.id}/export?format=${format}`);
      expect(exported.status).toBe(200);
      expect(await exported.text()).toContain('Human review note');
    }
    const sourcePath = `/api/repositories/${repo.id}/source/${repo.files![0].id}`;
    expect((await owner(sourcePath)).status).toBe(200);
    for (const [path, method] of [
      [`/api/repositories/${repo.id}`, 'GET'],
      [`/api/repositories/${repo.id}`, 'DELETE'],
      [sourcePath, 'GET'],
      [`/api/repositories/${repo.id}/candidates`, 'POST'],
      [`/api/analyses/${result.id}`, 'GET'],
      [`/api/analyses/${result.id}/cancel`, 'POST'],
      [`/api/analyses/${result.id}/review`, 'PATCH'],
      [`/api/analyses/${result.id}/export?format=json`, 'GET'],
    ]) {
      expect(
        (await foreign(path, method, method === 'POST' || method === 'PATCH' ? {} : undefined))
          .status,
      ).toBe(404);
    }
    const foreignSession = await (await foreign('/api/session')).json();
    expect(foreignSession.repositories).toEqual([]);
    expect((await owner(`/api/repositories/${repo.id}`, 'DELETE')).status).toBe(204);
    expect((await owner(`/api/analyses/${result.id}`)).status).toBe(404);
    expect((await owner(sourcePath)).status).toBe(404);
  }, 20000);
  it('enforces host/origin, demo mode, invalid snapshots, source redaction and seed ownership', async () => {
    const local = (await service()).client();
    expect(
      (await local('/api/health', 'GET', undefined, { Host: 'attacker.example' })).status,
    ).toBe(403);
    expect(
      (
        await local('/api/repositories/import', 'POST', snapshot, {
          Origin: 'https://attacker.example',
        })
      ).status,
    ).toBe(403);
    const demo = (await service({ mode: 'demo' })).client();
    expect((await demo('/api/repositories/import', 'POST', snapshot)).status).toBe(403);
    for (const files of [
      [],
      [{ relativePath: '../secret.ts', content: 'secret' }],
      [{ relativePath: 'C:/secret.ts', content: 'secret' }],
      [
        { relativePath: 'x.ts', content: 'x' },
        { relativePath: 'X.ts', content: 'y' },
      ],
    ])
      expect(
        (await local('/api/repositories/import', 'POST', { name: 'Invalid', files })).status,
      ).toBe(400);
    const repo = await ready(
      local,
      await (await local('/api/repositories/import', 'POST', snapshot)).json(),
    );
    const env = repo.files!.find((file) => file.path === '.env.example')!;
    expect(
      await (await local(`/api/repositories/${repo.id}/source/${env.id}`)).text(),
    ).not.toContain('DO_NOT_RETAIN');
    expect(
      (
        await local('/api/analyses', 'POST', {
          repositoryId: repo.id,
          requestText: 'Change the account status.',
          seedFileIds: ['foreign-id'],
          settings: {},
        })
      ).status,
    ).toBe(400);
    expect((await local('/api/no-such-route')).headers.get('content-type')).toContain(
      'application/json',
    );
  }, 15000);
  it('bounds long source lines and rejects oversize wire bodies, capacity, and request bursts', async () => {
    const local = (await service()).client();
    const repo = await ready(
      local,
      await (
        await local('/api/repositories/import', 'POST', {
          name: 'Long',
          files: [{ relativePath: 'long.md', content: 'a'.repeat(40_000) }],
        })
      ).json(),
    );
    const source = await (
      await local(`/api/repositories/${repo.id}/source/${repo.files![0].id}`)
    ).json();
    expect(source.truncated).toBe(true);
    expect(Buffer.byteLength(source.lines.join('\n'))).toBeLessThanOrEqual(16 * 1024);
    const tooLarge = await local('/api/repositories/import', 'POST', {
      padding: 'x'.repeat(16 * 1024 * 1024),
    });
    expect(tooLarge.status).toBe(413);
    const constrained = (await service({ snapshotBytes: 1 })).client();
    expect((await constrained('/api/repositories/import', 'POST', snapshot)).status).toBe(503);
    const limited = (await service({ rateLimit: 2 })).client();
    await limited('/api/health');
    await limited('/api/health');
    expect((await limited('/api/health')).status).toBe(429);
  }, 15000);
  it('expires snapshots and sessions with a distinct response', async () => {
    let time = Date.now();
    const local = (await service({ now: () => time, idleMs: 1000 })).client();
    const repo = await ready(
      local,
      await (await local('/api/repositories/import', 'POST', snapshot)).json(),
    );
    time += 2000;
    const expired = await local(`/api/repositories/${repo.id}`);
    expect(expired.status).toBe(410);
    expect((await expired.json()).error.code).toBe('EXPIRED');
    const restarted = await (await local('/api/session')).json();
    expect(restarted.repositories).toEqual([]);
  }, 15000);
  it('returns not-ready and queue-full, times out isolated work, and clears running jobs', async () => {
    const stalledWorker = new URL(
      'data:text/javascript,' + encodeURIComponent('setInterval(()=>{},1000);'),
    );
    const local = (
      await service({
        queue: { workerUrl: stalledWorker, concurrency: 1, maxQueued: 1, timeoutMs: 200 },
      })
    ).client();
    const first = (await (
      await local('/api/repositories/import', 'POST', snapshot)
    ).json()) as RepositoryView;
    expect(
      (
        await local(`/api/repositories/${first.id}/candidates`, 'POST', {
          requestText: 'Change the account status',
        })
      ).status,
    ).toBe(409);
    const second = (await (
      await local('/api/repositories/import', 'POST', snapshot)
    ).json()) as RepositoryView;
    const full = await local('/api/repositories/import', 'POST', snapshot);
    expect(full.status).toBe(503);
    expect((await full.json()).error.code).toBe('QUEUE_FULL');
    expect((await local(`/api/repositories/${second.id}`, 'DELETE')).status).toBe(204);
    await wait(350);
    const failed = await (await local(`/api/repositories/${first.id}`)).json();
    expect(failed.state).toBe('failed');
    expect(failed.error).toContain('time limit');
    expect(JSON.stringify(failed)).not.toContain('DO_NOT_RETAIN');
    const third = (await (
      await local('/api/repositories/import', 'POST', snapshot)
    ).json()) as RepositoryView;
    expect((await local(`/api/repositories/${third.id}`, 'DELETE')).status).toBe(204);
    expect((await local(`/api/repositories/${third.id}`)).status).toBe(404);
  });
  it('cancels queued and running analyses, permits a fresh run, and removes all work on clear', async () => {
    const engine = pathToFileURL(resolve('dist-server/server/analysis/index.js')).href;
    const workerUrl = new URL(
      'data:text/javascript,' +
        encodeURIComponent(
          `import {parentPort,workerData as data} from 'node:worker_threads'; const engine=await import(${JSON.stringify(engine)}); if(data.kind==='index') parentPort.postMessage({type:'complete',result:engine.indexProject(data.snapshot)}); else setTimeout(()=>parentPort.postMessage({type:'complete',result:engine.analyze(data.project,data.input)}),600);`,
        ),
    );
    const local = (
      await service({ queue: { workerUrl, concurrency: 1, timeoutMs: 5000 } })
    ).client();
    const repo = await ready(
      local,
      await (await local('/api/repositories/import', 'POST', snapshot)).json(),
    );
    const input = {
      repositoryId: repo.id,
      requestText: 'Change the account status.',
      seedFileIds: [repo.files![0].id],
      settings: {},
    };
    const running = (await (await local('/api/analyses', 'POST', input)).json()) as AnalysisView;
    const queued = (await (await local('/api/analyses', 'POST', input)).json()) as AnalysisView;
    expect(queued.state).toBe('queued');
    for (const value of [queued, running])
      expect(
        (await (await local(`/api/analyses/${value.id}/cancel`, 'POST', {})).json()).state,
      ).toBe('canceled');
    const fresh = await complete(local, await (await local('/api/analyses', 'POST', input)).json());
    expect(fresh.result!.analysisId).toBe(fresh.id);
    for (const value of [queued, running]) {
      const canceled = await (await local(`/api/analyses/${value.id}`)).json();
      expect(canceled.state).toBe('canceled');
      expect(canceled.result).toBeUndefined();
    }
    const cleared = (await (await local('/api/analyses', 'POST', input)).json()) as AnalysisView;
    expect((await local(`/api/repositories/${repo.id}`, 'DELETE')).status).toBe(204);
    expect((await local(`/api/analyses/${cleared.id}`)).status).toBe(404);
    expect((await local('/api/session')).status).toBe(200);
  }, 15000);
  it('enforces project count, expires idle snapshots inside an active session, and issues protected cookies', async () => {
    let time = Date.now();
    const local = (
      await service({ now: () => time, idleMs: 1000, publicOrigin: 'https://pickle.example' })
    ).client();
    const health = await local('/api/health');
    expect(health.headers.get('set-cookie')).toMatch(/HttpOnly/);
    expect(health.headers.get('set-cookie')).toMatch(/SameSite=Strict/);
    expect(health.headers.get('set-cookie')).toMatch(/Secure/);
    const first = await ready(
      local,
      await (await local('/api/repositories/import', 'POST', snapshot)).json(),
    );
    for (let i = 0; i < 2; i++)
      expect((await local('/api/repositories/import', 'POST', snapshot)).status).toBe(202);
    expect((await local('/api/repositories/import', 'POST', snapshot)).status).toBe(429);
    time += 800;
    await local('/api/session');
    time += 500;
    expect((await local(`/api/repositories/${first.id}`)).status).toBe(410);
    const remaining = await (await local('/api/session')).json();
    expect(remaining.repositories).toEqual([]);
    expect((await local('/api/repositories/import', 'POST', snapshot)).status).toBe(202);
  }, 15000);
  it('keeps thrown worker errors and private server paths out of responses', async () => {
    const workerUrl = new URL(
      'data:text/javascript,' +
        encodeURIComponent(
          `import {workerData} from 'node:worker_threads'; throw new Error('PRIVATE_MACHINE_PATH_CREDENTIAL ' + workerData.snapshot.files[0].content);`,
        ),
    );
    const local = (await service({ queue: { workerUrl } })).client();
    const repo = (await (
      await local('/api/repositories/import', 'POST', snapshot)
    ).json()) as RepositoryView;
    await wait(350);
    const value = await (await local(`/api/repositories/${repo.id}`)).json();
    expect(value.state).toBe('failed');
    const serialized = JSON.stringify(value);
    expect(serialized).not.toContain('PRIVATE_MACHINE');
    expect(serialized).not.toContain('export const');
    expect(serialized).not.toContain('stack');
    const broken = (await service({ sampleDir: 'C:/private-machine-path-missing' })).client();
    const failure = await broken('/api/repositories/sample', 'POST', {});
    expect(failure.status).toBe(500);
    expect(await failure.text()).not.toContain('private-machine');
  });
});
