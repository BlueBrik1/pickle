import path from 'node:path';
import { analyze, matchCandidates, tokenize } from '../../server/analysis/index.js';
import type { AnalysisResult, FileImpact } from '../../src/shared/schema.js';
import { summarizeChange, traceDependents, type ChangedSymbol } from './changes.js';
import { gatherContext, type ContextItem, type ContextOptions, type SourceState } from './context.js';
import { scanDesign, type DesignFinding, type DesignResult } from './design.js';
import { changedFiles, isRepo, showHead, type ChangedFile } from './git.js';
import { loadWorkspace, type Workspace } from './workspace.js';

export interface ImpactEntry {
  path: string;
  line?: number;
  lines?: number[];
  why: string;
  symbols?: string[];
  level: 'confirmed' | 'predicted' | 'unknown';
  feature?: string;
}
export interface Risk {
  level: 'high' | 'medium' | 'low';
  basis: 'confirmed' | 'predicted';
  text: string;
  refs: { path: string; line?: number }[];
}
export interface Report {
  mode: 'preview' | 'review';
  title: string;
  root: string;
  changed: { path: string; status: ChangedFile['status']; oldPath?: string; ranges: [number, number][]; symbols: ChangedSymbol[] }[];
  impact: { confirmed: ImpactEntry[]; predicted: ImpactEntry[]; unknown: ImpactEntry[]; excluded: string[]; omitted: number };
  context: ContextItem[];
  sources: SourceState[];
  design: DesignFinding[];
  designBaseline: DesignResult['baseline'];
  designPreexisting: number;
  risks: Risk[];
  verify: { command?: string; tests: string[]; reason: string };
  limitations: string[];
  timings: Record<string, number>;
}
export interface Options {
  context?: ContextOptions;
  tokensFile?: string;
  maxFiles?: number;
  /** Optional task description to sharpen context retrieval during review. */
  task?: string;
  staged?: boolean;
}

const CAP = 8;
const FEATURE_RE = /(?:^|\/)(?:pages|routes|views|screens|app)\/|(?:Page|Route|Screen|Layout)\.[jt]sx?$/;
const DOC_OR_TEST = new Set(['test', 'docs']);

function featureOf(ws: Workspace, file: string): string | undefined {
  if (!FEATURE_RE.test(file)) return undefined;
  const name = path.posix.basename(file).replace(/\.[^.]+$/, '');
  const component = name === 'page' || name === 'index' ? path.posix.basename(path.posix.dirname(file)) : name;
  // React Router: <Route path="/x" element={<Component ... />}
  for (const [f, text] of ws.contents)
    if (/\.[jt]sx$/.test(f)) {
      const m = new RegExp(`path=["'\`]([^"'\`]+)["'\`][^>]*element=\\{<${component}\\b`).exec(text);
      if (m) return `${component} (route ${m[1]})`;
    }
  return /(?:^|\/)app\//.test(file) && name === 'page' ? `${component} (Next.js page)` : component;
}

function testCommand(ws: Workspace, tests: string[]) {
  let scripts: Record<string, string> = {};
  try {
    scripts = JSON.parse(ws.contents.get('package.json') ?? '{}').scripts ?? {};
  } catch {
    /* unreadable manifest: no command */
  }
  if (!scripts.test) return { command: undefined, reason: 'No `test` script in package.json.' };
  return tests.length
    ? { command: `npm test -- ${tests.join(' ')}`, reason: 'Tests that import the affected files.' }
    : { command: 'npm test', reason: 'No test imports an affected file; run the full suite.' };
}

const rank = { high: 0, medium: 1, low: 2 } as const;
const sortRisks = (risks: Risk[]) =>
  risks.sort((a, b) => rank[a.level] - rank[b.level] || (a.basis === b.basis ? 0 : a.basis === 'confirmed' ? -1 : 1));

/** Line of the import that links `impact` to its parent, from the engine's own evidence span. */
function importLine(result: AnalysisResult, impact: FileImpact) {
  const rel = result.relationships.find((r) => r.id === impact.explanationPath.at(-1));
  const ev = result.evidence.find((e) => e.id === rel?.evidenceIds[0]);
  const span = ev?.spans.find((s) => s.fileId === impact.fileId);
  return { parent: rel ? result.files.find((f) => f.id === rel.toFileId)?.path : undefined, line: span?.startLine };
}

