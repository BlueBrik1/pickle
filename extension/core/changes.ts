import ts from 'typescript';
import { SOURCE_RE } from '../../server/analysis/index.js';
import { createResolver } from '../../server/analysis/resolver.js';
import type { ChangedFile } from './git.js';
import type { Workspace } from './workspace.js';

export interface ChangedSymbol {
  name: string;
  exported: boolean;
  line: number;
  endLine: number;
}
export interface ChangeSummary {
  path: string;
  /** Exported names (including `default`) whose declaration, or a same-file dependency of it, changed. */
  changed: Set<string>;
  /** Exported in HEAD, no longer exported now. */
  removed: Set<string>;
  /** A top-level side-effect statement changed: every importer may observe it. */
  fileLevel: boolean;
  symbols: ChangedSymbol[];
}
export interface Dependent {
  path: string;
  line: number;
  usageLines: number[];
  symbols: string[];
  /** confirmed: imports a changed/removed export. predicted: cannot narrow (namespace, require, side effect). */
  kind: 'confirmed' | 'predicted' | 'broken';
  reason: string;
  via?: string;
  test: boolean;
}

const script = (p: string) =>
  /\.tsx$/i.test(p)
    ? ts.ScriptKind.TSX
    : /\.jsx$/i.test(p)
      ? ts.ScriptKind.JSX
      : /\.[cm]?js$/i.test(p)
        ? ts.ScriptKind.JS
        : ts.ScriptKind.TS;
const parse = (p: string, text: string) =>
  ts.createSourceFile(p, text, ts.ScriptTarget.Latest, true, script(p));
const lineOf = (sf: ts.SourceFile, pos: number) => sf.getLineAndCharacterOfPosition(pos).line + 1;
const hasModifier = (n: ts.Node, kind: ts.SyntaxKind) =>
  ts.canHaveModifiers(n) && !!ts.getModifiers(n)?.some((m) => m.kind === kind);

interface Decl {
  locals: string[];
  exported: string[];
  start: number;
  end: number;
  node: ts.Node;
  sideEffect: boolean;
}

function topLevel(sf: ts.SourceFile): Decl[] {
  const decls: Decl[] = [];
  const aliases = new Map<string, string[]>();
  for (const st of sf.statements) {
    // Leading comments belong to the declaration they document.
    const comments = ts.getLeadingCommentRanges(sf.text, st.getFullStart());
    const start = lineOf(sf, comments?.[0]?.pos ?? st.getStart(sf)),
      end = lineOf(sf, st.end);
    const isExport = hasModifier(st, ts.SyntaxKind.ExportKeyword),
      isDefault = hasModifier(st, ts.SyntaxKind.DefaultKeyword);
    const decl = (locals: string[], sideEffect = false) =>
      decls.push({
        locals,
        exported: isExport ? (isDefault ? ['default'] : [...locals]) : [],
        start,
        end,
        node: st,
        sideEffect,
      });
    if (
      ts.isFunctionDeclaration(st) ||
      ts.isClassDeclaration(st) ||
      ts.isInterfaceDeclaration(st) ||
      ts.isTypeAliasDeclaration(st) ||
      ts.isEnumDeclaration(st)
    )
      decl(st.name ? [st.name.text] : []);
    else if (ts.isVariableStatement(st)) {
      const names: string[] = [];
      const collect = (n: ts.BindingName) => {
        if (ts.isIdentifier(n)) names.push(n.text);
        else for (const el of n.elements) if (ts.isBindingElement(el)) collect(el.name);
      };
      for (const d of st.declarationList.declarations) collect(d.name);
      decl(names);
    } else if (ts.isExportAssignment(st)) {
      decls.push({ locals: [], exported: ['default'], start, end, node: st, sideEffect: false });
      if (ts.isIdentifier(st.expression)) aliases.set(st.expression.text, ['default']);
    } else if (ts.isExportDeclaration(st)) {
      if (!st.moduleSpecifier && st.exportClause && ts.isNamedExports(st.exportClause))
        for (const el of st.exportClause.elements) {
          const local = (el.propertyName ?? el.name).text;
          aliases.set(local, [...(aliases.get(local) ?? []), el.name.text]);
        }
    } else if (!ts.isImportDeclaration(st) && !ts.isImportEqualsDeclaration(st)) decl([], true);
  }
  for (const d of decls)
    for (const local of d.locals) d.exported.push(...(aliases.get(local) ?? []));
  return decls;
}

