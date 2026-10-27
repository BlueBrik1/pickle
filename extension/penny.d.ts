// Types for the parts of penny-design@0.2.0 (plain ESM JavaScript) that Pickle imports.
declare module 'penny-design/src/parse.js' {
  export interface Usage {
    type: 'color' | 'spacing' | 'typography';
    value: string;
    color?: string;
    px?: number;
    prop: string;
    selector: string;
    file: string;
    line: number;
    raw?: string;
    syntax?: { kind: string; prefix?: string };
  }
  export function parseSource(text: string, file?: string): Usage[];
}
declare module 'penny-design/src/intrinsic.js' {
  import type { Usage } from 'penny-design/src/parse.js';
  export interface Token {
    name: string;
    type: string;
    value: string;
    label?: string;
    color?: string;
    px?: number;
  }
  export function deriveCanonicalTokens(usages: Usage[]): Token[];
}
declare module 'penny-design/src/diff.js' {
  import type { Usage } from 'penny-design/src/parse.js';
  import type { Token } from 'penny-design/src/intrinsic.js';
  export interface Location {
    file: string;
    line: number;
    selector: string;
    prop: string;
    value: string;
    raw: string;
    syntax: { kind: string; prefix?: string };
  }
  export interface Drift {
    id: number;
    category: 'value-drift' | 'inconsistent-usage' | 'off-palette' | 'off-scale';
    type: 'color' | 'spacing' | 'typography';
    token: { name: string; value: string } | null;
    expected: string | null;
    actualValues: string[];
    locations: Location[];
    severity: 'high' | 'medium' | 'low';
  }
  export function diff(tokens: Token[], usages: Usage[]): Drift[];
}
declare module 'penny-design/src/token-file.js' {
  import type { Token } from 'penny-design/src/intrinsic.js';
  export function loadTokenFile(filePath: string): Token[];
}
declare module 'penny-design/src/fixer.js' {
  import type { Drift } from 'penny-design/src/diff.js';
  export interface Edit {
    line: number;
    find: string;
    replace: string;
    before: string;
    after: string;
    file: string;
  }
  export function isFixable(drift: Drift): boolean;
  export function buildDeterministicEdits(drift: Drift, src: string): Edit[];
}
