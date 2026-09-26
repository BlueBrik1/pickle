# Pickle HTTP API

The frontend calls same-origin `/api` routes. The development server proxies these to the loopback Express service on port 3001. Production Express serves both `dist/` and the API. Unknown API routes always return JSON, never the frontend document.

## Sessions and operating modes

`PICKLE_MODE=local` is the default; it binds to `127.0.0.1` and accepts supported folder snapshots. `PICKLE_MODE=demo` binds to all interfaces and rejects the import endpoint. Configure `PICKLE_PUBLIC_ORIGIN` to the exact externally visible origin for a hosted demo. HTTPS origins enable the cookie's `Secure` attribute. Terminate HTTPS at the deployment proxy. `PORT` changes the service port.

Every API request checks Host and Origin. Local service origins and the Vite development origin on port 5173 are accepted; there is no wildcard CORS. Cross-site Fetch Metadata is rejected. Nonbrowser same-machine clients may omit Origin. A server-issued, unpredictable `pickle_session` cookie uses HttpOnly, SameSite=Strict and Path=/. Every repository, source, analysis, review, cancel, and export lookup checks that session's ownership. Other sessions receive generic 404 responses even with valid object IDs.

## Routes

| Method / route | Input | Response |
| --- | --- | --- |
| GET `/api/health` | — | `{ok:true,mode}` |
| GET `/api/session` | — | `SessionView`: current repositories and analysis metadata, without source, result bodies, or review notes |
| POST `/api/repositories/sample` | Empty JSON object | 202 `RepositoryView`, analyzed from the bundled fixture |
| POST `/api/repositories/import` | `{name,files:[{relativePath,content}],clientSkipped?}` | 202 `RepositoryView`; local mode only |
| GET `/api/repositories/:id` | — | Owned `RepositoryView`; completed views include files, scan summary and fingerprint |
| DELETE `/api/repositories/:id` | — | 204; clears source, related analyses and queued/running work |
| POST `/api/repositories/:id/candidates` | `{requestText}` | `{candidates:Candidate[]}`; project must be ready |
| GET `/api/repositories/:id/source/:fileId?line=N` | Positive one-based line, default 1 | `{path,startLine,lines,truncated}` |
| POST `/api/analyses` | `{repositoryId,requestText,seedFileIds,settings:{maxDepth,includeTypeOnly}}` | 202 `AnalysisView` |
| GET `/api/analyses/:id` | — | Owned job state, or completed result plus separate review map |
| POST `/api/analyses/:id/cancel` | Empty JSON object | `AnalysisView`; queued/running work becomes canceled |
| PATCH `/api/analyses/:id/review` | Map of existing task IDs to `{completed?,note?,title?}` | Updated `AnalysisView`; analysis facts remain unchanged |
| GET `/api/analyses/:id/export?format=markdown` | — | Downloadable Markdown report |
| GET `/api/analyses/:id/export?format=json` | — | Versioned result and separately labeled user review edits |
| GET `/api/analyses/:id/export?format=bob` | — | Downloadable Bob handoff |

Shared TypeScript/Zod contracts are in `src/shared/schema.ts`. Starting file IDs must be unique and belong to the exact owned snapshot. Requests have 10–2,000 trimmed characters. Settings permit dependent depth 1–5 and explicit type-only inclusion. Review patches accept only generated task IDs, with notes up to 2,000 characters and edited titles up to 500.

Source excerpts contain at most 17 lines (8 before and after the requested line) and 16 KiB of UTF-8 text. A long single line cannot bypass the byte limit. Source is redacted before display; `truncated` signals byte truncation. Paths are snapshot-relative. Redaction can change columns; the UI must not assume original column offsets remain valid. No endpoint reads user-supplied host filesystem paths.

## Jobs, limits and retention

Indexing and analysis execute in compiled JavaScript worker threads. Both development and production run `dist-server/server/workers/worker.js`; development compiles the server before starting it. Tests also compile the server before exercising real workers. Imported code is parsed as data, never imported, executed, built, or installed.

The scheduler caps running workers at 2 and waiting jobs at 10. Waiting sessions alternate while preserving their own FIFO order. Each worker has a 30-second hard wall-clock cap and a 256 MiB V8 old-generation limit (plus 32 MiB young generation). These limits are caps, not claimed normal usage or complete OS-process memory limits. Cancellation terminates the worker; its slot stays reserved until termination resolves. Queued payload references are discarded on cancellation. Late completions cannot revive canceled work.

Snapshots have a process-wide 64 MiB accepted-content budget and are limited to 3 per session. This counts accepted UTF-8 source bytes, not total heap size: parsed indexes, metadata, results and transient worker copies also consume memory. The process admits at most 200 sessions, each with at most 30 analyses. Per-session traffic is limited to 240 requests per minute, including polling. Accepted project limits remain 1,500 files, 256 KiB per file, 8 MiB total text, and a separate 16 MiB uncompressed JSON body cap. Compressed request bodies are not accepted. See `docs/privacy-and-safety.md` for filtering and redaction limits.

Sessions and individual snapshots expire after 30 idle minutes. Reading a repository or its analysis refreshes that snapshot's activity. Reading session metadata refreshes only the session. A periodic sweep and request-time checks remove expired source, results and jobs. Bounded tombstones let an owning session distinguish expiry (410) from missing/foreign work (404). Clearing a project immediately invalidates its related source and analyses. Data is retained only in process memory and disappears when the service restarts.

## Errors

Errors use `{error:{code,message}}`. Validation uses 400; unsupported demo import and rejected Host/Origin use 403; foreign/missing objects use 404; incomplete jobs use 409; expiry uses 410; oversize wire bodies use 413; unsupported body encoding uses 415; session request/project/analysis caps use 429; queue or memory capacity uses 503. Rate limits and full queues include Retry-After. Internal errors use 500 with a generic message; worker failures expose only a safe job error. Request bodies, source, cookies, private machine paths and stack traces are never included in normal server logs or internal-error responses.

Polling every 500–1,000 ms is sufficient. Stop polling on completed, failed or canceled states. A 410 response requires reloading the project; a cleared or foreign ID receives 404. A completed job cannot be canceled retroactively, and cancellation never returns a partial analysis as completed.
