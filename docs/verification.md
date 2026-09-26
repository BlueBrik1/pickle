# Verification record

Performed September 26, 2026, in the local Windows workspace. Commands use the committed npm lockfile. Node 24.21.0 and npm 10.9.2 were available; the package pins a development Node runtime for repeatability.

- `npm ci`: clean dependency installation succeeded; npm reported zero known vulnerabilities at installation time.
- `npm run typecheck`: strict client and server TypeScript checks passed.
- `npm run lint`: ESLint passed for application, server, and tests.
- `npm test`: 89 tests in six files passed. These include parser/resolver, graph/scoring/reference, anti-canned mutation, ingestion/export, API/session/lifecycle, worker and visual-token/contrast checks.
- `npm run build`: compiled JavaScript worker/server and production frontend succeeded. Vite reports an advisory that the main client bundle is above 500 kB (about 586 kB before gzip). This is not a build failure.
- `npm run test:e2e`: eight Chromium tests passed against production assets in local and demo modes. They cover all required browser flows, with some flows grouped into one test: request/confirmation/analysis, graph and table evidence, filters, notes/checkmarks/exports, route refresh/back/forward, keyboard, error recovery, clipboard fallback, mobile inspection, folder import, escaped malicious Markdown, demo restrictions, queued cancellation/restart, graph display limits without result loss, and source access for a cited test outside the bounded impact set.
- `npm run dev`: Vite and the compiled-worker service started. A separate real Chromium run through port 5173 loaded Pantry, matched/confirmed files, and completed analysis with zero browser errors and no 390px viewport overflow.
- Authored and bundled styles were searched for gradient functions; none were found. Automated authored-color and foreground contrast checks passed. Browser inspection confirmed Source Serif Pro and Work Sans loading/rendering. Desktop and mobile screenshots were visually inspected.
- `scripts/benchmark.mjs`: ten measured sample runs on the final engine. See [method and raw measurements](benchmark-method.md); these exclude worker startup and browser interaction and are not a productivity comparison.

## Captures

- [Start, 1440px](screenshots/start-1440.png)
- [Result, 1440px](screenshots/result-1440.png)
- [Result, 1280px](screenshots/result-1280.png)
- [Result, 390px](screenshots/result-390.png)
- [Start, 390px](screenshots/start-390.png)

These are application QA captures, not Bob task-session screenshots or finished submission media.

## Boundaries of verification

Automated browser coverage uses Chromium on Windows. Firefox, Safari, assistive-technology user testing, adversarial security certification, an RSS capacity/load study, and public-host deployment have not been performed. The deterministic fixture and synthetic mutation checks do not establish whole-program semantic accuracy or production safety. The 64 MiB snapshot text budget and worker heaps are enforced limits, not a claim that total process RSS is capped at those values.
