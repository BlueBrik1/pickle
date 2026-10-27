import { readFileSync } from 'node:fs';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { summarizeChange } from '../extension/core/changes.js';
import { parsePatch } from '../extension/core/git.js';
import { preview, review } from '../extension/core/pickle.js';
import { makeRepo } from './helpers/repo.js';

const base = {
  'package.json': JSON.stringify({ name: 'app', scripts: { test: 'vitest run' } }),
  'src/auth/session.ts': [
    'export interface Session { id: string }',
    '',
    'export function createSession(id: string): Session {',
    '  return { id };',
    '}',
    '',
    'export function sessionLabel(s: Session) {',
    '  return `Session ${s.id}`;',
    '}',
    '',
  ].join('\n'),
  'src/auth/index.ts': "export * from './session';\n",
  'src/auth/login.ts': "import { createSession } from './session';\n\nexport function login(id: string) {\n  return createSession(id);\n}\n",
  'src/components/Badge.tsx': "import { sessionLabel } from '../auth/session';\n\nexport const Badge = ({ id }: { id: string }) => <span>{sessionLabel({ id })}</span>;\n",
  'src/pages/Dashboard.tsx': "import { createSession } from '../auth';\nimport { login } from '../auth/login';\n\nexport function Dashboard() {\n  const s = createSession('x');\n  return <div>{login(s.id).id}</div>;\n}\n",
  'src/utils/format.ts': 'export const upper = (s: string) => s.toUpperCase();\n',
  'src/pages/Settings.tsx': "import { upper } from '../utils/format';\nexport const Settings = () => <h1>{upper('settings')}</h1>;\n",
  'tests/session.test.ts': "import { createSession } from '../src/auth/session';\nimport { it, expect } from 'vitest';\nit('creates', () => expect(createSession('a').id).toBe('a'));\n",
};

let repo: ReturnType<typeof makeRepo>;
afterEach(() => repo?.cleanup());

const line = (root: string, rel: string, n: number) => readFileSync(path.join(root, rel), 'utf8').split('\n')[n - 1];

