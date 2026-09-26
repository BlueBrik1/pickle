import ts from 'typescript';
import path from 'node:path';
import { createHash } from 'node:crypto';
import {
  resultSchema,
  type Snapshot,
  type IndexedProject,
  type Evidence,
  type FileRecord,
  type Relationship,
  type SourceSpan,
  type Candidate,
  type Settings,
  type AnalysisResult,
  type FileImpact,
  type Finding,
  type PlanTask,
  type ScoreComponent,
} from '../../src/shared/schema.js';
import { createResolver } from './resolver.js';
import { parseRootIgnore } from '../../src/shared/ingestion.js';

export const SOURCE_RE = /\.(?:[cm]?[jt]s|[jt]sx)$/i;
const TEST_RE = /(?:^|\/)(?:__tests__|tests?|specs?)(?:\/|$)|\.(?:test|spec)\.[cm]?[jt]sx?$/i;
const STRUCTURAL = new Set(['import', 're-export', 'require', 'dynamic-import']);
const LIMITATIONS = [
  'Static relationships do not establish runtime reachability, correctness, deployment safety, or test coverage.',
  'Only accepted files in this snapshot are inspected; packages and live services are never followed.',
  'Route matching omits middleware ordering, authentication, proxies and runtime base URLs.',
  'SQL recognition is a bounded text scanner, not a SQL parser; observed migrations may not be deployed.',
  'Test imports identify references, not assertions or executed coverage; indirect endpoint tests may remain unknown.',
];
const hash = (s: string) => createHash('sha256').update(s).digest('hex').slice(0, 20);
const stable = (prefix: string, ...parts: unknown[]) => `${prefix}_${hash(JSON.stringify(parts))}`;
const unique = <T>(values: T[]) => [...new Set(values)];
const compare = (a: string, b: string) => (a < b ? -1 : a > b ? 1 : 0);
const stop = new Set(
  'a an the to of for in on and or with from this that add change new related page all as is be it into by should can need implement'.split(
    ' ',
  ),
);
export function tokenize(text: string): string[] {
  return unique(
    text
      .replace(/([a-z\d])([A-Z])/g, '$1 $2')
      .toLowerCase()
      .split(/[^a-z0-9]+/)
      .map(
        (w) =>
          ({
            deleting: 'delete',
            deleted: 'delete',
            removing: 'remove',
            removed: 'remove',
            settings: 'setting',
            accounts: 'account',
            users: 'user',
            profiles: 'profile',
            files: 'file',
            tokens: 'token',
            uploads: 'upload',
            buckets: 'bucket',
            records: 'record',
          })[w] ?? w,
      )
      .filter((w) => w.length > 1 && !stop.has(w)),
  );
}
const intents = [
  ['delete', 'remove', 'deletion'],
  ['account', 'user', 'profile'],
  ['upload', 'storage', 'bucket'],
  ['oauth', 'token', 'credential'],
];
export const STRONG_MATCH_THRESHOLD = 30;
export function priorityForScore(score: number): 'high' | 'medium' | 'low' {
  return score >= 70 ? 'high' : score >= 40 ? 'medium' : 'low';
}
function category(p: string): Pick<FileRecord, 'category' | 'categoryBasis'> {
  if (TEST_RE.test(p)) return { category: 'test', categoryBasis: 'path-rule' };
  if (/\.mdx?$/i.test(p)) return { category: 'docs', categoryBasis: 'path-rule' };
  if (/\.sql$/i.test(p)) return { category: 'schema', categoryBasis: 'path-rule' };
  if (/(?:^|\/)(?:[^/]*config[^/]*|\.env[^/]*|package\.json)$/i.test(p))
    return { category: 'config', categoryBasis: 'path-rule' };
  if (/(?:auth|oauth|token)/i.test(p)) return { category: 'auth', categoryBasis: 'path-rule' };
  if (/(?:^|\/)(?:routes?|api|controllers?)(?:\/|\.)/i.test(p))
    return { category: 'api', categoryBasis: 'path-rule' };
  if (/(?:^|\/)(?:db|data|models?|migrations?|storage)(?:\/|\.)/i.test(p))
    return { category: 'data', categoryBasis: 'path-rule' };
  if (/\.[jt]sx$/i.test(p) || /(?:^|\/)(?:components?|pages?|ui)(?:\/|\.)/i.test(p))
    return { category: 'ui', categoryBasis: 'path-rule' };
  return { category: 'other', categoryBasis: 'default' };
}
interface Fact {
  file: FileRecord;
  value: string;
  evidence: Evidence;
  method?: string;
  receiver?: string;
  template?: boolean;
  target?: string;
}
function normalizeRoute(s: string) {
  return ('/' + s.split('?')[0]).replace(/\/+/g, '/').replace(/\/$/, '') || '/';
}
function literal(n: ts.Node | undefined): string | undefined {
  return n && (ts.isStringLiteral(n) || ts.isNoSubstitutionTemplateLiteral(n)) ? n.text : undefined;
}
function routeLiteral(n: ts.Node | undefined): { value: string; template: boolean } | undefined {
  const exact = literal(n);
  if (exact !== undefined && exact.startsWith('/'))
    return { value: normalizeRoute(exact), template: false };
  if (n && ts.isTemplateExpression(n) && n.head.text.startsWith('/'))
    return {
      value: normalizeRoute(
        n.head.text + n.templateSpans.map((s) => `:dynamic${s.literal.text}`).join(''),
      ),
      template: true,
    };
  return undefined;
}
function propertyName(n: ts.Node | undefined) {
  return n && (ts.isIdentifier(n) || ts.isStringLiteral(n)) ? n.text : undefined;
}

