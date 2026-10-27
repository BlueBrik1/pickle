// Launches VS Code as an Extension Development Host on a fresh copy of the demo, then runs suite.cjs.
// Uses the installed VS Code (override with VSCODE_EXECUTABLE) and a throwaway profile.
import { execFileSync, spawn } from 'node:child_process';
import { cpSync, existsSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const work = path.join(root, '.demo-test', `vscode-${process.pid}`);
const ws = path.join(work, 'checkout-app');

function vscodeExecutable() {
  if (process.env.VSCODE_EXECUTABLE) return process.env.VSCODE_EXECUTABLE;
  const which = execFileSync(process.platform === 'win32' ? 'where' : 'which', ['code'], { encoding: 'utf8' }).split(/\r?\n/)[0].trim();
  const install = path.resolve(path.dirname(which), '..');
  for (const exe of ['Code.exe', 'code', 'Electron', '../MacOS/Electron']) if (existsSync(path.join(install, exe))) return path.join(install, exe);
  throw new Error('Set VSCODE_EXECUTABLE to the VS Code binary.');
}

rmSync(work, { recursive: true, force: true });
mkdirSync(work, { recursive: true });
cpSync(path.join(root, 'demo', 'checkout-app'), ws, { recursive: true });
// Test settings are part of the baseline commit so they are not an uncommitted change.
writeFileSync(
  path.join(ws, '.vscode', 'settings.json'),
  JSON.stringify({ 'pickle.context.fixtureFile': '.pickle/fixtures/github-issues.json', 'pickle.autoAnalyzeDelayMs': 500 }, null, 2),
);

const git = (...args) => execFileSync('git', ['-c', 'user.name=t', '-c', 'user.email=t@example.invalid', ...args], { cwd: ws, stdio: 'pipe' });
git('init', '-q', '-b', 'main');
git('add', '-A');
git('commit', '-q', '-m', 'baseline');
cpSync(path.join(root, 'demo', 'agent-change'), ws, { recursive: true });
// Variables inherited from a running VS Code would hand the launch to that instance instead.
const env = Object.fromEntries(Object.entries(process.env).filter(([k]) => !/^(VSCODE_|ELECTRON_RUN_AS_NODE)/.test(k)));
const child = spawn(
  vscodeExecutable(),
  [
    ws,
    `--extensionDevelopmentPath=${root}`,
    `--extensionTestsPath=${path.join(root, 'tests', 'vscode', 'suite.cjs')}`,
    `--user-data-dir=${path.join(work, 'user')}`,
    `--extensions-dir=${path.join(work, 'extensions')}`,
    '--disable-extensions',
    '--disable-workspace-trust',
    '--skip-welcome',
    '--skip-release-notes',
    '--disable-gpu',
  ],
  { env, stdio: 'inherit' },
);
child.on('exit', (code) => {
  rmSync(work, { recursive: true, force: true });
  console.log(`VS Code integration tests ${code === 0 ? 'passed' : `failed (exit ${code})`}.`);
  process.exit(code ?? 1);
});
