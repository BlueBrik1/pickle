import { existsSync } from 'node:fs';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { Worker } from 'node:worker_threads';
import * as vscode from 'vscode';
import type { ContextItem } from '../core/context.js';
import { applyFixes, type DesignFinding, type DesignResult } from '../core/design.js';
import { git, githubRepo, isRepo } from '../core/git.js';
import type { Options, Report } from '../core/pickle.js';
import { counts, renderMarkdown } from '../core/render.js';
import type { Request } from './worker.js';

type Node = vscode.TreeItem & { children?: Node[] };

let report: Report | undefined;
let verifyState: 'not-run' | 'running' | 'passed' | 'failed' = 'not-run';
let lastFix: { uri: vscode.Uri; edits: { line: number; before: string; after: string }[] } | undefined;
const proposed = new Map<string, string>();
const changed = new vscode.EventEmitter<void>();
let diagnostics: vscode.DiagnosticCollection;
let status: vscode.StatusBarItem;
let output: vscode.OutputChannel;
let ctx: vscode.ExtensionContext;

const cfg = () => vscode.workspace.getConfiguration('pickle');

// One long-lived worker: indexing never blocks the extension host and its cache survives between runs.
let worker: Worker | undefined;
const pending = new Map<number, { resolve: (v: any) => void; reject: (e: Error) => void }>();
let nextId = 0;
function analysis<T>(op: Request['op'], root: string, opts: Options, task?: string): Promise<T> {
  if (!worker) {
    const w = new Worker(path.join(ctx.extensionPath, 'dist-ext', 'worker.cjs'));
    w.on('message', ({ id, result, error }) => {
      const p = pending.get(id);
      pending.delete(id);
      if (error) p?.reject(new Error(error));
      else p?.resolve(result);
    });
    const fail = (e: unknown) => {
      for (const p of pending.values()) p.reject(e instanceof Error ? e : new Error(`Analysis worker stopped (${e})`));
      pending.clear();
      worker = undefined;
    };
    w.on('error', fail);
    w.on('exit', fail);
    worker = w;
  }
  const id = nextId++;
  return new Promise<T>((resolve, reject) => {
    pending.set(id, { resolve, reject });
    worker!.postMessage({ id, op, root, task, opts } satisfies Request);
  });
}
const rootFolder = () => {
  const active = vscode.window.activeTextEditor?.document.uri;
  return (active && vscode.workspace.getWorkspaceFolder(active)) ?? vscode.workspace.workspaceFolders?.[0];
};
const cliPath = () => path.join(ctx.extensionPath, 'dist-ext', 'cli.cjs').replaceAll('\\', '/');
const abs = (root: string, p: string) => (path.isAbsolute(p) ? p : path.join(root, p));

async function options(root: string, interactive: boolean): Promise<Options> {
  const c = cfg();
  const trusted = vscode.workspace.isTrusted;
  let github: { repo: string; token: string } | undefined;
  if (c.get('context.github') && trusted) {
    const session = await vscode.authentication.getSession('github', ['repo'], { silent: !interactive }).then(undefined, () => undefined);
    const repo = await githubRepo(root);
    if (session && repo) github = { repo, token: session.accessToken };
  }
  const slackToken = await ctx.secrets.get('pickle.slackToken');
  const channels = c.get<string[]>('context.slackChannels', []);
  return {
    tokensFile: c.get<string>('design.tokensFile') || undefined,
    maxFiles: c.get<number>('maxFiles', 5000),
    context: {
      git: trusted,
      github,
      slack: slackToken && channels.length ? { token: slackToken, channels } : undefined,
      claudeCode: c.get<boolean>('context.claudeCode', false),
      codex: c.get<boolean>('context.codex', false),
      fixtureFile: c.get<string>('context.fixtureFile') || undefined,
    },
  };
}

// ---- Tree ------------------------------------------------------------------------------------

