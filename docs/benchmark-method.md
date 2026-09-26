# Benchmark method and measured results

Measured 2026-09-26T18:32:01.665Z with Node v24.21.0 on win32/x64, 12th Gen Intel(R) Core(TM) i5-12600K.

Run `npm run build:server`, then `node scripts/benchmark.mjs`. The script reads the inert bundled fixture, validates a fresh snapshot for each of ten sequential rounds, indexes it, and analyzes the same three confirmed starting paths: `src/pages/SettingsPage.tsx`, `server/services/accountService.ts`, `server/data/accountRepository.ts`. Depth is 3 and type-only links are included. No project source, package scripts, or fixture tests are executed. All ten runs are retained; there is no excluded warmup. Timing uses `performance.now()`. File reads precede the timer. Raw runs, environment, fingerprint, and counts are in [benchmark-results.json](benchmark-results.json).

| Stage | Minimum ms | Median ms | Maximum ms |
|---|---:|---:|---:|
| validation | 0.34 | 0.40 | 4.12 |
| index | 6.65 | 7.69 | 36.93 |
| analysis | 1.62 | 2.01 | 17.66 |
| engine | 8.35 | 9.61 | 54.59 |
| total | 8.69 | 10.00 | 58.71 |

The validated fixture has 35 accepted files (9334 bytes), including 23 source files. Its full index has 59 recognized relationships. The selected analysis reaches 25 unique files with 41 relationships, 54 findings, and 37 proposed tasks. Unresolved references: 0; scan warnings: 0.

No manual-review baseline, productivity improvement, time saved, precision, or recall was measured. These are local latency observations on one synthetic fixture, not a performance guarantee. Worker startup/queue, HTTP, browser rendering, file reads, and exports are excluded. JIT, caches, background load, and the small sample affect results. More relationships do not imply a more accurate or safer result. Re-running the script updates the recorded measurements honestly.