function exportedNames(sf: ts.SourceFile): Set<string> {
  const names = new Set(topLevel(sf).flatMap((d) => d.exported));
  for (const st of sf.statements)
    if (ts.isExportDeclaration(st) && st.moduleSpecifier && st.exportClause && ts.isNamedExports(st.exportClause))
      for (const el of st.exportClause.elements) names.add(el.name.text);
  return names;
}

const identifiers = (node: ts.Node) => {
  const out = new Set<string>();
  const visit = (n: ts.Node) => {
    if (ts.isIdentifier(n)) out.add(n.text);
    n.forEachChild(visit);
  };
  visit(node);
  return out;
};

/** Exported names whose declaration is in `start` or mentions (transitively, within the file) a changed name. */
function affectedExports(decls: Decl[], start: Decl[], names: Iterable<string> = []): Set<string> {
  const changedLocals = new Set([...names, ...start.flatMap((d) => d.locals)]);
  const affected = new Set(start);
  for (let grew = true; grew; ) {
    grew = false;
    for (const d of decls)
      if (!affected.has(d) && [...identifiers(d.node)].some((id) => changedLocals.has(id))) {
        affected.add(d);
        d.locals.forEach((l) => changedLocals.add(l));
        grew = true;
      }
  }
  return new Set([...affected].flatMap((d) => d.exported));
}

export function summarizeChange(file: ChangedFile, text: string, oldText?: string): ChangeSummary {
  const sf = parse(file.path, text);
  const decls = topLevel(sf);
  const hit = (d: Decl) =>
    file.status === 'added' || file.ranges.some(([a, b]) => a <= d.end && b >= d.start);
  const touched = decls.filter(hit);
  const before = oldText !== undefined ? exportedNames(parse(file.path, oldText)) : new Set<string>();
  const after = exportedNames(sf);
  return {
    path: file.path,
    changed: affectedExports(decls, touched),
    removed: new Set([...before].filter((n) => !after.has(n))),
    fileLevel: touched.some((d) => d.sideEffect),
    symbols: touched
      .filter((d) => d.locals.length || d.exported.length)
      .map((d) => ({
        name: d.locals[0] ?? d.exported[0],
        exported: d.exported.length > 0,
        line: d.start,
        endLine: d.end,
      })),
  };
}

interface Use {
  kind: 'named' | 'namespace' | 'side-effect' | 'opaque' | 'reexport-all' | 'reexport-named';
  imported: string;
  exportedAs?: string;
  local?: string;
  line: number;
}

function usesOf(sf: ts.SourceFile, targets: (spec: string) => boolean): Use[] {
  const uses: Use[] = [];
  const visit = (n: ts.Node) => {
    if (ts.isImportDeclaration(n) && ts.isStringLiteral(n.moduleSpecifier) && targets(n.moduleSpecifier.text)) {
      const line = lineOf(sf, n.getStart(sf)),
        clause = n.importClause;
      if (!clause) uses.push({ kind: 'side-effect', imported: '*', line });
      if (clause?.name) uses.push({ kind: 'named', imported: 'default', local: clause.name.text, line });
      const b = clause?.namedBindings;
      if (b && ts.isNamespaceImport(b)) uses.push({ kind: 'namespace', imported: '*', local: b.name.text, line });
      else if (b)
        for (const el of b.elements)
          uses.push({
            kind: 'named',
            imported: (el.propertyName ?? el.name).text,
            local: el.name.text,
            line: lineOf(sf, el.getStart(sf)),
          });
    } else if (ts.isExportDeclaration(n) && n.moduleSpecifier && ts.isStringLiteral(n.moduleSpecifier) && targets(n.moduleSpecifier.text)) {
      const line = lineOf(sf, n.getStart(sf));
      if (!n.exportClause) uses.push({ kind: 'reexport-all', imported: '*', line });
      else if (ts.isNamedExports(n.exportClause))
        for (const el of n.exportClause.elements)
          uses.push({ kind: 'reexport-named', imported: (el.propertyName ?? el.name).text, exportedAs: el.name.text, line });
      else uses.push({ kind: 'opaque', imported: '*', line }); // export * as ns
    } else if (
      ts.isCallExpression(n) &&
      (n.expression.kind === ts.SyntaxKind.ImportKeyword ||
        (ts.isIdentifier(n.expression) && n.expression.text === 'require')) &&
      n.arguments[0] &&
      ts.isStringLiteralLike(n.arguments[0]) &&
      targets(n.arguments[0].text)
    )
      uses.push({ kind: 'opaque', imported: '*', line: lineOf(sf, n.getStart(sf)) });
    n.forEachChild(visit);
  };
  visit(sf);
  return uses;
}

