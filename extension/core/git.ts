import { execFile } from 'node:child_process';

/** Neutralize repository-configured programs: git reads `.git/config`, which an untrusted repo controls. */
const HARDEN = ['-c', 'core.fsmonitor=false', '-c', 'core.quotePath=false'];
const EMPTY_TREE = '4b825dc642cb6eb9a060e54bf8d69288fbee4904';

export function git(cwd: string, args: string[]): Promise<string> {
  return new Promise((resolve, reject) =>
    execFile(
      'git',
      [...HARDEN, ...args],
      { cwd, maxBuffer: 64 * 1024 * 1024, windowsHide: true, timeout: 30_000 },
      (error, stdout) => (error ? reject(error) : resolve(stdout)),
    ),
  );
}

export async function isRepo(cwd: string): Promise<boolean> {
  return git(cwd, ['rev-parse', '--is-inside-work-tree']).then(
    (out) => out.trim() === 'true',
    () => false,
  );
}

export interface ChangedFile {
  path: string;
  status: 'added' | 'modified' | 'deleted' | 'renamed';
  oldPath?: string;
  /** New-side line ranges [start, end], inclusive. A pure deletion is the boundary line. */
  ranges: [number, number][];
  added: { line: number; text: string }[];
  removed: { line: number; text: string }[];
}

/** Uncommitted (or staged) changes, with paths relative to `cwd` so a workspace may be a repo subfolder. */
export async function changedFiles(cwd: string, staged = false): Promise<ChangedFile[]> {
  const head = await git(cwd, ['rev-parse', '--verify', '-q', 'HEAD']).then(
    (s) => s.trim(),
    () => EMPTY_TREE,
  );
  const base = staged ? ['--cached', head] : [head];
  const common = ['--relative', '--no-ext-diff', '--no-textconv', '--no-color', '-M'];
  const patch = await git(cwd, ['diff', ...base, ...common, '-U0']);
  const files = parsePatch(patch);
  if (!staged) {
    const untracked = await git(cwd, ['ls-files', '--others', '--exclude-standard', '-z']);
    for (const path of untracked.split('\0').filter(Boolean))
      files.push({ path, status: 'added', ranges: [[1, Number.MAX_SAFE_INTEGER]], added: [], removed: [] });
  }
  return files;
}

export function parsePatch(patch: string): ChangedFile[] {
  const files: ChangedFile[] = [];
  let file: ChangedFile | undefined;
  let oldLine = 0,
    newLine = 0,
    inHunk = false;
  for (const line of patch.split('\n')) {
    if (line.startsWith('diff --git ')) {
      inHunk = false;
      const path = / b\/(.+)$/.exec(line)?.[1] ?? '';
      file = { path, status: 'modified', ranges: [], added: [], removed: [] };
      files.push(file);
    } else if (!file) continue;
    else if (inHunk && line.startsWith('+')) file.added.push({ line: newLine++, text: line.slice(1) });
    else if (inHunk && line.startsWith('-')) file.removed.push({ line: oldLine++, text: line.slice(1) });
    else if (inHunk && line.startsWith(' ')) {
      oldLine++;
      newLine++;
    } else if (line.startsWith('new file mode')) file.status = 'added';
    else if (line.startsWith('deleted file mode')) file.status = 'deleted';
    else if (line.startsWith('rename from ')) {
      file.status = 'renamed';
      file.oldPath = line.slice(12);
    } else if (line.startsWith('rename to ')) file.path = line.slice(10);
    else if (line.startsWith('+++ ') && line !== '+++ /dev/null') file.path = line.slice(6);
    else if (line.startsWith('@@')) {
      inHunk = true;
      const m = /^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@/.exec(line);
      if (!m) continue;
      oldLine = Number(m[1]);
      newLine = Number(m[3]);
      const count = m[4] === undefined ? 1 : Number(m[4]);
      file.ranges.push(count ? [newLine, newLine + count - 1] : [Math.max(newLine, 1), Math.max(newLine, 1)]);
    }
  }
  return files.filter((f) => f.path);
}

export async function showHead(cwd: string, path: string): Promise<string | undefined> {
  return git(cwd, ['show', `HEAD:./${path}`]).catch(() => undefined);
}

export interface Commit {
  sha: string;
  date: string;
  author: string;
  subject: string;
  body: string;
  files: string[];
}

export async function log(cwd: string, paths: string[], limit = 40): Promise<Commit[]> {
  if (!paths.length) return [];
  const out = await git(cwd, [
    'log',
    `-n${limit}`,
    '--no-color',
    '--name-only',
    '--relative',
    '--format=%x1e%H%x1f%aI%x1f%an%x1f%s%x1f%b%x1f',
    '--',
    ...paths.slice(0, 200),
  ]).catch(() => '');
  return out
    .split('\x1e')
    .filter((r) => r.trim())
    .map((record) => {
      const [sha, date, author, subject, body, names] = record.split('\x1f');
      return {
        sha,
        date,
        author,
        subject,
        body: body.trim(),
        files: (names ?? '').split('\n').map((s) => s.trim()).filter(Boolean),
      };
    });
}

/** `owner/name` of a GitHub origin remote, or undefined. */
export async function githubRepo(cwd: string): Promise<string | undefined> {
  const url = (await git(cwd, ['config', '--get', 'remote.origin.url']).catch(() => '')).trim();
  return /github\.com[:/]([\w.-]+\/[\w.-]+?)(?:\.git)?\/?$/.exec(url)?.[1];
}
