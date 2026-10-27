import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { tokenize } from '../../server/analysis/index.js';
import { log } from './git.js';
import { claudeCodeMessages, codexMessages, sanitize, type SessionMessage } from './shadowqa.js';
import type { Workspace } from './workspace.js';

export type ContextStatus = 'requirement' | 'decision' | 'superseded' | 'discussion' | 'ai-suggestion' | 'history';
export interface ContextItem {
  id: string;
  source: 'repo' | 'git' | 'github' | 'slack' | 'claude-code' | 'codex' | 'fixture';
  status: ContextStatus;
  title: string;
  excerpt: string;
  /** External link (GitHub, Slack). Local items use `ref`. */
  url?: string;
  ref?: { path: string; line: number };
  time?: string;
  score: number;
  why: string;
  note?: string;
}
export interface SourceState {
  name: string;
  state: 'used' | 'off' | 'error' | 'empty';
  detail: string;
}
export interface ContextQuery {
  text: string;
  paths: string[];
  symbols: string[];
}
export interface ContextOptions {
  git?: boolean;
  github?: { repo: string; token: string };
  slack?: { token: string; channels: string[] };
  claudeCode?: boolean;
  codex?: boolean;
  /** Workspace-relative JSON of GitHub-shaped issues. Always labeled as a fixture. */
  fixtureFile?: string;
  fetch?: typeof fetch;
  limit?: number;
}

