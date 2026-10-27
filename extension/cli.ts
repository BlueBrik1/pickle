// pickle CLI — the same engine the VS Code extension uses, for agent hooks, Git hooks and terminals.
//   pickle preview "<task>" [--json] [--root dir]
//   pickle review [--staged] [--json] [--fail-on-high] [--task "..."] [--root dir]
//   pickle preview --hook claude-prompt   (Claude Code UserPromptSubmit: stdout becomes agent context)
//   pickle review --hook claude-stop      (Claude Code Stop: advisory summary, optional block)
import { readFileSync } from 'node:fs';
import path from 'node:path';
import ts from 'typescript';
import { githubRepo } from './core/git.js';
import { preview, review, type Options, type Report } from './core/pickle.js';
import { counts, renderText } from './core/render.js';

function settings(root: string): Record<string, any> {
  try {
    const text = readFileSync(path.join(root, '.vscode', 'settings.json'), 'utf8');
    return ts.parseConfigFileTextToJson('settings.json', text).config ?? {};
  } catch {
    return {};
  }
}

async function options(root: string, s: Record<string, any>): Promise<Options> {
  const repo = s['pickle.context.github'] && process.env.GITHUB_TOKEN ? await githubRepo(root) : undefined;
  const channels: string[] = s['pickle.context.slackChannels'] ?? [];
  return {
    tokensFile: s['pickle.design.tokensFile'] || undefined,
    maxFiles: s['pickle.maxFiles'],
    context: {
      github: repo ? { repo, token: process.env.GITHUB_TOKEN! } : undefined,
      slack: process.env.SLACK_TOKEN && channels.length ? { token: process.env.SLACK_TOKEN, channels } : undefined,
      claudeCode: !!s['pickle.context.claudeCode'],
      codex: !!s['pickle.context.codex'],
      fixtureFile: s['pickle.context.fixtureFile'] || undefined,
    },
  };
}

function stdin(): Promise<any> {
  return new Promise((resolve) => {
    if (process.stdin.isTTY) return resolve({});
    let buf = '';
    process.stdin.setEncoding('utf8');
    process.stdin.on('data', (c) => (buf += c));
    process.stdin.on('end', () => {
      try {
        resolve(JSON.parse(buf));
      } catch {
        resolve({});
      }
    });
  });
}

const flag = (args: string[], name: string) => args.includes(name);
const value = (args: string[], name: string) => {
  const i = args.indexOf(name);
  return i >= 0 ? args[i + 1] : undefined;
};

async function main(argv: string[]) {
  const [command, ...args] = argv;
  const hook = value(args, '--hook');
  const input = hook?.startsWith('claude') ? await stdin() : {};
  const root = path.resolve(value(args, '--root') ?? input.cwd ?? process.cwd());
  const s = settings(root);
  const opts = await options(root, s);
  let report: Report;

  if (command === 'preview') {
    const task = hook === 'claude-prompt' ? String(input.prompt ?? '') : args.filter((a, i) => !a.startsWith('--') && !args[i - 1]?.startsWith('--')).join(' ');
    if (hook === 'claude-prompt' && (task.trim().length < 20 || task.trim().startsWith('/'))) return 0;
    if (!task.trim()) {
      console.error('Usage: pickle preview "<describe the change>"');
      return 2;
    }
    report = await preview(root, task, opts);
    if (hook === 'claude-prompt') {
      // Only speak up when the description maps to real files; otherwise stay out of the agent's way.
      if (!report.impact.confirmed.length) return 0;
      process.stdout.write(renderText(report, { compact: true }).slice(0, 6000) + '\n');
      return 0;
    }
  } else if (command === 'review') {
    if (hook === 'claude-stop' && input.stop_hook_active) return 0;
    report = await review(root, { ...opts, staged: flag(args, '--staged'), task: value(args, '--task') });
    if (hook === 'claude-stop') {
      if (!report.changed.length) return 0;
      const c = counts(report);
      const summary = `Pickle: ${c.impact} affected file(s), ${c.context} context item(s), ${c.design} design issue(s), ${c.high} high risk(s).`;
      const block = s['pickle.agent.stopReview'] === 'block-on-high' && c.high > 0;
      process.stdout.write(
        JSON.stringify(block ? { decision: 'block', reason: renderText(report, { compact: true }).slice(0, 8000) } : { systemMessage: summary }) + '\n',
      );
      return 0;
    }
  } else {
    console.error('Usage: pickle preview "<task>" | pickle review [--staged] [--json] [--fail-on-high]');
    return 2;
  }

  process.stdout.write((flag(args, '--json') ? JSON.stringify(report, null, 2) : renderText(report)) + '\n');
  // Only confirmed, high-severity findings (e.g. imports of removed exports) may fail a commit.
  if (flag(args, '--fail-on-high') && report.risks.some((r) => r.level === 'high' && r.basis === 'confirmed')) {
    if (hook === 'git') console.error('\nPickle blocked this commit: confirmed high-severity findings. Fix them or commit with --no-verify.');
    return 1;
  }
  return 0;
}

main(process.argv.slice(2)).then(
  (code) => process.exit(code),
  (e) => {
    console.error(`pickle: ${e?.message ?? e}`);
    // A broken analyzer must never block an agent or a commit.
    process.exit(0);
  },
);
