import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
const css = readFileSync('src/styles.css', 'utf8');
describe('required visual rules', () => {
  it('contains no gradients and only approved literal colors', () => {
    expect(css).not.toMatch(/gradient\s*\(/i);
    const colors = css.match(/#[a-f0-9]{3,8}\b/gi) ?? [];
    expect([...new Set(colors.map((c) => c.toLowerCase()))].sort()).toEqual([
      '#181818',
      '#80ad89',
      '#d96b65',
      '#f3f0e8',
    ]);
    const functional = css.match(/rgba?\([^)]+\)/g) ?? [];
    for (const value of functional)
      expect(value.replaceAll(' ', '')).toMatch(/^rgba?\((?:243,240,232|24,24,24)(?:,[.\d]+)?\)$/);
  });
  it('uses the required font weights without an editor font', () => {
    const entry = readFileSync('src/main.tsx', 'utf8');
    for (const font of [
      'source-serif-pro/400',
      'source-serif-pro/600',
      'work-sans/400',
      'work-sans/500',
      'work-sans/600',
    ])
      expect(entry).toContain(font);
    expect(css).not.toMatch(/monospace|Inter|Geist|Source Serif 4/);
  });
  it('meets 4.5:1 for body, muted, danger and success on charcoal', () => {
    const luminance = (rgb: number[]) =>
      rgb
        .map((v) => {
          v /= 255;
          return v <= 0.04045 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4;
        })
        .reduce((sum, v, i) => sum + v * [0.2126, 0.7152, 0.0722][i], 0);
    const bg = luminance([24, 24, 24]);
    for (const color of [
      [243, 240, 232],
      [243, 240, 232].map((v) => v * 0.68 + 24 * 0.32),
      [217, 107, 101],
      [128, 173, 137],
    ])
      expect((luminance(color) + 0.05) / (bg + 0.05)).toBeGreaterThanOrEqual(4.5);
  });
});
