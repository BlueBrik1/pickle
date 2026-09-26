# Privacy and safety

Pickle reads an immutable text snapshot. In local mode, the browser sends selected, accepted files to the Pickle service on the same machine. Source does leave the browser. The application does not send it to a model provider, analytics service, or another repository host.

The public demo accepts only the bundled synthetic Pantry project. Its import endpoint rejects arbitrary snapshots even when called directly.

## What is read

The folder picker supplies browser `File` objects. Pickle removes exactly the selected root folder prefix and preserves the paths below it. It does not provide an absolute-path browser or a server endpoint for reading the host filesystem. The resolver sees only accepted paths under a virtual project root; dependency resolution never falls back to installed packages or host files.

Accepted extensions are `.ts`, `.tsx`, `.js`, `.jsx`, `.mts`, `.cts`, `.mjs`, `.cjs`, `.sql`, `.md`, `.mdx`, `.json`, `.jsonc`, `.yml`, and `.yaml`. Root `.gitignore` and `.env.example`/`.env.sample` files are also accepted. Acceptance is not a promise of full semantic analysis: Markdown, MDX, YAML, and SQL stay inert text with bounded recognizers.

Both browser and server reject malformed paths and ambiguous duplicates. Windows separators become POSIX separators; absolute paths, drive/UNC paths, dot segments, repeated separators, control characters, encoded path-control characters, and case collisions are rejected. No supplied path is URL-decoded into an accepted path.

## Exclusions and redaction

Always-excluded directories include Git metadata, dependencies, build output, coverage, framework caches, vendor trees, and generated trees. Unsupported formats, binary content, lockfiles, source maps, private-key material, common credential filenames, and recognizable service-account JSON are excluded. Non-example `.env` files are excluded even when an ignore negation tries to include them.

Environment example values and comments are discarded before transmission and again before server retention. Valid names and line positions remain. For example, `UPLOAD_BUCKET=private-value` becomes `UPLOAD_BUCKET=`. Values never provide evidence for the environment-name matcher.

Root ignore rules support comments, negation, root anchors, directory suffixes, `*`, `?`, and whole-segment `**`. Rules containing escaped syntax, character classes, or dot segments are ignored with a scan warning. Processing accepts at most 2,048 rules of 512 characters each; excess rules produce a warning. Nested ignore files and Git's full parent-directory negation semantics are unsupported. Supported rules run in order; the last matching rule wins. Explicit secret/generated exclusions take precedence. Glob matching does not compile uploaded patterns into regular expressions.

The browser decodes bytes with a fatal UTF-8 decoder. The server receives Unicode JSON strings and independently rejects replacement characters, unpaired surrogates, and binary control characters. A valid text file containing the Unicode replacement character is conservatively skipped.

Source excerpts and exports use best-effort redaction for common secret assignments, credential-bearing URLs, bearer tokens, private keys, and recognizable token formats. Markdown output escapes uploaded text. Redaction preserves line counts but may change columns; the source inspector does not claim exact highlighted column alignment after redaction. This is not a complete data-loss prevention system. Review exports before sharing them and do not import secrets.

## Retention and ownership

Snapshots, indexes, analyses, source, and user review edits stay in server memory. The app does not save imported source or reports to browser storage or disk. A downloaded export is a file the user has explicitly requested and controls separately.

Each browser session receives an unpredictable HTTP-only, SameSite=Strict cookie. Every repository, source, analysis, review, cancel, and export lookup checks its owning session. Foreign IDs return a generic not-found response. Cookies are marked Secure when `PICKLE_PUBLIC_ORIGIN` uses HTTPS.

Clearing a project cancels its work and removes its snapshot, results, and source. Idle projects and sessions expire after 30 minutes; expired routes receive a handled expired state. Restarting the process drops all in-memory work. Expiry does not erase copies a user downloaded or material retained by operating-system memory management.

## Resource limits

| Limit | Value |
| --- | --- |
| Accepted files | 1,500 per project |
| One accepted file | 256 KiB of UTF-8 text |
| Accepted content | 8 MiB per project |
| JSON body | 16 MiB, uncompressed |
| Normalized relative path | 512 characters |
| Change request | 10–2,000 trimmed characters |
| Starting files | 1–8 |
| Active snapshots | 3 per session |
| Analyses retained | 30 per session |
| Active workers / queued jobs | 2 / 10 |
| Worker deadline | 30 seconds |
| Logical retained snapshot content | 64 MiB process-wide |
| Worker V8 heaps | 256 MiB old generation; 32 MiB young generation |
| API request rate | 240 per session per minute |
| Sessions | 200 process-wide |
| Source excerpt | At most 17 lines and 16 KiB of text |

Oversized individual files are skipped with a reason. Exceeding global accepted-file or byte limits rejects the import rather than silently returning a partial project. A full queue or retained-content budget returns a retryable error. The 64 MiB counter measures retained snapshot text; it is not an operating-system RSS cap. Parser structures, results, worker copies, and runtime overhead consume additional memory. See the benchmark notes for measurements.

Local mode binds to `127.0.0.1`. API Host, Origin, and cross-site fetch checks restrict requests; CORS is not enabled. Errors omit stack traces, host paths, uploaded source, and parser details. Application logging records the startup mode and port, not requests or source.

## Non-execution boundary

Pickle never imports submitted modules, evaluates JavaScript or MDX, loads project plugins, installs uploaded dependencies, runs project scripts or tests, applies patches, or follows symlinks. Package scripts are inert strings. Worker threads parse the snapshot with the bundled analyzer; they do not execute uploaded code.

A source relationship does not establish runtime behavior, authorization, production state, or test coverage. Export for Bob produces a reviewable file. Any later test run or implementation belongs in a separately trusted checkout with its normal permissions.
