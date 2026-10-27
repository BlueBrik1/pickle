import { defineConfig } from 'rolldown';

// The extension host loads CommonJS; `.js` specifiers in TypeScript sources map to `.ts`.
const common = {
  platform: 'node',
  external: ['vscode'],
  resolve: { extensionAlias: { '.js': ['.ts', '.js'] } },
  // Penny modules run a self-check when import.meta.url matches argv[1]; inside a bundle it always would.
  transform: { define: { 'import.meta.url': '"file:///bundled"' } },
};
export default defineConfig([
  { ...common, input: 'extension/vscode/extension.ts', output: { file: 'dist-ext/extension.cjs', format: 'cjs' } },
  { ...common, input: 'extension/vscode/worker.ts', output: { file: 'dist-ext/worker.cjs', format: 'cjs' } },
  { ...common, input: 'extension/cli.ts', output: { file: 'dist-ext/cli.cjs', format: 'cjs' } },
]);