/** Lines where `local` is referenced outside import declarations, and `ns.member` accesses. */
function references(sf: ts.SourceFile) {
  const lines = new Map<string, number[]>();
  const members = new Map<string, Map<string, number[]>>();
  const wholeNamespace = new Set<string>();
  const push = <K>(m: Map<K, number[]>, k: K, line: number) => {
    const list = m.get(k) ?? [];
    if (!list.includes(line)) list.push(line);
    m.set(k, list);
  };
  const visit = (n: ts.Node) => {
    if (ts.isImportDeclaration(n) || ts.isExportDeclaration(n)) return;
    if (ts.isPropertyAccessExpression(n) && ts.isIdentifier(n.expression)) {
      const ns = n.expression.text;
      const map = members.get(ns) ?? new Map<string, number[]>();
      members.set(ns, map);
      push(map, n.name.text, lineOf(sf, n.getStart(sf)));
      push(lines, ns, lineOf(sf, n.getStart(sf)));
      return;
    }
    if (ts.isIdentifier(n)) {
      push(lines, n.text, lineOf(sf, n.getStart(sf)));
      wholeNamespace.add(n.text);
    }
    n.forEachChild(visit);
  };
  visit(sf);
  return { lines, members, wholeNamespace };
}

/**
 * Direct (and re-export-forwarded) dependents of the changed files, narrowed to the importers that
 * use a changed or removed export. Importers of only unchanged exports are returned separately.
 */
