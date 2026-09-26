import { describe, it, expect } from 'vitest';
import { renderExport } from '../server/analysis/exports.js';
import { resultSchema, type AnalysisResult } from '../src/shared/schema.js';

function fixture(): AnalysisResult {
  return {
    schemaVersion: '1.0',
    analyzerVersion: 'test',
    rulesVersion: 'test',
    analysisId: 'analysis-one',
    repositoryId: 'repo-one',
    snapshotFingerprint: 'sha256-test',
    requestText: 'Add account deletion; inspect original code.',
    seedFileIds: ['file-one'],
    settings: { maxDepth: 3, includeTypeOnly: true },
    createdAt: '2026-09-26T12:00:00Z',
    completedAt: '2026-09-26T12:00:00Z',
    durationMs: 12,
    files: [
      {
        id: 'file-one',
        path: 'src/account.ts',
        category: 'api',
        categoryBasis: 'path-rule',
        sizeBytes: 80,
        lineCount: 4,
        parseStatus: 'parsed',
      },
      {
        id: 'file-two',
        path: 'tests/account.test.ts',
        category: 'test',
        categoryBasis: 'path-rule',
        sizeBytes: 20,
        lineCount: 2,
        parseStatus: 'parsed',
      },
    ],
    evidence: [
      {
        id: 'evidence-one',
        ruleId: 'import',
        level: 'structural',
        spans: [{ fileId: 'file-two', startLine: 1, startColumn: 1, endLine: 1, endColumn: 20 }],
        summary: 'A test imports the account module.',
        limitations: ['Import does not establish behavioral coverage.'],
      },
    ],
    relationships: [
      {
        id: 'edge-one',
        fromFileId: 'file-two',
        toFileId: 'file-one',
        kind: 'import',
        level: 'structural',
        typeOnly: false,
        evidenceIds: ['evidence-one'],
      },
    ],
    impacts: [
      {
        fileId: 'file-one',
        roles: ['seed'],
        primaryRole: 'seed',
        depth: 0,
        explanationPath: [],
        score: 10,
        priority: 'low',
        scoreComponents: [
          {
            ruleId: 'seed',
            points: 10,
            explanation: 'Confirmed starting file',
            evidenceIds: [],
            requestDerived: false,
          },
        ],
        testReferences: {
          status: 'direct',
          testFileIds: ['file-two'],
          evidenceIds: ['evidence-one'],
          limitations: ['Existing read test only.'],
        },
      },
    ],
    findings: [
      {
        id: 'finding-one',
        ruleId: 'review',
        title: 'Inspect the account contract',
        explanation: 'Proposed deletion requires a reviewed contract.',
        fileIds: ['file-one'],
        evidenceIds: ['evidence-one'],
        level: 'inferred-reference',
        suggestedAction: 'Inspect original code',
        limitations: ['No runtime analysis'],
      },
    ],
    plan: [
      {
        id: 'task-one',
        group: 'backend',
        title: 'Review API contract',
        description: 'Confirm response shape.',
        fileIds: ['file-one'],
        evidenceIds: ['evidence-one'],
        findingIds: ['finding-one'],
        dependsOnTaskIds: [],
        requestDerived: true,
        suggestedNewPaths: [],
      },
      {
        id: 'task-two',
        group: 'tests',
        title: 'Add deletion tests',
        description: 'Verify authorization and linked-record behavior.',
        fileIds: ['file-two'],
        evidenceIds: [],
        findingIds: [],
        dependsOnTaskIds: ['task-one'],
        requestDerived: true,
        suggestedNewPaths: ['tests/deletion.test.ts'],
      },
    ],
    scan: {
      acceptedFiles: 2,
      acceptedBytes: 100,
      sourceFiles: 2,
      parsedFiles: 2,
      testFiles: 1,
      routes: 0,
      tables: 0,
      skippedFiles: 1,
      skippedReasons: { 'Secret or credential file': 1 },
      warnings: [],
      unresolvedReferences: ['./unknown'],
      unsupportedPatterns: ['Runtime dispatch is unsupported'],
      selectedConfiguration: 'defaults',
      supportedRules: ['import'],
      testScan: 'complete',
    },
    limitations: ['Static analysis does not prove safety.'],
  };
}

