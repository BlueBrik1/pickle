import { readdir, readFile, stat } from 'node:fs/promises';
import path from 'node:path';
import { indexProject } from '../../server/analysis/index.js';
import {
  contentExclusionReason,
  exclusionReason,
  parseRootIgnore,
  sanitizeEnv,
} from '../../src/shared/ingestion.js';
import type { FileRecord, IndexedProject, Snapshot } from '../../src/shared/schema.js';

/** Files Penny reads that the impact engine does not (stylesheets and markup). */
export const STYLE_RE = /\.(?:css|scss|less|jsx|tsx|html|vue|svelte)$/i;

export interface Workspace {
  root: string;
  project: IndexedProject;
  byPath: Map<string, FileRecord>;
  byId: Map<string, FileRecord>;
  contents: Map<string, string>;
  /** Stylesheets and markup for the design scan (tests excluded). */
  styleFiles: string[];
  skipped: Record<string, number>;
  /** False when nothing changed on disk since the previous load (the index was reused). */
  reindexed: boolean;
}

interface CacheEntry {
  mtimeMs: number;
  size: number;
  content: string;
}
const caches = new Map<string, { files: Map<string, CacheEntry>; workspace?: Workspace }>();

// ponytail: one in-memory cache per root, whole-index rebuild when any file changes.
// Per-file AST caching inside the engine is the upgrade if large repos re-index slowly.
export async function loadWorkspace(root: string, maxFiles = 5000): Promise<Workspace> {
  const cache = caches.get(root) ?? { files: new Map<string, CacheEntry>() };
  caches.set(root, cache);
  const ignoreText = await readFile(path.join(root, '.gitignore'), 'utf8').catch(() => '');
  const ignore = parseRootIgnore(ignoreText);
  const skipped: Record<string, number> = {};
  const skip = (reason: string) => (skipped[reason] = (skipped[reason] ?? 0) + 1);
  const found: string[] = [];
  async function walk(dir: string) {
    let entries;
    try {
      entries = await readdir(path.join(root, dir), { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      const rel = dir ? `${dir}/${entry.name}` : entry.name;
      if (entry.isSymbolicLink()) continue;
      if (entry.isDirectory()) {
        if (entry.name === '.git' || ignore.ignored(`${rel}/_`)) continue;
        if (exclusionReason(`${rel}/_.ts`) === 'Generated or dependency directory') continue;
        await walk(rel);
      } else if (entry.isFile()) found.push(rel);
    }
  }
  await walk('');
  found.sort();

  let changed = !cache.workspace;
  const live = new Set<string>();
  const files: Snapshot['files'] = [];
  const styleFiles: string[] = [];
  const contents = new Map<string, string>();
  let totalBytes = 0;
  for (const rel of found) {
    let reason: string | null;
    try {
      reason = exclusionReason(rel);
    } catch {
      reason = 'Invalid path';
    }
    const isStyle = STYLE_RE.test(rel) && !/(?:^|\/)(?:__tests__|tests?)\/|\.(?:test|spec)\./i.test(rel);
    if (reason === 'Unsupported file type' && isStyle) reason = null;
    if (!reason && rel !== '.gitignore' && ignore.ignored(rel)) reason = 'Root ignore rule';
    if (!reason && files.length >= maxFiles) reason = 'Beyond the configured file limit';
    if (reason) {
      skip(reason);
      continue;
    }
    const info = await stat(path.join(root, rel)).catch(() => undefined);
    if (!info) continue;
    if (info.size > 256 * 1024) {
      skip('File exceeds 256 KiB');
      continue;
    }
    live.add(rel);
    let entry = cache.files.get(rel);
    if (!entry || entry.mtimeMs !== info.mtimeMs || entry.size !== info.size) {
      entry = {
        mtimeMs: info.mtimeMs,
        size: info.size,
        content: await readFile(path.join(root, rel), 'utf8').catch(() => ''),
      };
      cache.files.set(rel, entry);
      changed = true;
    }
    const bad = contentExclusionReason(entry.content);
    if (bad) {
      skip(bad);
      continue;
    }
    const content = /(?:^|\/)\.env\.(?:example|sample)$/i.test(rel)
      ? sanitizeEnv(entry.content)
      : entry.content;
    contents.set(rel, content);
    if (isStyle) styleFiles.push(rel);
    // The engine indexes source/config/docs; pure stylesheets and markup go to Penny only.
    if (!/\.(?:css|scss|less|html|vue|svelte)$/i.test(rel)) {
      files.push({ relativePath: rel, content });
      totalBytes += entry.size;
    }
  }
  for (const rel of cache.files.keys())
    if (!live.has(rel)) {
      cache.files.delete(rel);
      changed = true;
    }
  if (!changed && cache.workspace) return { ...cache.workspace, reindexed: false };
  const project = indexProject({ name: path.basename(root), files, skippedReasons: skipped, totalBytes });
  cache.workspace = {
    root,
    project,
    byPath: new Map(project.files.map((f) => [f.path, f])),
    byId: new Map(project.files.map((f) => [f.id, f])),
    contents,
    styleFiles,
    skipped,
    reindexed: true,
  };
  return cache.workspace;
}

