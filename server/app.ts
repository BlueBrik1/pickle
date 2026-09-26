import express, { type Request, type Response, type NextFunction } from 'express';
import { randomBytes } from 'node:crypto';
import { readdir, readFile } from 'node:fs/promises';
import { resolve, join } from 'node:path';
import { ZodError } from 'zod';
import {
  analysisInputSchema,
  requestSchema,
  reviewSchema,
  LIMITS,
  type Snapshot,
  type IndexedProject,
  type RepositoryView,
  type AnalysisView,
  type AnalysisResult,
} from '../src/shared/schema.js';
import { redact } from '../src/shared/ingestion.js';
import { validateSnapshot } from './ingestion.js';
import { matchCandidates } from './analysis/index.js';
import { renderExport } from './analysis/exports.js';
import { JobQueue, QueueFullError, type QueueOptions } from './jobs.js';

type Mode = 'local' | 'demo';
interface Repository {
  view: RepositoryView;
  snapshot: Snapshot;
  project?: IndexedProject;
  touched: number;
}
interface Session {
  id: string;
  touched: number;
  repositories: Map<string, Repository>;
  analyses: Map<string, AnalysisView>;
  requests: number[];
  expired: Set<string>;
}
export interface AppOptions {
  mode?: Mode;
  port?: number;
  publicOrigin?: string;
  allowedHosts?: string[];
  allowedOrigins?: string[];
  idleMs?: number;
  snapshotBytes?: number;
  now?: () => number;
  queue?: QueueOptions;
  staticDir?: string;
  sampleDir?: string;
  rateLimit?: number;
}
class ApiError extends Error {
  constructor(
    public status: number,
    public code: string,
    message: string,
  ) {
    super(message);
  }
}
const id = () => randomBytes(24).toString('hex');
const fail = (status: number, code: string, message: string): never => {
  throw new ApiError(status, code, message);
};
const param = (req: Request, key: string) => String(req.params[key] ?? '');

