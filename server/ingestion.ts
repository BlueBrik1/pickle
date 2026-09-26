import { importSchema, LIMITS, type Snapshot } from '../src/shared/schema.js';
import {
  normalizePath,
  exclusionReason,
  contentExclusionReason,
  sanitizeEnv,
  parseRootIgnore,
  utf8Bytes,
  redact,
} from '../src/shared/ingestion.js';

export function validateSnapshot(input: unknown): Snapshot {
  const parsed = importSchema.safeParse(input);
  if (!parsed.success)
    throw new Error('Invalid project snapshot. Check its name, files, and input limits.');
  const data = parsed.data,
    skippedReasons: Record<string, number> = {};
  // These are client-reported counts, kept distinct from repeated server checks.
  for (const [reason, count] of Object.entries(data.clientSkipped ?? {})) {
    const allowed = [
      'Generated or dependency directory',
      'Secret or credential file',
      'Lockfile or source map',
      'Unsupported file type',
      'Malformed UTF-8',
      'Binary content',
      'Secret or credential content',
      'File exceeds 256 KiB',
      'Root ignore rule',
    ];
    if (allowed.includes(reason) && count > 0)
      skippedReasons[reason] = (skippedReasons[reason] ?? 0) + count;
  }
  const seen = new Set<string>(),
    caseSeen = new Set<string>();
  const entries = data.files.map((file) => {
    const relativePath = normalizePath(file.relativePath),
      lower = relativePath.toLowerCase();
    if (seen.has(relativePath)) throw new Error('Duplicate normalized paths are not allowed.');
    if (caseSeen.has(lower))
      throw new Error('Case-colliding paths are ambiguous. Rename one before importing.');
    seen.add(relativePath);
    caseSeen.add(lower);
    return { relativePath, content: file.content };
  });
  const ignoreFile = entries.find((file) => file.relativePath === '.gitignore');
  const ignore = parseRootIgnore(
    ignoreFile && !contentExclusionReason(ignoreFile.content) ? ignoreFile.content : '',
  );
  const files: Snapshot['files'] = [];
  let totalBytes = 0;
  for (const file of entries) {
    const reason =
      exclusionReason(file.relativePath) ??
      contentExclusionReason(file.content) ??
      (file.relativePath !== '.gitignore' && ignore.ignored(file.relativePath)
        ? 'Root ignore rule'
        : null);
    if (reason) {
      skippedReasons[reason] = (skippedReasons[reason] ?? 0) + 1;
      continue;
    }
    const content = /\/(?:\.env\.example|\.env\.sample)$|^(?:\.env\.example|\.env\.sample)$/i.test(
      file.relativePath,
    )
      ? sanitizeEnv(file.content)
      : file.content;
    totalBytes += utf8Bytes(content);
    files.push({ relativePath: file.relativePath, content });
    if (files.length > LIMITS.files || totalBytes > LIMITS.totalBytes)
      throw new Error(
        'Project exceeds 1,500 files or 8 MiB of accepted text. Select a smaller project.',
      );
  }
  if (!files.length) throw new Error('No supported text files were accepted.');
  return {
    name: redact(data.name.replace(/[\u0000-\u001f\u007f]/g, '')),
    files,
    skippedReasons,
    totalBytes,
  };
}
