import { execFileSync, spawnSync } from 'node:child_process';
import { cpSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import { applyFixes } from '../extension/core/design.js';
import type { Report } from '../extension/core/pickle.js';
import { makeRepo } from './helpers/repo.js';

const ROOT = path.resolve(__dirname, '..');
const CLI = path.join(ROOT, 'dist-ext', 'cli.cjs');
const cli = (args: string[], input?: string) => {
  const r = spawnSync(process.execPath, [CLI, ...args], { input, encoding: 'utf8', timeout: 60_000 });
  return { code: r.status, out: r.stdout, err: r.stderr };
};
const json = (args: string[]) => JSON.parse(cli([...args, '--json']).out) as Report;

const repos: (() => void)[] = [];
afterAll(() => repos.forEach((f) => f()));

describe('pickle CLI and agent hooks', () => {
  const files = {
    'src/a.ts': 'export const answer = () => 42;\nexport const other = 1;\n',
    'src/b.ts': "import { answer } from './a';\nexport const twice = () => answer() * 2;\n",
  };

  it('stays silent on short or slash-command prompts and injects a fenced preview otherwise', () => {
    const repo = makeRepo(files);
    repos.push(repo.cleanup);
    expect(cli(['preview', '--hook', 'claude-prompt'], JSON.stringify({ prompt: '/clear', cwd: repo.root })).out).toBe('');
    expect(cli(['preview', '--hook', 'claude-prompt'], JSON.stringify({ prompt: 'hi', cwd: repo.root })).out).toBe('');
    const out = cli(['preview', '--hook', 'claude-prompt'], JSON.stringify({ prompt: 'Change how answer is computed in src/a.ts', cwd: repo.root })).out;
    expect(out).toMatch(/^PICKLE IMPACT PREVIEW/);
    expect(out).toContain('src/b.ts');
  });

  it('Stop hook: no-op when re-entered, advisory JSON otherwise', () => {
    const repo = makeRepo(files);
    repos.push(repo.cleanup);
    repo.write('src/a.ts', files['src/a.ts'].replace('42', '43'));
    expect(cli(['review', '--hook', 'claude-stop'], JSON.stringify({ cwd: repo.root, stop_hook_active: true })).out).toBe('');
    const out = JSON.parse(cli(['review', '--hook', 'claude-stop'], JSON.stringify({ cwd: repo.root })).out);
    expect(out.systemMessage).toMatch(/^Pickle: 1 affected file/);
    expect(out.decision).toBeUndefined();
  });

  it('only fails a commit when explicitly asked and a confirmed high-severity finding exists', () => {
    const repo = makeRepo(files);
    repos.push(repo.cleanup);
    repo.write('src/a.ts', 'export const renamed = () => 42;\nexport const other = 1;\n');
    repo.git('add', '-A');
    expect(cli(['review', '--staged', '--hook', 'git', '--root', repo.root]).code).toBe(0);
    const blocked = cli(['review', '--staged', '--hook', 'git', '--fail-on-high', '--root', repo.root]);
    expect(blocked.code).toBe(1);
    expect(blocked.out).toContain('no longer exported');
  });

  it('never blocks when the analyzer itself fails', () => {
    expect(cli(['review', '--root', path.join(ROOT, 'does-not-exist')]).code).toBe(0);
  });
});

describe('end-to-end demo (checkout app)', () => {
  const dir = path.join(ROOT, '.demo-test', `checkout-${process.pid}`);
  repos.push(() => rmSync(dir, { recursive: true, force: true }));
  const git = (...args: string[]) => execFileSync('git', ['-c', 'user.name=t', '-c', 'user.email=t@example.invalid', ...args], { cwd: dir, stdio: 'pipe' });
  const npmTest = () => spawnSync('npm test', { cwd: dir, shell: true, encoding: 'utf8', timeout: 120_000 });

  it('runs all six stages with grounded results', () => {
    rmSync(dir, { recursive: true, force: true });
    mkdirSync(path.dirname(dir), { recursive: true });
    cpSync(path.join(ROOT, 'demo', 'checkout-app'), dir, { recursive: true });
    git('init', '-q', '-b', 'main');
    git('add', '-A');
    git('commit', '-q', '-m', 'baseline');

    // Stage 1–2: proposed change -> predicted files and the requirement behind them.
    const plan = json(['preview', '--root', dir, 'Redesign the checkout button and update its submission behavior']);
    expect(plan.impact.confirmed.map((e) => e.path)).toContain('src/checkout/CheckoutButton.tsx');
    const req = plan.context.find((c) => c.title.includes('REQ-CHK-1'))!;
    expect(req).toMatchObject({ status: 'requirement', ref: { path: 'docs/requirements/checkout.md', line: 3 } });
    expect(plan.context.find((c) => c.id === 'fixture:57')).toBeUndefined();

    // Stage 3: the agent's change.
    cpSync(path.join(ROOT, 'demo', 'agent-change'), dir, { recursive: true });
    const r = json(['review', '--root', dir]);
    expect(r.changed.map((c) => c.path)).toEqual(['src/checkout/CheckoutButton.tsx']);
    expect(r.impact.confirmed.map((e) => `${e.path}:${e.line}`)).toEqual(['src/checkout/CheckoutPage.tsx:2', 'src/checkout/index.ts:1']);
    expect(r.impact.predicted.find((e) => e.path === 'src/App.tsx')?.lines).toEqual([17]);
    expect(readFileSync(path.join(dir, 'src/App.tsx'), 'utf8').split('\n')[16]).toContain('<CheckoutPage');

    // Stage 4: design drift with a deterministic fix.
    expect(r.design).toHaveLength(1);
    expect(r.design[0]).toMatchObject({ expected: '#2563eb', actual: ['#2a6bf0'], locations: [{ path: 'src/checkout/CheckoutButton.tsx', line: 11 }] });

    // Stage 5: the requirement conflict is reported with evidence.
    const high = r.risks.filter((x) => x.level === 'high');
    expect(high).toHaveLength(1);
    expect(high[0].text).toContain('disabled={submitting}');
    expect(high[0].text).toContain('REQ-CHK-1');
    expect(r.verify.command).toBe('npm test -- tests/CheckoutButton.test.tsx');

    // Stage 6: verification fails on the agent's change...
    expect(npmTest().stdout).toMatch(/1 failed/);

    // ...the developer approves the design fix and restores the guard...
    const button = path.join(dir, 'src/checkout/CheckoutButton.tsx');
    const fixed = applyFixes(readFileSync(button, 'utf8'), r.design[0].fixes);
    expect(fixed.applied).toHaveLength(1);
    writeFileSync(button, fixed.text.replace('      aria-busy={submitting}', '      disabled={submitting}\n      aria-busy={submitting}'));

    // ...and the final review is clean while tests pass.
    const after = json(['review', '--root', dir]);
    expect(after.design).toEqual([]);
    expect(after.risks.filter((x) => x.level === 'high')).toEqual([]);
    const tests = npmTest();
    expect(tests.status).toBe(0);
    expect(tests.stdout).toMatch(/4 passed/);
  }, 180_000);
});
