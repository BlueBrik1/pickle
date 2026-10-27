// Penny (penny-design@0.2.0, github.com/BlueBrik1/penny @ 87363e1) is the design engine.
// Its deterministic parse -> baseline -> diff -> fixer path is used unchanged; no LLM calls.
import { existsSync } from 'node:fs';
import path from 'node:path';
import { diff, type Drift } from 'penny-design/src/diff.js';
import { buildDeterministicEdits, isFixable } from 'penny-design/src/fixer.js';
import { deriveCanonicalTokens, type Token } from 'penny-design/src/intrinsic.js';
import { parseSource, type Usage } from 'penny-design/src/parse.js';
import { loadTokenFile } from 'penny-design/src/token-file.js';
import type { Workspace } from './workspace.js';

export interface DesignFix {
  path: string;
  line: number;
  before: string;
  after: string;
}
export interface DesignFinding {
  id: string;
  category: Drift['category'];
  type: Drift['type'];
  expected: string | null;
  actual: string[];
  token?: string;
  locations: { path: string; line: number; raw: string }[];
  fixes: DesignFix[];
  /** At least one off-token location is on a changed line. */
  introduced: boolean;
  message: string;
  note?: string;
}
export interface DesignResult {
  findings: DesignFinding[];
  baseline: { mode: 'tokens-file' | 'intrinsic'; file?: string; tokens: number; warning?: string };
}

const TOKEN_FILES = ['design-tokens.json', 'tokens.json', 'src/tokens.json', 'src/design-tokens.json', 'src/styles/tokens.json', 'src/theme/tokens.json'];

export function scanDesign(
  ws: Workspace,
  opts: { tokensFile?: string; changed?: Map<string, [number, number][]> } = {},
): DesignResult {
  const usages: Usage[] = [];
  for (const file of ws.styleFiles) {
    try {
      usages.push(...parseSource(ws.contents.get(file) ?? '', file));
    } catch {
      // postcss rejects malformed stylesheets; Penny's CLI skips them the same way.
    }
  }
  let tokens: Token[] | undefined;
  let baseline: DesignResult['baseline'] = { mode: 'intrinsic', tokens: 0 };
  const candidates = opts.tokensFile ? [opts.tokensFile] : TOKEN_FILES;
  for (const rel of candidates) {
    const abs = path.resolve(ws.root, rel);
    if (path.relative(ws.root, abs).startsWith('..') || !existsSync(abs)) continue;
    try {
      tokens = loadTokenFile(abs);
      baseline = { mode: 'tokens-file', file: rel, tokens: tokens.length };
      break;
    } catch (e: any) {
      if (opts.tokensFile) baseline.warning = `${rel} ignored (${e.message}); using tokens inferred from code.`;
    }
  }
  if (!tokens) {
    tokens = deriveCanonicalTokens(usages);
    baseline.tokens = tokens.length;
  }
  const onChanged = (file: string, line: number) =>
    !!opts.changed?.get(file)?.some(([a, b]) => line >= a && line <= b);
  const findings = diff(tokens, usages).map((d): DesignFinding => {
    const off = d.locations.filter((l) => l.value !== d.expected);
    const byFile = new Map<string, Drift['locations']>();
    for (const l of d.locations) byFile.set(l.file, [...(byFile.get(l.file) ?? []), l]);
    const fixes = isFixable(d)
      ? [...byFile].flatMap(([file, locations]) =>
          buildDeterministicEdits({ ...d, locations }, ws.contents.get(file) ?? '').map((e) => ({
            path: file,
            line: e.line,
            before: e.before.replace(/\r$/, ''),
            after: e.after.replace(/\r$/, ''),
          })),
        )
      : [];
    const uses = d.expected ? usages.filter((u) => u.value === d.expected) : [];
    const spread = uses.length ? ` (used ${uses.length}× across ${new Set(uses.map((u) => u.file)).size} file(s))` : '';
    const message =
      d.category === 'value-drift'
        ? `${d.actualValues.join(', ')} is close to ${d.token?.name ?? 'token'} ${d.expected}${spread} but not equal.`
        : d.category === 'inconsistent-usage'
          ? `${d.token?.name ?? 'One token'} is written as ${d.actualValues.length} different values; expected ${d.expected}${spread}.`
          : `${d.actualValues.join(', ')} matches no ${d.type} token (${d.category}).`;
    return {
      id: `design:${d.category}:${d.type}:${d.actualValues.join('|')}`,
      category: d.category,
      type: d.type,
      expected: d.expected,
      actual: d.actualValues,
      token: d.token?.name,
      locations: (off.length ? off : d.locations).map((l) => ({ path: l.file, line: l.line, raw: l.raw })),
      fixes,
      introduced: off.some((l) => onChanged(l.file, l.line)),
      message,
    };
  });
  return { findings, baseline };
}

/** Apply edits to text only where the line still reads exactly as previewed; anything stale is skipped. */
export function applyFixes(text: string, fixes: DesignFix[]): { text: string; applied: DesignFix[]; stale: DesignFix[] } {
  const eol = text.includes('\r\n') ? '\r\n' : '\n';
  const lines = text.split(/\r?\n/);
  const applied: DesignFix[] = [],
    stale: DesignFix[] = [];
  for (const f of fixes) {
    if (lines[f.line - 1] === f.before) {
      lines[f.line - 1] = f.after;
      applied.push(f);
    } else stale.push(f);
  }
  return { text: lines.join(eol), applied, stale };
}