const openCmd = (root: string, p: string, line?: number): vscode.Command => ({
  title: 'Open',
  command: 'pickle.open',
  arguments: [abs(root, p), line],
});
function leaf(label: string, opts: Partial<Node> & { icon?: string } = {}): Node {
  const { icon, ...rest } = opts;
  const item: Node = new vscode.TreeItem(label, vscode.TreeItemCollapsibleState.None);
  if (icon) item.iconPath = new vscode.ThemeIcon(icon);
  return Object.assign(item, rest);
}
function group(label: string, children: Node[], description?: string, icon?: string, expanded = true): Node {
  const item: Node = new vscode.TreeItem(label, children.length ? (expanded ? vscode.TreeItemCollapsibleState.Expanded : vscode.TreeItemCollapsibleState.Collapsed) : vscode.TreeItemCollapsibleState.None);
  item.children = children;
  item.description = description;
  if (icon) item.iconPath = new vscode.ThemeIcon(icon);
  return item;
}
const STATUS_ICON: Record<ContextItem['status'], string> = {
  requirement: 'law',
  decision: 'pass',
  superseded: 'history',
  discussion: 'comment-discussion',
  'ai-suggestion': 'sparkle',
  history: 'git-commit',
};

function tree(r: Report): Node[] {
  const preview = r.mode === 'preview';
  const loc = (p: string, line?: number) => (line ? `${p}:${line}` : p);
  const impact = (e: Report['impact']['confirmed'][number], icon: string) =>
    leaf(loc(e.path, e.line), {
      icon,
      description: e.feature ?? e.symbols?.join(', '),
      tooltip: new vscode.MarkdownString(`${e.why}${e.lines?.length ? `\n\nUsed at lines ${e.lines.join(', ')}` : ''}`),
      command: e.path ? openCmd(r.root, e.path, e.line) : undefined,
    });
  const confirmed = r.impact.confirmed.map((e) => impact(e, preview ? 'circle-filled' : 'references'));
  const predicted = r.impact.predicted.map((e) => impact(e, 'circle-outline'));
  const unknown = r.impact.unknown.map((e) => leaf(e.path || 'Analysis', { icon: 'question', description: e.why, tooltip: e.why, command: e.path ? openCmd(r.root, e.path) : undefined }));
  const c = counts(r);
  return [
    group(
      'Change',
      preview
        ? [leaf(r.title, { icon: 'lightbulb', tooltip: r.title })]
        : r.changed.map((f) =>
            leaf(f.path, {
              icon: f.status === 'added' ? 'diff-added' : f.status === 'deleted' ? 'diff-removed' : f.status === 'renamed' ? 'diff-renamed' : 'diff-modified',
              description: f.symbols.map((s) => s.name).join(', ') || f.status,
              command: f.status === 'deleted' ? undefined : openCmd(r.root, f.path, f.ranges[0]?.[0]),
            }),
          ),
      preview ? 'planned' : `${r.changed.length} file(s)`,
      'git-compare',
      false,
    ),
    group(
      'Impact',
      [
        group(preview ? 'Likely affected' : 'Confirmed', confirmed, `${confirmed.length}`),
        group(preview ? 'Potentially affected' : 'Predicted', predicted, `${predicted.length}${r.impact.omitted ? ` +${r.impact.omitted}` : ''}`),
        ...(unknown.length ? [group('Unknown', unknown, `${unknown.length}`, undefined, false)] : []),
        ...(r.impact.excluded.length
          ? [group('Not affected', r.impact.excluded.map((p) => leaf(p, { icon: 'circle-slash', description: 'uses only unchanged exports', command: openCmd(r.root, p) })), `${r.impact.excluded.length}`, undefined, false)]
          : []),
      ],
      `${c.impact}`,
      'type-hierarchy',
    ),
    group(
      'Context',
      r.context.map((item) =>
        leaf(item.title, {
          icon: STATUS_ICON[item.status],
          description: item.status,
          tooltip: new vscode.MarkdownString(`**${item.status}** · ${item.source}\n\n${item.excerpt}\n\n*Why: ${item.why}*${item.note ? `\n\n${item.note}` : ''}`),
          command: item.url ? { title: 'Open source', command: 'vscode.open', arguments: [vscode.Uri.parse(item.url)] } : item.ref ? openCmd(r.root, item.ref.path, item.ref.line) : undefined,
        }),
      ),
      `${c.context}`,
      'book',
    ),
    group(
      'Design',
      r.design.map((d) =>
        leaf(d.message, {
          icon: d.fixes.length ? 'symbol-color' : 'warning',
          description: loc(d.locations[0]?.path ?? '', d.locations[0]?.line),
          tooltip: new vscode.MarkdownString(`${d.message}${d.note ? `\n\n${d.note}` : ''}${d.fixes.length ? '\n\nFix available: **Pickle: Review Suggested Fixes**' : ''}`),
          contextValue: d.fixes.length ? 'fixable' : undefined,
          command: d.locations[0] ? openCmd(r.root, d.locations[0].path, d.locations[0].line) : undefined,
        }),
      ),
      preview ? `${c.design}` : `${c.design} new${r.designPreexisting ? `, ${r.designPreexisting} existing` : ''}`,
      'paintcan',
    ),
    group(
      'Risk',
      r.risks.map((x) =>
        leaf(x.text, {
          icon: x.level === 'high' ? 'error' : x.level === 'medium' ? 'warning' : 'info',
          description: `${x.level} · ${x.basis}`,
          tooltip: x.text,
          command: x.refs[0]?.path ? openCmd(r.root, x.refs[0].path, x.refs[0].line) : undefined,
        }),
      ),
      `${c.high} high`,
      'shield',
    ),
    group(
      'Verify',
      [
        leaf(r.verify.command ?? r.verify.reason, {
          icon: verifyState === 'passed' ? 'pass-filled' : verifyState === 'failed' ? 'error' : verifyState === 'running' ? 'loading~spin' : 'play',
          description: verifyState === 'not-run' ? 'click to run' : verifyState,
          tooltip: r.verify.reason,
          command: r.verify.command ? { title: 'Run', command: 'pickle.runVerification' } : undefined,
        }),
        ...r.verify.tests.map((t) => leaf(t, { icon: 'beaker', command: openCmd(r.root, t) })),
      ],
      verifyState,
      'checklist',
    ),
  ];
}

