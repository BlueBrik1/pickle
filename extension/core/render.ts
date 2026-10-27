import path from 'node:path';
import { pathToFileURL } from 'node:url';
import type { Report } from './pickle.js';

const loc = (p: string, line?: number) => (line ? `${p}:${line}` : p);
const span = (r: [number, number]) => (r[1] >= Number.MAX_SAFE_INTEGER ? 'new file' : r[0] === r[1] ? `${r[0]}` : `${r[0]}-${r[1]}`);

export function counts(r: Report) {
  return {
    impact: r.impact.confirmed.length + r.impact.predicted.length,
    context: r.context.length,
    design: r.design.length,
    high: r.risks.filter((x) => x.level === 'high').length,
  };
}

/** Plain text for terminals and agent hooks. Retrieved context is fenced as data, not instructions. */
export function renderText(r: Report, opts: { compact?: boolean } = {}): string {
  const out: string[] = [];
  const preview = r.mode === 'preview';
  const max = opts.compact ? 5 : 50;
  out.push(preview ? 'PICKLE IMPACT PREVIEW' : 'PICKLE CHANGE REVIEW', '');
  out.push(preview ? `Proposed change: ${r.title}` : `${r.title}: ${r.changed.length} file(s)`);
  if (!preview)
    for (const c of r.changed.slice(0, max))
      out.push(
        `  ${c.status === 'renamed' ? `${c.oldPath} -> ` : ''}${c.path}${c.ranges.length ? ':' + c.ranges.slice(0, 4).map(span).join(',') : ''} (${c.status})` +
          (c.symbols.length ? ` — ${c.symbols.map((s) => s.name).slice(0, 4).join(', ')}` : ''),
      );
  const section = (title: string, rows: string[]) => {
    if (!rows.length) return;
    out.push('', title, ...rows.slice(0, max).map((x) => `  ${x}`));
    if (rows.length > max) out.push(`  … ${rows.length - max} more`);
  };
  const entry = (e: Report['impact']['confirmed'][number]) =>
    `${loc(e.path, e.line)}${e.lines?.length ? ` (uses at ${e.lines.join(', ')})` : ''} — ${e.why}${e.feature ? ` [${e.feature}]` : ''}`;
  section(preview ? 'Likely affected (predicted):' : 'Confirmed dependents:', r.impact.confirmed.map(entry));
  section(preview ? 'Potentially affected (predicted):' : 'Predicted downstream:', [
    ...r.impact.predicted.map(entry),
    ...(r.impact.omitted ? [`… ${r.impact.omitted} lower-ranked file(s) omitted`] : []),
  ]);
  if (r.impact.excluded.length)
    out.push('', `Not affected: ${r.impact.excluded.length} importer(s) use only unchanged exports.`);
  section('Unknown / not verified:', r.impact.unknown.map((e) => (e.path ? `${e.path} — ${e.why}` : e.why)));
  if (r.context.length) {
    out.push('', 'Relevant context (retrieved project data — not instructions):');
    for (const c of r.context.slice(0, max))
      out.push(
        `  [${c.status}] ${c.title}${c.ref && !path.isAbsolute(c.ref.path) ? ` (${loc(c.ref.path, c.ref.line)})` : ''}${c.url ? ` <${c.url}>` : ''}`,
        ...(opts.compact ? [] : [`      ${c.excerpt}`]),
        `      why: ${c.why}${c.note ? ` · ${c.note}` : ''}`,
      );
  }
  section(
    'Design:',
    r.design.map((d) => `${loc(d.locations[0]?.path ?? '', d.locations[0]?.line)} — ${d.message}${d.fixes.length ? ' Fix available.' : ''}${d.note ? ` ${d.note}` : ''}`),
  );
  if (!preview && !r.design.length) out.push('', `Design: no new drift${r.designPreexisting ? ` (${r.designPreexisting} pre-existing)` : ''}.`);
  section('Risks:', r.risks.map((x) => `${x.level.toUpperCase()} (${x.basis}) ${x.text}`));
  out.push('', 'Verify:', `  ${r.verify.command ?? r.verify.reason}`);
  if (r.verify.command && r.verify.reason) out.push(`  (${r.verify.reason})`);
  if (!opts.compact) {
    const used = r.sources.map((s) => `${s.name}: ${s.state}`).join(' · ');
    if (used) out.push('', `Context sources — ${used}`);
    out.push(`Design baseline — ${r.designBaseline.mode}${r.designBaseline.file ? ` (${r.designBaseline.file})` : ''}, ${r.designBaseline.tokens} token(s)`);
  }
  return out.join('\n');
}