describe('reviewable exports', () => {
  it('exports a schema-valid semantic result with separate user edits and no raw source', () => {
    const output = JSON.parse(
      renderExport(
        fixture(),
        { 'task-one': { completed: true, note: 'Confirm with maintainer' } },
        'json',
      ),
    );
    expect(resultSchema.safeParse(output.result).success).toBe(true);
    expect(output.review['task-one'].completed).toBe(true);
    expect(output.reviewLabel).toContain('User edits');
    expect(output.result).not.toHaveProperty('source');
    expect(output.result.evidence[0].spans[0].startLine).toBe(1);
  });
  it('contains scope, evidence, score breakdown, limitations, tasks and explicit review edits', () => {
    const output = renderExport(
      fixture(),
      { 'task-one': { completed: true, title: 'My title', note: 'My note' } },
      'markdown',
    );
    for (const value of [
      'Snapshot and scanned scope',
      'Confirmed starting files',
      'Summary counts',
      '10 points',
      'src/account',
      'tests/account',
      'Existing test references',
      'Proposed tests',
      'Prerequisites: task',
      '**User edits:**',
      'My note',
      'Static analysis does not prove safety',
    ])
      expect(output).toContain(value);
    expect(output).toContain('not observed source');
    expect(output).toContain(':1:1–1:20');
  });
  it('uses disjoint primary-role summary counts and unique direct test references', () => {
    const result = fixture();
    for (const [id, path, category] of [
      ['file-three', 'src/client.ts', 'api'],
      ['file-four', 'docs/account.md', 'docs'],
      ['file-five', 'tests/possible.test.ts', 'test'],
    ] as const)
      result.files.push({ ...result.files[0]!, id, path, category });
    result.scan.acceptedFiles = 5;
    result.scan.testFiles = 2;
    const seed = result.impacts[0]!;
    seed.roles = ['seed', 'dependent', 'dependency', 'reference'];
    result.impacts.push(
      {
        ...seed,
        fileId: 'file-two',
        roles: ['dependent', 'dependency', 'reference'],
        primaryRole: 'dependent',
      },
      {
        ...seed,
        fileId: 'file-three',
        roles: ['dependency', 'reference'],
        primaryRole: 'dependency',
      },
      {
        ...seed,
        fileId: 'file-four',
        roles: ['reference'],
        primaryRole: 'reference',
        testReferences: {
          status: 'possible',
          testFileIds: ['file-five'],
          evidenceIds: [],
          limitations: [],
        },
      },
    );
    for (const format of ['markdown', 'bob'] as const) {
      const report = renderExport(result, {}, format);
      const summary = report
        .split('## Summary counts and definitions')[1]!
        .split('## Assessed files')[0]!;
      for (const count of [
        '1 confirmed starting files:',
        '1 dependents:',
        '1 dependencies:',
        '1 related references:',
        '4 unique assessed/context files.',
        '1 direct test references:',
        '2 recognized test files',
      ])
        expect(summary).toContain(count);
      expect(summary).toContain('counts are disjoint');
      expect(summary).toContain('a separate category count');
    }
    const json = JSON.parse(renderExport(result, {}, 'json'));
    expect(json.result.impacts[0].roles).toEqual(['seed', 'dependent', 'dependency', 'reference']);
    expect(json.result.evidence).toEqual(result.evidence);
    expect(json.result.relationships).toEqual(result.relationships);
  });
  it('does not let uploaded strings inject Markdown headings or links', () => {
    const result = fixture();
    result.requestText = '# Fake heading\n[trusted](https://malicious.invalid) <script>';
    const output = renderExport(result, {}, 'markdown');
    expect(output).not.toContain('\n# Fake heading');
    expect(output).not.toContain('[trusted](https://malicious.invalid)');
    expect(output).not.toContain('<script>');
  });
  it('redacts accidental credentials and private host paths in all formats', () => {
    const result = fixture();
    result.requestText = 'Inspect apiKey="super-private-secret" at C:\\Users\\private\\file.ts';
    for (const format of ['markdown', 'bob', 'json'] as const) {
      const output = renderExport(result, {}, format);
      expect(output).not.toContain('super-private-secret');
      expect(output).not.toContain('Users');
    }
  });
  it('rejects dangling evidence, task and file references instead of exporting corrupt data', () => {
    const result = fixture();
    result.relationships[0]!.evidenceIds = ['missing'];
    expect(() => renderExport(result, {}, 'json')).toThrow('unresolved ID');
    expect(() => renderExport(fixture(), { missing: { note: 'bad' } }, 'json')).toThrow(
      'unresolved ID',
    );
    const invalid = fixture();
    invalid.evidence[0]!.spans[0]!.endLine = 100;
    expect(() => renderExport(invalid, {}, 'markdown')).toThrow('invalid source span');
    const path = fixture();
    path.impacts[0]!.explanationPath = ['file-one'];
    expect(() => renderExport(path, {}, 'json')).toThrow('unresolved ID');
    const duplicate = fixture();
    duplicate.relationships.push({ ...duplicate.relationships[0]! });
    expect(() => renderExport(duplicate, {}, 'json')).toThrow('duplicate IDs');
  });
  it('provides a useful Bob handoff with work ownership and execution boundaries', () => {
    const output = renderExport(fixture(), {}, 'bob');
    for (const value of [
      'Requested change',
      'Snapshot and scanned scope',
      'Confirmed starting files',
      'Structural dependencies and evidence',
      'inferred references requiring human review',
      'Prioritized implementation tasks',
      'Suggested bounded workstreams',
      'Shared contracts and prerequisite order',
      'Existing test references',
      'Open questions and analysis limits',
      'Verification and final reporting instructions',
      'Confirm the checkout still matches',
      'untrusted data',
      'appropriate approval',
      'trusted developer checkout',
      'actual checks run',
      'has not connected to or executed IBM Bob',
    ])
      expect(output).toContain(value);
  });
});