const provider: vscode.TreeDataProvider<Node> = {
  onDidChangeTreeData: changed.event,
  getTreeItem: (n) => n,
  getChildren: (n) => (n ? (n.children ?? []) : report ? tree(report) : []),
};

// ---- Rendering a report into the editor ----------------------------------------------------------

function show(r: Report) {
  report = r;
  verifyState = 'not-run';
  changed.fire();
  diagnostics.clear();
  const byFile = new Map<string, vscode.Diagnostic[]>();
  const add = (p: string, line: number | undefined, message: string, severity: vscode.DiagnosticSeverity) => {
    if (!p || !line) return;
    const file = abs(r.root, p);
    const d = new vscode.Diagnostic(new vscode.Range(line - 1, 0, line - 1, Number.MAX_SAFE_INTEGER), message, severity);
    d.source = 'Pickle';
    byFile.set(file, [...(byFile.get(file) ?? []), d]);
  };
  for (const d of r.design)
    for (const l of d.locations.slice(0, 5)) add(l.path, l.line, `Design: ${d.message}${d.note ? ` ${d.note}` : ''}`, vscode.DiagnosticSeverity.Warning);
  if (r.mode === 'review') {
    for (const e of r.impact.confirmed.slice(0, 20)) add(e.path, e.line, `Impact: ${e.why}`, vscode.DiagnosticSeverity.Information);
    for (const x of r.risks.filter((x) => x.level === 'high')) add(x.refs[0]?.path ?? '', x.refs[0]?.line, `Risk: ${x.text}`, vscode.DiagnosticSeverity.Warning);
  }
  for (const [file, list] of byFile) diagnostics.set(vscode.Uri.file(file), list);
  const c = counts(r);
  status.text = `$(target) ${c.impact}${c.design ? ` $(paintcan) ${c.design}` : ''}${c.high ? ` $(warning) ${c.high}` : ''}`;
  status.tooltip = `Pickle: ${c.impact} affected, ${c.context} context, ${c.design} design, ${c.high} high risk`;
  status.show();
  output.appendLine(`[${new Date().toLocaleTimeString()}] ${r.mode} — ${JSON.stringify(r.timings)}`);
}