function engineRisks(ws: Workspace, result: AnalysisResult, paths: Set<string>): Risk[] {
  const risks: Risk[] = [];
  for (const impact of result.impacts) {
    const file = ws.byId.get(impact.fileId)!;
    if (!paths.has(file.path)) continue;
    if (['auth', 'api', 'schema', 'config'].includes(file.category))
      risks.push({ level: 'medium', basis: 'predicted', text: `${file.path} has ${file.category} responsibility (${file.categoryBasis === 'path-rule' ? 'path heuristic' : 'recognized syntax'}).`, refs: [{ path: file.path }] });
    if (impact.testReferences.status === 'none-found')
      risks.push({ level: 'low', basis: 'predicted', text: `No test imports ${file.path}; behavior changes may go unverified.`, refs: [{ path: file.path }] });
    const fanIn = impact.scoreComponents.find((c) => c.ruleId === 'consumer-fan-in');
    if (fanIn && fanIn.points >= 12 && impact.roles.includes('seed'))
      risks.push({ level: 'medium', basis: 'confirmed', text: `${file.path}: ${fanIn.explanation}`, refs: [{ path: file.path }] });
  }
  return risks;
}

function directTests(ws: Workspace, result: AnalysisResult | undefined, paths: string[]) {
  if (!result) return [];
  const wanted = new Set(paths);
  return [
    ...new Set(
      result.impacts
        .filter((i) => wanted.has(ws.byId.get(i.fileId)!.path))
        .flatMap((i) => i.testReferences.status === 'direct' ? i.testReferences.testFileIds : [])
        .map((id) => ws.byId.get(id)!.path),
    ),
  ].sort();
}

/** Workflow A: before code exists. File-level predictions only; no line-level claims. */
export async function preview(root: string, task: string, opts: Options = {}): Promise<Report> {
  const t0 = Date.now();
  const ws = await loadWorkspace(root, opts.maxFiles);
  const t1 = Date.now();
  const candidates = matchCandidates(ws.project, task);
  const seeds = candidates.filter((c) => c.strong).slice(0, 5);
  const report = emptyReport('preview', task, root, ws);
  report.limitations.push('Preview is a prediction from the description and the dependency graph; exact lines are known only after the change exists.');
  if (!seeds.length) {
    report.impact.unknown.push({
      path: '',
      level: 'unknown',
      why: !ws.project.files.length
        ? `No supported source files were found in ${root}.`
        : candidates.length
        ? `No file matches the description strongly (best: ${ws.byId.get(candidates[0].fileId)!.path}). Name a file, component, or function to narrow it.`
        : 'No file matches the description. Name a file, component, or function.',
    });
    report.timings = { load: t1 - t0, total: Date.now() - t0 };
    return report;
  }
  const result = analyze(ws.project, {
    analysisId: 'preview',
    repositoryId: root,
    requestText: task,
    seedFileIds: seeds.map((s) => s.fileId),
    settings: { maxDepth: 2, includeTypeOnly: false },
  });
  const likely: ImpactEntry[] = [],
    potential: ImpactEntry[] = [];
  for (const s of seeds)
    likely.push({ path: ws.byId.get(s.fileId)!.path, why: `Matches the description — ${s.reasons.join('; ')}`, level: 'predicted' });
  const ordered = [...result.impacts].sort((a, b) => (b.score ?? -1) - (a.score ?? -1));
  for (const impact of ordered) {
    const file = ws.byId.get(impact.fileId)!;
    if (impact.roles.includes('seed') || DOC_OR_TEST.has(file.category)) continue;
    const { parent, line } = importLine(result, impact);
    if (impact.roles.includes('dependent'))
      (impact.depth === 1 ? likely : potential).push({
        path: file.path,
        line,
        why: impact.depth === 1 ? `Imports ${parent}.` : `Depends on ${parent} (depth ${impact.depth}).`,
        level: 'predicted',
      });
    else if (impact.roles.includes('reference'))
      potential.push({ path: file.path, why: `Shares a resource with an affected file (${result.relationships.find((r) => r.id === impact.explanationPath[0])?.kind ?? 'reference'}).`, level: 'predicted' });
  }
  for (const e of [...likely, ...potential]) e.feature = featureOf(ws, e.path);
  report.impact.confirmed = likely.slice(0, CAP); // in preview, "confirmed" renders as "Likely affected"
  report.impact.predicted = potential.slice(0, CAP);
  report.impact.omitted = Math.max(0, likely.length - CAP) + Math.max(0, potential.length - CAP);
  const affected = [...likely, ...potential].map((e) => e.path);
  const t2 = Date.now();
  // Declared names in the matched files (camel/Pascal case) anchor context retrieval.
  const symbols = [...new Set(seeds.flatMap((s) => ws.project.symbols[s.fileId] ?? []))].filter((n) => n.length >= 6 && /[a-z][A-Z]|^[A-Z][a-z]/.test(n));
  const ctx = await gatherContext(ws, { text: task, paths: likely.map((e) => e.path), symbols }, opts.context);
  report.context = ctx.items;
  report.sources = ctx.sources;
  const t3 = Date.now();
  const design = scanDesign(ws, { tokensFile: opts.tokensFile });
  const inScope = new Set(likely.map((e) => e.path));
  report.design = design.findings.filter((f) => f.locations.some((l) => inScope.has(l.path))).slice(0, 5);
  report.designBaseline = design.baseline;
  report.designPreexisting = report.design.length;
  report.risks = sortRisks([
    ...engineRisks(ws, result, inScope),
    ...ctx.items
      .filter((c) => (c.status === 'requirement' || c.status === 'decision') && /mentions|names/.test(c.why))
      .slice(0, 2)
      .map((c): Risk => ({ level: 'medium', basis: 'predicted', text: `Keep ${c.status} in force: ${c.title}`, refs: c.ref ? [c.ref] : [] })),
  ]);
  const tests = directTests(ws, result, affected);
  report.verify = { tests, ...testCommand(ws, tests) };
  report.timings = { load: t1 - t0, impact: t2 - t1, context: t3 - t2, design: Date.now() - t3, total: Date.now() - t0 };
  return report;
}

