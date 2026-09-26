import { describe, it, expect, vi } from 'vitest';
import ts from 'typescript';
import { readFileSync, readdirSync } from 'node:fs';
import path from 'node:path';
import {
  indexProject,
  analyze,
  matchCandidates,
  priorityForScore,
  tokenize,
  STRONG_MATCH_THRESHOLD,
} from '../server/analysis/index.js';
import { validateSnapshot } from '../server/ingestion.js';
import { resultSchema, type IndexedProject, type AnalysisResult } from '../src/shared/schema.js';

const project = (entries: Record<string, string>) =>
  indexProject(
    validateSnapshot({
      name: 'Synthetic',
      files: Object.entries(entries).map(([relativePath, content]) => ({ relativePath, content })),
    }),
  );
const id = (p: IndexedProject, name: string) => p.files.find((f) => f.path === name)!.id;
const run = (
  p: IndexedProject,
  seeds: string[],
  maxDepth = 3,
  includeTypeOnly = true,
  requestText = 'Change the selected feature behavior',
) =>
  analyze(p, {
    analysisId: 'analysis',
    repositoryId: 'repo',
    requestText,
    seedFileIds: seeds.map((n) => id(p, n)),
    settings: { maxDepth, includeTypeOnly },
  });
const paths = (r: AnalysisResult) =>
  r.files.filter((f) => r.impacts.some((i) => i.fileId === f.id)).map((f) => f.path);
const edges = (p: IndexedProject) =>
  p.relationships.map((r) => [
    p.files.find((f) => f.id === r.fromFileId)!.path,
    p.files.find((f) => f.id === r.toFileId)!.path,
    r.kind,
    r.typeOnly,
  ]);
const impact = (p: IndexedProject, r: AnalysisResult, name: string) =>
  r.impacts.find((i) => i.fileId === id(p, name))!;