const MUST = /\b(must(?: not)?|shall|required?|requirement|never|do not|don't|always)\b/i;
const SUPERSEDED = /\b(superseded|deprecated|obsolete|no longer applies)\b|status:\s*(superseded|rejected|deprecated)/i;
const DECISION = /status:\s*accepted|\bwe (?:decided|agreed|chose)\b|\bdecision\b/i;

export function classify(text: string, hint = ''): ContextStatus {
  if (SUPERSEDED.test(text)) return 'superseded';
  if (/(?:^|\/)(?:adr|decisions?)(?:\/|-)/i.test(hint) || DECISION.test(text)) return 'decision';
  if (MUST.test(text)) return 'requirement';
  return 'history';
}

const escapeRe = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

/** Relevance with an explanation. Paths and symbols are strong signals; shared words are weak. */
export function relevance(text: string, q: ContextQuery, common: Set<string> = new Set()) {
  const reasons: string[] = [];
  let score = 0;
  const lower = text.toLowerCase();
  const pathHits = q.paths.filter((p) => {
    const base = path.posix.basename(p).replace(/\.[^.]+$/, '');
    // A bare basename counts only when distinctive (CheckoutButton, use-auth), never plain words like "session".
    const distinctive = base.length >= 5 && /[a-z][A-Z]|[-_]/.test(base);
    return lower.includes(p.toLowerCase()) || (distinctive && new RegExp(`\\b${escapeRe(base)}\\b`).test(text));
  });
  if (pathHits.length) {
    score += Math.min(pathHits.length * 6, 18);
    reasons.push(`mentions ${pathHits.slice(0, 3).join(', ')}`);
  }
  const symbolHits = [...new Set(q.symbols)].filter((s) => s.length >= 4 && new RegExp(`\\b${escapeRe(s)}\\b`).test(text));
  if (symbolHits.length) {
    score += Math.min(symbolHits.length * 5, 15);
    reasons.push(`names ${symbolHits.slice(0, 3).join(', ')}`);
  }
  const words = new Set(tokenize(text));
  const taskTerms = tokenize(q.text).filter((t) => t.length >= 4 && words.has(t) && !common.has(t));
  const pathTerms = [...new Set(q.paths.flatMap((p) => tokenize(p)))].filter(
    (t) => t.length >= 4 && !['src', 'tsx', 'index', 'test', 'tests', 'components', 'lib'].includes(t) && words.has(t) && !common.has(t) && !taskTerms.includes(t),
  );
  score += taskTerms.length * 2 + pathTerms.length;
  if (taskTerms.length + pathTerms.length) reasons.push(`shares ${[...taskTerms, ...pathTerms].slice(0, 5).join(', ')}`);
  const relevant = pathHits.length > 0 || symbolHits.length > 0 || taskTerms.length + pathTerms.length >= 2;
  return { score: relevant ? score : 0, why: reasons.join('; ') };
}

const clip = (s: string, n = 280) => {
  const t = sanitize(s).replace(/\s+/g, ' ').trim();
  return t.length > n ? t.slice(0, n - 1) + '…' : t;
};

function markdownSections(file: string, text: string) {
  const out: { title: string; body: string; line: number }[] = [];
  const lines = text.split(/\r?\n/);
  let current = { title: path.posix.basename(file), body: '', line: 1 };
  lines.forEach((line, i) => {
    const h = /^#{1,4}\s+(.+)/.exec(line);
    if (h) {
      if (current.body.trim()) out.push(current);
      current = { title: h[1].trim(), body: '', line: i + 1 };
    } else current.body += line + '\n';
  });
  if (current.body.trim()) out.push(current);
  return out;
}

interface Issue {
  number: number;
  title: string;
  body?: string | null;
  state: string;
  state_reason?: string | null;
  labels?: (string | { name?: string })[];
  html_url: string;
  updated_at?: string;
  pull_request?: unknown;
}

function issueItem(issue: Issue, source: 'github' | 'fixture'): Omit<ContextItem, 'score' | 'why'> {
  const labels = (issue.labels ?? []).map((l) => (typeof l === 'string' ? l : (l.name ?? ''))).join(' ');
  const text = `${issue.title}\n${issue.body ?? ''}`;
  const status: ContextStatus =
    issue.state_reason === 'not_planned' || SUPERSEDED.test(text)
      ? 'superseded'
      : /requirement|spec|acceptance|security/i.test(labels) || MUST.test(text)
        ? 'requirement'
        : issue.state === 'open'
          ? 'discussion'
          : 'history';
  return {
    id: `${source}:${issue.number}`,
    source,
    status,
    title: `${source === 'fixture' ? '[fixture] ' : ''}${issue.pull_request ? 'PR' : 'Issue'} #${issue.number}: ${issue.title}`,
    excerpt: clip(issue.body ?? ''),
    url: source === 'github' ? issue.html_url : undefined,
    time: issue.updated_at,
  };
}

const githubCache = new Map<string, { at: number; issues: Issue[] }>();

async function githubIssues(repo: string, token: string, fetcher: typeof fetch): Promise<Issue[]> {
  const hit = githubCache.get(repo);
  if (hit && Date.now() - hit.at < 10 * 60_000) return hit.issues;
  const issues: Issue[] = [];
  for (let page = 1; page <= 2; page++) {
    const res = await fetcher(
      `https://api.github.com/repos/${repo}/issues?state=all&sort=updated&per_page=100&page=${page}`,
      {
        headers: {
          accept: 'application/vnd.github+json',
          authorization: `Bearer ${token}`,
          'X-GitHub-Api-Version': '2022-11-28',
          'User-Agent': 'Pickle',
        },
        signal: AbortSignal.timeout(20_000),
      },
    );
    if (!res.ok) throw new Error(`GitHub returned ${res.status}${res.status === 404 ? ' (no access to this repository?)' : ''}`);
    const rows = (await res.json()) as Issue[];
    issues.push(...rows);
    if (rows.length < 100) break;
  }
  githubCache.set(repo, { at: Date.now(), issues });
  return issues;
}

async function slackMessages(token: string, channels: string[], fetcher: typeof fetch) {
  const out: Omit<ContextItem, 'score' | 'why'>[] = [];
  for (const channel of channels.slice(0, 10)) {
    const res = await fetcher(`https://slack.com/api/conversations.history?channel=${encodeURIComponent(channel)}&limit=200`, {
      headers: { authorization: `Bearer ${token}` },
      signal: AbortSignal.timeout(20_000),
    });
    const body: any = await res.json();
    if (!body.ok) throw new Error(`Slack ${channel}: ${body.error ?? res.status}`);
    for (const m of body.messages ?? []) {
      if (!m.text || m.subtype) continue;
      out.push({
        id: `slack:${channel}:${m.ts}`,
        source: 'slack',
        // A chat message is never authoritative on its own, whatever its wording.
        status: SUPERSEDED.test(m.text) ? 'superseded' : 'discussion',
        title: `Slack ${channel}: ${clip(m.text, 70)}`,
        excerpt: clip(m.text),
        url: `https://slack.com/archives/${channel}/p${String(m.ts).replace('.', '')}`,
        time: new Date(Number(m.ts) * 1000).toISOString(),
      });
    }
  }
  return out;
}

function sessionItem(m: SessionMessage, i: number): Omit<ContextItem, 'score' | 'why'> {
  const label = m.origin === 'claude-code' ? 'Claude Code' : 'Codex';
  return {
    id: `${m.origin}:${m.sessionId}:${i}`,
    source: m.origin,
    // What an assistant proposed is not what the developer decided (ShadowQA's extraction rule).
    status: m.role === 'assistant' ? 'ai-suggestion' : 'discussion',
    title: `${label} ${m.role === 'user' ? 'developer' : 'assistant'}: ${clip(m.text, 70)}`,
    excerpt: clip(m.text),
    ref: { path: m.file, line: 1 },
    time: m.timestamp,
  };
}

export async function gatherContext(ws: Workspace, q: ContextQuery, opts: ContextOptions = {}) {
  const fetcher = opts.fetch ?? fetch;
  const candidates: Omit<ContextItem, 'score' | 'why'>[] = [];
  const sources: SourceState[] = [];
  const attempt = async (name: string, enabled: unknown, offDetail: string, run: () => Promise<number>) => {
    if (!enabled) return sources.push({ name, state: 'off', detail: offDetail });
    try {
      const n = await run();
      sources.push({ name, state: n ? 'used' : 'empty', detail: `${n} item(s) scanned` });
    } catch (e: any) {
      sources.push({ name, state: 'error', detail: sanitize(String(e?.message ?? e)) });
    }
  };

  await attempt('Repository docs', true, '', async () => {
    let n = 0;
    for (const [file, text] of ws.contents)
      if (/\.mdx?$/i.test(file))
        for (const s of markdownSections(file, text)) {
          n++;
          candidates.push({
            id: `repo:${file}:${s.line}`,
            source: 'repo',
            status: classify(`${s.title}\n${s.body}`, file),
            title: `${file} — ${s.title}`,
            excerpt: clip(s.body),
            ref: { path: file, line: s.line },
          });
        }
    return n;
  });
  await attempt('Git history', opts.git !== false, 'Not a Git repository or workspace not trusted', async () => {
    const commits = await log(ws.root, q.paths.filter((p) => ws.contents.has(p)), 30);
    for (const c of commits)
      candidates.push({
        id: `git:${c.sha}`,
        source: 'git',
        status: /^revert/i.test(c.subject) ? 'superseded' : classify(`${c.subject}\n${c.body}`) === 'superseded' ? 'superseded' : 'history',
        title: `${c.sha.slice(0, 7)} ${c.subject}`,
        excerpt: clip(`${c.body}\nFiles: ${c.files.slice(0, 6).join(', ')}`),
        time: c.date,
        // Commit links resolve only with a remote; locally the hash is the reference.
        url: opts.github ? `https://github.com/${opts.github.repo}/commit/${c.sha}` : undefined,
      });
    return commits.length;
  });
  await attempt('GitHub issues & PRs', opts.github, 'Not connected', async () => {
    const issues = await githubIssues(opts.github!.repo, opts.github!.token, fetcher);
    candidates.push(...issues.map((i) => issueItem(i, 'github')));
    return issues.length;
  });
  await attempt('Slack', opts.slack?.channels.length, 'Not connected', async () => {
    const items = await slackMessages(opts.slack!.token, opts.slack!.channels, fetcher);
    candidates.push(...items);
    return items.length;
  });
  await attempt('Claude Code sessions', opts.claudeCode, 'Disabled', async () => {
    const msgs = await claudeCodeMessages(ws.root);
    candidates.push(...msgs.map(sessionItem));
    return msgs.length;
  });
  await attempt('Codex sessions', opts.codex, 'Disabled', async () => {
    const msgs = await codexMessages(ws.root);
    candidates.push(...msgs.map(sessionItem));
    return msgs.length;
  });
  await attempt('Fixture', opts.fixtureFile, 'None configured', async () => {
    const file = path.resolve(ws.root, opts.fixtureFile!);
    if (path.relative(ws.root, file).startsWith('..')) throw new Error('Fixture must be inside the workspace');
    const data = JSON.parse(await readFile(file, 'utf8'));
    const rel = path.relative(ws.root, file).replaceAll('\\', '/');
    const items = (data.items ?? []).map((i: Issue) => ({ ...issueItem(i, 'fixture'), ref: { path: rel, line: 1 } }));
    candidates.push(...items);
    return items.length;
  });

  // Terms in more than a quarter of a large corpus (the project's own name, its domain) carry no signal.
  const df = new Map<string, number>();
  for (const c of candidates) for (const t of new Set(tokenize(`${c.title} ${c.excerpt}`))) df.set(t, (df.get(t) ?? 0) + 1);
  const common = new Set(candidates.length >= 20 ? [...df].filter(([, n]) => n > candidates.length / 4).map(([t]) => t) : []);
  const scored: ContextItem[] = candidates
    .map((c) => {
      // Session chatter needs a concrete anchor (a path or symbol) to count.
      const r = relevance(`${c.title}\n${c.excerpt}`, q, common);
      const weak = (c.source === 'claude-code' || c.source === 'codex') && !/mentions|names/.test(r.why);
      const authority = { requirement: 3, decision: 2, superseded: 1, discussion: 0, 'ai-suggestion': 0, history: 0 }[c.status];
      // A commit touching the same file is supporting history, ranked below stated requirements.
      const score = c.source === 'git' ? Math.round(r.score / 2) : r.score;
      return { ...c, score: weak || !score ? 0 : score + authority, why: r.why };
    })
    .filter((c) => c.score >= 6 && !(c.source === 'repo' && c.status === 'history' && c.score < 10))
    .sort((a, b) => b.score - a.score || a.id.localeCompare(b.id));
  const limit = opts.limit ?? 6;
  const picked: ContextItem[] = [];
  for (const c of scored) {
    // At most three commits; history is supporting context, not the headline.
    if (c.source === 'git' && picked.filter((p) => p.source === 'git').length >= 3) continue;
    if (picked.length < limit) picked.push(c);
  }
  // Show disagreement instead of silently choosing: pair each superseded item with the current source
  // that names it (e.g. "Supersedes 0001"), else with the one sharing the most terms.
  const ids = (t: string) => new Set(t.match(/\b(?:\d{3,4}|#\d+|[A-Z]+-[A-Z]*-?\d+)\b/g) ?? []);
  for (const old of picked.filter((p) => p.status === 'superseded')) {
    const oldText = old.title + ' ' + old.excerpt;
    const oldTerms = new Set(tokenize(oldText).filter((t) => t.length > 3));
    const best = picked
      .filter((p) => p.status === 'requirement' || p.status === 'decision')
      .map((cur) => {
        const text = cur.title + ' ' + cur.excerpt;
        const named = [...ids(text)].some((id) => ids(oldText).has(id));
        return { cur, rank: (named ? 100 : 0) + tokenize(text).filter((t) => oldTerms.has(t)).length };
      })
      .sort((a, b) => b.rank - a.rank)[0];
    if (best && best.rank >= 3) {
      old.note = `Superseded; compare with “${best.cur.title}”.`;
      best.cur.note ??= `Supersedes “${old.title}”.`;
    }
  }
  return { items: picked, sources };
}
