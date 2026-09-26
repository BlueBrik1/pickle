import { describe, it, expect } from 'vitest';
import { validateSnapshot } from '../server/ingestion.js';
import {
  normalizePath,
  sanitizeEnv,
  redact,
  exclusionReason,
  decodeUtf8,
  parseRootIgnore,
} from '../src/shared/ingestion.js';
import { LIMITS } from '../src/shared/schema.js';
const project = (files: { relativePath: string; content: string }[]) => ({
  name: 'Synthetic test',
  files,
});
const file = (relativePath: string, content = 'export const value = 1;') => ({
  relativePath,
  content,
});

describe('safe immutable snapshot boundary', () => {
  it.each([
    '/absolute.ts',
    'C:\\private.ts',
    '\\\\host\\share.ts',
    '../bad.ts',
    'src/./bad.ts',
    'src//bad.ts',
    'src\\\\bad.ts',
    'src/%2e%2e/bad.ts',
    'src/\u0000bad.ts',
    'src/\nbad.ts',
    'src/\u0085bad.ts',
    'src/\u202ebad.ts',
    'src/\ud800bad.ts',
  ])('rejects malformed path %s', (path) => {
    expect(() => validateSnapshot(project([file(path)]))).toThrow('Invalid project-relative path');
  });
  it('normalizes Windows separators without flattening a nested folder', () => {
    expect(normalizePath('src\\pages\\Account.tsx')).toBe('src/pages/Account.tsx');
  });
  it('rejects duplicate normalized and case-colliding paths', () => {
    expect(() => validateSnapshot(project([file('src/a.ts'), file('src\\a.ts')]))).toThrow(
      'Duplicate',
    );
    expect(() => validateSnapshot(project([file('src/a.ts'), file('src/A.ts')]))).toThrow(
      'Case-colliding',
    );
  });
  it('always excludes secrets and generated files even after ignore negations', () => {
    const snapshot = validateSnapshot(
      project([
        file('safe.ts'),
        file('.env', 'TOKEN=private'),
        file('node_modules/lib/a.ts'),
        file('dist/a.ts'),
        file('credentials.json'),
        file('key.pem'),
        file('picture.png'),
        file('package-lock.json'),
        file('.gitignore', '!node_modules/**\n!.env\n!credentials.json'),
      ]),
    );
    expect(snapshot.files.map((item) => item.relativePath)).toEqual(['safe.ts', '.gitignore']);
    expect(snapshot.skippedReasons['Secret or credential file']).toBe(3);
    expect(snapshot.skippedReasons['Generated or dependency directory']).toBe(2);
  });
  it('discards env values and comments before retention, preserving line positions', () => {
    const input =
      '# top-secret comment\nUPLOAD_BUCKET=private-bucket\nexport TOKEN = "private-token"\nINVALID-NAME=secret\n';
    expect(sanitizeEnv(input)).toBe('\nUPLOAD_BUCKET=\nTOKEN=\n\n');
    const snapshot = validateSnapshot(project([file('.env.example', input)]));
    expect(snapshot.files[0]?.content).not.toContain('private');
    expect(snapshot.files[0]?.content.split('\n')).toHaveLength(input.split('\n').length);
    expect(validateSnapshot(project([file('.ENV.EXAMPLE', input)])).files[0]?.content).toBe(
      sanitizeEnv(input),
    );
  });
  it('validates original UTF-8 bytes and rejects malformed Unicode or binary content on the server', () => {
    expect(() => decodeUtf8(new Uint8Array([0xc3, 0x28]).buffer)).toThrow('Malformed UTF-8');
    const snapshot = validateSnapshot(
      project([
        file('valid.ts'),
        file('binary.ts', 'ab\0cd'),
        file('replacement.ts', '\ufffd'),
        file('surrogate.ts', '\ud800'),
      ]),
    );
    expect(snapshot.files).toHaveLength(1);
    expect(snapshot.skippedReasons['Malformed UTF-8']).toBe(2);
    expect(snapshot.skippedReasons['Binary content']).toBe(1);
  });
  it('excludes recognizable credential JSON despite a harmless filename', () => {
    const snapshot = validateSnapshot(
      project([
        file('good.ts'),
        file('config.json', '{"type":"service_account","private_key":"never-retain"}'),
      ]),
    );
    expect(snapshot.skippedReasons['Secret or credential content']).toBe(1);
  });
  it('records per-file size skips but rejects global capacity instead of truncating', () => {
    const snapshot = validateSnapshot(
      project([file('small.ts'), file('large.ts', 'a'.repeat(LIMITS.fileBytes + 1))]),
    );
    expect(snapshot.skippedReasons['File exceeds 256 KiB']).toBe(1);
    expect(() =>
      validateSnapshot(
        project(Array.from({ length: LIMITS.files + 1 }, (_, i) => file(`${i}.ts`))),
      ),
    ).toThrow('Select a smaller project');
    expect(() =>
      validateSnapshot(
        project(
          Array.from({ length: 33 }, (_, i) => file(`${i}.ts`, 'x'.repeat(LIMITS.fileBytes))),
        ),
      ),
    ).toThrow('Select a smaller project');
  });
  it('counts UTF-8 bytes instead of JavaScript characters', () => {
    const snapshot = validateSnapshot(project([file('readme.md', '🍐')]));
    expect(snapshot.totalBytes).toBe(4);
  });
  it('treats malicious source and scripts as inert text', () => {
    const source = 'globalThis.__pickleExecuted = true; throw new Error("do not run")';
    const scripts = '{"scripts":{"install":"rm -rf /"}}';
    const snapshot = validateSnapshot(
      project([file('malicious.ts', source), file('package.json', scripts)]),
    );
    expect(snapshot.files[0]?.content).toBe(source);
    expect(snapshot.files[1]?.content).toBe(scripts);
    expect('__pickleExecuted' in globalThis).toBe(false);
  });
  it('applies supported root ignore patterns and reports unsupported syntax', () => {
    const rules = parseRootIgnore('/local/\n*.generated.ts\nlogs/**\n!logs/keep.ts\n[ab].ts');
    expect(rules.ignored('local/a.ts')).toBe(true);
    expect(rules.ignored('src/local/a.ts')).toBe(false);
    expect(rules.ignored('src/a.generated.ts')).toBe(true);
    expect(rules.ignored('logs/keep.ts')).toBe(false);
    expect(rules.unsupported).toHaveLength(1);
    const snapshot = validateSnapshot(
      project([file('.gitignore', 'tmp/**'), file('tmp/ignored.ts'), file('keep.ts')]),
    );
    expect(snapshot.skippedReasons['Root ignore rule']).toBe(1);
  });
  it('redacts likely credentials in snippets while preserving newline positions', () => {
    const secret =
      'apiKey = "my-private-value"\nAuthorization: "Bearer secret-value"\nconst okay=1';
    const cleaned = redact(secret);
    expect(cleaned).not.toContain('my-private-value');
    expect(cleaned).not.toContain('secret-value');
    expect(cleaned.split('\n')).toHaveLength(3);
    expect(exclusionReason('src/.env.production')).toBe('Secret or credential file');
  });
  it('bounds adversarial ignore rules without regex backtracking or recursion overflow', () => {
    const rules = parseRootIgnore('*a'.repeat(100) + 'b\n' + '**/'.repeat(1000) + 'secret.ts');
    expect(rules.ignored('a'.repeat(250) + '.ts')).toBe(false);
    expect(rules.unsupported).toHaveLength(1);
    const many = parseRootIgnore(
      Array.from({ length: 2050 }, (_, i) => `ignored-${i}.ts`).join('\n'),
    );
    expect(many.unsupported).toHaveLength(1);
    expect(many.ignored('ignored-2049.ts')).toBe(false);
  });
});
