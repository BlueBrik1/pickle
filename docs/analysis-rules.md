# Analysis rules (analyzer 0.1.0 / rules 1.0)

Pickle indexes a validated, in-memory snapshot. It neither executes its files nor loads its dependencies. All IDs derive from normalized paths, rules, and source locations. The fingerprint hashes sorted accepted paths and content. Repeating the same input produces the same semantic output; runtime IDs, elapsed time, and timestamps are separate.

## Source and module resolution

TypeScript 6 `createSourceFile` parses `.js`, `.jsx`, `.ts`, `.tsx`, `.mjs`, `.cjs`, `.mts`, and `.cts`. JSX script kinds are selected explicitly. A syntax-tree walk extracts static imports, re-exports, literal `require` and `import()` calls, type-only clauses (including all-type named clauses), declared names, and the reference patterns below. Mixed type/value clauses count as value imports. Comments and string contents are not treated as JavaScript syntax. Syntax diagnostics mark a file partial; retained references remain observations of parsed syntax, not proof of valid executable code. Nonliteral import targets are recorded as unsupported.

The custom TypeScript resolution host has only snapshot-backed `fileExists`, `readFile`, `directoryExists`, and identity `realpath`. There is no `ts.sys`, real-filesystem, package installation, or execution fallback. Relative paths, TS source substitution for `.js` imports, directory indexes, and root `paths`/`baseUrl` work under Bundler resolution by default. Node10 resolution can be selected; other modes are reported and fall back explicitly to Bundler because runtime package conditions are not modeled. Root `tsconfig.json` takes precedence over `jsconfig.json`.

Configuration is JSONC data. Relative, in-snapshot `extends` is limited to eight files with cycle detection. Relative `baseUrl` and `paths` are anchored at the declaring config before merging. Package-provided, array, cyclic, too-deep, or escaping inheritance is reported and ignored. Plugins are ignored. Declared root-package dependencies and `node:` names are external, never followed. Unmatched relative, configured alias, `#` alias, or baseUrl candidates are unresolved; other bare package specifiers are external. This conservative classification can report an undeclared package under baseUrl as unresolved. Nested configs and package export conditions are not modeled.

One-based line/column spans use offsets in the original accepted text, including CRLF. The server supplies escaped source excerpts separately. File metadata includes all scanned files so evidence can cite a mount or fan-in consumer outside the reached impact set. Only `impacts` are affected-file results; metadata count is the scanned-file count.

## Additional references

Each recognized fact has its own evidence and source location, including facts whose endpoints are the same file. Matched relationships have evidence citing both facts. Evidence levels remain separate from review priority.

* **HTTP:** literal method calls on `app`, `router`, or names ending `Router` recognize GET/POST/PUT/PATCH/DELETE/HEAD/OPTIONS handlers. These are receiver-name patterns, not framework type checking. An imported identifier passed as the second argument to `.use('/prefix', identifier)` composes a route, up to four mount levels with cycle detection. Imported router identity is matched by file; multiple exported routers are not distinguished. `fetch('/path')` is GET; an object literal may specify a literal method. Dynamic options/methods and spreads are unknown. The Axios subset is `axios.get/post/put/patch/delete/head/options('/path', ...)`. Only relative root URLs are matched. Duplicate handlers, route parameters, and compatible template strings yield inferred links. Exact unique method/path pairs without dynamic segments are supported references. Queries/trailing slashes are normalized; runtime URLs, middleware, authentication, proxies, arrays, wildcards, Axios instances, and computed mount identities are not modeled.
* **Tables:** literal `.from('table')` calls on receiver roots named `supabase`, `db`, `database`, or `client` are recognized as table-name references. The name rule does not establish runtime database identity. Schema-qualified names match exactly; an unqualified name matches only if one scanned table definition has that basename. Ambiguous/missing definitions are unresolved.
* **SQL:** a bounded scanner recognizes `CREATE TABLE [IF NOT EXISTS] name (...)`, `REFERENCES name [(columns)] [ON DELETE CASCADE|RESTRICT|SET NULL|NO ACTION]`, and `CREATE POLICY name ON table`. It retains quoted identifier case and folds unquoted names to lowercase. Comments, ordinary string literals, and dollar-quoted bodies are masked without changing source offsets. Dollar bodies, procedural SQL, ALTER/DROP, views, and nonstandard CREATE forms are explicitly limited. Foreign-key delete clauses are observed text, not verified production behavior. Column-level semantics, dynamic SQL, nested comments, alternate dialect quoting, migration ordering, and deployment state are not established.
* **Environment:** `process.env.NAME`, `process.env['NAME']`, and `import.meta.env.NAME`/literal element access record key names only. They match accepted sanitized `.env.example`/`.env.sample` keys (the engine also recognizes template-shaped example names if supplied by a future ingestion policy). Computed keys are unsupported. Missing example keys are unresolved documentation questions, not proof of missing deployed variables. No process environment values are read.
* **Documents:** Markdown is inert text. Inline code and relative link targets match accepted root-relative or document-relative paths only when unambiguous. Inline exact route (`/path` or `METHOD /path`) and table names can match indexed resources. These are inferred reference candidates. Word overlap is used only in candidate search. HTML/MDX is never executed by the analyzer; displayed source must remain escaped.
* **Tests:** `.test.*`, `.spec.*`, and `test`, `tests`, `spec`, `specs`, or `__tests__` path segments identify tests. A resolved direct import is a direct reference. Equal source/test basenames without an import are possible references. Tests and docs have no review score. No claim is made about assertions, indirect endpoint tests, executed coverage, or completeness. Parse failures, unresolved local imports, dynamic module targets, and potentially relevant skipped-file reasons make the test scan partial and suppress absence penalties.