describe('change review (git diff)', () => {
  it('reports direct importers of a changed symbol with real line numbers and excludes importers of unchanged exports', async () => {
    repo = makeRepo(base);
    repo.write('src/auth/session.ts', base['src/auth/session.ts'].replace('return { id };', 'return { id: id.trim() };'));
    const r = await review(repo.root);
    expect(r.changed.map((c) => c.path)).toEqual(['src/auth/session.ts']);
    expect(r.changed[0].ranges).toEqual([[4, 4]]);
    expect(r.changed[0].symbols.map((s) => s.name)).toEqual(['createSession']);
    const login = r.impact.confirmed.find((e) => e.path === 'src/auth/login.ts')!;
    expect(login.symbols).toEqual(['createSession']);
    expect(line(repo.root, login.path, login.line!)).toContain('createSession');
    expect(login.lines!.every((n) => line(repo.root, login.path, n).includes('createSession'))).toBe(true);
    // Badge imports only the unchanged sessionLabel: excluded, not reported as affected.
    expect(r.impact.excluded).toContain('src/components/Badge.tsx');
    expect([...r.impact.confirmed, ...r.impact.predicted].map((e) => e.path)).not.toContain('src/components/Badge.tsx');
    // Unrelated files never appear.
    expect(JSON.stringify(r.impact)).not.toContain('Settings.tsx');
    expect(r.verify.tests).toContain('tests/session.test.ts');
    expect(r.verify.command).toBe('npm test -- tests/session.test.ts');
  });

  it('follows `export *` barrels to the importers of the re-exported symbol', async () => {
    repo = makeRepo(base);
    repo.write('src/auth/session.ts', base['src/auth/session.ts'].replace('return { id };', 'return { id: id.trim() };'));
    const r = await review(repo.root);
    const barrel = r.impact.confirmed.find((e) => e.path === 'src/auth/index.ts');
    expect(barrel?.why).toMatch(/Re-exports changed createSession/);
    const dashboard = r.impact.confirmed.find((e) => e.path === 'src/pages/Dashboard.tsx' && e.why.includes('via src/auth/session.ts'));
    expect(dashboard).toBeDefined();
    expect(line(repo.root, dashboard!.path, dashboard!.line!)).toContain("from '../auth'");
  });

  it('traces through dependents: users of an export that uses the change are predicted, users of untouched exports are not', async () => {
    repo = makeRepo({
      ...base,
      'src/pages/Home.tsx': "import { login } from '../auth/login';\nexport const Home = () => <a onClick={() => login('h')}>Home</a>;\n",
      'src/auth/login.ts': base['src/auth/login.ts'] + 'export const LOGIN_PATH = "/login";\n',
      'src/pages/Links.tsx': "import { LOGIN_PATH } from '../auth/login';\nexport const Links = () => <a href={LOGIN_PATH}>Sign in</a>;\n",
    });
    repo.write('src/auth/session.ts', base['src/auth/session.ts'].replace('return { id };', 'return { id: id.trim() };'));
    const r = await review(repo.root);
    const home = r.impact.predicted.find((e) => e.path === 'src/pages/Home.tsx')!;
    expect(home.why).toMatch(/Uses login from src\/auth\/login\.ts, which depends on the change/);
    expect(line(repo.root, home.path, home.lines![0])).toContain('login(');
    expect(r.impact.excluded).toContain('src/pages/Links.tsx');
    // Dashboard reaches the change both directly (barrel) and via login: listed once, as confirmed.
    expect([...r.impact.confirmed, ...r.impact.predicted].filter((e) => e.path === 'src/pages/Dashboard.tsx')).toHaveLength(1);
    expect(r.impact.confirmed.some((e) => e.path === 'src/pages/Dashboard.tsx')).toBe(true);
  });

  it('propagates an internal change to the exported functions that call it', async () => {
    repo = makeRepo({
      ...base,
      'src/auth/session.ts': 'function normalize(id: string) {\n  return id;\n}\n\nexport function createSession(id: string) {\n  return { id: normalize(id) };\n}\n\nexport const unrelated = 1;\n',
    });
    repo.write('src/auth/session.ts', 'function normalize(id: string) {\n  return id.toLowerCase();\n}\n\nexport function createSession(id: string) {\n  return { id: normalize(id) };\n}\n\nexport const unrelated = 1;\n');
    const r = await review(repo.root);
    expect(r.impact.confirmed.find((e) => e.path === 'src/auth/login.ts')?.symbols).toEqual(['createSession']);
  });

  it('flags importers of a removed export as broken (confirmed, high)', async () => {
    repo = makeRepo(base);
    repo.write('src/auth/session.ts', base['src/auth/session.ts'].replace('export function createSession', 'export function makeSession'));
    const r = await review(repo.root);
    const login = r.impact.confirmed.find((e) => e.path === 'src/auth/login.ts')!;
    expect(login.why).toMatch(/no longer exported/);
    expect(r.risks[0]).toMatchObject({ level: 'high', basis: 'confirmed' });
  });

  it('flags imports of a deleted file as broken', async () => {
    repo = makeRepo(base);
    repo.remove('src/utils/format.ts');
    const r = await review(repo.root);
    expect(r.changed).toEqual([expect.objectContaining({ path: 'src/utils/format.ts', status: 'deleted' })]);
    const broken = r.impact.confirmed.find((e) => e.path === 'src/pages/Settings.tsx')!;
    expect(broken.why).toMatch(/deleted or renamed/);
    expect(line(repo.root, broken.path, broken.line!)).toContain('../utils/format');
  });

  it('handles a renamed file: importers still using the old path are broken', async () => {
    repo = makeRepo(base);
    repo.git('mv', 'src/utils/format.ts', 'src/utils/text.ts');
    const r = await review(repo.root);
    expect(r.changed[0]).toMatchObject({ status: 'renamed', oldPath: 'src/utils/format.ts', path: 'src/utils/text.ts' });
    expect(r.impact.confirmed.map((e) => e.path)).toContain('src/pages/Settings.tsx');
  });

  it('analyzes untracked files and staged-only review separately', async () => {
    repo = makeRepo(base);
    repo.write('src/auth/oauth.ts', "import { createSession } from './session';\nexport const google = () => createSession('g');\n");
    expect((await review(repo.root)).changed).toEqual([expect.objectContaining({ path: 'src/auth/oauth.ts', status: 'added' })]);
    expect((await review(repo.root, { staged: true })).changed).toEqual([]);
    repo.git('add', 'src/auth/oauth.ts');
    expect((await review(repo.root, { staged: true })).changed.map((c) => c.path)).toEqual(['src/auth/oauth.ts']);
  });

  it('marks what it cannot narrow as predicted or unknown instead of guessing', async () => {
    repo = makeRepo({
      ...base,
      'src/lazy.ts': "export const load = () => import('./auth/session');\n",
      'src/broken.ts': 'export const x = (;\n',
    });
    repo.write('src/auth/session.ts', base['src/auth/session.ts'].replace('return { id };', 'return { id: id.trim() };'));
    repo.write('src/broken.ts', 'export const x = (;;\n');
    const r = await review(repo.root);
    expect(r.impact.predicted.find((e) => e.path === 'src/lazy.ts')?.why).toMatch(/cannot be narrowed/);
    expect(r.impact.unknown.find((e) => e.path === 'src/broken.ts')?.why).toMatch(/syntax errors/);
  });

  it('reports a non-repository folder as unknown rather than failing', async () => {
    const r = await review(path.parse(process.cwd()).root + 'nonexistent-pickle-dir');
    expect(r.impact.unknown[0].why).toMatch(/Not a Git repository/);
  });
});

