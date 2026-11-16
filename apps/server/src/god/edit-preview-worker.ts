// #2140: the god-edit preview off the world's tick thread. The world hands this worker a checkpoint it took with its stepped
// capture, the descriptor of its engine factory and its ground recipe; the worker rebuilds the factory once, restores a
// copy from each checkpoint and previews the edit on it with the same code as the in-thread path (edit-preview.ts).
import { parentPort } from 'node:worker_threads';
import type { EngineFactory, EngineSnapshot } from '@souls/engine-contract';
import type { WorldEditV1 } from '@souls/engine-mars';
import { registerGroundRecipe } from '@souls/engine-mars';
import { factoryFromDescriptorV1, type FactoryDescriptorV1 } from '../world-factory.ts';
import { previewWorldEditV1 } from './edit-preview.ts';

export type PreviewJobV1 = { id: number; descriptor: FactoryDescriptorV1; recipe: unknown; snapshot: EngineSnapshot; edit: WorldEditV1 };
export type PreviewReplyV1 = { id: number; result: ReturnType<typeof previewWorldEditV1> } | { id: number; error: string };

const factories = new Map<string, Promise<EngineFactory>>();
parentPort!.on('message', async (job: PreviewJobV1) => {
  try {
    const key = JSON.stringify(job.descriptor);
    let f = factories.get(key);
    if (!f) factories.set(key, (f = factoryFromDescriptorV1(job.descriptor)));
    if (job.recipe) registerGroundRecipe(job.recipe as never);
    const copy = (await f).restore(job.snapshot);
    parentPort!.postMessage({ id: job.id, result: previewWorldEditV1(copy as never, job.edit) } satisfies PreviewReplyV1);
  } catch (e) {
    parentPort!.postMessage({ id: job.id, error: (e as Error)?.message ?? String(e) } satisfies PreviewReplyV1);
  }
});
