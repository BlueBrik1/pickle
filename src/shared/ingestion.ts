import { LIMITS } from './schema.js';

const generated = new Set([
  '.git',
  'node_modules',
  'dist',
  'build',
  'coverage',
  '.next',
  '.nuxt',
  '.turbo',
  '.cache',
  'cache',
  'caches',
  'vendor',
  'vendors',
  'generated',
  '__generated__',
  '.output',
  '.parcel-cache',
]);
const sourceExtension = /\.(?:[cm]?[jt]sx?|sql|mdx?|jsonc?|ya?ml)$/i;
const encoder = new TextEncoder();
export const utf8Bytes = (text: string): number => encoder.encode(text).length;

/** Normalize separators only: never collapse dot segments or URL-decode a path. */
export function normalizePath(path: string): string {
  if (
    !path ||
    path.length > LIMITS.pathLength ||
    /[\u0000-\u001f\u007f-\u009f\u202a-\u202e\u2066-\u2069]/.test(path) ||
    /[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/.test(path) ||
    /^[\/\\]/.test(path) ||
    /^[a-z]:/i.test(path) ||
    /[:]/.test(path)
  )
    throw new Error('Invalid project-relative path.');
  const normalized = path.replace(/\\/g, '/');
  if (
    normalized.split('/').some((part) => !part || part === '.' || part === '..') ||
    /%(?:2e|2f|5c|00)/i.test(normalized)
  )
    throw new Error('Invalid project-relative path.');
  return normalized;
}

export function exclusionReason(path: string): string | null {
  const normalized = normalizePath(path),
    parts = normalized.toLowerCase().split('/'),
    name = parts.at(-1)!;
  if (parts.slice(0, -1).some((part) => generated.has(part)))
    return 'Generated or dependency directory';
  if (/^\.env(?:\.|$)/.test(name) && !['.env.example', '.env.sample'].includes(name))
    return 'Secret or credential file';
  if (
    /\.(pem|key|p12|pfx|crt|cer|der|keystore)$/.test(name) ||
    /^(id_rsa|id_ed25519|id_dsa|id_ecdsa)(\.|$)/.test(name) ||
    /(?:credentials?|service[-_]?account|secrets?)(?:[._-]|$)/.test(name) ||
    ['.npmrc', '.netrc', '.pypirc'].includes(name)
  )
    return 'Secret or credential file';
  if (
    /^(package-lock\.json|npm-shrinkwrap\.json|yarn\.lock|pnpm-lock\.yaml|bun\.lockb?|composer\.lock)$/.test(
      name,
    ) ||
    name.endsWith('.map')
  )
    return 'Lockfile or source map';
  if (['.env.example', '.env.sample'].includes(name) || normalized === '.gitignore') return null;
  return sourceExtension.test(name) ? null : 'Unsupported file type';
}

/** Preserve line positions and valid keys, discard comments and every value. */
export function sanitizeEnv(content: string): string {
  return content
    .split('\n')
    .map((line) => {
      const match = /^\s*(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=/.exec(line);
      return match ? `${match[1]}=` : '';
    })
    .join('\n');
}

/** Best effort display/export redaction, preserving newline count. */
export function redact(content: string): string {
  return content
    .replace(
      /-----BEGIN [^-\r\n]*PRIVATE KEY-----[\s\S]*?-----END [^-\r\n]*PRIVATE KEY-----/g,
      (value) => value.replace(/[^\r\n]+/g, '[REDACTED]'),
    )
    .replace(
      /\b(?:sk-(?:proj-)?[A-Za-z0-9_-]{16,}|gh[pousr]_[A-Za-z0-9]{20,}|github_pat_[A-Za-z0-9_]{20,}|AKIA[A-Z0-9]{16}|eyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,})\b/g,
      '[REDACTED]',
    )
    .replace(
      /((?:["']?(?:password|passwd|secret|api[_-]?key|access[_-]?token|refresh[_-]?token|client[_-]?secret|token|authorization)["']?)\s*[:=]\s*)(["'`])[^\r\n]*?\2/gi,
      '$1$2[REDACTED]$2',
    )
    .replace(
      /((?:password|passwd|secret|api[_-]?key|access[_-]?token|refresh[_-]?token|client[_-]?secret|token)\s*[:=]\s*)(?!["'`\s])[^\s,;)}]+/gi,
      '$1[REDACTED]',
    )
    .replace(/\b(Bearer|Basic)\s+[A-Za-z0-9._~+\/-]+=*/gi, '$1 [REDACTED]')
    .replace(/(https?:\/\/)[^\s/@:]+:[^\s/@]+@/gi, '$1[REDACTED]@');
}