export function createApp(options: AppOptions = {}) {
  const app = express();
  const mode = options.mode ?? 'local';
  const port = options.port ?? 3001;
  const now = options.now ?? Date.now;
  const idleMs = options.idleMs ?? LIMITS.idleMs;
  const sessions = new Map<string, Session>();
  const expiredSessions = new Set<string>();
  const queue = new JobQueue(options.queue);
  let retainedBytes = 0;
  const origins = new Set(
    options.allowedOrigins ?? [
      `http://localhost:${port}`,
      `http://127.0.0.1:${port}`,
      'http://localhost:5173',
      'http://127.0.0.1:5173',
      ...(options.publicOrigin ? [options.publicOrigin] : []),
    ],
  );
  const hosts = new Set(options.allowedHosts ?? [...origins].map((origin) => new URL(origin).host));
  const secure = options.publicOrigin?.startsWith('https:') ?? false;
  const remember = (set: Set<string>, value: string) => {
    set.add(value);
    if (set.size > 1000) set.delete(set.values().next().value!);
  };
  function clearRepository(session: Session, repositoryId: string, expired = false) {
    const repo = session.repositories.get(repositoryId);
    if (!repo) return;
    queue.cancel(repositoryId);
    for (const [analysisId, analysis] of session.analyses)
      if (analysis.repositoryId === repositoryId) {
        queue.cancel(analysisId);
        session.analyses.delete(analysisId);
        if (expired) remember(session.expired, analysisId);
      }
    retainedBytes -= repo.snapshot.totalBytes;
    session.repositories.delete(repositoryId);
    if (expired) remember(session.expired, repositoryId);
  }
  function expire() {
    for (const session of sessions.values()) {
      for (const [repositoryId, repo] of session.repositories)
        if (now() - repo.touched >= idleMs) clearRepository(session, repositoryId, true);
      if (now() - session.touched >= idleMs) {
        for (const repositoryId of session.repositories.keys())
          clearRepository(session, repositoryId, true);
        sessions.delete(session.id);
        remember(expiredSessions, session.id);
      }
    }
  }
  const cleanup = setInterval(expire, Math.min(idleMs, 60_000));
  cleanup.unref();
  app.disable('x-powered-by');
  app.use((_req, res, next) => {
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('Referrer-Policy', 'no-referrer');
    res.setHeader('X-Frame-Options', 'DENY');
    res.setHeader(
      'Content-Security-Policy',
      "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; font-src 'self'; img-src 'self' data:; connect-src 'self'; frame-ancestors 'none'; base-uri 'self'; object-src 'none'",
    );
    next();
  });
  app.use('/api', (req, res, next) => {
    try {
      if (!hosts.has(req.headers.host ?? ''))
        fail(403, 'HOST_REJECTED', 'This host is not allowed.');
      if (req.headers.origin && !origins.has(req.headers.origin))
        fail(403, 'ORIGIN_REJECTED', 'This origin is not allowed.');
      if (req.headers['sec-fetch-site'] === 'cross-site')
        fail(403, 'ORIGIN_REJECTED', 'Cross-site requests are not allowed.');
      res.setHeader('Cache-Control', 'no-store');
      expire();
      const cookie = /(?:^|;\s*)pickle_session=([a-f0-9]{48})(?:;|$)/.exec(
        req.headers.cookie ?? '',
      )?.[1];
      if (
        cookie &&
        expiredSessions.has(cookie) &&
        /^\/(repositories|analyses)\/[^/]+/.test(req.path) &&
        !['/repositories/sample', '/repositories/import'].includes(req.path)
      )
        fail(410, 'EXPIRED', 'This session expired. Reload your project.');
      let session = cookie ? sessions.get(cookie) : undefined;
      if (!session) {
        if (sessions.size >= 200)
          fail(503, 'CAPACITY', 'Session capacity reached. Try again later.');
        session = {
          id: id(),
          touched: now(),
          repositories: new Map(),
          analyses: new Map(),
          requests: [],
          expired: new Set(),
        };
        sessions.set(session.id, session);
        res.cookie('pickle_session', session.id, {
          httpOnly: true,
          sameSite: 'strict',
          secure,
          path: '/',
        });
      }
      session.touched = now();
      session.requests = session.requests.filter((time) => time > now() - 60_000);
      if (session.requests.length >= (options.rateLimit ?? 240)) {
        res.setHeader('Retry-After', '60');
        fail(429, 'RATE_LIMIT', 'Too many requests. Try again shortly.');
      }
      session.requests.push(now());
      res.locals.session = session;
      next();
    } catch (error) {
      next(error);
    }
  });
  app.use('/api', express.json({ limit: LIMITS.bodyBytes, strict: true, inflate: false }));
  const sessionOf = (res: Response): Session => res.locals.session;
  function missing(session: Session, objectId: string): never {
    return session.expired.has(objectId)
      ? fail(410, 'EXPIRED', 'This project or analysis expired. Reload your project.')
      : fail(404, 'NOT_FOUND', 'Not found.');
  }
  function repository(res: Response, objectId: string) {
    const session = sessionOf(res);
    const repo = session.repositories.get(objectId) ?? missing(session, objectId);
    repo.touched = now();
    return repo;
  }
  function analysis(res: Response, objectId: string) {
    const session = sessionOf(res);
    const value = session.analyses.get(objectId) ?? missing(session, objectId);
    repository(res, value.repositoryId);
    return value;
  }
  function ready(repo: Repository): IndexedProject {
    return repo.project ?? fail(409, 'NOT_READY', 'The project is not ready.');
  }
  function snapshotInput(input: unknown): Snapshot {
    try {
      return validateSnapshot(input);
    } catch {
      return fail(
        400,
        'INVALID_SNAPSHOT',
        'The project snapshot is invalid or exceeds the supported limits.',
      );
    }
  }
  function addRepository(res: Response, snapshot: Snapshot) {
    const session = sessionOf(res);
    if (session.repositories.size >= LIMITS.repositories)
      fail(429, 'PROJECT_LIMIT', 'Clear a project before loading another.');
    if (retainedBytes + snapshot.totalBytes > (options.snapshotBytes ?? LIMITS.snapshotBytes))
      fail(503, 'CAPACITY', 'Snapshot memory budget reached. Clear a project or try later.');
    const view: RepositoryView = {
      id: id(),
      name: snapshot.name,
      state: 'queued',
      stage: 'Waiting to index',
      createdAt: new Date(now()).toISOString(),
    };
    const repo: Repository = { view, snapshot, touched: now() };
    queue.enqueue<IndexedProject>(
      view.id,
      session.id,
      { kind: 'index', snapshot },
      {
        start() {
          view.state = 'running';
          view.stage = 'Parsing source files';
        },
        stage(value) {
          view.stage = value;
        },
        complete(project) {
          project.snapshot = repo.snapshot;
          repo.project = project;
          view.state = 'completed';
          view.stage = 'Project ready';
          view.scan = project.scan;
          view.files = project.files;
          view.fingerprint = project.fingerprint;
        },
        fail(code) {
          view.state = 'failed';
          view.stage = 'Indexing failed';
          view.error =
            code === 'timeout'
              ? 'Indexing exceeded the time limit.'
              : 'Indexing could not complete.';
        },
        cancel() {
          view.state = 'canceled';
          view.stage = 'Indexing canceled';
        },
      },
    );
    session.repositories.set(view.id, repo);
    retainedBytes += snapshot.totalBytes;
    res.status(202).json(view);
  }
  app.get('/api/health', (_req, res) => res.json({ ok: true, mode }));
  app.get('/api/session', (_req, res) => {
    const session = sessionOf(res);
    res.json({
      mode,
      repositories: [...session.repositories.values()].map((repo) => repo.view),
      analyses: [...session.analyses.values()].map(
        ({ result: _result, review: _review, ...metadata }) => metadata,
      ),
    });
  });
  app.post('/api/repositories/sample', async (_req, res) => {
    const root = resolve(options.sampleDir ?? 'fixtures/sample-project');
    const files: { relativePath: string; content: string }[] = [];
    async function visit(directory: string, prefix = '') {
      for (const entry of await readdir(directory, { withFileTypes: true })) {
        if (entry.isSymbolicLink()) continue;
        const relativePath = prefix + entry.name;
        if (entry.isDirectory()) await visit(join(directory, entry.name), relativePath + '/');
        else if (entry.isFile())
          files.push({
            relativePath,
            content: await readFile(join(directory, entry.name), 'utf8'),
          });
      }
    }
    await visit(root);
    addRepository(res, snapshotInput({ name: 'Pantry', files }));
  });
  app.post('/api/repositories/import', (req, res) => {
    if (mode !== 'local')
      fail(
        403,
        'MODE_UNSUPPORTED',
        'Folder import is unavailable in the public demo. Use the bundled sample.',
      );
    addRepository(res, snapshotInput(req.body));
  });
  app.get('/api/repositories/:id', (req, res) => res.json(repository(res, param(req, 'id')).view));
  app.delete('/api/repositories/:id', (req, res) => {
    repository(res, param(req, 'id'));
    clearRepository(sessionOf(res), param(req, 'id'));
    res.status(204).end();
  });
  app.post('/api/repositories/:id/candidates', (req, res) => {
    const project = ready(repository(res, param(req, 'id')));
    const input = requestSchema.parse(req.body);
    res.json({ candidates: matchCandidates(project, input.requestText) });
  });
  app.get('/api/repositories/:id/source/:fileId', (req, res) => {
    const repo = repository(res, param(req, 'id'));
    const project = ready(repo);
    const file =
      project.files.find((item) => item.id === param(req, 'fileId')) ??
      fail(404, 'NOT_FOUND', 'Not found.');
    const line = req.query.line === undefined ? 1 : Number(req.query.line);
    if (!Number.isSafeInteger(line) || line < 1 || line > Math.max(file.lineCount, 1))
      fail(400, 'INVALID_RANGE', 'Choose a valid source line.');
    const raw = repo.snapshot.files.find((item) => item.relativePath === file.path)?.content ?? '';
    const all = redact(raw).split(/\r?\n/);
    const startLine = Math.max(1, line - 8);
    const selected = all.slice(startLine - 1, line + 8);
    let remaining = 16 * 1024;
    let truncated = false;
    const lines: string[] = [];
    for (const text of selected) {
      const bytes = Buffer.from(text, 'utf8');
      if (bytes.length + 1 > remaining) {
        lines.push(
          bytes
            .subarray(0, Math.max(0, remaining - 1))
            .toString('utf8')
            .replace(/\uFFFD$/, ''),
        );
        truncated = true;
        break;
      }
      lines.push(text);
      remaining -= bytes.length + 1;
    }
    res.json({ path: file.path, startLine, lines, truncated });
  });
  app.post('/api/analyses', (req, res) => {
    const input = analysisInputSchema.parse(req.body);
    const project = ready(repository(res, input.repositoryId));
    if (
      new Set(input.seedFileIds).size !== input.seedFileIds.length ||
      input.seedFileIds.some((seed) => !project.files.some((file) => file.id === seed))
    )
      fail(400, 'INVALID_SEEDS', 'Starting files must belong to this project and be unique.');
    const session = sessionOf(res);
    if (session.analyses.size >= 30)
      fail(429, 'ANALYSIS_LIMIT', 'Clear a project before starting more analyses.');
    const view: AnalysisView = {
      id: id(),
      repositoryId: input.repositoryId,
      requestText: input.requestText,
      state: 'queued',
      stage: 'Waiting to analyze',
      createdAt: new Date(now()).toISOString(),
      review: {},
    };
    queue.enqueue<AnalysisResult>(
      view.id,
      session.id,
      { kind: 'analyze', project, input: { ...input, analysisId: view.id } },
      {
        start() {
          view.state = 'running';
          view.stage = 'Tracing dependencies';
        },
        stage(value) {
          view.stage = value;
        },
        complete(result) {
          view.result = result;
          view.state = 'completed';
          view.stage = 'Analysis complete';
        },
        fail(code) {
          view.state = 'failed';
          view.stage = 'Analysis failed';
          view.error =
            code === 'timeout'
              ? 'Analysis exceeded the time limit.'
              : 'Analysis could not complete.';
        },
        cancel() {
          view.state = 'canceled';
          view.stage = 'Analysis canceled';
        },
      },
    );
    session.analyses.set(view.id, view);
    res.status(202).json(view);
  });
  app.get('/api/analyses/:id', (req, res) => res.json(analysis(res, param(req, 'id'))));
  app.post('/api/analyses/:id/cancel', (req, res) => {
    const value = analysis(res, param(req, 'id'));
    queue.cancel(value.id);
    res.json(value);
  });
  app.patch('/api/analyses/:id/review', (req, res) => {
    const value = analysis(res, param(req, 'id'));
    if (!value.result) fail(409, 'NOT_READY', 'Wait for a completed analysis.');
    const review = reviewSchema.parse(req.body);
    if (
      Object.keys(review).length > 1000 ||
      Object.keys(review).some((key) => !value.result!.plan.some((task) => task.id === key))
    )
      fail(400, 'INVALID_REVIEW', 'Review edits must refer to generated tasks.');
    value.review = { ...value.review, ...review };
    res.json(value);
  });
  app.get('/api/analyses/:id/export', (req, res) => {
    const value = analysis(res, param(req, 'id'));
    if (!value.result) fail(409, 'NOT_READY', 'Wait for a completed analysis.');
    const format = req.query.format;
    if (format !== 'json' && format !== 'markdown' && format !== 'bob')
      fail(400, 'INVALID_FORMAT', 'Choose markdown, json, or bob.');
    res.setHeader(
      'Content-Disposition',
      `attachment; filename="pickle-${format}.${format === 'json' ? 'json' : 'md'}"`,
    );
    res
      .type(format === 'json' ? 'application/json' : 'text/markdown')
      .send(renderExport(value.result!, value.review, format as 'markdown' | 'json' | 'bob'));
  });
  app.use('/api', (_req, _res, next) => next(new ApiError(404, 'NOT_FOUND', 'Not found.')));
  if (options.staticDir) {
    app.use(express.static(resolve(options.staticDir), { index: false }));
    app.get('/{*path}', (_req, res) => res.sendFile(resolve(options.staticDir!, 'index.html')));
  }
  app.use((error: unknown, _req: Request, res: Response, _next: NextFunction) => {
    if (error instanceof ApiError) {
      res.status(error.status).json({ error: { code: error.code, message: error.message } });
      return;
    }
    if (error instanceof ZodError) {
      res
        .status(400)
        .json({
          error: {
            code: 'INVALID_INPUT',
            message: 'The submitted data is invalid. Check the project, request, and settings.',
          },
        });
      return;
    }
    if (error instanceof QueueFullError) {
      res.setHeader('Retry-After', '5');
      res
        .status(503)
        .json({
          error: { code: 'QUEUE_FULL', message: 'The analysis queue is full. Try again shortly.' },
        });
      return;
    }
    const detail = error as { status?: number; code?: string; name?: string; type?: string };
    if (detail.status === 413 || detail.type === 'entity.too.large') {
      res
        .status(413)
        .json({
          error: {
            code: 'BODY_TOO_LARGE',
            message: 'The submitted request exceeds the body limit.',
          },
        });
      return;
    }
    if (detail.status === 400 || detail.name === 'IngestionError') {
      res
        .status(400)
        .json({
          error: {
            code: 'INVALID_SNAPSHOT',
            message: 'The project snapshot is invalid or exceeds the supported limits.',
          },
        });
      return;
    }
    if (detail.status === 415) {
      res
        .status(415)
        .json({ error: { code: 'UNSUPPORTED_ENCODING', message: 'Send uncompressed JSON.' } });
      return;
    }
    res
      .status(500)
      .json({
        error: { code: 'INTERNAL_ERROR', message: 'The operation could not complete. Try again.' },
      });
  });
  return Object.assign(app, {
    dispose: async () => {
      clearInterval(cleanup);
      await queue.dispose();
      sessions.clear();
      expiredSessions.clear();
      retainedBytes = 0;
    },
  });
}
