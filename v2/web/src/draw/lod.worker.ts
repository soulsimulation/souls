/// <reference lib="webworker" />
// The ground's distance levels (#3785), off the main thread, as today's apps/web/src/mesh-lod.worker.ts: a phone stalled
// 100–400 ms per big mesh while meshoptimizer simplified it on the main thread.
// Messages: {id, input} -> {id, levels} (index buffers transferred) or {id, error}; {id: 0} -> {id: 0, ready}.
import { MeshoptSimplifier } from 'meshoptimizer/simplifier';
import { simplifyLevels, type LodInput, type Simplifier } from './lod-core.ts';

const ready = MeshoptSimplifier.ready.then(() => MeshoptSimplifier.supported);
self.onmessage = async (ev: MessageEvent<{ id: number; input?: LodInput }>) => {
  const { id, input } = ev.data;
  try {
    const ok = await ready;
    if (!id) return void (self as unknown as Worker).postMessage({ id: 0, ready: ok });
    if (!ok || !input) throw new Error('simplifier unavailable');
    const levels = simplifyLevels(MeshoptSimplifier as unknown as Simplifier, input);
    (self as unknown as Worker).postMessage({ id, levels }, levels.map((l) => l.index.buffer));
  } catch (e) {
    (self as unknown as Worker).postMessage({ id, error: String((e as Error)?.message ?? e) });
  }
};