describe('compiler-backed parsing and virtual resolution', () => {
  it('extracts import forms, TS .js substitution, directories, re-exports, require and dynamic import', () => {
    const p = project({
      'main.ts': `import named from './a';\nimport * as ns from './a.js';\nimport {value} from './folder';\nimport './a.ts';\nexport * from './barrel';\nconst x=require('./a');\nimport('./a');\nimport(somewhere);`,
      'a.ts': 'export default 1; export const value=1;',
      'folder/index.ts': `export * from '../a';`,
      'barrel.ts': `export {value} from './a';`,
    });
    expect(edges(p).filter((e) => e[0] === 'main.ts')).toHaveLength(7);
    expect(p.scan.unsupportedPatterns.join(' ')).toContain('nonliteral import');
    expect(p.scan.unresolvedReferences).toEqual([]);
    expect(p.relationships.filter((r) => r.kind === 'require')).toHaveLength(1);
    expect(p.relationships.filter((r) => r.kind === 'dynamic-import')).toHaveLength(1);
  });
  it('extracts type-only import/export clauses and preserves mixed value imports', () => {
    const p = project({
      'a.ts': 'export interface Model {x:number}; export const x=1;',
      'b.ts': `import type {Model} from './a'; import {type Model as Alias} from './a'; export type {Model} from './a'; export {type Model as Other} from './a'; import {type Model,x} from './a';`,
    });
    expect(p.relationships.filter((r) => r.typeOnly)).toHaveLength(4);
    expect(p.relationships.filter((r) => !r.typeOnly)).toHaveLength(1);
  });
  it('uses JSONC aliases and bounded relative inherited configuration', () => {
    const p = project({
      'tsconfig.json':
        '{ // jsonc\n "extends":"./config/base", "compilerOptions":{"plugins":[{"name":"evil"}]} }',
      'config/base.json': '{"compilerOptions":{"baseUrl":"..","paths":{"@/*":["src/*"]}}}',
      'src/a.ts': 'export const one=1',
      'src/b.ts': `import {one} from '@/a'; import missing from '@/missing';`,
    });
    expect(edges(p)).toContainEqual(['src/b.ts', 'src/a.ts', 'import', false]);
    expect(p.scan.unresolvedReferences[0]).toContain('@/missing');
    expect(p.scan.unsupportedPatterns.join(' ')).toContain('plugins');
  });
  it('detects config cycles and ignores package and escaping config extends', () => {
    const cycle = project({
      'tsconfig.json': '{"extends":"./other"}',
      'other.json': '{"extends":"./tsconfig"}',
      'a.ts': 'export {}',
    });
    expect(cycle.scan.unsupportedPatterns.join(' ')).toContain('cycle');
    expect(
      project({
        'tsconfig.json': '{"extends":"../private.json"}',
        'a.ts': 'export {}',
      }).scan.unsupportedPatterns.join(' '),
    ).toContain('Out-of-snapshot');
    expect(
      project({
        'tsconfig.json': '{"extends":"@org/config"}',
        'a.ts': 'export {}',
      }).scan.unsupportedPatterns.join(' '),
    ).toContain('relative');
  });
  it('never calls ts.sys host filesystem and distinguishes external/unresolved', () => {
    const read = vi.spyOn(ts.sys, 'readFile').mockImplementation(() => {
      throw new Error('host read forbidden');
    });
    const exists = vi.spyOn(ts.sys, 'fileExists').mockImplementation(() => {
      throw new Error('host access forbidden');
    });
    try {
      const p = project({ 'a.ts': `import 'react'; import '../secret'; import './missing';` });
      expect(p.relationships).toEqual([]);
      expect(p.scan.unresolvedReferences).toHaveLength(2);
      expect(p.evidence.some((e) => e.summary.includes('external'))).toBe(true);
      expect(read).not.toHaveBeenCalled();
      expect(exists).not.toHaveBeenCalled();
    } finally {
      read.mockRestore();
      exists.mockRestore();
    }
  });
  it.each(['\n', '\r\n'])('preserves one-based source spans with %j', (newline) => {
    const p = project({
      'a.ts': 'export {}',
      'b.ts': `// heading${newline}import './a';${newline}`,
    });
    const ev = p.evidence.find((e) => e.ruleId === 'syntax-import')!;
    expect(ev.spans[0]).toMatchObject({ startLine: 2, startColumn: 8, endLine: 2, endColumn: 13 });
  });
  it('reports partial syntax diagnostics and does not execute source', () => {
    const p = project({ 'a.ts': 'const broken = ; globalThis.__pickle_executed = true;' });
    expect(p.files[0].parseStatus).toBe('partial');
    expect(p.scan.testScan).toBe('partial');
    expect(p.scan.warnings.length).toBeGreaterThan(0);
    expect('__pickle_executed' in globalThis).toBe(false);
  });
  it('indexes declarations using AST and does not read commented fake imports', () => {
    const p = project({
      'a.ts': `// import './nope';\nexport function addUser(){}; class User {}; interface Profile {}; type Token=string; const accountStatus='x';`,
    });
    expect(p.symbols[p.files[0].id]).toEqual([
      'addUser',
      'User',
      'Profile',
      'Token',
      'accountStatus',
    ]);
    expect(p.scan.unresolvedReferences).toEqual([]);
  });
  it('indexes destructured variable names and requires whole identifiers for exact symbol points', () => {
    const p = project({
      'a.ts':
        'const {profile: currentProfile, token}=value; const [first]=items; const set=()=>{};',
    });
    expect(p.symbols[p.files[0].id]).toEqual(['currentProfile', 'token', 'first', 'set']);
    expect(
      matchCandidates(p, 'Change settings feature')
        .flatMap((c) => c.reasons)
        .some((r) => r.startsWith('Declared identifier')),
    ).toBe(false);
    expect(
      matchCandidates(p, 'Change currentProfile behavior')[0].reasons.some((r) =>
        r.startsWith('Declared identifier'),
      ),
    ).toBe(true);
  });
});