let running = Promise.resolve();
function run<T>(title: string, task: () => Promise<T>, silent = false): Promise<T | undefined> {
  const next = running.then(async () => {
    try {
      return silent ? await task() : await vscode.window.withProgress({ location: { viewId: 'pickle.report' }, title }, task);
    } catch (e: any) {
      output.appendLine(`Error: ${e?.stack ?? e}`);
      if (!silent) vscode.window.showErrorMessage(`Pickle: ${e?.message ?? e}`);
      return undefined;
    }
  });
  running = next.then(() => undefined);
  return next;
}

async function analyzeChanges(staged = false, silent = false) {
  const folder = rootFolder();
  if (!folder) return vscode.window.showWarningMessage('Pickle: open a folder first.');
  if (!vscode.workspace.isTrusted) {
    if (!silent) vscode.window.showWarningMessage('Pickle reads Git only in trusted workspaces. Preview Planned Change works without trust.');
    return;
  }
  const r = await run(staged ? 'Reviewing staged changes' : 'Analyzing changes', async () =>
    analysis<Report>('review', folder.uri.fsPath, { ...(await options(folder.uri.fsPath, !silent)), staged, task: ctx.workspaceState.get('pickle.lastTask') }),
  silent);
  if (!r) return;
  // Automatic runs never replace a plan preview with an empty review.
  if (silent && !r.changed.length && report?.mode === 'preview') return;
  show(r);
  if (!silent) vscode.commands.executeCommand('pickle.report.focus');
}

async function previewChange(task?: string) {
  const folder = rootFolder();
  if (!folder) return vscode.window.showWarningMessage('Pickle: open a folder first.');
  task ??= await vscode.window.showInputBox({
    title: 'Pickle: Preview Planned Change',
    prompt: 'Describe the change you or an agent are about to make',
    value: ctx.workspaceState.get<string>('pickle.lastTask'),
    placeHolder: 'e.g. Add Google sign-in to the login page',
    ignoreFocusOut: true,
  });
  if (!task?.trim()) return;
  await ctx.workspaceState.update('pickle.lastTask', task);
  const r = await run('Previewing impact', async () => analysis<Report>('preview', folder.uri.fsPath, await options(folder.uri.fsPath, true), task));
  if (r) {
    show(r);
    vscode.commands.executeCommand('pickle.report.focus');
  }
}

async function showImpact() {
  if (!report) await analyzeChanges();
  if (!report) return;
  const doc = await vscode.workspace.openTextDocument({ language: 'markdown', content: renderMarkdown(report) });
  await vscode.commands.executeCommand('markdown.showPreview', doc.uri);
}

async function showContext() {
  if (!report) return vscode.window.showInformationMessage('Pickle: run an analysis or preview first.');
  if (!report.context.length) return vscode.window.showInformationMessage(`Pickle: no relevant context. Sources: ${report.sources.map((s) => `${s.name} (${s.state})`).join(', ')}`);
  const pick = await vscode.window.showQuickPick(
    report.context.map((c) => ({ label: `$(${STATUS_ICON[c.status]}) ${c.title}`, description: c.status, detail: `${c.excerpt} — why: ${c.why}`, item: c })),
    { title: 'Pickle: Relevant Context', matchOnDetail: true },
  );
  if (pick?.item.url) vscode.env.openExternal(vscode.Uri.parse(pick.item.url));
  else if (pick?.item.ref) vscode.commands.executeCommand('pickle.open', abs(report.root, pick.item.ref.path), pick.item.ref.line);
}

