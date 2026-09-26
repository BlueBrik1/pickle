# Pickle

**Know what your change touches.**

Pickle traces supported relationships in a JavaScript/TypeScript project before you implement a change. Load a folder or the synthetic Pantry sample, describe your change, confirm starting files, then inspect dependencies, source evidence, review priorities, tests, and suggested work. Download Markdown, JSON, or a handoff for IBM Bob.

It is deterministic static analysis. It does not execute imported code, use an LLM, prove that code will break, measure test coverage, or run Bob. No account, database, or API key is required.

## Run locally

Use Node.js 24 LTS and npm. The build was tested on Windows with Node **24.21.0** (the pinned development runtime) and npm **10.9.2**. The initial dependency installation also worked with the host's Node 22.13.1. Prefer the documented 24 LTS runtime for a clean setup.

```sh
npm ci
npm run dev
```

Open **http://127.0.0.1:5173**. Vite proxies `/api` to the loopback service on port 3001. The development script compiles the server and workers before starting, then watches both code paths. `Ctrl+C` stops development processes.

For the production build:

```sh
npm run build
npm start
```

Open **http://127.0.0.1:3001**. Express serves the built interface, real client routes, and the API. A static-only host is insufficient.

## Use the sample

1. Select **Try the sample**. Pantry contains 35 small, synthetic source/config/schema/document files and harmless mock data clients.
2. Keep the account-deletion request or choose another sample request. Press **Find starting files**.
3. Inspect the suggestions and confirm the files you intend to edit. For the documented benchmark/demo, select `src/pages/SettingsPage.tsx`, `server/services/accountService.ts`, and `server/data/accountRepository.ts` using path search. Up to eight files are supported.
4. Press **Analyze impact**. Inspect nodes or the Files table, open source evidence, and expand the score rules. Arrows point from a dependent to its dependency. Type-only links are distinct.
5. Review Plan and Checks. Task wording, notes, and manual completion are a separate user overlay; they do not modify evidence or scores.
6. Download the Markdown report, JSON result, or **Export for Bob** handoff. Review it before passing it to Bob in a trusted checkout.

Account deletion is proposed work. The sample has existing GET/PATCH account routes, not an implemented deletion endpoint. A direct test import does not establish deletion-behavior coverage.

## Local and hosted-demo modes

`PICKLE_MODE=local` is the default. It binds to `127.0.0.1`, and the browser sends selected supported files to that local service. Source is held in memory and expires after 30 idle minutes; clearing a project deletes its source and associated work. Results recover on refresh while the same cookie session and service remain available. Source is not stored in browser storage or on disk by the application.

`PICKLE_MODE=demo` allows only the bundled public sample and rejects folder uploads at the API. It listens on all interfaces. For public hosting, configure an exact `PICKLE_PUBLIC_ORIGIN` and HTTPS reverse proxy. Example in PowerShell:

```powershell
$env:PICKLE_MODE = 'demo'
$env:PICKLE_PUBLIC_ORIGIN = 'https://your-approved-host.example'
npm start
```

Do not publish local mode. Deployment has not been performed. See [deployment instructions](docs/deployment.md).

## Verify

```sh
npx playwright install chromium
npm run verify
```

`verify` runs strict client/server typechecking, ESLint, unit/integration tests, a production build, and Chromium browser tests against local and demo services. Browser tests use ports 3001 and 3002; stop unrelated services on those ports first. They capture desktop and mobile views in `docs/screenshots/`. Test reports and traces stay in ignored output directories.

Individual commands: `npm run typecheck`, `npm run lint`, `npm test`, `npm run build`, `npm run test:e2e`. `npm test` first compiles worker entry points. After a production build, `node scripts/benchmark.mjs` reruns the documented synthetic benchmark. No tests, scripts, or dependencies from an imported project are executed by Pickle.

## Scope and limits

- Accepted snapshot: at most 1,500 files, 256 KiB per accepted file, 8 MiB total UTF-8 content, and 16 MiB request body. Oversized individual files are explicitly skipped; global capacity failures reject the project. See the scan summary.
- Imports/re-exports, literal `require` and dynamic `import`, type-only relationships, and bounded root aliases/config inheritance are recognized through TypeScript **6.0.3**, pinned for its compiler API. Resolution is against the snapshot only.
- Additional relationships use documented literal Express/fetch/Axios, table/SQL, environment-name, Markdown, and test patterns. Unknown dynamic behavior, external packages, other frameworks, and full SQL semantics remain outside the analyzer.
- Scores prioritize human review. They are not probabilities or a safety guarantee. Test/document rows are not scored as implementation risk.
- The graph displays up to 120 nodes and 200 edges. Panning/zooming changes the viewport; filters and graph caps never remove the full Files results or export evidence.
- Exclusions and redaction reduce accidental disclosure but cannot guarantee removal of every secret. Do not import confidential source into a public deployment.
- In-memory snapshots disappear on restart. There is no Git cloning, ZIP extraction, automatic project edit, project execution, external agent connection, or automatic publication.

See [analysis rules](docs/analysis-rules.md), [privacy and safety](docs/privacy-and-safety.md), [API and lifecycle](docs/api.md), [measured benchmark](docs/benchmark-method.md), and [build verification record](docs/build-progress.md).

## Submission and licensing

The application and source are prepared locally. Authentic IBM Bob IDE work, task-summary screenshots, public repository approval, application publication, cover image, video, slides, and event submission still require participant action. This Codex session is not Bob evidence. See [submission checklist](docs/submission-checklist.md) and [Bob usage record](docs/bob-usage.md).

Original code and the synthetic fixture are MIT licensed. Font licenses and third-party notices are retained under `licenses/` and [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md).
