# Running and publishing Pickle

The application has no database, external model key, or account signup. Use Node.js 22.12 or newer. Run all commands from the repository root so the compiled server can locate `dist/` and `fixtures/sample-project/`.

```sh
npm ci
npm run build
npm start
```

The local production build listens at `http://127.0.0.1:3001`. `npm run dev` starts the API and Vite development interface; use the address printed by Vite. Production uses the built Express server for both the interface and API.

## Sample-only deployment

Publication requires the repository owner's approval. These instructions prepare a deployment; no public URL has been created by this build.

Set these environment variables for a Node-capable host:

```text
PICKLE_MODE=demo
PORT=3001
PICKLE_PUBLIC_ORIGIN=https://your-approved-host.example
```

Build with `npm ci && npm run build`, then start with `npm start`. Keep the fixture directory alongside the application. Use an HTTPS reverse proxy and preserve a Host header matching the configured public origin. Proxy `/api` and frontend routes to the same process; do not add wildcard CORS. A missing or mismatched public origin causes the API's Host/Origin checks to reject public requests. HTTPS configuration marks the session cookie Secure.

Demo mode binds to `0.0.0.0` for hosting and rejects arbitrary project imports server-side. Never expose local mode publicly. The required hosted version is for the synthetic sample only.

Sessions and results live in one process. Restarting it invalidates existing routes; multiple replicas require sticky routing and still lose state when a replica restarts. Prefer one modest instance for this prototype and apply a host memory limit above measured runtime usage. The application's snapshot-content and worker limits do not cap total RSS. Configure proxy access logs to omit request bodies and cookies.

## Verify the deployed instance

Run the repository checks before publishing: `npm run typecheck`, `npm run lint`, `npm test`, `npm run build`, and `npm run test:e2e`. Inspect real desktop and mobile rendering. Review build-progress notes for checks actually completed in this environment.

On the deployed instance, load the sample, confirm starting files, complete analysis, refresh the result URL in the same browser session, and download all three exports. Confirm that an unknown `/api` path returns JSON rather than the frontend. Send a direct import request and confirm the demo-mode rejection. Open another browser session and verify that it cannot retrieve the first session's repository or result.

For shutdown, send SIGINT or SIGTERM; the server stops accepting connections and terminates workers. No imported source needs disk cleanup because snapshots are held in memory.
