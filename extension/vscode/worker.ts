// Analysis runs here so indexing never blocks the extension host. The worker lives for the session,
// which keeps the workspace cache warm between runs.
import { parentPort } from 'node:worker_threads';
import { scanDesign } from '../core/design.js';
import { preview, review, type Options } from '../core/pickle.js';
import { loadWorkspace } from '../core/workspace.js';

export type Request = { id: number; op: 'preview' | 'review' | 'design'; root: string; task?: string; opts: Options };

parentPort!.on('message', async ({ id, op, root, task, opts }: Request) => {
  try {
    const result =
      op === 'preview'
        ? await preview(root, task!, opts)
        : op === 'review'
          ? await review(root, opts)
          : scanDesign(await loadWorkspace(root, opts.maxFiles), { tokensFile: opts.tokensFile });
    parentPort!.postMessage({ id, result });
  } catch (e: any) {
    parentPort!.postMessage({ id, error: String(e?.message ?? e) });
  }
});
