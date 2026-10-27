# Third-party notices

The MIT license at the repository root applies to original Pickle code and the original synthetic Pantry fixture. Dependencies retain their own copyright notices and licenses. Installed package versions are recorded in `package-lock.json`; preserve the notices included with packages when redistributing their code.

## Bundled fonts

Pickle self-hosts Source Serif Pro and Work Sans through Fontsource. Their font files are distributed under the SIL Open Font License 1.1. The original license texts have been copied without modification from the installed packages:

- Source Serif Pro: `@fontsource/source-serif-pro` 5.3.0, [license text](licenses/source-serif-pro-OFL.txt). The package notice credits Google Inc.
- Work Sans: `@fontsource/work-sans` 5.3.0, [license text](licenses/work-sans-OFL.txt). Copyright 2019 The Work Sans Project Authors.

The app uses Source Serif Pro weights 400 and 600 and Work Sans weights 400, 500, and 600. The OFL files govern font redistribution and reserved-name conditions; the fonts are not relicensed under Pickle's MIT license.

## Runtime and build packages

React, React DOM, Express, Zod, React Flow, Dagre, TypeScript, Vite, Vitest, Playwright, ESLint, and their transitive dependencies are third-party software. Their authoritative notices are the license files shipped in each installed package. No private source, real credentials, production datasets, or third-party sample application was used to create Pantry.

## Integrated projects (VS Code extension)

- **Penny** — `penny-design` 0.2.0 from npm (MIT, per its `package.json`; source [BlueBrik1/penny](https://github.com/BlueBrik1/penny) at commit `87363e165747f782056d76b4770bb21d1dbe2c70`, identical to the npm release apart from line endings). Pickle imports, unmodified, `src/parse.js`, `src/css.js`, `src/color.js`, `src/intrinsic.js`, `src/diff.js`, `src/token-file.js`, `src/fixer.js` and `src/concrete-fix.js`, and bundles them into `dist-ext/`. Penny's dependency `postcss` (MIT) is bundled with them.
- **ShadowQA** — [BlueBrik1/shadowqa](https://github.com/BlueBrik1/shadowqa) at commit `50beee86fdbffff6464497fe727b72ce5742e2af`. The repository has no license file; it is by the same author as Pickle and was adapted at the author's direction. `extension/core/shadowqa.ts` adapts `sanitize()` from `src/core/security.ts` and the local transcript readers from `individual/companion/src/adapters/claude-code.ts` and `codex.ts`; `extension/core/context.ts` reuses the shape of `src/adapters/github.ts` issue/PR normalization and the requirement/decision/suggestion distinction from `individual/core/extract.ts`. Add a license to ShadowQA before redistributing Pickle outside the author's own use.
