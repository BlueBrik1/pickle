import ts from 'typescript';
import path from 'node:path';
import type { Snapshot } from '../../src/shared/schema.js';

/** This host deliberately has no ts.sys or native-filesystem fallback. */
export function createResolver(snapshot: Snapshot, warnings: string[], unsupported: string[]) {
  const root = '/snapshot';
  const files = new Map(snapshot.files.map((f) => [`${root}/${f.relativePath}`, f.content]));
  const safe = (p: string) => p.startsWith(`${root}/`) && files.has(p);
  const host: ts.ModuleResolutionHost = {
    fileExists: safe,
    readFile: (p) => (safe(p) ? files.get(p) : undefined),
    directoryExists: (p) =>
      (p === root || p.startsWith(`${root}/`)) &&
      [...files.keys()].some((f) => f.startsWith(p + '/')),
    getCurrentDirectory: () => root,
    realpath: (p) => p,
    useCaseSensitiveFileNames: true,
  };
  const configPath = files.has(`${root}/tsconfig.json`)
    ? `${root}/tsconfig.json`
    : files.has(`${root}/jsconfig.json`)
      ? `${root}/jsconfig.json`
      : undefined;
  let options: ts.CompilerOptions = {
    module: ts.ModuleKind.ESNext,
    moduleResolution: ts.ModuleResolutionKind.Bundler,
    allowJs: true,
    resolveJsonModule: true,
  };
  const aliases: string[] = [];
  const packages = new Set<string>();
  try {
    const manifest = JSON.parse(files.get(`${root}/package.json`) ?? '{}') as Record<
      string,
      Record<string, unknown>
    >;
    for (const key of [
      'dependencies',
      'devDependencies',
      'peerDependencies',
      'optionalDependencies',
    ])
      for (const name of Object.keys(manifest[key] ?? {})) packages.add(name);
  } catch {
    warnings.push('Root package.json could not be parsed for external dependency names.');
  }
  function readConfig(p: string, chain: string[]): Record<string, unknown> {
    if (chain.includes(p) || chain.length >= 8) {
      unsupported.push('Configuration inheritance cycle or depth limit (8).');
      return {};
    }
    const text = files.get(p);
    if (text === undefined) {
      warnings.push(`In-snapshot configuration missing: ${p.slice(root.length + 1)}`);
      return {};
    }
    const parsed = ts.parseConfigFileTextToJson(p, text);
    if (parsed.error) {
      warnings.push(`Invalid JSONC configuration: ${p.slice(root.length + 1)}`);
      return {};
    }
    const config = parsed.config as {
      extends?: unknown;
      compilerOptions?: Record<string, unknown>;
    };
    let inherited: Record<string, unknown> = {};
    if (config.extends !== undefined) {
      if (typeof config.extends === 'string' && config.extends.startsWith('.')) {
        let next = path.posix.resolve(path.posix.dirname(p), config.extends);
        if (!next.endsWith('.json')) next += '.json';
        if (next.startsWith(root + '/')) inherited = readConfig(next, [...chain, p]);
        else unsupported.push('Out-of-snapshot configuration inheritance ignored.');
      } else
        unsupported.push('Only a relative, in-snapshot configuration extends string is supported.');
    }
    const current = { ...(config.compilerOptions ?? {}) };
    if (current.plugins) {
      unsupported.push('TypeScript plugins are ignored and never loaded.');
      delete current.plugins;
    }
    // Resolve path-bearing options against the file that declared them before merging.
    if (typeof current.baseUrl === 'string')
      current.baseUrl = path.posix.resolve(path.posix.dirname(p), current.baseUrl);
    if (current.paths && typeof current.paths === 'object') {
      const base =
        typeof current.baseUrl === 'string'
          ? current.baseUrl
          : typeof inherited.baseUrl === 'string'
            ? inherited.baseUrl
            : path.posix.dirname(p);
      current.paths = Object.fromEntries(
        Object.entries(current.paths).map(([key, values]) => [
          key,
          Array.isArray(values)
            ? values.filter((v) => typeof v === 'string').map((v) => path.posix.resolve(base, v))
            : [],
        ]),
      );
    }
    return { ...inherited, ...current };
  }
  if (configPath) {
    const raw = readConfig(configPath, []);
    if (raw.paths && typeof raw.paths === 'object') aliases.push(...Object.keys(raw.paths));
    const converted = ts.convertCompilerOptionsFromJson(raw, root);
    if (converted.errors.length)
      warnings.push(
        'Some TypeScript configuration options are invalid; supported options are used.',
      );
    options = { ...options, ...converted.options };
    // These modes require package/runtime context that this bounded resolver does not model.
    if (
      options.moduleResolution !== ts.ModuleResolutionKind.Bundler &&
      options.moduleResolution !== ts.ModuleResolutionKind.Node10
    ) {
      unsupported.push(
        'Configured resolution mode is not modeled; using Bundler syntax resolution.',
      );
      options.moduleResolution = ts.ModuleResolutionKind.Bundler;
      options.module = ts.ModuleKind.ESNext;
    }
  }
  const cache = ts.createModuleResolutionCache(root, (x) => x, options);
  return {
    configuration: `${configPath ? configPath.slice(root.length + 1) : 'Default (no root config)'}; ${ts.ModuleResolutionKind[options.moduleResolution!]} virtual snapshot resolution`,
    resolve(
      specifier: string,
      from: string,
    ): { path?: string; status: 'resolved' | 'external' | 'unresolved' } {
      const resolved = ts.resolveModuleName(
        specifier,
        `${root}/${from}`,
        options,
        host,
        cache,
      ).resolvedModule;
      if (resolved && safe(resolved.resolvedFileName))
        return { path: resolved.resolvedFileName.slice(root.length + 1), status: 'resolved' };
      const alias = aliases.some((a) =>
        a.includes('*')
          ? specifier.startsWith(a.split('*')[0]) && specifier.endsWith(a.split('*')[1])
          : a === specifier,
      );
      const packageName = specifier.startsWith('@')
        ? specifier.split('/').slice(0, 2).join('/')
        : specifier.split('/')[0];
      // A declared dependency or node: builtin remains external even under baseUrl.
      const knownExternal = packages.has(packageName) || specifier.startsWith('node:');
      const local =
        !knownExternal &&
        (specifier.startsWith('.') ||
          specifier.startsWith('/') ||
          alias ||
          specifier.startsWith('#') ||
          !!options.baseUrl);
      return { status: local ? 'unresolved' : 'external' };
    },
  };
}
