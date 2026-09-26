import { readFile, readdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { performance } from 'node:perf_hooks';
import { indexProject, analyze } from '../dist-server/server/analysis/index.js';
import { validateSnapshot } from '../dist-server/server/ingestion.js';

const root = path.resolve('fixtures/sample-project');
const files = [];
async function readTree(dir) {
  for (const entry of await readdir(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) await readTree(full);
    else
      files.push({
        relativePath: path.relative(root, full).replaceAll('\\', '/'),
        content: await readFile(full, 'utf8'),
      });
  }
}
await readTree(root);
files.sort((a, b) => a.relativePath.localeCompare(b.relativePath));
const seedPaths = [
  'src/pages/SettingsPage.tsx',
  'server/services/accountService.ts',
  'server/data/accountRepository.ts',
];
const requestText =
  "Add account deletion to the settings page. Remove the user's profile, related records, stored files, and saved OAuth tokens.";
const rounds = [];
let finalProject, finalResult;
for (let run = 1; run <= 10; run++) {
  const start = performance.now();
  const snapshot = validateSnapshot({ name: 'Pantry benchmark', files });
  const validated = performance.now();
  const project = indexProject(snapshot);
  const indexed = performance.now();
  const seedFileIds = seedPaths.map((p) => {
    const file = project.files.find((f) => f.path === p);
    if (!file) throw new Error(`Benchmark seed missing: ${p}`);
    return file.id;
  });
  const result = analyze(project, {
    analysisId: `benchmark-${run}`,
    repositoryId: 'benchmark-sample',
    requestText,
    seedFileIds,
    settings: { maxDepth: 3, includeTypeOnly: true },
  });
  const finished = performance.now();
  rounds.push({
    run,
    validationMs: validated - start,
    indexMs: indexed - validated,
    analysisMs: finished - indexed,
    engineMs: finished - validated,
    totalMs: finished - start,
  });
  finalProject = project;
  finalResult = result;
}
const stats = (key) => {
  const values = rounds.map((r) => r[key]).sort((a, b) => a - b);
  return { min: values[0], median: (values[4] + values[5]) / 2, max: values[9] };
};
const countsBy = (items, key) =>
  Object.fromEntries(
    [...new Set(items.map((i) => i[key]))]
      .sort()
      .map((value) => [value, items.filter((i) => i[key] === value).length]),
  );
const results = {
  measuredAt: new Date().toISOString(),
  method:
    'Ten sequential synchronous calls in one Node process; all runs retained, no warmup excluded; file reads outside timer. Engine includes indexing and analysis; validation reported separately.',
  environment: {
    node: process.version,
    platform: process.platform,
    architecture: process.arch,
    osRelease: os.release(),
    cpu: os.cpus()[0]?.model,
  },
  input: {
    seedPaths,
    requestText,
    settings: { maxDepth: 3, includeTypeOnly: true },
    snapshotFingerprint: finalProject.fingerprint,
    acceptedFiles: finalProject.scan.acceptedFiles,
    acceptedBytes: finalProject.scan.acceptedBytes,
    sourceFiles: finalProject.scan.sourceFiles,
  },
  counts: {
    indexedRelationships: finalProject.relationships.length,
    resultRelationships: finalResult.relationships.length,
    resultImpacts: finalResult.impacts.length,
    relationshipsByKind: countsBy(finalResult.relationships, 'kind'),
    roles: countsBy(finalResult.impacts, 'primaryRole'),
    findings: finalResult.findings.length,
    tasks: finalResult.plan.length,
    unresolved: finalProject.scan.unresolvedReferences.length,
    warnings: finalProject.scan.warnings.length,
  },
  milliseconds: {
    validation: stats('validationMs'),
    index: stats('indexMs'),
    analysis: stats('analysisMs'),
    engine: stats('engineMs'),
    total: stats('totalMs'),
  },
  runs: rounds,
  manualBaseline: 'Unmeasured. No productivity or time-saved comparison is claimed.',
  limits: [
    'Synthetic 35-file fixture; results do not generalize to large or private repositories.',
    'HTTP, worker startup/queue, browser rendering, source loading, and export times are excluded.',
    'JIT/caches, background load, and a small sample influence measurements.',
    'Counts are recognized relationships, not correctness, recall, precision, test coverage, or safety.',
  ],
};
await writeFile('docs/benchmark-results.json', JSON.stringify(results, null, 2) + '\n');
const f = (value) => value.toFixed(2);
await writeFile(
  'docs/benchmark-method.md',
  `# Benchmark method and measured results

Measured ${results.measuredAt} with Node ${results.environment.node} on ${results.environment.platform}/${results.environment.architecture}, ${results.environment.cpu}.

Run \`npm run build:server\`, then \`node scripts/benchmark.mjs\`. The script reads the inert bundled fixture, validates a fresh snapshot for each of ten sequential rounds, indexes it, and analyzes the same three confirmed starting paths: ${seedPaths.map((p) => '\`' + p + '\`').join(', ')}. Depth is 3 and type-only links are included. No project source, package scripts, or fixture tests are executed. All ten runs are retained; there is no excluded warmup. Timing uses \`performance.now()\`. File reads precede the timer. Raw runs, environment, fingerprint, and counts are in [benchmark-results.json](benchmark-results.json).

| Stage | Minimum ms | Median ms | Maximum ms |
|---|---:|---:|---:|
${Object.entries(results.milliseconds)
  .map(
    ([label, s]) => '| ' + label + ' | ' + f(s.min) + ' | ' + f(s.median) + ' | ' + f(s.max) + ' |',
  )
  .join('\n')}

The validated fixture has ${results.input.acceptedFiles} accepted files (${results.input.acceptedBytes} bytes), including ${results.input.sourceFiles} source files. Its full index has ${results.counts.indexedRelationships} recognized relationships. The selected analysis reaches ${results.counts.resultImpacts} unique files with ${results.counts.resultRelationships} relationships, ${results.counts.findings} findings, and ${results.counts.tasks} proposed tasks. Unresolved references: ${results.counts.unresolved}; scan warnings: ${results.counts.warnings}.

No manual-review baseline, productivity improvement, time saved, precision, or recall was measured. These are local latency observations on one synthetic fixture, not a performance guarantee. Worker startup/queue, HTTP, browser rendering, file reads, and exports are excluded. JIT, caches, background load, and the small sample affect results. More relationships do not imply a more accurate or safer result. Re-running the script updates the recorded measurements honestly.
`,
);
console.log(
  JSON.stringify(
    {
      runs: 10,
      engineMedianMs: results.milliseconds.engine.median,
      impactedFiles: results.counts.resultImpacts,
      relationships: results.counts.resultRelationships,
      output: 'docs/benchmark-results.json',
    },
    null,
    2,
  ),
);