describe('graph traversal and review score rules', () => {
  const graph = () =>
    project({
      'a.ts': `import './a'; export const x=1;`,
      'b.ts': `import './a';`,
      'c.ts': `import './a';`,
      'd.ts': `import './b'; import './c';`,
      'e.ts': `import './d';`,
      'unrelated.ts': 'export const nope=1;',
    });
  it('traverses reverse imports, deduplicates diamonds/self links, and respects depth', () => {
    const p = graph(),
      r = run(p, ['a.ts'], 2);
    expect(paths(r)).toEqual(['a.ts', 'b.ts', 'c.ts', 'd.ts']);
    expect(r.impacts).toHaveLength(4);
    expect(impact(p, r, 'd.ts').depth).toBe(2);
    expect(impact(p, r, 'a.ts').primaryRole).toBe('seed');
    const route = impact(p, r, 'd.ts').explanationPath.map((eid) =>
      p.relationships.find((e) => e.id === eid)!,
    );
    expect(route.map((e) => p.files.find((f) => f.id === e.fromFileId)!.path)).toEqual([
      'b.ts',
      'd.ts',
    ]);
  });
  it('handles cycles, multiple seeds, role precedence, and outgoing-only context', () => {
    const p = project({
        'a.ts': `import './b';`,
        'b.ts': `import './a'; import './c';`,
        'c.ts': `import './far';`,
        'far.ts': 'export {}',
      }),
      r = run(p, ['a.ts', 'b.ts'], 1);
    expect(paths(r)).toEqual(['a.ts', 'b.ts', 'c.ts']);
    expect(impact(p, r, 'c.ts').primaryRole).toBe('dependency');
    expect(impact(p, r, 'c.ts').depth).toBeNull();
    expect(r.impacts.filter((i) => i.primaryRole === 'seed')).toHaveLength(2);
  });
  it('excludes type-only traversal when toggled', () => {
    const p = project({ 'a.ts': 'export type User={};', 'b.ts': `import type {User} from './a';` });
    expect(paths(run(p, ['a.ts'], 3, false))).toEqual(['a.ts']);
    expect(paths(run(p, ['a.ts']))).toEqual(['a.ts', 'b.ts']);
  });
  it.each([
    [39, 'low'],
    [40, 'medium'],
    [69, 'medium'],
    [70, 'high'],
  ] as const)('score boundary %s is %s', (score, expected) =>
    expect(priorityForScore(score)).toBe(expected),
  );
  it('starting and related are mutually exclusive; fan-in omits type and test imports', () => {
    const p = project({
        'a.ts': 'export type User={}; export const x=1;',
        'b.ts': `import {x} from './a'; import './a';`,
        'c.ts': `import type {User} from './a';`,
        'a.test.ts': `import {x} from './a';`,
      }),
      r = run(p, ['a.ts']);
    const a = impact(p, r, 'a.ts');
    expect(a.scoreComponents.find((c) => c.ruleId === 'consumer-fan-in')?.points).toBe(3);
    expect(a.scoreComponents.some((c) => c.ruleId === 'starting-file')).toBe(true);
    expect(a.scoreComponents.some((c) => c.ruleId === 'related-file')).toBe(false);
    expect(a.testReferences.status).toBe('direct');
    expect(a.scoreComponents.some((c) => c.ruleId === 'no-direct-test')).toBe(false);
    expect(impact(p, r, 'a.test.ts').score).toBeNull();
  });
  it('does not assign destructive points to unrelated implementation', () => {
    const p = project({
        'plain.ts': 'export const formatDate=()=>0;',
        'account.ts': 'export const deleteUser=()=>0;',
      }),
      r = run(p, ['plain.ts', 'account.ts'], 3, true, 'Delete the account and remove profile');
    expect(
      impact(p, r, 'plain.ts').scoreComponents.some((c) => c.ruleId === 'destructive-review'),
    ).toBe(false);
    expect(
      impact(p, r, 'account.ts').scoreComponents.find((c) => c.ruleId === 'destructive-review')
        ?.requestDerived,
    ).toBe(true);
  });
  it('sensitive points are explicit and apply once; configuration has no test penalty', () => {
    const p = project({
        'auth/oauthTokens.ts':
          'export const savedTokens=1; const bucket=process.env.UPLOAD_BUCKET;',
        '.env.example': 'UPLOAD_BUCKET=\n',
      }),
      r = run(p, ['auth/oauthTokens.ts'], 3, true, 'Delete user tokens and stored uploads');
    expect(
      impact(p, r, 'auth/oauthTokens.ts').scoreComponents.filter(
        (c) => c.ruleId === 'sensitive-responsibility',
      ),
    ).toHaveLength(1);
    expect(
      impact(p, r, '.env.example').scoreComponents.some((c) => c.ruleId === 'no-direct-test'),
    ).toBe(false);
    expect(impact(p, r, 'auth/oauthTokens.ts').score).toBeLessThanOrEqual(100);
  });
  it('test scan gaps suppress absence penalties', () => {
    const p = project({
        'a.ts': 'export const x=1;',
        'bad.test.ts': `import './missing'; const bad=;`,
      }),
      r = run(p, ['a.ts']);
    expect(impact(p, r, 'a.ts').testReferences.status).toBe('unknown');
    expect(impact(p, r, 'a.ts').scoreComponents.some((c) => c.ruleId === 'no-direct-test')).toBe(
      false,
    );
  });
  it('bounded reference expansion does not recursively gather environment consumers', () => {
    const p = project({
      'a.ts': 'const a=process.env.BUCKET;',
      'b.ts': 'const b=process.env.BUCKET;',
      '.env.example': 'BUCKET=\n',
    });
    expect(paths(run(p, ['a.ts']))).toEqual(['.env.example', 'a.ts']);
  });
  it('does not cap analysis results for graph rendering and rejects foreign seeds', () => {
    const p = project(
      Object.fromEntries([
        ['base.ts', 'export {}'],
        ...Array.from({ length: 120 }, (_, i) => [`consumer${i}.ts`, `import './base';`]),
      ]),
    );
    expect(run(p, ['base.ts']).impacts).toHaveLength(121);
    expect(() =>
      analyze(p, {
        analysisId: 'a',
        repositoryId: 'r',
        requestText: 'Change something',
        seedFileIds: ['foreign'],
        settings: { maxDepth: 3, includeTypeOnly: true },
      }),
    ).toThrow('starting');
  });
});

