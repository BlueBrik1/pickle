import { parentPort, workerData } from 'node:worker_threads';
import { indexProject, analyze } from '../analysis/index.js';
import { resultSchema } from '../../src/shared/schema.js';

const stage = (value: string) => parentPort?.postMessage({ type: 'stage', stage: value });
try {
  const result =
    workerData.kind === 'index'
      ? indexProject(workerData.snapshot, stage)
      : resultSchema.parse(analyze(workerData.project, workerData.input, stage));
  parentPort?.postMessage({ type: 'complete', result });
} catch {
  parentPort?.postMessage({ type: 'failed' });
}