## Request matching

Case and punctuation are normalized; camelCase, snake_case, and kebab-case are split. The stop list is: `a an the to of for in on and or with from this that add change new related page all as is be it into by should can need implement`.

Conservative normalization maps deleting/deleted to delete, removing/removed to remove, and the explicit plural forms settings, accounts, users, profiles, files, tokens, uploads, buckets, records to their singular forms. Intent groups are `delete/remove/deletion`, `account/user/profile`, `upload/storage/bucket`, and `oauth/token/credential`. These are search hints, never graph edges.

Match scoring adds: explicit path +100; exact declared identifier +30 each (cap 60); exact literal resource +25 each (cap 50); direct path token +15 each (cap 45); expanded intent token +5 each (cap 20); other content token +2 each (cap 10). The content index examines at most the first 65,536 characters of each accepted file. Resource facts are grouped by file in one pass per request; sorting uses a file-ID/path map rather than repeated scans. Scoring similarly uses per-file evidence and incoming-edge indexes. Each explanation names the matched field and actual terms. Scores sort descending, then normalized path ascending. `STRONG_MATCH_THRESHOLD` is 30; test/doc suggestions are never strong unless their path was explicitly mentioned. The UI may preselect up to three strong matches, but analysis still requires user confirmation. Match scores do not become review scores.

## Graph traversal and counts

For `A -> B`, A depends on B. A deterministic breadth-first traversal follows incoming structural edges from confirmed starting files to the configured depth (1–5). Edges are ordered by importer path and stable edge ID; starting paths are sorted. Visited tracking handles cycles, diamonds, and self-imports. Every dependent receives a deterministic shortest ordered relationship-ID path. Additional supported relationships are retained even if they are not on that path.

Immediate outgoing dependencies of starting files are context, with no recursive dependency expansion. One round of nonstructural references attaches to the initial seed/dependent/dependency set in either direction. A table definition attached through a table reference permits one further incoming schema-reference round. Reference attachment does not recursively collect all consumers of a shared resource. A single file can have multiple roles, but disjoint summary precedence is seed, dependent, dependency, reference. Category counts are independent. Type-only traversal respects the setting and remains labeled type-level. Fan-in scoring uses the whole scanned structural graph regardless of selected depth. Graph display caps must not truncate `impacts` or exports.

## Review scoring and tasks

Scores are a human inspection queue, not probabilities. Assessed implementation, schema, config, and other accepted code/data files receive:

| Rule | Points | Basis |
|---|---:|---|
| Base review | 10 | Relevant assessed file and classification evidence |
| Starting file | 20 | User confirmation |
| Related file | 10 | Non-starting reached file, mutually exclusive with starting points |
| Sensitive responsibility | 25 | Once for auth/API/schema/config classification or observed handler/env/table/policy facts |
| Destructive review | 20 | Delete/remove/deletion request plus account/user/profile/record/storage/upload/bucket/token/oauth terms in observed declarations or resource facts |
| No direct test import | 10 | Implementation only; no direct import and test scan complete enough for the narrow absence claim |
| Consumer fan-in | 0–15 | Three per unique non-test, non-self, non-type-only local importer, capped at 15 |

Scores clamp at 100. Low is 0–39, medium 40–69, high 70–100; tests/docs show null/Not assessed. Path classifications are explicitly heuristic. Every applied component has evidence IDs or a user-input basis. No-direct-test evidence is explicitly unknown about coverage. Tasks and checkmarks do not alter snapshot scores.

Findings cite observed relationships or a qualified scan absence. Per-file review tasks reference the actual files/findings/evidence; preparation, acceptance criteria, execution of checks elsewhere, and deletion verification questions are labeled request-derived. Pickle does not propose code as observed source or pretend that tests, edits, or Bob actions have executed. Developers still decide implementation details and confirm unrecognized relationships.

## Verification

`tests/engine.test.ts` exercises AST forms, virtual-host isolation, configuration inheritance, positions, graph shapes/depth/type settings, score boundaries, reference recognizers, scan uncertainty, deterministic ordering, a separate synthetic layout, bundled source analysis, and all six mandatory anti-canned mutations. The fixture contains source files only; the analyzer does not read expected results. API/ingestion/export/browser tests live separately.