describe('traceable bounded reference recognizers', () => {
  it('matches a unique literal HTTP method/path with both spans', () => {
    const p = project({
      'routes.ts': `router.get('/account', handler); router.post('/account', create);`,
      'client.ts': `fetch('/account'); axios.post('/account',{});`,
    });
    const refs = p.relationships.filter((r) => r.kind === 'api-reference');
    expect(refs).toHaveLength(2);
    expect(refs.every((r) => r.level === 'supported-reference')).toBe(true);
    for (const r of refs)
      expect(p.evidence.find((e) => e.id === r.evidenceIds[0])!.spans).toHaveLength(2);
  });
  it('does not assume GET for dynamic fetch options or spread overrides', () => {
    const p = project({
      'routes.ts': `app.get('/account', handler);`,
      'client.ts': `fetch('/account',options); fetch('/account',{...options}); fetch('/account',{headers:{}});`,
    });
    expect(p.relationships.filter((r) => r.kind === 'api-reference')).toHaveLength(1);
    expect(p.scan.unsupportedPatterns.join(' ')).toContain('fetch method');
  });
  it('composes a resolved imported router mount and cites mount and handler', () => {
    const p = project({
      'routes.ts': `router.get('/',handler); export default router;`,
      'app.ts': `import routes from './routes'; app.use('/api/account',routes);`,
      'client.ts': `fetch('/api/account');`,
    });
    const r = p.relationships.find((r) => r.kind === 'api-reference')!;
    expect(r).toBeDefined();
    expect(p.files.find((f) => f.id === r.toFileId)!.path).toBe('routes.ts');
    expect(p.evidence.find((e) => e.id === r.evidenceIds[0])!.spans).toHaveLength(3);
  });
  it('labels ambiguous and parameter/template routes inferred', () => {
    const p = project({
      'a.ts': `app.get('/same',h); app.get('/users/:id',h);`,
      'b.ts': `router.get('/same',h);`,
      'client.ts': "fetch('/same'); fetch(`/users/${id}`);",
    });
    expect(p.relationships.filter((r) => r.kind === 'api-reference')).toHaveLength(3);
    expect(
      p.relationships
        .filter((r) => r.kind === 'api-reference')
        .every((r) => r.level === 'inferred-reference'),
    ).toBe(true);
  });
  it('recognizes SQL comments/quoted identifiers and cites deletion text without inventing facts', () => {
    const p = project({
      'tables.sql': `-- CREATE TABLE fake (id int);\nCREATE TABLE "public"."profiles" (id uuid);\nCREATE TABLE posts(id uuid, owner uuid REFERENCES "public"."profiles"(id) ON DELETE CASCADE);\nCREATE POLICY "owner" ON "public"."profiles" USING (true);`,
      'a.ts': `db.from('profiles').select();`,
    });
    expect(p.scan.tables).toBe(2);
    expect(p.relationships.filter((r) => r.kind === 'table-reference')).toHaveLength(1);
    expect(
      p.evidence.some(
        (e) => e.ruleId === 'sql-foreign-key' && e.summary.includes('ON DELETE CASCADE'),
      ),
    ).toBe(true);
    expect(p.evidence.some((e) => e.ruleId === 'sql-policy')).toBe(true);
    expect(p.evidence.some((e) => e.matchedValue === 'fake')).toBe(false);
    expect(
      p.relationships.some((r) => r.kind === 'schema-reference' && r.fromFileId === r.toFileId),
    ).toBe(true);
  });
  it('attaches one incoming foreign-key schema context beyond a referenced definition', () => {
    const p = project({
      'a.ts': `db.from('profiles');`,
      'profiles.sql': 'CREATE TABLE profiles(id uuid);',
      'posts.sql': 'CREATE TABLE posts(owner uuid REFERENCES profiles(id));',
      'comments.sql': 'CREATE TABLE comments(post uuid REFERENCES posts(id));',
    });
    expect(paths(run(p, ['a.ts']))).toEqual(['a.ts', 'posts.sql', 'profiles.sql']);
  });
  it('does not choose between ambiguous schema/table names and warns for unsupported SQL', () => {
    const p = project({
      'a.ts': `db.from('profiles');`,
      'one.sql': 'CREATE TABLE one.profiles(id int);',
      'two.sql': 'CREATE TABLE two.profiles(id int); ALTER TABLE two.profiles ADD x int;',
    });
    expect(p.relationships.filter((r) => r.kind === 'table-reference')).toHaveLength(0);
    expect(p.scan.unresolvedReferences.join(' ')).toContain('ambiguous');
    expect(p.scan.unsupportedPatterns.join(' ')).toContain('bounded SQL');
  });
  it('does not manufacture SQL definitions from quoted strings, comments, or dollar bodies', () => {
    const p = project({
      'tables.sql': `/* CREATE TABLE fake_a(id int); */\nSELECT 'CREATE TABLE fake_b(id int)';\nDO $$ BEGIN CREATE TABLE fake_c(id int); END $$;\nCREATE TABLE "dash--name"(id int);`,
    });
    expect(p.scan.tables).toBe(1);
    expect(p.evidence.filter((e) => e.ruleId === 'sql-table').map((e) => e.matchedValue)).toEqual([
      'dash--name',
    ]);
    expect(p.scan.unsupportedPatterns.join(' ')).toContain('dollar-quoted');
  });
  it('detects router mount cycles without recursive expansion', () => {
    const p = project({
      'a.ts': `import bRouter from './b'; export const aRouter=Router(); aRouter.use('/a',bRouter); aRouter.get('/x',h); export default aRouter;`,
      'b.ts': `import aRouter from './a'; export const bRouter=Router(); bRouter.use('/b',aRouter); export default bRouter;`,
      'client.ts': `fetch('/a/x');`,
    });
    expect(p.scan.unsupportedPatterns.join(' ')).toContain('cycle');
    expect(p.relationships.filter((r) => r.kind === 'api-reference')).toHaveLength(0);
  });
  it('matches all supported environment access forms and never retains example values', () => {
    const p = project({
      'a.ts': `const a=process.env.BUCKET; const b=process.env['KEY']; const c=import.meta.env.CLIENT;`,
      '.env.example': 'BUCKET=not-a-real-secret\nKEY=demo\nCLIENT=example\n',
    });
    expect(p.relationships.filter((r) => r.kind === 'env-reference')).toHaveLength(3);
    expect(JSON.stringify(p)).not.toContain('not-a-real-secret');
    expect(
      p.evidence
        .filter((e) => e.ruleId === 'env-definition')
        .every((e) => !e.matchedValue?.includes('=')),
    ).toBe(true);
  });
  it('recognizes and sanitizes uppercase environment example filenames consistently', () => {
    const p = project({
      'a.ts': 'process.env.BUCKET;',
      '.ENV.EXAMPLE': 'BUCKET=private-value-to-remove\n',
    });
    expect(p.relationships.filter((r) => r.kind === 'env-reference')).toHaveLength(1);
    expect(JSON.stringify(p)).not.toContain('private-value-to-remove');
  });
  it('distinguishes direct test imports and naming-only candidates', () => {
    const p = project({
        'thing.ts': 'export const thing=1;',
        'thing.test.ts': 'test("placeholder",()=>{});',
        'other.test.ts': `import './thing';`,
      }),
      r = run(p, ['thing.ts']);
    expect(p.relationships.filter((r) => r.kind === 'test-candidate')).toHaveLength(1);
    expect(impact(p, r, 'thing.ts').testReferences.status).toBe('direct');
    expect(impact(p, r, 'thing.test.ts').score).toBeNull();
    const q = project({
      'thing.ts': 'export const thing=1;',
      'thing.test.ts': 'test("placeholder",()=>{});',
    });
    expect(impact(q, run(q, ['thing.ts']), 'thing.ts').testReferences.status).toBe('possible');
  });
  it('uses explicit Markdown references only, and treats uploaded HTML as inert text', () => {
    const p = project({
      'a.ts': 'export const profile=1;',
      'README.md': '<script>globalThis.evil=true</script> profile profile `a.ts` [source](./a.ts)',
      'notes.md': 'profile profile profile',
    });
    expect(p.relationships.filter((r) => r.kind === 'document-reference')).toHaveLength(2);
    expect(paths(run(p, ['a.ts']))).toEqual(['README.md', 'a.ts']);
    expect('evil' in globalThis).toBe(false);
    expect(impact(p, run(p, ['a.ts']), 'README.md').score).toBeNull();
  });
});