async function scanDrift() {
  const folder = rootFolder();
  if (!folder) return;
  const opts = await options(folder.uri.fsPath, false);
  const result = await run('Scanning design drift', () => analysis<DesignResult>('design', folder.uri.fsPath, opts));
  if (!result) return;
  const base: Report =
    report && report.root === folder.uri.fsPath ? report : await analysis<Report>('preview', folder.uri.fsPath, opts, 'Design drift scan of the whole workspace');
  show({ ...base, design: result.findings, designPreexisting: 0, designBaseline: result.baseline });
  vscode.window.showInformationMessage(`Pickle: ${result.findings.length} design finding(s), baseline ${result.baseline.mode}${result.baseline.file ? ` (${result.baseline.file})` : ''}.`);
}

// ---- Design fixes: preview, explicit approval, apply only unchanged lines, reversible ------------

async function reviewFixes(finding?: DesignFinding | Node) {
  if (!report) return vscode.window.showInformationMessage('Pickle: run an analysis or design scan first.');
  const fixable = report.design.filter((d) => d.fixes.length);
  if (!fixable.length) return vscode.window.showInformationMessage('Pickle: no deterministic fixes available.');
  let chosen = fixable.find((d) => finding && 'message' in finding && d.id === finding.id) ?? fixable.find((d) => finding && 'label' in finding && d.message === finding.label);
  if (!chosen) {
    const pick = await vscode.window.showQuickPick(
      fixable.map((d) => ({ label: d.message, description: `${d.fixes.length} edit(s)`, detail: d.note, d })),
      { title: 'Pickle: Review Suggested Fixes' },
    );
    chosen = pick?.d;
  }
  if (!chosen) return;
  const root = report.root;
  for (const file of [...new Set(chosen.fixes.map((f) => f.path))]) {
    const uri = vscode.Uri.file(abs(root, file));
    const doc = await vscode.workspace.openTextDocument(uri);
    const fixes = chosen.fixes.filter((f) => f.path === file);
    const result = applyFixes(doc.getText(), fixes);
    if (!result.applied.length) {
      vscode.window.showWarningMessage(`Pickle: ${file} changed since the scan; re-run the analysis before fixing.`);
      continue;
    }
    const key = `${uri.toString()}#${Date.now()}`;
    proposed.set(key, result.text);
    const proposal = vscode.Uri.from({ scheme: 'pickle-fix', path: uri.path, query: encodeURIComponent(key) });
    await vscode.commands.executeCommand('vscode.diff', uri, proposal, `Pickle fix: ${path.basename(file)} (current ↔ proposed)`);
    const answer = await vscode.window.showInformationMessage(
      `Apply ${result.applied.length} design fix(es) to ${file}?`,
      { modal: true, detail: `${chosen.message}\n\n${result.applied.map((f) => `Line ${f.line}:\n- ${f.before.trim()}\n+ ${f.after.trim()}`).join('\n\n')}${result.stale.length ? `\n\n${result.stale.length} stale edit(s) will be skipped.` : ''}\n\nOnly these lines change. You can undo with Pickle: Revert Last Fix.` },
      'Apply',
    );
    proposed.delete(key);
    await vscode.commands.executeCommand('workbench.action.closeActiveEditor');
    if (answer !== 'Apply') continue;
    const wasDirty = doc.isDirty;
    const edit = new vscode.WorkspaceEdit();
    for (const f of result.applied) edit.replace(uri, doc.lineAt(f.line - 1).range, f.after);
    if (!(await vscode.workspace.applyEdit(edit))) continue;
    // Keep the user's unsaved state as it was: save only when the buffer was clean before the fix.
    if (!wasDirty) await doc.save();
    lastFix = { uri, edits: result.applied };
    vscode.window.showInformationMessage(`Pickle: applied ${result.applied.length} fix(es) to ${file}.`);
  }
}