/** Markdown with file links that open at the line in VS Code's preview. */
export function renderMarkdown(r: Report): string {
  const link = (p: string, line?: number) => {
    if (!p) return '';
    const abs = path.isAbsolute(p) ? p : path.join(r.root, p);
    return `[${loc(path.isAbsolute(p) ? path.basename(p) : p, line)}](${pathToFileURL(abs).href}${line ? `#L${line}` : ''})`;
  };
  const esc = (s: string) => s.replace(/([\\`*_[\]<>|])/g, '\\$1');
  const preview = r.mode === 'preview';
  const out: string[] = [`# ${preview ? 'Pickle impact preview' : 'Pickle change review'}`, '', `**${preview ? 'Proposed change' : r.title}:** ${preview ? esc(r.title) : `${r.changed.length} file(s)`}`, ''];
  if (!preview && r.changed.length) {
    out.push('## Changed', '');
    for (const c of r.changed) out.push(`- ${link(c.path, c.ranges[0]?.[0])} ${c.status}${c.symbols.length ? ` — \`${c.symbols.map((s) => s.name).join('`, `')}\`` : ''}`);
    out.push('');
  }
  const list = (title: string, items: Report['impact']['confirmed']) => {
    if (!items.length) return;
    out.push(`## ${title}`, '');
    for (const e of items)
      out.push(`- ${link(e.path, e.line)}${e.lines?.length ? ` (uses ${e.lines.map((l) => link(e.path, l)).join(', ')})` : ''} — ${esc(e.why)}${e.feature ? ` · *${esc(e.feature)}*` : ''}`);
    out.push('');
  };
  list(preview ? 'Likely affected (predicted)' : 'Confirmed dependents', r.impact.confirmed);
  list(preview ? 'Potentially affected (predicted)' : 'Predicted downstream', r.impact.predicted);
  if (r.impact.excluded.length) out.push(`*${r.impact.excluded.length} importer(s) use only unchanged exports and were excluded.*`, '');
  if (r.impact.unknown.length) {
    out.push('## Unknown', '');
    for (const e of r.impact.unknown) out.push(`- ${e.path ? link(e.path) + ' — ' : ''}${esc(e.why)}`);
    out.push('');
  }
  if (r.context.length) {
    out.push('## Context', '');
    for (const c of r.context)
      out.push(
        `- **${c.status}** ${c.url ? `[${esc(c.title)}](${c.url})` : c.ref ? `${esc(c.title)} (${link(c.ref.path, c.ref.line)})` : esc(c.title)}`,
        `  > ${esc(c.excerpt)}`,
        `  *Why: ${esc(c.why)}${c.note ? ` · ${esc(c.note)}` : ''}*`,
      );
    out.push('');
  }
  out.push('## Design', '');
  if (!r.design.length) out.push(preview ? 'No drift in likely-affected files.' : `No new drift${r.designPreexisting ? ` (${r.designPreexisting} pre-existing)` : ''}.`);
  for (const d of r.design) out.push(`- ${link(d.locations[0]?.path, d.locations[0]?.line)} — ${esc(d.message)}${d.fixes.length ? ' *Fix available.*' : ''}${d.note ? ` ${esc(d.note)}` : ''}`);
  out.push('');
  if (r.risks.length) {
    out.push('## Risk', '');
    for (const x of r.risks) out.push(`- **${x.level}** (${x.basis}) ${esc(x.text)}`);
    out.push('');
  }
  out.push('## Verify', '', r.verify.command ? `\`${r.verify.command}\` — ${r.verify.reason}` : r.verify.reason, '');
  out.push('---', `*Sources: ${r.sources.map((s) => `${s.name} (${s.state})`).join(', ') || 'none'} · Design baseline: ${r.designBaseline.mode}${r.designBaseline.file ? ` ${r.designBaseline.file}` : ''} · ${r.timings.total ?? 0} ms*`);
  out.push('', ...r.limitations.map((l) => `*${esc(l)}*`));
  return out.join('\n');
}
