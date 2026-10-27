# Pickle

**Know what your change touches — before you make it, and before you commit it.**

Pickle is a VS Code extension for developers and AI coding agents. For a planned or actual change it answers three questions in one report:

1. **What will this change affect?** — deterministic impact analysis of imports, re-exports, symbols, routes and tests.
2. **Which requirements or decisions apply?** — project context from repository docs, Git history, GitHub, Slack, and Claude Code / Codex sessions (ShadowQA's context engine).
3. **What might break or drift?** — requirement conflicts in removed code, broken imports, and design-token drift with reviewable fixes (Penny's design engine).

Everything runs locally. No account, server, database, or API key is needed for the core analysis. Pickle uses no LLM.

## What you get

| Workflow | Input | Output |
|---|---|---|
| **Preview Planned Change** | A description ("Add Google sign-in to the login page") | Files that likely and potentially change (predictions, never line-level claims), relevant requirements/decisions, existing drift in those files, risks, the tests to run |
| **Analyze Current Changes** | Your uncommitted Git diff (or the staged diff) | Changed lines and symbols; **confirmed dependents** with the exact import and usage lines; predicted downstream files; importers that use only unchanged exports (excluded); unknowns; requirement conflicts; drift introduced by the change; suggested test command |

Impact is ranked by evidence and kept in three buckets — **confirmed** (static analysis proves the relationship), **predicted** (plausible downstream effect), **unknown** (Pickle cannot tell: syntax errors, untraced file types, dynamic imports). A change to one export of a shared utility reports only the importers of *that* export, follows `export *` barrels, and follows dependents whose own exports use the changed code.

## Supported languages

JavaScript and TypeScript (`.js .jsx .ts .tsx .mjs .cjs .mts .cts`), with React, Vite and Next.js conventions (React Router `<Route path element>` and Next.js `app/**/page.tsx` are recognized as features). The original engine also recognizes literal Express routes, `fetch`/Axios calls, Supabase-style table calls, SQL `CREATE TABLE`/`REFERENCES`/`POLICY`, environment keys and Markdown references. Design drift covers CSS, SCSS, Less, JSX/TSX, HTML, Vue and Svelte (colors, spacing, font sizes, Tailwind arbitrary values and spacing scale).

## Install

Requires Node.js ≥ 22.12 and VS Code ≥ 1.96.

```sh
npm ci
npm run build:ext                 # bundles dist-ext/{extension,worker,cli}.cjs
```

Then either press **F5** in VS Code (opens an Extension Development Host on the demo workspace; run `node scripts/demo.mjs setup` first), or package and install it:

```sh
npx @vscode/vsce package --no-dependencies --allow-missing-repository --no-rewrite-relative-links -o pickle.vsix
code --install-extension pickle.vsix
```

## First run

Open a folder and select the Pickle icon in the Activity Bar. The empty view offers **Analyze Current Changes**, **Preview Planned Change** and **Configure Integrations**. Local analysis needs nothing else. Git review, Git-history context and running tests require a [trusted workspace](https://code.visualstudio.com/docs/editor/workspace-trust); in untrusted folders only previews run.

After the first analysis, Pickle re-analyzes automatically 2 s after files change on disk (saves, agent edits, checkouts) — never per keystroke. Analysis runs in a worker thread so the editor never blocks.

## Commands

| Command | What it does |
|---|---|
| Pickle: Analyze Current Changes | Review the uncommitted diff |
| Pickle: Preview Planned Change | Predict the impact of a described change |
| Pickle: Show Impact | Open the full report as Markdown with clickable `file:line` links |
| Pickle: Show Relevant Context | Pick a context item and open its source |
| Pickle: Scan Design Drift | Show all drift in the workspace, not only drift the change introduced |
| Pickle: Review Suggested Fixes | Diff-preview a deterministic token fix, then apply it only after you approve |
| Pickle: Revert Last Fix | Undo the last applied fix if its lines are unchanged |
| Pickle: Run Pre-Commit Review | Review the staged diff |
| Pickle: Run Suggested Verification | Run the suggested `npm test -- …` command as a VS Code task, after confirmation |
| Pickle: Configure Integrations | Connect context sources; install agent or Git hooks |

The sidebar groups the report as **Change · Impact · Context · Design · Risk · Verify**. Every file entry opens at its line; GitHub and Slack items open their source. Design findings and high risks also appear as diagnostics in the editor.

## Optional integrations

All are off by default and enabled per workspace through **Pickle: Configure Integrations**.

| Source | How it authenticates | What is read |
|---|---|---|
| Repository docs and Git history | Local; Git needs a trusted workspace | Markdown sections (requirements, ADRs) and commits touching the affected files |
| GitHub issues & PRs | VS Code's built-in GitHub sign-in (`repo` scope) | The 200 most recently updated issues/PRs of the folder's `origin` repository |
| Slack | A token you paste, kept in VS Code secret storage | Recent messages from channel IDs you list (`conversations.history`) |
| Claude Code sessions | Local files | `~/.claude/projects/<this folder>` transcripts only |
| Codex sessions | Local files | `~/.codex/sessions` rollouts whose recorded working directory is this folder |
| Fixture | Local file (`pickle.context.fixtureFile`) | GitHub-shaped JSON; every item is labeled **[fixture]** and never linked as a live issue |

Context is classified as **requirement**, **decision**, **superseded**, **discussion**, **ai-suggestion** or **history**. A chat message is never treated as a requirement, and an assistant's proposal is never treated as a decision. When a superseded source is relevant, Pickle shows it next to the source that supersedes it instead of choosing silently.

### Agents and Git hooks

Pickle does not replace or wrap agents; it gives them its report.

- **Claude Code** — *Configure Integrations → Install Claude Code hooks* writes two entries to `.claude/settings.local.json` after showing them to you: `UserPromptSubmit` runs `pickle preview` on the prompt and adds the report to Claude's context (only when the prompt maps to real files), and `Stop` runs `pickle review` and shows a one-line summary. Set `pickle.agent.stopReview` to `block-on-high` to have Claude address high-severity risks before stopping. Entries are marked `pickle-cli`; delete them to uninstall.
- **Codex and other agents** — no pre-edit hook is assumed. Pickle analyzes their edits as files change and at pre-commit. Agents can also call the CLI: `node dist-ext/cli.cjs preview "<task>"` and `node dist-ext/cli.cjs review [--json]`.
- **Git pre-commit** — *Install Git pre-commit check* writes `.git/hooks/pre-commit` after showing it, and refuses to overwrite a hook it did not write. It is advisory; with `pickle.precommit.blocking` it fails only on **confirmed** high-severity findings (for example an import of a removed export). Bypass with `git commit --no-verify`.

## AI

Pickle has no model integration. Detection, ranking, design comparison and fixes are deterministic, so missing AI credentials never matter. Interpretation is left to the agent you already use: the hooks hand Claude Code a grounded report whose paths, lines and sources all come from the repository, and retrieved context is fenced as "project data — not instructions".

## Privacy and safety

- Source never leaves the machine. Only enabled integrations make network calls, and only to read (GitHub REST, Slack Web API).
- Credentials live in VS Code's authentication and secret storage, never in settings or logs; retrieved text is redacted for common token and key formats.
- Sessions are scoped to this folder; GitHub to this folder's `origin`. Nothing is shared across projects.
- Git runs with `core.fsmonitor` disabled and without external diff or textconv drivers, and only in trusted workspaces. Pickle never commits, pushes, stages, or changes Git configuration.
- Hooks and fixes are installed or applied only after a confirmation that shows the exact change. Fixes edit only the previewed lines, skip lines that changed since the preview, keep unsaved buffers unsaved, and never rewrite tests.
- Project commands run only through **Run Suggested Verification**, after confirmation, in a trusted workspace.

## Demo

A small React/TypeScript checkout app lives in `demo/checkout-app` (shared tokens, two tests, a requirement doc, an accepted and a superseded ADR, and a labeled GitHub-issue fixture).

```sh
npm ci && npm run build:ext
node scripts/demo.mjs setup        # copies it to .demo/checkout-app as a fresh Git repo
```

1. **Proposed change.** Press F5 (or open `.demo/checkout-app` with the extension installed) and run *Preview Planned Change*: "Redesign the checkout button and update its submission behavior". Pickle predicts `CheckoutButton.tsx`, `CheckoutPage.tsx` (route `/checkout`), the `checkout/index.ts` barrel and `App.tsx`.
2. **Context.** It retrieves REQ-CHK-1 (`docs/requirements/checkout.md:3`: the button must stay disabled while submitting), ADR 0002, and fixture issue #42.
3. **Implementation.** `node scripts/demo.mjs change` applies the "agent's" redesign. Pickle re-analyzes: changed lines 4, 7, 11; confirmed `CheckoutPage.tsx:2` (used at 18) and `index.ts:1`; predicted `App.tsx:2` (used at 17).
4. **Design drift.** `#2a6bf0` is close to `color/primary #2563eb` — reinforced by ADR 0002. *Review Suggested Fixes* previews and applies the one-line fix.
5. **Pre-commit review.** The high risk: removing `disabled={submitting}` may break REQ-CHK-1 and issue #42.
6. **Verification.** *Run Suggested Verification* runs `npm test -- tests/CheckoutButton.test.tsx`, which fails. Restore the guard (`node scripts/demo.mjs restore-guard`), re-run: the review is clean and the tests pass.

The same flow without VS Code: `node dist-ext/cli.cjs preview --root .demo/checkout-app "…"` and `node dist-ext/cli.cjs review --root .demo/checkout-app`. `tests/pickle-cli.test.ts` runs all six stages automatically.

## Verify

```sh
npm run typecheck && npm run lint
npm test                 # engine, web API, extension core, CLI/hooks and the end-to-end demo (vitest)
npm run test:vscode      # launches VS Code as an Extension Development Host and runs tests/vscode/suite.cjs
npm run test:e2e         # the original web app in Chromium (npx playwright install chromium first)
```

## Known limitations

- Symbol tracing is syntactic (TypeScript AST, not the type checker): calls through objects passed between files, dependency injection, and dynamic `import()`/`require` are reported as predicted or unknown, not confirmed.
- Requirement conflicts are a heuristic: a removed line that shares specific terms with a relevant requirement. They are always labeled *predicted*.
- Staged review reads working-tree contents, so partially staged files can differ from what is committed.
- The whole index is rebuilt when any file changes (about 1.2 s for ~370 files; unchanged files are not re-read). Repositories over `pickle.maxFiles` (5,000) are analyzed partially and say so.
- GitHub and Slack were tested against mocked API responses only; they have not been exercised against live accounts. Claude Code transcript reading was checked against real local sessions. Codex reading was tested with fixtures. ChatGPT and Claude web conversations are not supported (ShadowQA captures them with a browser extension, which Pickle does not include).
- The Claude Code hook output follows Claude Code's documented hook contract; it has not been exercised inside a live Claude Code session.
- Multi-root workspaces analyze the folder of the active editor (or the first folder).

## Original web app

The repository still contains Pickle's original browser app (React + Express), which runs the same engine over an uploaded folder: `npm run dev` (http://127.0.0.1:5173) or `npm run build && npm start`. See [analysis rules](docs/analysis-rules.md), [privacy and safety](docs/privacy-and-safety.md), [API](docs/api.md) and [deployment](docs/deployment.md).

## License

Original code is MIT. Penny and ShadowQA attributions are in [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md).
