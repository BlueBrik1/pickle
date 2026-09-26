import { z } from 'zod';
export const LIMITS = {
  files: 1500,
  fileBytes: 256 * 1024,
  totalBytes: 8 * 1024 * 1024,
  bodyBytes: 16 * 1024 * 1024,
  pathLength: 512,
  requestLength: 2000,
  seeds: 8,
  repositories: 3,
  idleMs: 30 * 60 * 1000,
  workers: 2,
  queued: 10,
  jobMs: 30000,
  snapshotBytes: 64 * 1024 * 1024,
  workerMb: 256,
} as const;
export const categorySchema = z.enum([
  'ui',
  'api',
  'auth',
  'data',
  'schema',
  'config',
  'test',
  'docs',
  'other',
]);
export const levelSchema = z.enum([
  'structural',
  'supported-reference',
  'inferred-reference',
  'unknown',
]);
export const roleSchema = z.enum(['seed', 'dependent', 'dependency', 'reference']);
export const spanSchema = z.object({
  fileId: z.string(),
  startLine: z.number().int().positive(),
  startColumn: z.number().int().positive(),
  endLine: z.number().int().positive(),
  endColumn: z.number().int().positive(),
});
export const evidenceSchema = z.object({
  id: z.string(),
  ruleId: z.string(),
  level: levelSchema,
  spans: z.array(spanSchema),
  summary: z.string(),
  matchedValue: z.string().optional(),
  limitations: z.array(z.string()),
});
export const fileSchema = z.object({
  id: z.string(),
  path: z.string(),
  category: categorySchema,
  categoryBasis: z.enum(['recognized-pattern', 'path-rule', 'default']),
  sizeBytes: z.number(),
  lineCount: z.number(),
  parseStatus: z.enum(['parsed', 'text-only', 'partial', 'failed']),
});
export const relationshipSchema = z.object({
  id: z.string(),
  fromFileId: z.string(),
  toFileId: z.string(),
  kind: z.enum([
    'import',
    're-export',
    'require',
    'dynamic-import',
    'api-reference',
    'table-reference',
    'schema-reference',
    'env-reference',
    'document-reference',
    'test-candidate',
  ]),
  typeOnly: z.boolean(),
  level: levelSchema,
  evidenceIds: z.array(z.string()),
});
export const scoreComponentSchema = z.object({
  ruleId: z.string(),
  points: z.number(),
  explanation: z.string(),
  evidenceIds: z.array(z.string()),
  requestDerived: z.boolean(),
});
export const testReferenceSchema = z.object({
  status: z.enum(['direct', 'possible', 'none-found', 'unknown', 'not-applicable']),
  testFileIds: z.array(z.string()),
  evidenceIds: z.array(z.string()),
  limitations: z.array(z.string()),
});
export const impactSchema = z.object({
  fileId: z.string(),
  roles: z.array(roleSchema),
  primaryRole: roleSchema,
  depth: z.number().nullable(),
  explanationPath: z.array(z.string()),
  score: z.number().nullable(),
  priority: z.enum(['high', 'medium', 'low', 'not-assessed']),
  scoreComponents: z.array(scoreComponentSchema),
  testReferences: testReferenceSchema,
});
export const findingSchema = z.object({
  id: z.string(),
  ruleId: z.string(),
  title: z.string(),
  explanation: z.string(),
  fileIds: z.array(z.string()),
  evidenceIds: z.array(z.string()),
  level: levelSchema,
  suggestedAction: z.string(),
  limitations: z.array(z.string()),
});
export const taskSchema = z.object({
  id: z.string(),
  group: z.enum(['preparation', 'backend', 'interface', 'tests', 'docs-release']),
  title: z.string(),
  description: z.string(),
  fileIds: z.array(z.string()),
  evidenceIds: z.array(z.string()),
  findingIds: z.array(z.string()),
  dependsOnTaskIds: z.array(z.string()),
  requestDerived: z.boolean(),
  suggestedNewPaths: z.array(z.string()),
});
export const scanSchema = z.object({
  acceptedFiles: z.number(),
  acceptedBytes: z.number(),
  sourceFiles: z.number(),
  parsedFiles: z.number(),
  testFiles: z.number(),
  routes: z.number(),
  tables: z.number(),
  skippedFiles: z.number(),
  skippedReasons: z.record(z.string(), z.number()),
  warnings: z.array(z.string()),
  unresolvedReferences: z.array(z.string()),
  unsupportedPatterns: z.array(z.string()),
  selectedConfiguration: z.string(),
  supportedRules: z.array(z.string()),
  testScan: z.enum(['complete', 'partial', 'unknown']),
});
export const settingsSchema = z.object({
  maxDepth: z.number().int().min(1).max(5).default(3),
  includeTypeOnly: z.boolean().default(true),
});
export const resultSchema = z.object({
  schemaVersion: z.literal('1.0'),
  analyzerVersion: z.string(),
  rulesVersion: z.string(),
  analysisId: z.string(),
  repositoryId: z.string(),
  snapshotFingerprint: z.string(),
  requestText: z.string(),
  seedFileIds: z.array(z.string()),
  settings: settingsSchema,
  createdAt: z.string(),
  completedAt: z.string(),
  durationMs: z.number(),
  files: z.array(fileSchema),
  relationships: z.array(relationshipSchema),
  evidence: z.array(evidenceSchema),
  impacts: z.array(impactSchema),
  findings: z.array(findingSchema),
  plan: z.array(taskSchema),
  scan: scanSchema,
  limitations: z.array(z.string()),
});
export const inputFileSchema = z.object({
  relativePath: z.string().max(LIMITS.pathLength),
  content: z.string(),
});
export const importSchema = z.object({
  name: z.string().trim().min(1).max(100),
  files: z.array(inputFileSchema).max(10000),
  clientSkipped: z.record(z.string(), z.number().int().nonnegative()).optional(),
});
export const requestSchema = z.object({
  requestText: z.string().trim().min(10).max(LIMITS.requestLength),
});
export const analysisInputSchema = requestSchema.extend({
  repositoryId: z.string(),
  seedFileIds: z.array(z.string()).min(1).max(LIMITS.seeds),
  settings: settingsSchema,
});
export const reviewItemSchema = z.object({
  completed: z.boolean().optional(),
  note: z.string().max(2000).optional(),
  title: z.string().max(500).optional(),
});
export const reviewSchema = z.record(z.string(), reviewItemSchema);
export type SourceSpan = z.infer<typeof spanSchema>;
export type Evidence = z.infer<typeof evidenceSchema>;
export type FileRecord = z.infer<typeof fileSchema>;
export type Relationship = z.infer<typeof relationshipSchema>;
export type ScoreComponent = z.infer<typeof scoreComponentSchema>;
export type FileImpact = z.infer<typeof impactSchema>;
export type Finding = z.infer<typeof findingSchema>;
export type PlanTask = z.infer<typeof taskSchema>;
export type AnalysisResult = z.infer<typeof resultSchema>;
export type ScanSummary = z.infer<typeof scanSchema>;
export type InputFile = z.infer<typeof inputFileSchema>;
export type ReviewState = z.infer<typeof reviewSchema>;
export type Settings = z.infer<typeof settingsSchema>;
export interface Snapshot {
  name: string;
  files: InputFile[];
  skippedReasons: Record<string, number>;
  totalBytes: number;
}
export interface IndexedProject {
  snapshot: Snapshot;
  fingerprint: string;
  files: FileRecord[];
  relationships: Relationship[];
  evidence: Evidence[];
  scan: ScanSummary;
  symbols: Record<string, string[]>;
  terms: Record<string, string[]>;
}
export interface Candidate {
  fileId: string;
  score: number;
  terms: string[];
  reasons: string[];
  strong: boolean;
}
export type JobState = 'queued' | 'running' | 'completed' | 'failed' | 'canceled';
export interface RepositoryView {
  id: string;
  name: string;
  state: JobState;
  stage: string;
  createdAt: string;
  scan?: ScanSummary;
  files?: FileRecord[];
  fingerprint?: string;
  error?: string;
}
export interface AnalysisView {
  id: string;
  repositoryId: string;
  requestText: string;
  state: JobState;
  stage: string;
  createdAt: string;
  result?: AnalysisResult;
  review: ReviewState;
  error?: string;
}
export interface SessionView {
  mode: 'local' | 'demo';
  repositories: RepositoryView[];
  analyses: Omit<AnalysisView, 'result' | 'review'>[];
}