async function revertFix() {
  if (!lastFix) return vscode.window.showInformationMessage('Pickle: no fix to revert in this session.');
  const doc = await vscode.workspace.openTextDocument(lastFix.uri);
  const wasDirty = doc.isDirty;
  const edit = new vscode.WorkspaceEdit();
  let n = 0;
  for (const e of lastFix.edits)
    if (doc.lineAt(e.line - 1).text === e.after) {
      edit.replace(lastFix.uri, doc.lineAt(e.line - 1).range, e.before);
      n++;
    }
  if (!n) return vscode.window.showWarningMessage('Pickle: the fixed lines were edited since; nothing reverted.');
  await vscode.workspace.applyEdit(edit);
  if (!wasDirty) await doc.save();
  lastFix = undefined;
  vscode.window.showInformationMessage(`Pickle: reverted ${n} line(s).`);
}

// ---- Verification (runs the project's own test script only after explicit approval) --------------

async function runVerification() {
  const folder = rootFolder();
  const command = report?.verify.command;
  if (!folder || !command) return;
  if (!vscode.workspace.isTrusted) return vscode.window.showWarningMessage('Pickle runs project commands only in trusted workspaces.');
  const ok = await vscode.window.showWarningMessage(`Run \`${command}\` in ${folder.name}?`, { modal: true, detail: report!.verify.reason }, 'Run');
  if (ok !== 'Run') return;
  const [bin, ...args] = command.split(' ');
  const task = new vscode.Task({ type: 'pickle' }, folder, 'Pickle verification', 'pickle', new vscode.ShellExecution(bin, args, { cwd: folder.uri.fsPath }));
  verifyState = 'running';
  changed.fire();
  const execution = await vscode.tasks.executeTask(task);
  const done = vscode.tasks.onDidEndTaskProcess((e) => {
    if (e.execution !== execution) return;
    done.dispose();
    verifyState = e.exitCode === 0 ? 'passed' : 'failed';
    changed.fire();
    vscode.window.showInformationMessage(`Pickle verification ${verifyState} (exit ${e.exitCode}).`);
  });
}

// ---- Integrations and hooks: explicit, previewed, reversible ---------------------------------------

async function configureIntegrations() {
  const folder = rootFolder();
  const c = cfg();
  const items: (vscode.QuickPickItem & { id: string })[] = [
    { id: 'github', label: '$(github) GitHub issues & PRs', description: c.get('context.github') ? 'enabled' : 'off', detail: 'Uses VS Code’s GitHub sign-in (repo scope) to read issues and PRs of this repository’s origin remote.' },
    { id: 'slack', label: '$(comment-discussion) Slack channels', description: c.get<string[]>('context.slackChannels', []).length ? 'enabled' : 'off', detail: 'Reads recent messages from channel IDs you list, using a token kept in VS Code secret storage.' },
    { id: 'claude', label: '$(hubot) Claude Code sessions', description: c.get('context.claudeCode') ? 'enabled' : 'off', detail: 'Reads local transcripts in ~/.claude/projects for this folder only.' },
    { id: 'codex', label: '$(hubot) Codex sessions', description: c.get('context.codex') ? 'enabled' : 'off', detail: 'Reads local rollouts in ~/.codex/sessions whose working directory is this folder.' },
    { id: 'hooks', label: '$(plug) Install Claude Code hooks…', detail: 'Preview before prompts and an advisory review when Claude stops. Shows the exact change first.' },
    { id: 'precommit', label: '$(git-commit) Install Git pre-commit check…', detail: 'Advisory by default. Shows the hook file first; never overwrites an existing hook.' },
  ];
  const pick = await vscode.window.showQuickPick(items, { title: 'Pickle: Configure Integrations', placeHolder: 'Local analysis works without any of these.' });
  if (!pick || !folder) return;
  const target = vscode.ConfigurationTarget.Workspace;
  if (pick.id === 'github') {
    if (c.get('context.github')) return c.update('context.github', false, target);
    const session = await vscode.authentication.getSession('github', ['repo'], { createIfNone: true }).then(undefined, () => undefined);
    if (!session) return;
    const repo = await githubRepo(folder.uri.fsPath);
    await c.update('context.github', true, target);
    vscode.window.showInformationMessage(repo ? `Pickle: GitHub connected for ${repo}.` : 'Pickle: GitHub signed in, but this folder has no GitHub origin remote.');
  } else if (pick.id === 'slack') {
    if (c.get<string[]>('context.slackChannels', []).length) {
      await ctx.secrets.delete('pickle.slackToken');
      return c.update('context.slackChannels', [], target);
    }
    const token = await vscode.window.showInputBox({ title: 'Slack token (stored in VS Code secret storage)', prompt: 'A bot or user token with channels:history for the channels below', password: true, ignoreFocusOut: true });
    if (!token) return;
    const channels = await vscode.window.showInputBox({ title: 'Slack channel IDs', prompt: 'Comma-separated channel IDs, e.g. C01234567', ignoreFocusOut: true });
    if (!channels) return;
    await ctx.secrets.store('pickle.slackToken', token.trim());
    await c.update('context.slackChannels', channels.split(',').map((s) => s.trim()).filter(Boolean), target);
  } else if (pick.id === 'claude') await c.update('context.claudeCode', !c.get('context.claudeCode'), target);
  else if (pick.id === 'codex') await c.update('context.codex', !c.get('context.codex'), target);
  else if (pick.id === 'hooks') await installClaudeHooks(folder.uri.fsPath);
  else if (pick.id === 'precommit') await installPreCommit(folder.uri.fsPath);
}