describe('request matching and mandatory anti-canned checks', () => {
  it('builds the resource lookup once per request instead of rescanning all evidence per file', () => {
    const p = project(
      Object.fromEntries(
        Array.from({ length: 180 }, (_, i) => [
          `source${i}.ts`,
          `export const account${i}=db.from('profiles');`,
        ]),
      ),
    );
    const evidence = p.evidence;
    let reads = 0;
    Object.defineProperty(p, 'evidence', {
      get() {
        reads++;
        return evidence;
      },
    });
    const matched = matchCandidates(p, 'Change profiles account behavior');
    expect(matched).toHaveLength(180);
    expect(reads).toBe(1);
    expect(matched.every((m) => m.reasons.some((r) => r.startsWith('Literal resource')))).toBe(
      true,
    );
  });
  it('normalizes names conservatively and enforces a named strong threshold', () => {
    expect(tokenize('deleteUser saved_tokens upload-buckets')).toEqual([
      'delete',
      'user',
      'saved',
      'token',
      'upload',
      'bucket',
    ]);
    expect(STRONG_MATCH_THRESHOLD).toBe(30);
    const p = project({
      'src/profile.ts': 'export function deleteAccount(){}',
      'tests/profile.test.ts': 'export const profile=1;',
      'README.md': 'deleteAccount profile',
      'weak.ts': '// imaginary',
    });
    const results = matchCandidates(p, 'Delete account profile using deleteAccount');
    expect(results[0].fileId).toBe(id(p, 'src/profile.ts'));
    expect(results.find((c) => c.fileId === id(p, 'tests/profile.test.ts'))?.strong).toBe(false);
    expect(matchCandidates(p, 'Imaginary feature')[0]?.strong).toBe(false);
    expect(matchCandidates(p, 'Totally unrecognized zzzqqq')).toEqual([]);
    expect(
      matchCandidates(p, 'Inspect README.md specifically').find(
        (c) => c.fileId === id(p, 'README.md'),
      )?.strong,
    ).toBe(true);
  });
  it('changes dependent results when an importer is added and removes deleted import edges', () => {
    const before = project({
      'lib/core.ts': 'export const data=1;',
      'ui/view.ts': `import '../lib/core';`,
    });
    const added = project({
      'lib/core.ts': 'export const data=1;',
      'ui/view.ts': `import '../lib/core';`,
      'jobs/reindex.ts': `import '../lib/core';`,
    });
    expect(paths(run(added, ['lib/core.ts']))).toHaveLength(
      paths(run(before, ['lib/core.ts'])).length + 1,
    );
    const removed = project({ 'lib/core.ts': 'export const data=1;', 'ui/view.ts': 'export {}' });
    expect(removed.relationships).toHaveLength(0);
    expect(paths(run(removed, ['lib/core.ts']))).toEqual(['lib/core.ts']);
  });
  it('changes environment references after renaming one endpoint', () => {
    const old = project({ 'a.ts': 'process.env.BUCKET;', '.env.example': 'BUCKET=\n' }),
      changed = project({ 'a.ts': 'process.env.NEW_BUCKET;', '.env.example': 'BUCKET=\n' });
    expect(old.relationships.filter((r) => r.kind === 'env-reference')).toHaveLength(1);
    expect(changed.relationships.filter((r) => r.kind === 'env-reference')).toHaveLength(0);
    expect(changed.scan.unresolvedReferences.join(' ')).toContain('NEW_BUCKET');
  });
  it('changes seed results for structural reasons and repeats identical semantic output', () => {
    const p = project({
      'core.ts': 'export {}',
      'consumer.ts': `import './core';`,
      'isolated.ts': 'export {}',
    });
    expect(paths(run(p, ['core.ts']))).not.toEqual(paths(run(p, ['isolated.ts'])));
    const normalize = (r: AnalysisResult) => {
      const { createdAt: _a, completedAt: _b, durationMs: _c, ...semantic } = r;
      return semantic;
    };
    expect(normalize(run(p, ['core.ts']))).toEqual(normalize(run(p, ['core.ts'])));
    expect(matchCandidates(p, 'Change core consumer')).toEqual(
      matchCandidates(p, 'Change core consumer'),
    );
  });
  it('runs on a second independently shaped project and validates evidence references', () => {
    const p = project({
        'engine/main.mjs': `const util=require('../util/math.cjs');`,
        'util/math.cjs': 'exports.sum=(a,b)=>a+b;',
        'qa/sum.spec.js': `require('../util/math.cjs');`,
      }),
      r = run(p, ['util/math.cjs']);
    expect(paths(r)).toEqual(['engine/main.mjs', 'qa/sum.spec.js', 'util/math.cjs']);
    expect(resultSchema.safeParse(r).success).toBe(true);
    const ids = new Set(r.evidence.map((e) => e.id));
    for (const rel of r.relationships)
      for (const e of rel.evidenceIds) expect(ids.has(e)).toBe(true);
    for (const f of r.findings) {
      expect(f.evidenceIds.length).toBeGreaterThan(0);
      for (const e of f.evidenceIds) expect(ids.has(e)).toBe(true);
    }
    for (const e of r.evidence)
      for (const s of e.spans) {
        expect(s.startLine).toBeGreaterThan(0);
        expect(s.endLine).toBeLessThanOrEqual(p.files.find((f) => f.id === s.fileId)!.lineCount);
      }
  });
  it('runs the bundled sample through exactly the same analyzer and generates source-specific tasks', () => {
    const root = path.resolve('fixtures/sample-project');
    const inputs: Record<string, string> = {};
    function visit(dir: string) {
      for (const entry of readdirSync(dir, { withFileTypes: true })) {
        const full = path.join(dir, entry.name);
        if (entry.isDirectory()) visit(full);
        else inputs[path.relative(root, full).replaceAll('\\', '/')] = readFileSync(full, 'utf8');
      }
    }
    visit(root);
    const p = project(inputs);
    expect(p.scan.sourceFiles).toBeGreaterThan(20);
    expect(p.scan.unresolvedReferences).toEqual([]);
    expect(p.scan.routes).toBeGreaterThan(0);
    expect(p.relationships.some((r) => r.kind === 'api-reference')).toBe(true);
    expect(p.relationships.some((r) => r.kind === 'schema-reference')).toBe(true);
    const candidates = matchCandidates(
      p,
      "Add account deletion to the settings page. Remove the user's profile, related records, stored files, and saved OAuth tokens.",
    );
    const selected = candidates
      .filter((c) => c.strong)
      .slice(0, 3)
      .map((c) => p.files.find((f) => f.id === c.fileId)!.path);
    expect(selected.length).toBeGreaterThan(0);
    const r = run(p, selected, 3, true, 'Delete the account and remove profiles and stored files');
    expect(r.findings.length).toBeGreaterThan(0);
    expect(r.plan.some((t) => t.requestDerived)).toBe(true);
    expect(r.plan.some((t) => !t.requestDerived && t.fileIds.length)).toBe(true);
    expect(r.impacts.some((i) => i.testReferences.status === 'direct')).toBe(true);
    const concrete = run(
      p,
      [
        'src/pages/SettingsPage.tsx',
        'server/services/accountService.ts',
        'server/data/accountRepository.ts',
      ],
      3,
      true,
      'Delete account profiles, stored files, and OAuth tokens',
    );
    expect(
      concrete.plan.some((t) => t.title.includes('foreign-key') && t.evidenceIds.length > 0),
    ).toBe(true);
    expect(
      concrete.plan.some((t) => t.title.includes('configuration') && t.evidenceIds.length > 0),
    ).toBe(true);
    expect(concrete.plan.some((t) => t.title.includes('token retention') && t.requestDerived)).toBe(
      true,
    );
    expect(
      concrete.plan.some(
        (t) =>
          t.title.includes('deletion handler') &&
          t.requestDerived &&
          t.suggestedNewPaths.length === 0,
      ),
    ).toBe(true);
    const allEvidence = new Set(concrete.evidence.map((e) => e.id)),
      allFiles = new Set(concrete.files.map((f) => f.id));
    for (const task of concrete.plan) {
      for (const e of task.evidenceIds) expect(allEvidence.has(e)).toBe(true);
      for (const f of task.fileIds) expect(allFiles.has(f)).toBe(true);
      expect(task.dependsOnTaskIds.every((t) => concrete.plan.some((p) => p.id === t))).toBe(true);
    }
  });
});