export function contentExclusionReason(content: string): string | null {
  // JSON strings are Unicode already. Reject replacements/unpaired surrogates;
  // browser decodeUtf8 validates original bytes before building the payload.
  if (
    /\uFFFD/.test(content) ||
    /[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/.test(content)
  )
    return 'Malformed UTF-8';
  if (/[\u0000-\u0008\u000b\u000c\u000e-\u001f]/.test(content)) return 'Binary content';
  if (
    /"type"\s*:\s*"service_account"/.test(content) ||
    /"private_key"\s*:\s*"/.test(content) ||
    /-----BEGIN [^-\r\n]*PRIVATE KEY-----/.test(content)
  )
    return 'Secret or credential content';
  if (utf8Bytes(content) > LIMITS.fileBytes) return 'File exceeds 256 KiB';
  return null;
}

export function decodeUtf8(bytes: ArrayBuffer): string {
  try {
    return new TextDecoder('utf-8', { fatal: true }).decode(bytes);
  } catch {
    throw new Error('Malformed UTF-8');
  }
}

export interface IgnoreRules {
  ignored: (path: string) => boolean;
  unsupported: string[];
}
// Greedy segment matching avoids user-authored exponential regular expressions.
function segmentMatches(pattern: string, text: string): boolean {
  let p = 0,
    t = 0,
    star = -1,
    retry = 0;
  while (t < text.length) {
    if (pattern[p] === '?' || pattern[p] === text[t]) {
      p++;
      t++;
    } else if (pattern[p] === '*') {
      star = p++;
      retry = t;
    } else if (star >= 0) {
      p = star + 1;
      t = ++retry;
    } else return false;
  }
  while (pattern[p] === '*') p++;
  return p === pattern.length;
}
function pathMatches(pattern: string[], parts: string[], directory: boolean): boolean {
  const memo = new Map<string, boolean>();
  const match = (p: number, t: number): boolean => {
    const key = `${p}:${t}`;
    if (memo.has(key)) return memo.get(key)!;
    let answer: boolean;
    if (p === pattern.length) answer = !directory || t < parts.length;
    else if (pattern[p] === '**') answer = match(p + 1, t) || (t < parts.length && match(p, t + 1));
    else answer = t < parts.length && segmentMatches(pattern[p]!, parts[t]!) && match(p + 1, t + 1);
    memo.set(key, answer);
    return answer;
  };
  return match(0, 0);
}
/** Root rules: comments, !, / anchors, directory suffixes, *, **, and ?. */
export function parseRootIgnore(content: string): IgnoreRules {
  const rules: { negative: boolean; matches: (path: string) => boolean }[] = [],
    unsupported: string[] = [];
  for (const raw of content.split(/\r?\n/)) {
    const line = raw.trim();
    if (!line || line.startsWith('#')) continue;
    if (line.length > LIMITS.pathLength || rules.length >= 2048) {
      unsupported.push(
        'Root ignore processing supports at most 2,048 rules of 512 characters each; excess rules are not applied.',
      );
      continue;
    }
    if (/[\[\]\\]/.test(line) || line.includes('..')) {
      unsupported.push(
        'An ignore rule uses unsupported escaping, character classes, or dot segments.',
      );
      continue;
    }
    const negative = line.startsWith('!');
    let pattern = negative ? line.slice(1) : line;
    const anchored = pattern.startsWith('/');
    pattern = pattern.replace(/^\//, '');
    const directory = pattern.endsWith('/');
    pattern = pattern.replace(/\/$/, '');
    if (!pattern) continue;
    const hasSlash = pattern.includes('/');
    const patternParts = pattern.split('/');
    rules.push({
      negative,
      matches(path: string) {
        const parts = path.split('/');
        return anchored || hasSlash
          ? pathMatches(patternParts, parts, directory)
          : parts.some(
              (part, index) =>
                segmentMatches(pattern, part) && (!directory || index < parts.length - 1),
            );
      },
    });
  }
  return {
    unsupported: [...new Set(unsupported)],
    ignored(path: string) {
      let ignored = false;
      for (const rule of rules) if (rule.matches(path)) ignored = !rule.negative;
      return ignored;
    },
  };
}