export function indexProject(
  snapshot: Snapshot,
  onStage?: (stage: string) => void,
): IndexedProject {
  onStage?.('Parsing source files');
  const ordered = [...snapshot.files].sort((a, b) => compare(a.relativePath, b.relativePath));
  const files: FileRecord[] = ordered.map((f) => ({
    id: stable('file', f.relativePath),
    path: f.relativePath,
    ...category(f.relativePath),
    sizeBytes: Buffer.byteLength(f.content),
    lineCount: f.content.split('\n').length,
    parseStatus: SOURCE_RE.test(f.relativePath) ? 'parsed' : 'text-only',
  }));
  const byPath = new Map(files.map((f) => [f.path, f]));
  const contents = new Map(ordered.map((f) => [f.relativePath, f.content]));
  const evidence: Evidence[] = [],
    relationships: Relationship[] = [],
    warnings: string[] = [],
    unsupported: string[] = [],
    unresolved: string[] = [];
  const symbols: Record<string, string[]> = {},
    terms: Record<string, string[]> = {};
  const resolver = createResolver(snapshot, warnings, unsupported);
  warnings.push(...parseRootIgnore(contents.get('.gitignore') ?? '').unsupported);
  const routes: Fact[] = [],
    clients: Fact[] = [],
    tables: Fact[] = [],
    tableUses: Fact[] = [],
    schemaUses: Fact[] = [],
    envUses: Fact[] = [],
    envDefs: Fact[] = [],
    mounts: Fact[] = [];
  const bindings = new Map<string, Map<string, string>>();
  function span(file: FileRecord, start: number, end: number): SourceSpan {
    const text = contents.get(file.path)!;
    const a = text.slice(0, start).split('\n'),
      b = text.slice(0, end).split('\n');
    return {
      fileId: file.id,
      startLine: a.length,
      startColumn: a.at(-1)!.length + 1,
      endLine: b.length,
      endColumn: b.at(-1)!.length + 1,
    };
  }
  function fact(
    file: FileRecord,
    ruleId: string,
    value: string,
    start: number,
    end: number,
    summary: string,
    level: Evidence['level'] = 'supported-reference',
    limitations: string[] = [],
  ): Fact {
    const e: Evidence = {
      id: stable('ev', ruleId, file.path, start, end, value),
      ruleId,
      level,
      spans: [span(file, start, end)],
      summary,
      matchedValue: value,
      limitations,
    };
    evidence.push(e);
    return { file, value, evidence: e };
  }
  function link(
    from: Fact,
    to: Fact,
    kind: Relationship['kind'],
    level: Evidence['level'],
    summary: string,
    limitations: string[] = [],
  ) {
    const e: Evidence = {
      id: stable('ev', kind, from.evidence.id, to.evidence.id),
      ruleId: kind,
      level,
      spans: [...from.evidence.spans, ...to.evidence.spans],
      summary,
      matchedValue: from.value,
      limitations,
    };
    evidence.push(e);
    relationships.push({
      id: stable('rel', kind, from.file.id, to.file.id, e.id),
      fromFileId: from.file.id,
      toFileId: to.file.id,
      kind,
      typeOnly: false,
      level,
      evidenceIds: [e.id],
    });
  }
  for (const file of files) {
    const text = contents.get(file.path)!;
    symbols[file.id] = [];
    terms[file.id] = tokenize(text.slice(0, 65536));
    fact(
      file,
      'classification',
      file.category,
      0,
      Math.min(text.length, 1),
      `${file.category} category from ${file.categoryBasis === 'path-rule' ? 'a path heuristic' : file.categoryBasis === 'recognized-pattern' ? 'recognized file syntax' : 'the default rule'}.`,
      'inferred-reference',
      ['Category is an inspection aid, not a semantic guarantee.'],
    );
    if (SOURCE_RE.test(file.path)) {
      const scriptKind = /\.tsx$/i.test(file.path)
        ? ts.ScriptKind.TSX
        : /\.jsx$/i.test(file.path)
          ? ts.ScriptKind.JSX
          : /\.[cm]?js$/i.test(file.path)
            ? ts.ScriptKind.JS
            : ts.ScriptKind.TS;
      const source = ts.createSourceFile(file.path, text, ts.ScriptTarget.Latest, true, scriptKind);
      const diagnostics =
        (source as ts.SourceFile & { parseDiagnostics?: ts.Diagnostic[] }).parseDiagnostics ?? [];
      if (diagnostics.length) {
        file.parseStatus = 'partial';
        warnings.push(
          `${file.path}: ${diagnostics.length} syntax diagnostic(s); references may be incomplete.`,
        );
      }
      const imports = new Map<string, string>();
      bindings.set(file.id, imports);
      function nodeFact(
        n: ts.Node,
        rule: string,
        value: string,
        summary: string,
        level: Evidence['level'] = 'supported-reference',
        limits: string[] = [],
      ) {
        return fact(file, rule, value, n.getStart(source), n.end, summary, level, limits);
      }
      function structural(n: ts.Node, spec: string, kind: Relationship['kind'], typeOnly: boolean) {
        const resolution = resolver.resolve(spec, file.path);
        const f = nodeFact(
          n,
          `syntax-${kind}`,
          spec,
          `${typeOnly ? 'Type-only ' : ''}${kind} ${JSON.stringify(spec)}: ${resolution.status}.`,
          resolution.status === 'resolved' ? 'structural' : 'unknown',
          resolution.status === 'external' ? ['External package not followed.'] : [],
        );
        if (resolution.path) {
          const target = byPath.get(resolution.path)!;
          relationships.push({
            id: stable('rel', f.evidence.id, target.id),
            fromFileId: file.id,
            toFileId: target.id,
            kind,
            typeOnly,
            level: 'structural',
            evidenceIds: [f.evidence.id],
          });
        } else if (resolution.status === 'unresolved')
          unresolved.push(`${file.path}: unresolved local/alias ${spec}`);
        return resolution.path;
      }
      function visit(n: ts.Node) {
        if (
          (ts.isFunctionDeclaration(n) ||
            ts.isClassDeclaration(n) ||
            ts.isInterfaceDeclaration(n) ||
            ts.isTypeAliasDeclaration(n) ||
            ts.isEnumDeclaration(n) ||
            ts.isVariableDeclaration(n)) &&
          n.name
        ) {
          const names: ts.Identifier[] = [];
          const collect = (name: ts.DeclarationName) => {
            if (ts.isIdentifier(name)) names.push(name);
            else if (ts.isObjectBindingPattern(name) || ts.isArrayBindingPattern(name))
              for (const entry of name.elements)
                if (ts.isBindingElement(entry)) collect(entry.name);
          };
          collect(n.name);
          for (const name of names) {
            symbols[file.id].push(name.text);
            nodeFact(name, 'declaration', name.text, `Declared name ${name.text}.`, 'structural');
          }
        }
        if (ts.isImportDeclaration(n) && ts.isStringLiteral(n.moduleSpecifier)) {
          const clause = n.importClause,
            bindingsNode = clause?.namedBindings;
          const typeOnly =
            !!clause?.isTypeOnly ||
            !!(
              bindingsNode &&
              ts.isNamedImports(bindingsNode) &&
              bindingsNode.elements.length &&
              bindingsNode.elements.every((e) => e.isTypeOnly) &&
              !clause?.name
            );
          const target = structural(n.moduleSpecifier, n.moduleSpecifier.text, 'import', typeOnly);
          if (target) {
            if (clause?.name) imports.set(clause.name.text, target);
            if (bindingsNode) {
              if (ts.isNamespaceImport(bindingsNode)) imports.set(bindingsNode.name.text, target);
              else for (const el of bindingsNode.elements) imports.set(el.name.text, target);
            }
          }
        } else if (
          ts.isExportDeclaration(n) &&
          n.moduleSpecifier &&
          ts.isStringLiteral(n.moduleSpecifier)
        ) {
          const only =
            n.isTypeOnly ||
            !!(
              n.exportClause &&
              ts.isNamedExports(n.exportClause) &&
              n.exportClause.elements.length &&
              n.exportClause.elements.every((e) => e.isTypeOnly)
            );
          structural(n.moduleSpecifier, n.moduleSpecifier.text, 're-export', only);
        }
        if (ts.isPropertyAccessExpression(n) || ts.isElementAccessExpression(n)) {
          const owner = n.expression.getText(source);
          if (owner === 'process.env' || owner === 'import.meta.env') {
            const key = ts.isPropertyAccessExpression(n)
              ? n.name.text
              : literal(n.argumentExpression);
            if (key)
              envUses.push(
                nodeFact(
                  n,
                  'env-use',
                  key,
                  `Environment key ${key} is read.`,
                  'supported-reference',
                  ['Only key presence is observed; live values are never loaded.'],
                ),
              );
            else unsupported.push(`${file.path}: computed environment key is unsupported.`);
          }
        }
        if (ts.isCallExpression(n)) {
          const expr = n.expression,
            callName = expr.getText(source),
            arg = n.arguments[0];
          if (expr.kind === ts.SyntaxKind.ImportKeyword || callName === 'require') {
            const spec = literal(arg);
            if (spec !== undefined)
              structural(arg, spec, callName === 'require' ? 'require' : 'dynamic-import', false);
            else {
              unsupported.push(`${file.path}: nonliteral ${callName} target is unsupported.`);
              nodeFact(
                n,
                'dynamic-unsupported',
                callName,
                'Nonliteral module target is unknown.',
                'unknown',
              );
            }
          }
          if (callName === 'fetch') {
            let method: string | undefined = 'GET';
            const options = n.arguments[1];
            if (options) {
              method = undefined;
              if (ts.isObjectLiteralExpression(options)) {
                const hasSpread = options.properties.some((p) => ts.isSpreadAssignment(p));
                const property = options.properties.find(
                  (p) => ts.isPropertyAssignment(p) && propertyName(p.name) === 'method',
                );
                if (!hasSpread)
                  method =
                    property && ts.isPropertyAssignment(property)
                      ? literal(property.initializer)?.toUpperCase()
                      : 'GET';
              }
            }
            const route = routeLiteral(arg);
            if (route && method)
              clients.push({
                ...nodeFact(
                  n,
                  'http-client',
                  `${method} ${route.value}`,
                  `fetch uses ${method} ${route.value}.`,
                ),
                ...route,
                method,
              });
            else if (route)
              unsupported.push(
                `${file.path}: fetch method cannot be established from dynamic options.`,
              );
          }
          if (ts.isPropertyAccessExpression(expr)) {
            const method = expr.name.text.toLowerCase(),
              receiver = expr.expression.getText(source),
              route = routeLiteral(arg);
            if (/^(?:get|post|put|patch|delete|head|options)$/.test(method) && route) {
              if (receiver === 'axios')
                clients.push({
                  ...nodeFact(
                    n,
                    'http-client',
                    `${method.toUpperCase()} ${route.value}`,
                    `Axios literal ${method.toUpperCase()} ${route.value}.`,
                  ),
                  ...route,
                  method: method.toUpperCase(),
                });
              else if (/^(?:app|router|\w+Router)$/.test(receiver))
                routes.push({
                  ...nodeFact(
                    n,
                    'http-handler',
                    `${method.toUpperCase()} ${route.value}`,
                    `Literal route handler ${method.toUpperCase()} ${route.value}.`,
                  ),
                  ...route,
                  method: method.toUpperCase(),
                  receiver,
                });
            }
            if (
              method === 'use' &&
              route &&
              n.arguments[1] &&
              ts.isIdentifier(n.arguments[1]) &&
              /^(?:app|router|\w+Router)$/.test(receiver)
            )
              mounts.push({
                ...nodeFact(
                  n,
                  'http-mount',
                  route.value,
                  `Literal router mount at ${route.value}.`,
                ),
                receiver,
                target: n.arguments[1].text,
              });
            if (method === 'from' && /^(?:supabase|db|database|client)(?:\.|$)/i.test(receiver)) {
              const table = literal(arg);
              if (table)
                tableUses.push(
                  nodeFact(
                    n,
                    'table-use',
                    table,
                    `Literal table reference ${table}.`,
                    'supported-reference',
                    [
                      'Receiver-name rule (supabase/db/database/client); runtime database identity is unverified.',
                    ],
                  ),
                );
            }
          }
        }
        ts.forEachChild(n, visit);
      }
      visit(source);
      symbols[file.id] = unique(symbols[file.id]);
      if (file.category !== 'test' && routes.some((r) => r.file.id === file.id)) {
        file.category = 'api';
        file.categoryBasis = 'recognized-pattern';
      }
    }
    if (
      /(?:^|\/)\.env(?:\.[^/]+)?\.(?:example|sample|template)$/i.test(file.path) ||
      /(?:^|\/)\.env\.(?:example|sample|template)$/i.test(file.path)
    ) {
      for (const match of text.matchAll(/^\s*(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=/gm))
        envDefs.push(
          fact(
            file,
            'env-definition',
            match[1],
            match.index!,
            match.index! + match[0].length,
            `Example key ${match[1]} is present; no value is retained.`,
          ),
        );
    }
    if (/\.sql$/i.test(file.path)) scanSql(file, text, fact, tables, schemaUses, unsupported);
  }
  onStage?.('Resolving references');
  // Compose only imported literal router mounts, with a hard bound and cycle guard.
  function mounted(route: Fact, visited: string[] = [], depth = 0): Fact[] {
    if (depth >= 4) {
      unsupported.push('Router mount composition is capped at 4 levels.');
      return [route];
    }
    if (visited.includes(route.file.id)) {
      unsupported.push('Router mount cycle detected.');
      return [];
    }
    const matches = mounts.filter(
      (m) => bindings.get(m.file.id)?.get(m.target!) === route.file.path,
    );
    if (!matches.length) return [route];
    return matches.flatMap((m) => {
      const value = normalizeRoute(m.value + '/' + route.value);
      const e: Evidence = {
        ...route.evidence,
        id: stable('ev', 'mounted', m.evidence.id, route.evidence.id),
        ruleId: 'http-mounted-handler',
        matchedValue: `${route.method} ${value}`,
        spans: [...route.evidence.spans, ...m.evidence.spans],
        summary: `Route composed from a literal mount: ${route.method} ${value}.`,
        limitations: [
          'Imported router identity is matched by file; multiple exported routers are not distinguished.',
        ],
      };
      evidence.push(e);
      const expanded = { ...route, value, evidence: e };
      // Recurse using the mounting file as traversal location; keep the original handler as endpoint.
      return mounted({ ...expanded, file: m.file }, [...visited, route.file.id], depth + 1).map(
        (r) => ({ ...r, file: route.file }),
      );
    });
  }
  const composed = routes.flatMap((r) => mounted(r));
  for (const client of clients) {
    const compatible = composed.filter(
      (r) => r.method === client.method && routeCompatible(r.value, client.value),
    );
    for (const handler of compatible) {
      const exact =
        compatible.length === 1 &&
        handler.value === client.value &&
        !handler.template &&
        !client.template &&
        !handler.value.includes(':');
      link(
        client,
        handler,
        'api-reference',
        exact ? 'supported-reference' : 'inferred-reference',
        `${client.method} ${client.value} matches ${compatible.length > 1 ? 'an ambiguous ' : exact ? 'a literal ' : 'a parameter-compatible '}handler.`,
        [
          ...(!exact
            ? ['Parameterized, template, or ambiguous route match requires confirmation.']
            : []),
          'No runtime route reachability is established.',
        ],
      );
    }
  }
  for (const use of tableUses.concat(schemaUses)) {
    const candidates = tables.filter((t) => tableMatch(t.value, use.value));
    if (candidates.length === 1)
      link(
        use,
        candidates[0],
        schemaUses.includes(use) ? 'schema-reference' : 'table-reference',
        'supported-reference',
        `${use.value} has one matching table definition.`,
        ['Observed schema text does not prove deployed schema or database identity.'],
      );
    else
      unresolved.push(
        `${use.file.path}: table ${use.value} ${candidates.length ? 'has ambiguous definitions' : 'has no scanned definition'}`,
      );
  }
  for (const use of envUses) {
    const defs = envDefs.filter((d) => d.value === use.value);
    if (defs.length)
      for (const def of defs)
        link(
          use,
          def,
          'env-reference',
          'supported-reference',
          `Environment key ${use.value} appears in code and an example.`,
          ['Presence only; no live value or deployment configuration is known.'],
        );
    else
      unresolved.push(`${use.file.path}: environment key ${use.value} has no example definition`);
  }
  for (const file of files.filter((f) => f.category === 'docs')) {
    const text = contents.get(file.path)!;
    for (const match of text.matchAll(/`([^`\n]+)`|\[[^\]\n]*\]\(([^)\s]+)\)/g)) {
      const value = match[1] ?? match[2];
      const clean = value.replace(/^\.\//, '').split('#')[0];
      const candidates = unique(
        [
          byPath.get(clean),
          byPath.get(path.posix.normalize(path.posix.join(path.posix.dirname(file.path), clean))),
        ].filter((f): f is FileRecord => !!f),
      );
      const f = fact(
        file,
        'document-literal',
        value,
        match.index!,
        match.index! + match[0].length,
        `Explicit Markdown reference ${value}.`,
        'inferred-reference',
      );
      if (candidates.length === 1) {
        const target = candidates[0];
        link(
          f,
          fact(
            target,
            'document-target',
            target.path,
            0,
            Math.min(contents.get(target.path)!.length, 1),
            `Accepted file ${target.path}.`,
            'structural',
          ),
          'document-reference',
          'inferred-reference',
          'Document explicitly refers to an accepted file.',
          ['Documents are inert text and not runtime dependencies.'],
        );
      }
      for (const target of [...tables, ...composed].filter(
        (t) => t.value === value || `${t.method} ${t.value}` === value,
      ))
        link(
          f,
          target,
          'document-reference',
          'inferred-reference',
          `Document names observed resource ${value}.`,
          ['An explicit document reference is a review candidate.'],
        );
    }
  }
  for (const test of files.filter((f) => f.category === 'test')) {
    const basename = path.posix
      .basename(test.path)
      .replace(/\.(test|spec)(?=\.)/, '')
      .replace(/\.[^.]+$/, '')
      .toLowerCase();
    for (const target of files.filter(
      (f) =>
        SOURCE_RE.test(f.path) &&
        f.category !== 'test' &&
        path.posix
          .basename(f.path)
          .replace(/\.[^.]+$/, '')
          .toLowerCase() === basename,
    )) {
      if (
        relationships.some(
          (r) => r.fromFileId === test.id && r.toFileId === target.id && STRUCTURAL.has(r.kind),
        )
      )
        continue;
      link(
        fact(
          test,
          'test-name',
          basename,
          0,
          Math.min(contents.get(test.path)!.length, 1),
          'Test basename matches an implementation basename.',
          'inferred-reference',
        ),
        fact(
          target,
          'test-target',
          basename,
          0,
          Math.min(contents.get(target.path)!.length, 1),
          'Implementation basename matches a test basename.',
          'inferred-reference',
        ),
        'test-candidate',
        'inferred-reference',
        'Matching basename suggests a possible test reference.',
        ['No direct import or relevant assertion was observed.'],
      );
    }
  }
  const parseGaps = files.some((f) => f.parseStatus === 'partial' || f.parseStatus === 'failed');
  const skipped = Object.values(snapshot.skippedReasons).reduce((a, b) => a + b, 0);
  const testScan =
    parseGaps ||
    unresolved.some((s) => /unresolved local\/alias/.test(s)) ||
    unsupported.some((s) => /nonliteral .*target/.test(s)) ||
    Object.entries(snapshot.skippedReasons).some(
      ([reason, count]) =>
        count > 0 && !/secret|generated|excluded|unsupported extension/i.test(reason),
    )
      ? 'partial'
      : 'complete';
  const dedupEvidence = [...new Map(evidence.map((e) => [e.id, e])).values()].sort((a, b) =>
    compare(a.id, b.id),
  );
  return {
    snapshot,
    fingerprint: createHash('sha256')
      .update(JSON.stringify(ordered.map((f) => [f.relativePath, f.content])))
      .digest('hex'),
    files,
    relationships: [...new Map(relationships.map((r) => [r.id, r])).values()].sort((a, b) =>
      compare(a.id, b.id),
    ),
    evidence: dedupEvidence,
    symbols,
    terms,
    scan: {
      acceptedFiles: files.length,
      acceptedBytes: snapshot.totalBytes,
      sourceFiles: files.filter((f) => SOURCE_RE.test(f.path)).length,
      parsedFiles: files.filter((f) => f.parseStatus === 'parsed').length,
      testFiles: files.filter((f) => f.category === 'test').length,
      routes: routes.length,
      tables: tables.length,
      skippedFiles: skipped,
      skippedReasons: snapshot.skippedReasons,
      warnings: unique(warnings).sort(compare),
      unresolvedReferences: unique(unresolved).sort(compare),
      unsupportedPatterns: unique(unsupported).sort(compare),
      selectedConfiguration: resolver.configuration,
      supportedRules: [
        'AST imports/re-exports/literal require/import',
        'Literal Express app/router methods; imported mounts (4 levels)',
        'fetch and axios.method literal relative URLs',
        'supabase/db/database/client.from literal table names',
        'SQL CREATE TABLE / REFERENCES / CREATE POLICY ON',
        'process.env / import.meta.env literal keys',
        'Markdown inline paths, links, exact resource names',
        'Direct test imports and basename candidates',
      ],
      testScan,
    },
  };
}

function routeCompatible(a: string, b: string) {
  const x = a.split('/'),
    y = b.split('/');
  return (
    x.length === y.length &&
    x.every((s, i) => s === y[i] || s.startsWith(':') || y[i].startsWith(':'))
  );
}
function tableMatch(a: string, b: string) {
  return (
    a === b ||
    ((!a.includes('.') || !b.includes('.')) && a.split('.').at(-1) === b.split('.').at(-1))
  );
}
type MakeFact = (
  file: FileRecord,
  rule: string,
  value: string,
  start: number,
  end: number,
  summary: string,
  level?: Evidence['level'],
  limits?: string[],
) => Fact;
function scanSql(
  file: FileRecord,
  text: string,
  fact: MakeFact,
  tables: Fact[],
  uses: Fact[],
  unsupported: string[],
) {
  // Preserve length/newlines while hiding comments and string literals; retain double-quoted identifiers.
  let masked = '',
    i = 0;
  while (i < text.length) {
    const dollar = text.slice(i).match(/^\$[a-zA-Z_0-9]*\$/)?.[0];
    if (dollar) {
      const end = text.indexOf(dollar, i + dollar.length);
      const stopAt = end < 0 ? text.length : end + dollar.length;
      masked += text.slice(i, stopAt).replace(/[^\r\n]/g, ' ');
      i = stopAt;
      unsupported.push(`${file.path}: dollar-quoted SQL bodies are opaque and not scanned.`);
    } else if (text[i] === '"') {
      let end = i + 1;
      while (end < text.length) {
        if (text[end] === '"') {
          if (text[end + 1] === '"') {
            end += 2;
            continue;
          }
          end++;
          break;
        }
        end++;
      }
      masked += text.slice(i, end);
      i = end;
    } else if (text.startsWith('--', i)) {
      const end = text.indexOf('\n', i);
      const stopAt = end < 0 ? text.length : end;
      masked += text.slice(i, stopAt).replace(/[^\r\n]/g, ' ');
      i = stopAt;
    } else if (text.startsWith('/*', i)) {
      const end = text.indexOf('*/', i + 2);
      const stopAt = end < 0 ? text.length : end + 2;
      masked += text.slice(i, stopAt).replace(/[^\r\n]/g, ' ');
      i = stopAt;
    } else if (text[i] === "'") {
      let end = i + 1;
      while (end < text.length) {
        if (text[end] === "'") {
          if (text[end + 1] === "'") {
            end += 2;
            continue;
          }
          end++;
          break;
        }
        end++;
      }
      masked += text.slice(i, end).replace(/[^\r\n]/g, ' ');
      i = end;
    } else {
      masked += text[i];
      i++;
    }
  }
  const ident = '(?:"(?:[^"]|"")+"|[A-Za-z_][A-Za-z0-9_$]*)';
  const qualified = `${ident}(?:\\s*\\.\\s*${ident})?`;
  const name = (v: string) =>
    v
      .split(/\s*\.\s*/)
      .map((s) => (s.startsWith('"') ? s.slice(1, -1).replace(/""/g, '"') : s.toLowerCase()))
      .join('.');
  for (const m of masked.matchAll(
    new RegExp(`\\bCREATE\\s+TABLE\\s+(?:IF\\s+NOT\\s+EXISTS\\s+)?(${qualified})\\s*\\(`, 'gi'),
  ))
    tables.push(
      fact(
        file,
        'sql-table',
        name(m[1]),
        m.index!,
        m.index! + m[0].length,
        `Recognized CREATE TABLE ${name(m[1])}.`,
      ),
    );
  for (const m of masked.matchAll(
    new RegExp(
      `\\bREFERENCES\\s+(${qualified})(?:\\s*\\([^)]*\\))?(?:\\s+ON\\s+DELETE\\s+(CASCADE|RESTRICT|SET\\s+NULL|NO\\s+ACTION))?`,
      'gi',
    ),
  ))
    uses.push(
      fact(
        file,
        'sql-foreign-key',
        name(m[1]),
        m.index!,
        m.index! + m[0].length,
        `Foreign-key text REFERENCES ${name(m[1])}${m[2] ? ` ON DELETE ${m[2].toUpperCase()}` : ''}.`,
        'supported-reference',
        ['Recognized declaration text only; constraint behavior is not verified.'],
      ),
    );
  for (const m of masked.matchAll(
    new RegExp(`\\bCREATE\\s+POLICY\\s+${ident}\\s+ON\\s+(${qualified})`, 'gi'),
  ))
    uses.push(
      fact(
        file,
        'sql-policy',
        name(m[1]),
        m.index!,
        m.index! + m[0].length,
        `Policy declaration names ${name(m[1])}.`,
      ),
    );
  if (
    /\$[a-z_]*\$|\b(?:DO|FUNCTION|TRIGGER|ALTER|DROP)\b|\bCREATE\s+(?:TEMP|UNLOGGED|VIEW)/i.test(
      masked,
    )
  )
    unsupported.push(
      `${file.path}: procedural SQL, ALTER/DROP, views, and nonstandard CREATE forms are outside the bounded SQL scanner.`,
    );
}

export function matchCandidates(project: IndexedProject, requestText: string): Candidate[] {
  const direct = tokenize(requestText),
    expanded = unique(
      intents.filter((group) => group.some((x) => direct.includes(x))).flat(),
    ).filter((x) => !direct.includes(x));
  const raw = requestText.toLowerCase();
  const exactWords = new Set(raw.match(/[a-z_$][a-z0-9_$]*/g) ?? []);
  const pathsById = new Map(project.files.map((f) => [f.id, f.path]));
  const resourceRules = new Set([
    'http-handler',
    'http-client',
    'table-use',
    'sql-table',
    'env-use',
    'env-definition',
  ]);
  const resourcesByFile = new Map<string, Set<string>>();
  for (const ev of project.evidence) {
    const fileId = ev.spans[0]?.fileId;
    if (fileId && ev.matchedValue && resourceRules.has(ev.ruleId)) {
      const values = resourcesByFile.get(fileId) ?? new Set<string>();
      values.add(ev.matchedValue);
      resourcesByFile.set(fileId, values);
    }
  }
  return project.files
    .map((file) => {
      let score = 0;
      const matches: string[] = [],
        reasons: string[] = [];
      const add = (label: string, values: string[], weight: number, cap: number) => {
        if (values.length) {
          const points = Math.min(values.length * weight, cap);
          score += points;
          matches.push(...values);
          reasons.push(`${label}: ${values.join(', ')} (+${points})`);
        }
      };
      const explicit = raw.includes(file.path.toLowerCase());
      if (explicit) add('Explicit file path', [file.path], 100, 100);
      add(
        'Declared identifier',
        (project.symbols[file.id] ?? []).filter((s) => exactWords.has(s.toLowerCase())),
        30,
        60,
      );
      const resources = [...(resourcesByFile.get(file.id) ?? [])];
      add(
        'Literal resource',
        resources.filter((s) => raw.includes(s.toLowerCase())),
        25,
        50,
      );
      const paths = tokenize(file.path);
      add(
        'Path term',
        direct.filter((t) => paths.includes(t)),
        15,
        45,
      );
      const indexed = unique([
        ...(project.terms[file.id] ?? []),
        ...paths,
        ...(project.symbols[file.id] ?? []).flatMap(tokenize),
      ]);
      add(
        'Expanded intent term',
        expanded.filter((t) => indexed.includes(t)),
        5,
        20,
      );
      add(
        'Content term',
        direct.filter((t) => indexed.includes(t) && !paths.includes(t)),
        2,
        10,
      );
      return {
        fileId: file.id,
        score,
        terms: unique(matches),
        reasons,
        strong:
          score >= STRONG_MATCH_THRESHOLD &&
          (explicit || !['test', 'docs'].includes(file.category)),
      };
    })
    .filter((c) => c.score > 0)
    .sort(
      (a, b) => b.score - a.score || compare(pathsById.get(a.fileId)!, pathsById.get(b.fileId)!),
    );
}

export function analyze(
  project: IndexedProject,
  input: {
    analysisId: string;
    repositoryId: string;
    requestText: string;
    seedFileIds: string[];
    settings: Settings;
  },
  onStage?: (stage: string) => void,
): AnalysisResult {
  const started = Date.now(),
    createdAt = new Date(started).toISOString();
  const byId = new Map(project.files.map((f) => [f.id, f]));
  const evidenceById = new Map(project.evidence.map((e) => [e.id, e]));
  const evidenceByFile = new Map<string, Evidence[]>();
  for (const ev of project.evidence)
    for (const fileId of unique(ev.spans.map((s) => s.fileId))) {
      const list = evidenceByFile.get(fileId) ?? [];
      list.push(ev);
      evidenceByFile.set(fileId, list);
    }
  const incomingByFile = new Map<string, Relationship[]>();
  for (const rel of project.relationships) {
    const list = incomingByFile.get(rel.toFileId) ?? [];
    list.push(rel);
    incomingByFile.set(rel.toFileId, list);
  }
  const seeds = unique(input.seedFileIds).sort((a, b) =>
    compare(byId.get(a)?.path ?? a, byId.get(b)?.path ?? b),
  );
  if (!seeds.length || seeds.length > 8 || seeds.some((s) => !byId.has(s)))
    throw new Error('Select one to eight accepted starting files.');
  if (input.settings.maxDepth < 1 || input.settings.maxDepth > 5)
    throw new Error('Depth must be between one and five.');
  onStage?.('Tracing structural dependencies');
  const active = project.relationships.filter((r) => !r.typeOnly || input.settings.includeTypeOnly);
  const structural = active.filter((r) => STRUCTURAL.has(r.kind));
  const reverse = new Map<string, Relationship[]>();
  for (const r of structural) {
    const list = reverse.get(r.toFileId) ?? [];
    list.push(r);
    reverse.set(r.toFileId, list);
  }
  for (const list of reverse.values())
    list.sort(
      (a, b) =>
        compare(byId.get(a.fromFileId)!.path, byId.get(b.fromFileId)!.path) || compare(a.id, b.id),
    );
  const reached = new Map<
    string,
    { roles: Set<FileImpact['primaryRole']>; depth: number | null; path: string[] }
  >();
  for (const seed of seeds) reached.set(seed, { roles: new Set(['seed']), depth: 0, path: [] });
  const queue = [...seeds];
  for (let i = 0; i < queue.length; i++) {
    const id = queue[i],
      current = reached.get(id)!;
    if (current.depth! >= input.settings.maxDepth) continue;
    for (const edge of reverse.get(id) ?? []) {
      const old = reached.get(edge.fromFileId);
      if (old) {
        if (!seeds.includes(edge.fromFileId)) old.roles.add('dependent');
        continue;
      }
      reached.set(edge.fromFileId, {
        roles: new Set(['dependent']),
        depth: current.depth! + 1,
        path: [...current.path, edge.id],
      });
      queue.push(edge.fromFileId);
    }
  }
  for (const edge of structural.filter((r) => seeds.includes(r.fromFileId))) {
    const old = reached.get(edge.toFileId);
    if (old) old.roles.add('dependency');
    else
      reached.set(edge.toFileId, { roles: new Set(['dependency']), depth: null, path: [edge.id] });
  }
  const structuralSet = new Set(reached.keys());
  const referenceEdges: Relationship[] = [];
  for (const edge of active.filter((r) => !STRUCTURAL.has(r.kind))) {
    if (structuralSet.has(edge.fromFileId) || structuralSet.has(edge.toFileId)) {
      referenceEdges.push(edge);
      for (const id of [edge.fromFileId, edge.toFileId]) {
        const old = reached.get(id);
        if (old) old.roles.add('reference');
        else reached.set(id, { roles: new Set(['reference']), depth: null, path: [edge.id] });
      }
    }
  }
  const tableContext = new Set(
    referenceEdges.filter((e) => e.kind === 'table-reference').map((e) => e.toFileId),
  );
  for (const edge of active.filter(
    (e) => e.kind === 'schema-reference' && tableContext.has(e.toFileId),
  )) {
    referenceEdges.push(edge);
    if (!reached.has(edge.fromFileId))
      reached.set(edge.fromFileId, { roles: new Set(['reference']), depth: null, path: [edge.id] });
  }
  const referenceIds = new Set(referenceEdges.map((e) => e.id));
  const included = active.filter(
    (r) =>
      reached.has(r.fromFileId) &&
      reached.has(r.toFileId) &&
      (STRUCTURAL.has(r.kind) || referenceIds.has(r.id)),
  );
  const relatedEvidenceByFile = new Map<string, string[]>();
  for (const rel of included)
    for (const fileId of unique([rel.fromFileId, rel.toFileId])) {
      const list = relatedEvidenceByFile.get(fileId) ?? [];
      list.push(...rel.evidenceIds);
      relatedEvidenceByFile.set(fileId, list);
    }
  const evidence = [...project.evidence];
  const findings: Finding[] = [];
  const isDestructive = tokenize(input.requestText).some((t) =>
    ['delete', 'remove', 'deletion'].includes(t),
  );
  const precedence: FileImpact['primaryRole'][] = ['seed', 'dependent', 'dependency', 'reference'];
  onStage?.('Explaining review priorities');
  const impacts: FileImpact[] = [...reached]
    .sort(([a], [b]) => compare(byId.get(a)!.path, byId.get(b)!.path))
    .map(([id, reach]) => {
      const file = byId.get(id)!,
        roles = precedence.filter((r) => reach.roles.has(r));
      const incoming = incomingByFile.get(id) ?? [];
      const direct = incoming.filter(
        (r) => STRUCTURAL.has(r.kind) && byId.get(r.fromFileId)?.category === 'test',
      );
      const possible = incoming.filter((r) => r.kind === 'test-candidate');
      const implementation =
        SOURCE_RE.test(file.path) && !['test', 'config'].includes(file.category);
      const status: FileImpact['testReferences']['status'] = !implementation
        ? 'not-applicable'
        : direct.length
          ? 'direct'
          : project.scan.testScan !== 'complete'
            ? 'unknown'
            : possible.length
              ? 'possible'
              : 'none-found';
      const testReferences: FileImpact['testReferences'] = {
        status,
        testFileIds: unique([...direct, ...possible].map((r) => r.fromFileId)),
        evidenceIds: unique([...direct, ...possible].flatMap((r) => r.evidenceIds)),
        limitations: [
          'Direct imports do not establish behavior assertions or measured coverage.',
          ...(status === 'unknown' ? ['Scan gaps prevent a reliable absence statement.'] : []),
        ],
      };
      const assessed = !['test', 'docs'].includes(file.category);
      const components: ScoreComponent[] = [];
      const ev = evidenceByFile.get(id) ?? [];
      const classEv = ev.filter((e) => e.ruleId === 'classification').map((e) => e.id);
      const relationshipEvidence = relatedEvidenceByFile.get(id) ?? [];
      const component = (
        ruleId: string,
        points: number,
        explanation: string,
        evidenceIds: string[],
        requestDerived = false,
      ) =>
        components.push({
          ruleId,
          points,
          explanation,
          evidenceIds: unique(evidenceIds),
          requestDerived,
        });
      if (assessed) {
        component('base-review', 10, 'Relevant assessed file.', classEv);
        if (roles.includes('seed'))
          component('starting-file', 20, 'User confirmed this starting file.', [], true);
        else
          component(
            'related-file',
            10,
            'Reached by a supported analysis rule.',
            relationshipEvidence,
          );
        const sensitive =
          ['auth', 'api', 'schema', 'config'].includes(file.category) ||
          ev.some((e) => ['http-handler', 'env-use', 'sql-table', 'sql-policy'].includes(e.ruleId));
        if (sensitive)
          component(
            'sensitive-responsibility',
            25,
            `Review ${file.category} responsibility${file.categoryBasis === 'path-rule' ? ' (path heuristic)' : ''}.`,
            [
              ...classEv,
              ...ev
                .filter((e) =>
                  ['http-handler', 'env-use', 'sql-table', 'sql-policy'].includes(e.ruleId),
                )
                .map((e) => e.id),
            ],
          );
        const responsibility = ev.filter(
          (e) =>
            ['table-use', 'sql-table', 'env-use', 'declaration', 'http-handler'].includes(
              e.ruleId,
            ) &&
            tokenize(e.matchedValue ?? '').some((t) =>
              [
                'account',
                'user',
                'profile',
                'record',
                'storage',
                'upload',
                'bucket',
                'token',
                'oauth',
              ].includes(t),
            ),
        );
        if (isDestructive && responsibility.length)
          component(
            'destructive-review',
            20,
            'Request expresses removal and observed declarations/resources concern account, data, storage, or token responsibilities.',
            responsibility.map((e) => e.id),
            true,
          );
        if (implementation && !direct.length && project.scan.testScan === 'complete') {
          const absence: Evidence = {
            id: stable('ev', 'no-direct-test', id, project.fingerprint),
            ruleId: 'no-direct-test',
            level: 'unknown',
            spans: ev.find((e) => e.ruleId === 'classification')?.spans ?? [],
            summary: 'No direct test import was found in the accepted, scanned files.',
            limitations: ['This is an index-wide absence observation, not a coverage measurement.'],
          };
          evidence.push(absence);
          component('no-direct-test', 10, 'No direct test import found in the scanned snapshot.', [
            absence.id,
          ]);
          findings.push({
            id: stable('finding', absence.id),
            ruleId: 'no-direct-test',
            title: 'No direct test reference found',
            explanation: `${file.path} has no observed direct test import in the scanned files.`,
            fileIds: [id],
            evidenceIds: [absence.id],
            level: 'unknown',
            suggestedAction:
              'Locate indirect tests or add focused tests for the proposed behavior; run them separately.',
            limitations: absence.limitations,
          });
        }
        const consumers = incoming.filter(
          (r) =>
            STRUCTURAL.has(r.kind) &&
            !r.typeOnly &&
            r.fromFileId !== id &&
            byId.get(r.fromFileId)?.category !== 'test',
        );
        const count = unique(consumers.map((r) => r.fromFileId)).length;
        if (count)
          component(
            'consumer-fan-in',
            Math.min(15, count * 3),
            `${count} unique local non-test value-importing consumer(s).`,
            consumers.flatMap((r) => r.evidenceIds),
          );
      }
      const score = assessed
        ? Math.min(
            100,
            components.reduce((s, c) => s + c.points, 0),
          )
        : null;
      return {
        fileId: id,
        roles,
        primaryRole: roles[0],
        depth: reach.depth,
        explanationPath: reach.path,
        score,
        priority: score === null ? 'not-assessed' : priorityForScore(score),
        scoreComponents: components,
        testReferences,
      };
    });
  for (const edge of included) {
    const from = byId.get(edge.fromFileId)!,
      to = byId.get(edge.toFileId)!;
    const ev = evidenceById.get(edge.evidenceIds[0])!;
    findings.push({
      id: stable('finding', edge.id),
      ruleId: edge.kind,
      title: STRUCTURAL.has(edge.kind)
        ? `${edge.typeOnly ? 'Type-level' : 'Structural'} ${edge.kind} relationship`
        : `${edge.kind.replaceAll('-', ' ')} to inspect`,
      explanation: STRUCTURAL.has(edge.kind)
        ? `${from.path} depends on ${to.path} through a resolved ${edge.typeOnly ? 'type-only ' : ''}${edge.kind}.`
        : ev.summary,
      fileIds: unique([from.id, to.id]),
      evidenceIds: edge.evidenceIds,
      level: edge.level,
      suggestedAction: STRUCTURAL.has(edge.kind)
        ? 'Review the imported interface and update this consumer if the contract changes.'
        : referenceAction(edge.kind),
      limitations: ev.limitations,
    });
  }
  findings.sort((a, b) => compare(a.id, b.id));
  const findingsByFile = new Map<string, Finding[]>();
  for (const finding of findings)
    for (const fileId of finding.fileIds) {
      const list = findingsByFile.get(fileId) ?? [];
      list.push(finding);
      findingsByFile.set(fileId, list);
    }
  const plan: PlanTask[] = [];
  const prepId = stable('task', 'prepare', seeds);
  plan.push({
    id: prepId,
    group: 'preparation',
    title: 'Confirm the intended behavior and boundaries',
    description: `Request-derived review question: confirm acceptance criteria for “${input.requestText}”. Inspect the confirmed starting files and resolve scan warnings before implementation.`,
    fileIds: seeds,
    evidenceIds: [],
    findingIds: [],
    dependsOnTaskIds: [],
    requestDerived: true,
    suggestedNewPaths: [],
  });
  for (const impact of impacts) {
    const file = byId.get(impact.fileId)!,
      related = findingsByFile.get(file.id) ?? [];
    const group: PlanTask['group'] =
      file.category === 'test'
        ? 'tests'
        : file.category === 'docs'
          ? 'docs-release'
          : file.category === 'ui'
            ? 'interface'
            : 'backend';
    plan.push({
      id: stable('task', 'review-file', file.id),
      group,
      title: `Review ${file.path}`,
      description:
        group === 'tests'
          ? 'Inspect assertions for the requested behavior, update focused cases, and record actual results after running the project tests separately.'
          : group === 'docs-release'
            ? 'Check the cited paths and resource descriptions against the approved implementation and update outdated statements.'
            : impact.primaryRole === 'seed'
              ? 'Define the concrete implementation change in this confirmed starting file; inspect its cited dependencies before editing.'
              : `Inspect ${impact.primaryRole === 'dependent' ? 'the consuming interface' : 'the cited relationship'} and decide whether this file needs an update; record the decision.`,
      fileIds: [file.id],
      evidenceIds: unique(related.flatMap((f) => f.evidenceIds)),
      findingIds: related.map((f) => f.id),
      dependsOnTaskIds: [prepId],
      requestDerived: false,
      suggestedNewPaths: [],
    });
  }
  // Focused templates use facts from the bounded result, never guessed source behavior.
  const observed = project.evidence.filter((e) => e.spans.some((s) => reached.has(s.fileId)));
  const focused = (
    rule: string,
    group: PlanTask['group'],
    title: string,
    description: string,
    facts: Evidence[],
    requestDerived = false,
  ) => {
    if (!facts.length) return;
    const fileIds = unique(facts.flatMap((e) => e.spans.map((s) => s.fileId))).sort((a, b) =>
      compare(byId.get(a)!.path, byId.get(b)!.path),
    );
    const evidenceIds = unique(facts.map((e) => e.id)).sort(compare);
    plan.push({
      id: stable('task', rule, fileIds),
      group,
      title,
      description,
      fileIds,
      evidenceIds,
      findingIds: findings
        .filter((f) => f.evidenceIds.some((e) => evidenceIds.includes(e)))
        .map((f) => f.id),
      dependsOnTaskIds: [prepId],
      requestDerived,
      suggestedNewPaths: [],
    });
  };
  const tableFacts = observed.filter((e) => ['table-use', 'sql-table'].includes(e.ruleId));
  focused(
    'table-operations',
    'backend',
    'Define the data changes for the named tables',
    `Review ${unique(tableFacts.map((e) => e.matchedValue!))
      .sort(compare)
      .join(
        ', ',
      )}. Specify which rows the approved change should read, update, remove, or retain; compare the implementation with the cited table declarations and verify deployed schema separately.`,
    tableFacts,
  );
  const fkFacts = observed.filter((e) => ['sql-foreign-key', 'sql-policy'].includes(e.ruleId));
  focused(
    'schema-rules',
    'backend',
    'Review foreign-key deletion rules and row policies',
    `Inspect the observed declarations: ${unique(fkFacts.map((e) => e.summary)).join(' ')} Confirm which records cascade, restrict, become null, or require explicit handling, and whether row policies allow the intended operation. Record any migration needed; scanned SQL does not establish deployed behavior.`,
    fkFacts,
  );
  const envFacts = observed.filter((e) => e.ruleId === 'env-use' || e.ruleId === 'env-definition');
  focused(
    'environment-contract',
    'backend',
    'Check configuration consumers and example keys',
    `Confirm the intended use and example documentation of ${unique(
      envFacts.map((e) => e.matchedValue!),
    )
      .sort(compare)
      .join(
        ', ',
      )}. Trace the cited consumers before changing a key and verify configuration in the approved runtime separately. No environment value is inferred here.`,
    envFacts,
  );
  const storageFacts = observed.filter(
    (e) =>
      ['env-use', 'declaration'].includes(e.ruleId) &&
      tokenize(e.matchedValue ?? '').some((t) =>
        ['bucket', 'storage', 'stored', 'upload', 'object'].includes(t),
      ),
  );
  focused(
    'storage-review',
    'backend',
    'Verify stored-object ownership and operation ordering',
    'Inspect the cited storage declarations and bucket-key consumers. Define how object identifiers map to the affected records and how missing objects, partial failure, and retries should be handled. This is a review question; declaration names do not prove existing cleanup behavior.',
    storageFacts,
    true,
  );
  const apiFacts = observed.filter((e) =>
    ['http-handler', 'http-mounted-handler', 'api-reference'].includes(e.ruleId),
  );
  focused(
    'api-contract',
    'backend',
    'Compare the client and handler contracts',
    `Review the observed endpoints: ${unique(apiFacts.map((e) => e.matchedValue!).filter(Boolean))
      .sort(compare)
      .join(
        ', ',
      )}. Confirm method, route parameters, request fields, response shape, and error handling for the approved change; update callers and handlers together where needed.`,
    apiFacts,
  );
  const authFacts = observed.filter(
    (e) =>
      (e.ruleId === 'classification' && e.matchedValue === 'auth') ||
      (e.ruleId === 'declaration' &&
        /^(?:requireUser|authenticate|authorize)/i.test(e.matchedValue ?? '')),
  );
  focused(
    'authorization-checks',
    'tests',
    'Specify authorization and account-isolation checks',
    'Request-derived review question: inspect the cited auth classification/declarations, then define tests for unauthenticated requests, another user’s account, and authorized success. The observed names and path heuristics do not establish authentication correctness.',
    authFacts,
    true,
  );
  const tokenFacts = observed.filter(
    (e) =>
      ['declaration', 'table-use', 'sql-table'].includes(e.ruleId) &&
      tokenize(e.matchedValue ?? '').some((t) => ['token', 'oauth', 'credential'].includes(t)),
  );
  focused(
    'token-retention',
    'tests',
    'Verify token retention or revocation requirements',
    'Request-derived review question: inspect the cited token declarations/table names and decide what the requested change must retain, remove, or revoke. Add focused cases for the approved behavior and failure handling; a stored token reference does not establish provider-side revocation.',
    tokenFacts,
    true,
  );
  const uiFacts = observed.filter((e) => e.ruleId === 'classification' && e.matchedValue === 'ui');
  focused(
    'interface-checks',
    'tests',
    'Verify the affected interface states',
    'Request-derived review question: inspect the cited interface files and define checks for the changed control, validation, pending state, failure recovery, keyboard operation, and completed behavior. These are proposed verification cases, not observed assertions.',
    uiFacts,
    true,
  );
  if (
    isDestructive &&
    apiFacts.length &&
    !apiFacts.some((e) => (e.matchedValue ?? '').startsWith('DELETE '))
  )
    focused(
      'proposed-delete-handler',
      'backend',
      'Design a deletion handler as proposed new work',
      'Request-derived review question: no DELETE handler was recognized among these related API facts. Decide whether to add a deletion handler to an existing route module or a new module; specify ownership checks, data/storage/token sequencing, retry behavior, and the response contract. No new path or existing deletion implementation is claimed, and unsupported route syntax may conceal other handlers.',
      apiFacts,
      true,
    );
  if (isDestructive)
    plan.push({
      id: stable('task', 'destructive-question', seeds),
      group: 'tests',
      title: 'Verify deletion boundaries and failure handling',
      description:
        'Request-derived review question: define tests for authorization, unrelated-user isolation, partial failure, retry behavior, and retained records before approving deletion behavior. These checks have not been proven by the analyzer.',
      fileIds: seeds,
      evidenceIds: [],
      findingIds: [],
      dependsOnTaskIds: [prepId],
      requestDerived: true,
      suggestedNewPaths: [],
    });
  plan.push({
    id: stable('task', 'verification', seeds),
    group: 'tests',
    title: 'Run and record focused verification separately',
    description:
      'Review the project scripts without executing them here. In an approved development environment, run the relevant tests and type/build checks; record commands, outcomes, and remaining gaps.',
    fileIds: impacts
      .filter((i) => i.testReferences.status === 'direct')
      .flatMap((i) => i.testReferences.testFileIds)
      .filter((v, i, a) => a.indexOf(v) === i),
    evidenceIds: unique(impacts.flatMap((i) => i.testReferences.evidenceIds)),
    findingIds: [],
    dependsOnTaskIds: [prepId],
    requestDerived: true,
    suggestedNewPaths: [],
  });
  const neededEvidence = new Set([
    ...included.flatMap((r) => r.evidenceIds),
    ...findings.flatMap((f) => f.evidenceIds),
    ...impacts.flatMap((i) => [
      ...i.scoreComponents.flatMap((c) => c.evidenceIds),
      ...i.testReferences.evidenceIds,
    ]),
    ...plan.flatMap((t) => t.evidenceIds),
  ]);
  // Keep same-file facts and provenance used for scoring/inspection even without a graph edge.
  for (const ev of evidence)
    if (ev.spans.some((s) => reached.has(s.fileId))) neededEvidence.add(ev.id);
  const done = Date.now();
  return resultSchema.parse({
    schemaVersion: '1.0',
    analyzerVersion: '0.1.0',
    rulesVersion: '1.0',
    ...input,
    seedFileIds: seeds,
    snapshotFingerprint: project.fingerprint,
    createdAt,
    completedAt: new Date(done).toISOString(),
    durationMs: done - started,
    files: project.files,
    relationships: included,
    evidence: evidence.filter((e) => neededEvidence.has(e.id)),
    impacts,
    findings,
    plan,
    scan: project.scan,
    limitations: LIMITATIONS,
  });
}
function referenceAction(kind: Relationship['kind']) {
  return (
    (
      {
        'api-reference':
          'Compare the request method, route shape, payload, and handler contract; verify routing in the real application.',
        'table-reference':
          'Review the named table and intended data operations against the actual deployed schema.',
        'schema-reference':
          'Inspect the cited foreign-key or policy text and verify retention/deletion requirements.',
        'env-reference':
          'Confirm example key documentation and configuration consumers; do not infer deployed values.',
        'document-reference': 'Check whether the explicit document reference needs updating.',
        'test-candidate':
          'Inspect this possible test and confirm it exercises the intended behavior.',
      } as Partial<Record<Relationship['kind'], string>>
    )[kind] ?? 'Inspect the cited relationship.'
  );
}