export function traceDependents(ws: Workspace, summaries: ChangeSummary[], deleted: string[] = []) {
  const warnings: string[] = [],
    unsupported: string[] = [];
  // Stub deleted/renamed-away paths so imports that still name them resolve, then flag them as broken.
  const stubs = deleted.filter((p) => !ws.byPath.has(p));
  const resolver = createResolver(
    { ...ws.project.snapshot, files: [...ws.project.snapshot.files, ...stubs.map((relativePath) => ({ relativePath, content: '' }))] },
    warnings,
    unsupported,
  );
  const importersOf = new Map<string, Set<string>>();
  for (const rel of ws.project.relationships)
    if (['import', 're-export', 'require', 'dynamic-import'].includes(rel.kind)) {
      const to = ws.byId.get(rel.toFileId)!.path,
        from = ws.byId.get(rel.fromFileId)!.path;
      if (!importersOf.has(to)) importersOf.set(to, new Set());
      importersOf.get(to)!.add(from);
    }
  const dependents: Dependent[] = [];
  const unaffected = new Set<string>();
  const parsed = new Map<string, ts.SourceFile>();
  const sourceOf = (p: string) => {
    if (!parsed.has(p)) parsed.set(p, parse(p, ws.contents.get(p) ?? ''));
    return parsed.get(p)!;
  };
  const isTest = (p: string) => ws.byPath.get(p)?.category === 'test';

  if (stubs.length) {
    const gone = new Set(stubs);
    for (const unresolved of ws.project.scan.unresolvedReferences) {
      const m = /^(.+?): unresolved local\/alias (.+)$/.exec(unresolved);
      if (!m) continue;
      const [, from, spec] = m;
      const target = resolver.resolve(spec, from).path;
      if (!target || !gone.has(target)) continue;
      const sf = sourceOf(from);
      for (const use of usesOf(sf, (s) => s === spec))
        dependents.push({
          path: from,
          line: use.line,
          usageLines: [],
          symbols: [use.imported],
          kind: 'broken',
          reason: `Still imports ${spec}, which was deleted or renamed.`,
          test: isTest(from),
        });
    }
  }

  // depth 0: the changed file (and barrels re-exporting it); depth n: files using exports that use the change.
  type Item = { path: string; changed: Set<string>; removed: Set<string>; fileLevel: boolean; depth: number; via?: string };
  const queue: Item[] = summaries.map((s) => ({ path: s.path, changed: s.changed, removed: s.removed, fileLevel: s.fileLevel, depth: 0 }));
  const queued = new Map(queue.map((q) => [q.path, new Set(q.changed)]));
  const enqueue = (item: Item) => {
    const prior = queued.get(item.path) ?? new Set<string>();
    const fresh = [...item.changed].filter((n) => !prior.has(n));
    if (!fresh.length && !item.removed.size && !item.fileLevel) return;
    fresh.forEach((n) => prior.add(n));
    queued.set(item.path, prior);
    queue.push({ ...item, changed: new Set(fresh) });
  };
  for (let i = 0; i < queue.length && i < 1000; i++) {
    const item = queue[i];
    for (const importer of [...(importersOf.get(item.path) ?? [])].sort()) {
      if (!SOURCE_RE.test(importer)) continue;
      const sf = sourceOf(importer);
      const uses = usesOf(sf, (spec) => resolver.resolve(spec, importer).path === item.path);
      const refs = references(sf);
      const confirmed: string[] = [],
        predicted: string[] = [],
        lines: number[] = [],
        locals: string[] = [];
      let line = uses[0]?.line ?? 1;
      const forwardChanged = new Set<string>(),
        forwardRemoved = new Set<string>();
      let forwardAll = false;
      for (const use of uses) {
        if (use.kind === 'named') {
          if (item.removed.has(use.imported) || item.changed.has(use.imported)) {
            confirmed.push(use.imported);
            locals.push(use.local!);
            line = use.line;
            lines.push(...(refs.lines.get(use.local!) ?? []).filter((l) => l !== use.line));
          } else if (item.fileLevel) predicted.push(use.imported);
        } else if (use.kind === 'namespace') {
          const accessed = refs.members.get(use.local!) ?? new Map<string, number[]>();
          for (const [member, at] of accessed)
            if (item.changed.has(member) || item.removed.has(member)) {
              confirmed.push(member);
              locals.push(use.local!);
              lines.push(...at);
            }
          // The namespace object itself is passed around: members cannot be narrowed.
          if (refs.wholeNamespace.has(use.local!) || item.fileLevel) predicted.push('*');
        } else if (use.kind === 'reexport-all') {
          [...item.changed].filter((n) => n !== 'default').forEach((n) => forwardChanged.add(n));
          [...item.removed].filter((n) => n !== 'default').forEach((n) => forwardRemoved.add(n));
          forwardAll ||= item.fileLevel;
        } else if (use.kind === 'reexport-named') {
          if (item.changed.has(use.imported)) forwardChanged.add(use.exportedAs!);
          if (item.removed.has(use.imported)) forwardRemoved.add(use.exportedAs!);
        } else if (use.kind === 'opaque' || (use.kind === 'side-effect' && item.fileLevel)) predicted.push('*');
      }
      const reexported = [...forwardChanged, ...forwardRemoved];
      confirmed.push(...reexported);
      const names = [...new Set(confirmed.length ? confirmed : predicted)];
      const removedHit = confirmed.some((n) => item.removed.has(n));
      if (names.length) {
        const kind: Dependent['kind'] = removedHit ? 'broken' : confirmed.length && item.depth === 0 ? 'confirmed' : 'predicted';
        const dependent: Dependent = {
          path: importer,
          line,
          usageLines: [...new Set(lines)].sort((a, b) => a - b).slice(0, 5),
          symbols: names,
          kind,
          reason: removedHit
            ? `Uses ${confirmed.filter((n) => item.removed.has(n)).join(', ')}, no longer exported by ${item.path}.`
            : !confirmed.length
              ? `Imports ${item.path} in a way that cannot be narrowed to symbols.`
              : item.depth === 0
                ? `${reexported.length && !lines.length ? 'Re-exports' : 'Uses'} changed ${names.join(', ')} from ${item.path}.`
                : `${reexported.length && !lines.length ? 'Re-exports' : 'Uses'} ${names.join(', ')} from ${item.path}, which depends on the change.`,
          via: item.via,
          test: isTest(importer),
        };
        // One entry per file: the most severe, closest relationship wins.
        const order = { broken: 0, confirmed: 1, predicted: 2 };
        const prior = dependents.findIndex((d) => d.path === importer);
        if (prior < 0) dependents.push(dependent);
        else if (order[kind] < order[dependents[prior].kind]) dependents[prior] = dependent;
        unaffected.delete(importer);
      } else if (!dependents.some((d) => d.path === importer)) unaffected.add(importer);
      if (reexported.length || forwardAll)
        enqueue({ path: importer, changed: forwardChanged, removed: forwardRemoved, fileLevel: forwardAll, depth: item.depth, via: item.path });
      // Follow behavior, not just names: this file's exports that use the changed symbols changed too.
      if (locals.length && !removedHit && item.depth < 2 && !isTest(importer)) {
        const exportsUsing = affectedExports(topLevel(sf), [], locals);
        if (exportsUsing.size)
          enqueue({ path: importer, changed: exportsUsing, removed: new Set(), fileLevel: false, depth: item.depth + 1, via: item.path });
      }
    }
  }
  return { dependents, unaffected: [...unaffected].sort() };
}