const MARK = 'pickle-cli';
async function installClaudeHooks(root: string) {
  const file = path.join(root, '.claude', 'settings.local.json');
  const node = `node "${cliPath()}"`;
  const hooks = {
    UserPromptSubmit: [{ hooks: [{ type: 'command', command: `${node} preview --hook claude-prompt # ${MARK}`, timeout: 30 }] }],
    Stop: [{ hooks: [{ type: 'command', command: `${node} review --hook claude-stop # ${MARK}`, timeout: 60 }] }],
  };
  let settings: any = {};
  try {
    settings = JSON.parse(await readFile(file, 'utf8'));
  } catch (e: any) {
    if (e.code !== 'ENOENT') return vscode.window.showErrorMessage(`Pickle: ${file} is not valid JSON; not changed.`);
  }
  const answer = await vscode.window.showWarningMessage(
    `Add Pickle hooks to ${path.relative(root, file)}?`,
    { modal: true, detail: `UserPromptSubmit: Pickle previews the prompt's impact and adds it as context.\nStop: Pickle summarizes the diff review (advisory).\n\nAdds:\n${JSON.stringify(hooks, null, 2)}\n\nRemove the entries marked "${MARK}" to uninstall. Claude Code may ask you to review hook changes in /hooks.` },
    'Install',
  );
  if (answer !== 'Install') return;
  settings.hooks ??= {};
  for (const [event, entries] of Object.entries(hooks)) {
    const list: any[] = (settings.hooks[event] ?? []).filter((e: any) => !(e.hooks ?? []).some((h: any) => String(h.command).includes(MARK)));
    settings.hooks[event] = [...list, ...entries];
  }
  await mkdir(path.dirname(file), { recursive: true });
  await writeFile(file, JSON.stringify(settings, null, 2) + '\n');
  vscode.window.showInformationMessage(`Pickle: Claude Code hooks written to ${path.relative(root, file)}.`);
}

async function installPreCommit(root: string) {
  if (!(await isRepo(root))) return vscode.window.showWarningMessage('Pickle: not a Git repository.');
  const hooksDir = path.resolve(root, (await git(root, ['rev-parse', '--git-path', 'hooks'])).trim());
  const file = path.join(hooksDir, 'pre-commit');
  const blocking = cfg().get<boolean>('precommit.blocking', false);
  const script = `#!/bin/sh\n# Installed by Pickle (${MARK}). Delete this file to uninstall.\nnode "${cliPath()}" review --staged --hook git --root "${root.replaceAll('\\', '/')}"${blocking ? ' --fail-on-high' : ''}\n`;
  if (existsSync(file) && !(await readFile(file, 'utf8')).includes(MARK))
    return vscode.window.showWarningMessage(`Pickle: ${file} already exists and is not Pickle's. Add this line to it yourself:\n${script.split('\n')[2]}`, { modal: true });
  const answer = await vscode.window.showWarningMessage(
    `Write ${file}?`,
    { modal: true, detail: `${script}\n${blocking ? 'Blocking: commits with confirmed high-severity findings fail (bypass with --no-verify).' : 'Advisory: prints the review and never blocks. Enable pickle.precommit.blocking to block on confirmed high-severity findings.'}` },
    'Install',
  );
  if (answer !== 'Install') return;
  await mkdir(hooksDir, { recursive: true });
  await writeFile(file, script, { mode: 0o755 });
  vscode.window.showInformationMessage('Pickle: pre-commit check installed.');
}

