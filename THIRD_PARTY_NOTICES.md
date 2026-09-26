# Third-party notices

The MIT license at the repository root applies to original Pickle code and the original synthetic Pantry fixture. Dependencies retain their own copyright notices and licenses. Installed package versions are recorded in `package-lock.json`; preserve the notices included with packages when redistributing their code.

## Bundled fonts

Pickle self-hosts Source Serif Pro and Work Sans through Fontsource. Their font files are distributed under the SIL Open Font License 1.1. The original license texts have been copied without modification from the installed packages:

- Source Serif Pro: `@fontsource/source-serif-pro` 5.3.0, [license text](licenses/source-serif-pro-OFL.txt). The package notice credits Google Inc.
- Work Sans: `@fontsource/work-sans` 5.3.0, [license text](licenses/work-sans-OFL.txt). Copyright 2019 The Work Sans Project Authors.

The app uses Source Serif Pro weights 400 and 600 and Work Sans weights 400, 500, and 600. The OFL files govern font redistribution and reserved-name conditions; the fonts are not relicensed under Pickle's MIT license.

## Runtime and build packages

React, React DOM, Express, Zod, React Flow, Dagre, TypeScript, Vite, Vitest, Playwright, ESLint, and their transitive dependencies are third-party software. Their authoritative notices are the license files shipped in each installed package. No private source, real credentials, production datasets, or third-party sample application was used to create Pantry.
