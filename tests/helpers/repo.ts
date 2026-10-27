import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

/** A throwaway Git repository with `files` committed as HEAD. */
export function makeRepo(files: Record<string, string>) {
  const root = mkdtempSync(path.join(os.tmpdir(), 'pickle-test-'));
  const git = (...args: string[]) =>
    execFileSync('git', ['-c', 'user.name=t', '-c', 'user.email=t@example.invalid', ...args], { cwd: root, stdio: 'pipe' }).toString();
  const write = (rel: string, content: string) => {
    mkdirSync(path.dirname(path.join(root, rel)), { recursive: true });
    writeFileSync(path.join(root, rel), content);
  };
  for (const [rel, content] of Object.entries(files)) write(rel, content);
  git('init', '-q', '-b', 'main');
  git('add', '-A');
  git('commit', '-q', '-m', 'baseline');
  return {
    root,
    git,
    write,
    remove: (rel: string) => rmSync(path.join(root, rel)),
    cleanup: () => rmSync(root, { recursive: true, force: true }),
  };
}
