// Adapted from ShadowQA (github.com/BlueBrik1/shadowqa @ 50beee8):
//   sanitize()            src/core/security.ts
//   Claude Code reader    individual/companion/src/adapters/claude-code.ts
//   Codex reader          individual/companion/src/adapters/codex.ts
// Changes: no database/companion; results are scoped to one workspace folder and capped.
import { readFile, readdir, stat } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

export function sanitize(text: string): string {
  return text
    .replace(
      /-----BEGIN [^-]*PRIVATE KEY-----[\s\S]*?-----END [^-]*PRIVATE KEY-----/g,
      '[REDACTED PRIVATE KEY]',
    )
    .replace(
      /\b(?:AIza[\w-]{30,}|gh[pousr]_[\w]{20,}|github_pat_[\w]{20,}|xox[baprs]-[\w-]{10,}|xapp-[\w-]{20,}|npm_[\w]{20,}|AKIA[A-Z0-9]{16}|sk-[\w-]{20,})\b/g,
      '[REDACTED TOKEN]',
    )
    .replace(
      /((?:api[_-]?key|password|secret|authorization|access[_-]?token|_authToken)\s*[=:]\s*["']?)[^\s"',;]+/gi,
      '$1[REDACTED]',
    )
    .replace(/\x1b\[[0-?]*[ -/]*[@-~]/g, '')
    .replace(/[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]/g, '');
}

export interface SessionMessage {
  origin: 'claude-code' | 'codex';
  sessionId: string;
  role: 'user' | 'assistant';
  text: string;
  file: string;
  timestamp?: string;
}

const MAX_SESSIONS = 20;
const MAX_BYTES = 20 * 1024 * 1024;
const cache = new Map<string, { mtimeMs: number; messages: SessionMessage[] }>();

async function cached(file: string, read: () => Promise<SessionMessage[]>) {
  const info = await stat(file).catch(() => undefined);
  if (!info || info.size > MAX_BYTES) return [];
  const hit = cache.get(file);
  if (hit && hit.mtimeMs === info.mtimeMs) return hit.messages;
  const messages = await read();
  cache.set(file, { mtimeMs: info.mtimeMs, messages });
  return messages;
}

/** Claude Code's project folder name: every non-alphanumeric character in the cwd becomes '-'. */
export const claudeProjectSlug = (cwd: string) => path.resolve(cwd).replace(/[^A-Za-z0-9]/g, '-');

const claudeText = (content: unknown): string =>
  typeof content === 'string'
    ? content
    : Array.isArray(content)
      ? content
          .map((b: any) => (typeof b === 'string' ? b : b?.type === 'text' ? String(b.text ?? '') : ''))
          .filter(Boolean)
          .join('\n')
      : '';

/** Main-thread user/assistant turns from this workspace's Claude Code transcripts only. */
export async function claudeCodeMessages(cwd: string, home = process.env.CLAUDE_CONFIG_DIR ?? path.join(os.homedir(), '.claude')) {
  const dir = path.join(home, 'projects', claudeProjectSlug(cwd));
  const names = (await readdir(dir).catch(() => [] as string[])).filter((f) => f.endsWith('.jsonl'));
  const files = (
    await Promise.all(names.map(async (n) => ({ file: path.join(dir, n), info: await stat(path.join(dir, n)).catch(() => undefined) })))
  )
    .filter((f) => f.info)
    .sort((a, b) => b.info!.mtimeMs - a.info!.mtimeMs)
    .slice(0, MAX_SESSIONS);
  const out: SessionMessage[] = [];
  for (const { file } of files)
    out.push(
      ...(await cached(file, async () => {
        const messages: SessionMessage[] = [];
        for (const line of (await readFile(file, 'utf8').catch(() => '')).split(/\r?\n/)) {
          let r: any;
          try {
            r = JSON.parse(line);
          } catch {
            continue;
          }
          if ((r.type !== 'user' && r.type !== 'assistant') || r.isMeta || r.isSidechain) continue;
          const text = sanitize(claudeText(r.message?.content)).trim();
          if (!text || text.startsWith('<')) continue; // command wrappers and hook output
          messages.push({
            origin: 'claude-code',
            sessionId: path.basename(file, '.jsonl'),
            role: r.type,
            text: text.slice(0, 20_000),
            file,
            timestamp: typeof r.timestamp === 'string' ? r.timestamp : undefined,
          });
        }
        return messages;
      })),
    );
  return out;
}

const ROLLOUT = /^rollout-.*-([0-9a-f-]{36})\.jsonl$/i;
const samePath = (a: string, b: string) =>
  process.platform === 'win32' ? path.resolve(a).toLowerCase() === path.resolve(b).toLowerCase() : path.resolve(a) === path.resolve(b);

/** Codex rollouts whose recorded session cwd is this workspace. Other projects' sessions are skipped. */
export async function codexMessages(cwd: string, home = process.env.CODEX_HOME ?? path.join(os.homedir(), '.codex')) {
  const found: { file: string; mtimeMs: number }[] = [];
  const walk = async (dir: string, depth: number) => {
    for (const e of await readdir(dir, { withFileTypes: true }).catch(() => [])) {
      const full = path.join(dir, e.name);
      if (e.isDirectory() && depth < 3) await walk(full, depth + 1);
      else if (e.isFile() && ROLLOUT.test(e.name)) {
        const info = await stat(full).catch(() => undefined);
        if (info) found.push({ file: full, mtimeMs: info.mtimeMs });
      }
    }
  };
  await walk(path.join(home, 'sessions'), 0);
  found.sort((a, b) => b.mtimeMs - a.mtimeMs);
  const out: SessionMessage[] = [];
  for (const { file } of found.slice(0, MAX_SESSIONS * 5)) {
    const messages = await cached(file, async () => {
      const messages: SessionMessage[] = [];
      let sessionCwd: string | undefined;
      for (const line of (await readFile(file, 'utf8').catch(() => '')).split(/\r?\n/)) {
        let r: any;
        try {
          r = JSON.parse(line);
        } catch {
          continue;
        }
        const p = r.payload ?? {};
        if (r.type === 'session_meta') sessionCwd = p.cwd ?? sessionCwd;
        if (r.type !== 'response_item' || p.type !== 'message' || (p.role !== 'user' && p.role !== 'assistant')) continue;
        const text = sanitize(
          Array.isArray(p.content) ? p.content.map((c: any) => (typeof c?.text === 'string' ? c.text : '')).join('\n') : String(p.content ?? ''),
        ).trim();
        // Codex injects environment/instruction preambles as user turns.
        if (!text || /^<(environment_context|user_instructions)>/.test(text)) continue;
        messages.push({
          origin: 'codex',
          sessionId: ROLLOUT.exec(path.basename(file))?.[1] ?? path.basename(file),
          role: p.role,
          text: text.slice(0, 20_000),
          file,
          timestamp: typeof r.timestamp === 'string' ? r.timestamp : undefined,
        });
      }
      return sessionCwd ? messages.map((m) => ({ ...m, cwd: sessionCwd })) : [];
    });
    out.push(...messages.filter((m: any) => m.cwd && samePath(m.cwd, cwd)));
  }
  return out;
}
