import { afterEach, describe, expect, it } from 'vitest';
import { applyFixes, scanDesign } from '../extension/core/design.js';
import { review } from '../extension/core/pickle.js';
import { loadWorkspace } from '../extension/core/workspace.js';
import { makeRepo } from './helpers/repo.js';

const files = {
  'tokens.json': JSON.stringify({ colors: { primary: '#2563eb', text: '#111827' }, spacing: { md: '16px' } }),
  'src/Button.tsx': 'export const Button = () => <button className="bg-[#2563eb] p-4">Go</button>;\n',
  'src/Card.tsx': 'export const Card = () => <div className="text-[#111827] p-4">Card</div>;\n',
  'src/app.css': '.title {\n  color: #111827;\n  padding: 16px;\n}\n',
};

let repo: ReturnType<typeof makeRepo>;
afterEach(() => repo?.cleanup());

describe('design drift (Penny)', () => {
  it('does not flag values that match tokens exactly', async () => {
    repo = makeRepo(files);
    const result = scanDesign(await loadWorkspace(repo.root));
    expect(result.baseline).toMatchObject({ mode: 'tokens-file', file: 'tokens.json' });
    expect(result.findings).toEqual([]);
  });

  it('detects a near-token value introduced on a changed line, with a valid fix location', async () => {
    repo = makeRepo(files);
    repo.write('src/Button.tsx', 'export const Button = () => <button className="bg-[#2a6bf0] p-4">Go</button>;\n');
    const r = await review(repo.root);
    expect(r.design).toHaveLength(1);
    const d = r.design[0];
    expect(d).toMatchObject({ category: 'value-drift', expected: '#2563eb', actual: ['#2a6bf0'], introduced: true });
    expect(d.locations).toEqual([{ path: 'src/Button.tsx', line: 1, raw: 'bg-[#2a6bf0]' }]);
    expect(d.fixes).toEqual([
      {
        path: 'src/Button.tsx',
        line: 1,
        before: 'export const Button = () => <button className="bg-[#2a6bf0] p-4">Go</button>;',
        after: 'export const Button = () => <button className="bg-[#2563eb] p-4">Go</button>;',
      },
    ]);
    expect(r.risks.some((x) => x.text.startsWith('Design drift introduced'))).toBe(true);
  });

  it('separates pre-existing drift from drift this change introduced', async () => {
    repo = makeRepo({ ...files, 'src/Old.tsx': 'export const Old = () => <i className="text-[#121a2b]" />;\n' });
    repo.write('src/Card.tsx', files['src/Card.tsx'].replace('Card</div>', 'Card!</div>'));
    const r = await review(repo.root);
    expect(r.design).toEqual([]);
    expect(r.designPreexisting).toBe(1);
  });

  it('notes context that may make a deviation intentional instead of dismissing it', async () => {
    repo = makeRepo({ ...files, 'docs/brand.md': '# Rebrand\n\nThe Button in src/Button.tsx moves to the new brand color #2a6bf0.\n' });
    repo.write('src/Button.tsx', 'export const Button = () => <button className="bg-[#2a6bf0] p-4">Go</button>;\n');
    const r = await review(repo.root);
    expect(r.design[0].note).toMatch(/Possibly intentional: docs\/brand\.md/);
  });

  it('applies only approved edits on unchanged lines and preserves unrelated edits', () => {
    const fix = { path: 'a.tsx', line: 2, before: '  <b className="bg-[#2a6bf0]" />', after: '  <b className="bg-[#2563eb]" />' };
    const text = 'const user = "edited elsewhere";\r\n  <b className="bg-[#2a6bf0]" />\r\nexport {};\r\n';
    const out = applyFixes(text, [fix]);
    expect(out.text).toBe('const user = "edited elsewhere";\r\n  <b className="bg-[#2563eb]" />\r\nexport {};\r\n');
    expect(out.applied).toEqual([fix]);
    // The line moved on since the preview: nothing is changed.
    const stale = applyFixes('  <b className="bg-[#000000]" />\n', [{ ...fix, line: 1 }]);
    expect(stale.text).toBe('  <b className="bg-[#000000]" />\n');
    expect(stale.stale).toHaveLength(1);
  });
});
