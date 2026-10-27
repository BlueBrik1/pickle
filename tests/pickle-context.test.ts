import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { classify, gatherContext } from '../extension/core/context.js';
import { claudeCodeMessages, claudeProjectSlug, codexMessages, sanitize } from '../extension/core/shadowqa.js';
import { loadWorkspace } from '../extension/core/workspace.js';
import { makeRepo } from './helpers/repo.js';

const files = {
  'src/checkout/submit.ts': 'export function submitOrder() { return 1; }\n',
  'src/settings/theme.ts': 'export const theme = "light";\n',
  'docs/requirements.md': '# Requirements\n\n## Duplicate orders\n\n`submitOrder` must ignore repeat calls while an order is in flight.\n\n## Theme\n\nThe settings theme defaults to light.\n',
  'docs/adr/0001-spinner.md': '# 0001 Spinner\n\nStatus: Superseded by 0002\n\nsubmitOrder shows a spinner during checkout submit.\n',
  'docs/adr/0002-label.md': '# 0002 Label\n\nStatus: Accepted\n\nsubmitOrder keeps the label during checkout submit. Supersedes 0001.\n',
  'fixtures/issues.json': JSON.stringify({
    items: [
      { number: 42, title: 'Double submit in checkout', body: 'submitOrder must not run twice', state: 'closed', state_reason: 'completed', labels: ['requirement'], html_url: 'https://github.com/o/r/issues/42' },
      { number: 57, title: 'Dark mode', body: 'Add dark mode to settings', state: 'open', labels: [], html_url: 'https://github.com/o/r/issues/57' },
    ],
  }),
};
const query = { text: 'change checkout submission', paths: ['src/checkout/submit.ts'], symbols: ['submitOrder'] };

let cleanup: (() => void)[] = [];
afterEach(() => {
  cleanup.forEach((f) => f());
  cleanup = [];
});
async function setup() {
  const repo = makeRepo(files);
  cleanup.push(repo.cleanup);
  return { repo, ws: await loadWorkspace(repo.root) };
}

describe('context retrieval', () => {
  it('retrieves the relevant requirement with its source location and excludes unrelated material', async () => {
    const { ws } = await setup();
    const { items, sources } = await gatherContext(ws, query, { fixtureFile: 'fixtures/issues.json' });
    const req = items.find((i) => i.title.includes('Duplicate orders'))!;
    expect(req).toMatchObject({ status: 'requirement', source: 'repo', ref: { path: 'docs/requirements.md', line: 3 } });
    expect(req.why).toMatch(/submitOrder/);
    expect(items.some((i) => i.title.includes('Theme'))).toBe(false);
    expect(items.some((i) => i.title.includes('Dark mode'))).toBe(false);
    expect(sources.find((s) => s.name === 'Repository docs')?.state).toBe('used');
  });

  it('labels fixture items as fixtures and never as live GitHub links', async () => {
    const { ws } = await setup();
    const { items } = await gatherContext(ws, query, { fixtureFile: 'fixtures/issues.json' });
    const issue = items.find((i) => i.id === 'fixture:42')!;
    expect(issue.title).toMatch(/^\[fixture\]/);
    expect(issue.url).toBeUndefined();
    expect(issue.ref?.path).toBe('fixtures/issues.json');
  });

  it('identifies superseded decisions and pairs them with the source that supersedes them', async () => {
    const { ws } = await setup();
    const { items } = await gatherContext(ws, query, {});
    const old = items.find((i) => i.title.includes('0001'))!;
    expect(old.status).toBe('superseded');
    expect(old.note).toMatch(/0002/);
    expect(items.find((i) => i.title.includes('0002'))?.status).toBe('decision');
  });

  it('classifies authority conservatively', () => {
    expect(classify('We must keep sessions valid')).toBe('requirement');
    expect(classify('Status: Accepted\nUse labels')).toBe('decision');
    expect(classify('Deprecated: use v2')).toBe('superseded');
    expect(classify('thoughts on colors')).toBe('history');
  });

  it('reads GitHub through the supplied token and degrades to an error state when it fails', async () => {
    const { ws } = await setup();
    const calls: string[] = [];
    const ok = (async (url: string, init: any) => {
      calls.push(`${url} ${init.headers.authorization}`);
      return new Response(JSON.stringify([{ number: 7, title: 'submitOrder must be idempotent', body: '', state: 'open', labels: [], html_url: 'https://github.com/o/r/issues/7' }]));
    }) as unknown as typeof fetch;
    const a = await gatherContext(ws, query, { github: { repo: 'o/r-ok', token: 'T' }, fetch: ok });
    expect(calls[0]).toMatch(/api\.github\.com\/repos\/o\/r-ok\/issues.* Bearer T$/);
    expect(a.items.find((i) => i.id === 'github:7')).toMatchObject({ status: 'requirement', url: 'https://github.com/o/r/issues/7' });

    const failing = (async () => new Response('{}', { status: 404 })) as unknown as typeof fetch;
    const b = await gatherContext(ws, query, { github: { repo: 'o/r-missing', token: 'T' }, fetch: failing });
    expect(b.sources.find((s) => s.name.startsWith('GitHub'))).toMatchObject({ state: 'error' });
    expect(b.items.length).toBeGreaterThan(0); // local context still works
  });

  it('treats Slack messages as discussion, never as requirements', async () => {
    const { ws } = await setup();
    const slack = (async () =>
      new Response(JSON.stringify({ ok: true, messages: [{ ts: '1700000000.000100', text: 'submitOrder must retry 3 times, agreed?' }] }))) as unknown as typeof fetch;
    const { items } = await gatherContext(ws, query, { slack: { token: 'x', channels: ['C1'] }, fetch: slack });
    expect(items.find((i) => i.source === 'slack')).toMatchObject({ status: 'discussion', url: 'https://slack.com/archives/C1/p1700000000000100' });
  });

  it('reports disabled integrations as off without touching them', async () => {
    const { ws } = await setup();
    const { sources } = await gatherContext(ws, query, { git: false });
    expect(sources.filter((s) => s.state === 'off').map((s) => s.name)).toEqual(
      expect.arrayContaining(['Git history', 'GitHub issues & PRs', 'Slack', 'Claude Code sessions', 'Codex sessions', 'Fixture']),
    );
  });

  it('redacts secrets from retrieved text', () => {
    expect(sanitize('token ghp_abcdefghijklmnopqrstuvwxyz123456 and password=hunter2')).toBe('token [REDACTED TOKEN] and password=[REDACTED]');
  });
});