describe('planned change preview', () => {
  it('predicts files from the description and their dependents without line-level claims about the change', async () => {
    repo = makeRepo(base);
    const r = await preview(repo.root, 'Add Google OAuth to the login flow');
    const likely = r.impact.confirmed.map((e) => e.path);
    expect(likely).toContain('src/auth/login.ts');
    expect(r.impact.confirmed.every((e) => e.level === 'predicted')).toBe(true);
    expect(likely).not.toContain('src/pages/Settings.tsx');
    expect(r.limitations.join(' ')).toMatch(/prediction/);
  });

  it('says so when nothing matches instead of inventing files', async () => {
    repo = makeRepo(base);
    const r = await preview(repo.root, 'Rewrite the billing reconciliation pipeline in Rust');
    expect(r.impact.confirmed).toEqual([]);
    expect(r.impact.unknown[0].why).toMatch(/No file matches|strongly/);
  });
});

describe('diff parsing', () => {
  it('parses hunks, renames, deletions and keeps header lines out of content', () => {
    const files = parsePatch(
      [
        'diff --git a/a.ts b/a.ts',
        'index 1..2 100644',
        '--- a/a.ts',
        '+++ b/a.ts',
        '@@ -3 +3,2 @@',
        '--- not a header, a removed line',
        '+one',
        '+two',
        'diff --git a/old.ts b/new.ts',
        'similarity index 100%',
        'rename from old.ts',
        'rename to new.ts',
        'diff --git a/gone.ts b/gone.ts',
        'deleted file mode 100644',
        '--- a/gone.ts',
        '+++ /dev/null',
        '@@ -1,2 +0,0 @@',
        '-x',
        '-y',
      ].join('\n'),
    );
    expect(files[0]).toMatchObject({ path: 'a.ts', ranges: [[3, 4]], removed: [{ line: 3, text: '-- not a header, a removed line' }] });
    expect(files[0].added.map((a) => a.line)).toEqual([3, 4]);
    expect(files[1]).toMatchObject({ path: 'new.ts', oldPath: 'old.ts', status: 'renamed' });
    expect(files[2]).toMatchObject({ path: 'gone.ts', status: 'deleted' });
  });

  it('summarizes changed declarations including default exports and leading comments', () => {
    const text = '/** doc */\nexport default function Page() {\n  return 1;\n}\nexport const a = 1;\n';
    const s = summarizeChange({ path: 'x.ts', status: 'modified', ranges: [[1, 1]], added: [], removed: [] }, text, text);
    expect([...s.changed]).toEqual(['default']);
    expect(s.fileLevel).toBe(false);
  });
});