// ---- Activation ------------------------------------------------------------------------------------

export function activate(context: vscode.ExtensionContext) {
  ctx = context;
  diagnostics = vscode.languages.createDiagnosticCollection('pickle');
  output = vscode.window.createOutputChannel('Pickle');
  status = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Left, 50);
  status.command = 'pickle.report.focus';
  const view = vscode.window.createTreeView('pickle.report', { treeDataProvider: provider, showCollapseAll: true });
  const command = (id: string, fn: (...args: any[]) => unknown) => vscode.commands.registerCommand(id, fn);
  context.subscriptions.push(
    diagnostics,
    output,
    status,
    view,
    vscode.workspace.registerTextDocumentContentProvider('pickle-fix', { provideTextDocumentContent: (uri) => proposed.get(decodeURIComponent(uri.query)) ?? '' }),
    command('pickle.analyzeChanges', () => analyzeChanges()),
    command('pickle.previewChange', (task?: string) => previewChange(task)),
    command('pickle.showImpact', showImpact),
    command('pickle.showContext', showContext),
    command('pickle.scanDesign', scanDrift),
    command('pickle.reviewFixes', reviewFixes),
    command('pickle.revertFix', revertFix),
    command('pickle.preCommitReview', () => analyzeChanges(true)),
    command('pickle.runVerification', runVerification),
    command('pickle.configureIntegrations', configureIntegrations),
    command('pickle.open', async (file: string, line?: number) => {
      const editor = await vscode.window.showTextDocument(vscode.Uri.file(file), { preview: true });
      if (line) {
        const pos = new vscode.Position(Math.max(0, line - 1), 0);
        editor.selection = new vscode.Selection(pos, pos);
        editor.revealRange(new vscode.Range(pos, pos), vscode.TextEditorRevealType.InCenter);
      }
    }),
    // Test/automation hooks: the last report, and the sidebar as rendered labels.
    command('pickle.getReport', () => report),
    command('pickle.getTree', () => {
      const flat = (n: Node): unknown => ({ label: n.label, description: n.description, command: n.command?.command, arguments: n.command?.arguments, children: n.children?.map(flat) });
      return report ? tree(report).map(flat) : [];
    }),
  );

  // Debounced re-analysis after files change on disk (saves, agents, git operations); never per keystroke.
  let timer: NodeJS.Timeout | undefined;
  const watcher = vscode.workspace.createFileSystemWatcher('**/*.{ts,tsx,js,jsx,mjs,cjs,css,scss,less,json,md}');
  const schedule = (uri: vscode.Uri) => {
    if (cfg().get('autoAnalyze', 'onChange') !== 'onChange' || /[\\/](node_modules|\.git|dist|dist-ext|out|build|coverage)[\\/]/.test(uri.fsPath)) return;
    clearTimeout(timer);
    timer = setTimeout(() => analyzeChanges(false, true), cfg().get('autoAnalyzeDelayMs', 2000));
  };
  context.subscriptions.push(watcher, watcher.onDidChange(schedule), watcher.onDidCreate(schedule), watcher.onDidDelete(schedule), { dispose: () => clearTimeout(timer) });
  vscode.commands.executeCommand('setContext', 'pickle.trusted', vscode.workspace.isTrusted);
  context.subscriptions.push(vscode.workspace.onDidGrantWorkspaceTrust(() => vscode.commands.executeCommand('setContext', 'pickle.trusted', true)));
}

export function deactivate() {
  return worker?.terminate();
}