describe('agent session isolation', () => {
  it('reads Claude Code transcripts only for this workspace and keeps assistant text as suggestions', async () => {
    const home = mkdtempSync(path.join(os.tmpdir(), 'pickle-claude-'));
    cleanup.push(() => rmSync(home, { recursive: true, force: true }));
    const mine = path.join(os.tmpdir(), 'project-a'),
      other = path.join(os.tmpdir(), 'project-b');
    for (const [cwd, text] of [
      [mine, 'Never change submitOrder retries'],
      [other, 'SECRET OTHER PROJECT'],
    ]) {
      const dir = path.join(home, 'projects', claudeProjectSlug(cwd));
      mkdirSync(dir, { recursive: true });
      writeFileSync(
        path.join(dir, 's.jsonl'),
        [
          { type: 'user', message: { content: text }, timestamp: '2026-01-01T00:00:00Z' },
          { type: 'assistant', message: { content: [{ type: 'text', text: 'I suggest caching submitOrder' }] } },
          { type: 'user', isSidechain: true, message: { content: 'subagent chatter' } },
        ]
          .map((r) => JSON.stringify(r))
          .join('\n'),
      );
    }
    const messages = await claudeCodeMessages(mine, home);
    expect(messages.map((m) => [m.role, m.text])).toEqual([
      ['user', 'Never change submitOrder retries'],
      ['assistant', 'I suggest caching submitOrder'],
    ]);
  });

  it('reads Codex rollouts only when their recorded cwd is this workspace', async () => {
    const home = mkdtempSync(path.join(os.tmpdir(), 'pickle-codex-'));
    cleanup.push(() => rmSync(home, { recursive: true, force: true }));
    const dir = path.join(home, 'sessions', '2026', '01', '01');
    mkdirSync(dir, { recursive: true });
    const rollout = (cwd: string, text: string, id: string) =>
      writeFileSync(
        path.join(dir, `rollout-2026-01-01T00-00-00-${id}.jsonl`),
        [
          { type: 'session_meta', payload: { cwd } },
          { type: 'response_item', payload: { type: 'message', role: 'user', content: [{ type: 'input_text', text: '<environment_context>x</environment_context>' }] } },
          { type: 'response_item', payload: { type: 'message', role: 'user', content: [{ type: 'input_text', text }] } },
        ]
          .map((r) => JSON.stringify(r))
          .join('\n'),
      );
    rollout('/work/a', 'keep submitOrder idempotent', '11111111-1111-1111-1111-111111111111');
    rollout('/work/b', 'other project', '22222222-2222-2222-2222-222222222222');
    const messages = await codexMessages('/work/a', home);
    expect(messages.map((m) => m.text)).toEqual(['keep submitOrder idempotent']);
  });
});