function emptyReport(mode: Report['mode'], title: string, root: string, ws?: Workspace): Report {
  return {
    mode,
    title,
    root,
    changed: [],
    impact: { confirmed: [], predicted: [], unknown: [], excluded: [], omitted: 0 },
    context: [],
    sources: [],
    design: [],
    designBaseline: { mode: 'intrinsic', tokens: 0 },
    designPreexisting: 0,
    risks: [],
    verify: { tests: [], reason: '' },
    limitations: [
      'Static relationships do not prove runtime behavior or test coverage.',
      ...(ws?.skipped['Beyond the configured file limit'] ? [`${ws.skipped['Beyond the configured file limit']} file(s) beyond the file limit were not analyzed.`] : []),
    ],
    timings: {},
  };
}

const GENERIC = new Set(['const', 'return', 'function', 'import', 'export', 'class', 'classname', 'true', 'false', 'null', 'type', 'string', 'number', 'props', 'onclick', 'await', 'async', 'interface']);

/** Terms a removed line shares with a requirement, ignoring words every line of the file shares (its path, its symbols). */
function protectedTerms(removedLine: string, item: ContextItem, fileTerms: Set<string>) {
  const words = (s: string) => new Set(tokenize(s).filter((t) => t.length >= 5 && !GENERIC.has(t) && !fileTerms.has(t)));
  const a = words(removedLine);
  return [...words(`${item.title} ${item.excerpt}`)].filter((t) => a.has(t));
}

/** Workflow B: actual uncommitted (or staged) changes. Confirmed relationships carry real line numbers. */
export async function review(root: string, opts: Options = {}): Promise<Report> {
  const t0 = Date.now();
  if (!(await isRepo(root))) {
    const report = emptyReport('review', 'Uncommitted changes', root);
    report.impact.unknown.push({ path: '', level: 'unknown', why: 'Not a Git repository: there is no diff to review. Use Preview Planned Change instead.' });
    return report;
  }
  const changes = await changedFiles(root, opts.staged);
  const ws = await loadWorkspace(root, opts.maxFiles);
  const t1 = Date.now();
  const report = emptyReport('review', opts.staged ? 'Staged changes' : 'Uncommitted changes', root, ws);
  if (opts.staged) report.limitations.push('Staged review reads working-tree file contents; partially staged files may differ from what will be committed.');
  const present = changes.filter((c) => c.status !== 'deleted' && ws.contents.has(c.path));
  const summaries = await Promise.all(
    present
      .filter((c) => /\.(?:[cm]?[jt]s|[jt]sx)$/i.test(c.path))
      .map(async (c) => summarizeChange(c, ws.contents.get(c.path)!, c.status === 'added' ? undefined : await showHead(root, c.oldPath ?? c.path))),
  );
  const bySummary = new Map(summaries.map((s) => [s.path, s]));
  report.changed = changes.map((c) => ({ path: c.path, status: c.status, oldPath: c.oldPath, ranges: c.ranges, symbols: bySummary.get(c.path)?.symbols ?? [] }));
  if (!changes.length) {
    report.timings = { total: Date.now() - t0 };
    return report;
  }
  const gone = changes.flatMap((c) => (c.status === 'deleted' ? [c.path] : c.oldPath ? [c.oldPath] : []));
  const trace = traceDependents(ws, summaries, gone);
  const changedSet = new Set(changes.map((c) => c.path));
  const outside = trace.dependents.filter((d) => !changedSet.has(d.path) || d.kind === 'broken');
  for (const d of outside.filter((d) => !d.test))
    (d.kind === 'predicted' ? report.impact.predicted : report.impact.confirmed).push({
      path: d.path,
      line: d.line,
      lines: d.usageLines,
      symbols: d.symbols,
      why: d.reason + (d.via ? ` (via ${d.via})` : ''),
      level: d.kind === 'predicted' ? 'predicted' : 'confirmed',
    });
  report.impact.excluded = trace.unaffected.filter((p) => !changedSet.has(p));

  // Engine pass: transitive dependents, references and test links, never through excluded importers.
  const seedIds = present.map((c) => ws.byPath.get(c.path)?.id).filter((id): id is string => !!id);
  let result: AnalysisResult | undefined;
  if (seedIds.length) {
    result = analyze(ws.project, {
      analysisId: 'review',
      repositoryId: root,
      requestText: opts.task ?? 'Review of uncommitted changes',
      seedFileIds: seedIds,
      maxSeeds: 500,
      settings: { maxDepth: 3, includeTypeOnly: false },
    });
    const excluded = new Set(report.impact.excluded);
    const listed = new Set([...report.impact.confirmed, ...report.impact.predicted].map((e) => e.path));
    for (const impact of result.impacts) {
      const file = ws.byId.get(impact.fileId)!;
      if (listed.has(file.path) || changedSet.has(file.path) || DOC_OR_TEST.has(file.category)) continue;
      // Import chains come from the symbol trace above; the engine adds what imports cannot show.
      if (excluded.has(file.path) || !impact.roles.includes('reference') || impact.roles.includes('dependency')) continue;
      const rel = result.relationships.find((r) => r.id === impact.explanationPath[0]);
      if (rel && !['test-candidate', 'document-reference'].includes(rel.kind))
        report.impact.predicted.push({ path: file.path, why: result.evidence.find((e) => e.id === rel.evidenceIds[0])?.summary ?? rel.kind, level: 'predicted' });
    }
  }
  for (const e of [...report.impact.confirmed, ...report.impact.predicted]) e.feature = featureOf(ws, e.path);
  const total = report.impact.predicted.length;
  report.impact.predicted = report.impact.predicted.slice(0, CAP);
  report.impact.omitted = total - report.impact.predicted.length;

  for (const c of present) {
    const file = ws.byPath.get(c.path);
    if (file?.parseStatus === 'partial')
      report.impact.unknown.push({ path: c.path, level: 'unknown', why: 'Has syntax errors; references may be incomplete.' });
    if (!file && !/\.(?:css|scss|less|html|vue|svelte)$/i.test(c.path))
      report.impact.unknown.push({ path: c.path, level: 'unknown', why: 'File type is not traced by the dependency graph.' });
    else if (file && !/\.(?:[cm]?[jt]s|[jt]sx|md|mdx)$/i.test(c.path) && file.category !== 'docs')
      report.impact.unknown.push({ path: c.path, level: 'unknown', why: `${file.category} file: only literal references are recognized.` });
  }
  for (const u of ws.project.scan.unresolvedReferences.concat(ws.project.scan.unsupportedPatterns))
    if ([...changedSet].some((p) => u.startsWith(`${p}:`)))
      report.impact.unknown.push({ path: u.split(':')[0], level: 'unknown', why: u.slice(u.indexOf(':') + 2) });
  const t2 = Date.now();

  // Context: what the changed code is, plus the optional task.
  const symbols = summaries.flatMap((s) => s.symbols.map((x) => x.name));
  const affectedPaths = [...changedSet, ...report.impact.confirmed.map((e) => e.path)];
  const ctx = await gatherContext(ws, { text: [opts.task ?? '', ...symbols].join(' '), paths: affectedPaths, symbols }, opts.context);
  report.context = ctx.items;
  report.sources = ctx.sources;
  const t3 = Date.now();

  const design = scanDesign(ws, { tokensFile: opts.tokensFile, changed: new Map(present.map((c) => [c.path, c.ranges])) });
  report.design = design.findings.filter((f) => f.introduced);
  report.designPreexisting = design.findings.length - report.design.length;
  report.designBaseline = design.baseline;
  // Context can explain a deviation (a rebrand naming the new value) or reinforce the token (a decision naming it).
  for (const f of report.design) {
    const text = (c: ContextItem) => `${c.title} ${c.excerpt}`.toLowerCase();
    const intent = ctx.items.find((c) => f.actual.some((v) => text(c).includes(v.toLowerCase())) || /\b(rebrand|brand colou?r|new palette|design refresh)\b/.test(text(c)));
    const keeps = ctx.items.find((c) => c.status !== 'superseded' && ((f.token && text(c).includes(f.token.toLowerCase())) || (f.expected && text(c).includes(f.expected.toLowerCase()))));
    if (intent) f.note = `Possibly intentional: ${intent.title}.`;
    else if (keeps) f.note = `Reinforced by ${keeps.title}.`;
  }

  const risks: Risk[] = [];
  for (const d of trace.dependents.filter((d) => d.kind === 'broken'))
    risks.push({ level: 'high', basis: 'confirmed', text: `${d.path}:${d.line} — ${d.reason}`, refs: [{ path: d.path, line: d.line }] });
  // A removed line that names what a requirement protects (e.g. `disabled={submitting}`) is a predicted conflict.
  const conflicts = new Map<string, { file: ChangedFile; text: string; items: ContextItem[]; terms: Set<string> }>();
  const binding = ctx.items.filter((c) => c.status === 'requirement' || c.status === 'decision');
  for (const c of changes.filter((c) => c.removed.length)) {
    // Terms that survive in the added lines were rewritten, not lost; they say nothing about removal.
    const fileTerms = new Set([
      ...tokenize(c.path),
      ...(bySummary.get(c.path)?.symbols ?? []).flatMap((s) => tokenize(s.name)),
      ...tokenize(c.added.map((a) => a.text).join('\n')),
    ]);
    const added = new Set(c.added.map((a) => a.text.trim()));
    for (const r of c.removed) {
      if (added.has(r.text.trim())) continue; // moved, not removed
      for (const item of binding) {
        const shared = protectedTerms(r.text, item, fileTerms);
        if (shared.length < 2 && !(shared.length === 1 && /prevent|guard|duplicate|twice|double|must not|never/i.test(item.title + item.excerpt))) continue;
        const key = `${c.path}:${r.line}`;
        const hit = conflicts.get(key) ?? { file: c, text: r.text.trim(), items: [], terms: new Set<string>() };
        if (!hit.items.includes(item)) hit.items.push(item);
        shared.forEach((t) => hit.terms.add(t));
        conflicts.set(key, hit);
      }
    }
  }
  for (const hit of [...conflicts.values()].sort((a, b) => b.terms.size - a.terms.size).slice(0, 3))
    risks.push({
      level: 'high',
      basis: 'predicted',
      text: `Removed \`${hit.text.slice(0, 80)}\` from ${hit.file.path} may break: ${hit.items.map((i) => i.title).join('; ')}`,
      refs: [{ path: hit.file.path, line: hit.file.ranges[0]?.[0] }, ...hit.items.flatMap((i) => (i.ref ? [i.ref] : []))],
    });
  for (const f of report.design)
    risks.push({ level: 'medium', basis: 'confirmed', text: `Design drift introduced: ${f.message}${f.note ? ` ${f.note}` : ''}`, refs: f.locations.slice(0, 2) });
  if (result) risks.push(...engineRisks(ws, result, new Set(present.map((c) => c.path))));
  report.risks = sortRisks(risks);

  const tests = [
    ...new Set([
      ...trace.dependents.filter((d) => d.test).map((d) => d.path),
      ...changes.filter((c) => ws.byPath.get(c.path)?.category === 'test' && c.status !== 'deleted').map((c) => c.path),
      ...directTests(ws, result, [...changedSet]),
    ]),
  ].sort();
  report.verify = { tests, ...testCommand(ws, tests) };
  report.timings = { load: t1 - t0, impact: t2 - t1, context: t3 - t2, design: Date.now() - t3, total: Date.now() - t0 };
  return report;
}
