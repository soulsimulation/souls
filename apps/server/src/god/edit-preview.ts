// Legal by construction 1a (#2134, design note docs/design/legal-by-construction.md part 1): a god world-edit batch
// previewed on a detached copy of the world, the check-on-a-copy path authored installs already use (engine.ts
// previewCommonsFoodDeliveryV1: snapshot, restore detached, run every invariant). A preview and nothing else: it refuses
// nothing, and `commitBatch`, BUILDSAFE and the walk-outs are unchanged. 1b reads it to refuse.
// #2140: on Eden 2026 one preview costs most of a second, three quarters of it the copy, so the world's own entry point
// (previewWorldEditOffThreadV1) runs it in a worker: the world takes the checkpoint with the stepped capture its periodic
// snapshots use, and the worker restores and previews it with the code below. The caller awaits the result.
import { setImmediate } from 'node:timers/promises';
import { Worker } from 'node:worker_threads';
import type { EngineCheckpoint, EngineSnapshot } from '@souls/engine-contract';
import { groundRecipe, type WorldEditV1 } from '@souls/engine-mars';
import type { WorldHost } from '../world.ts';
import { factoryDescriptorV1 } from '../world-factory.ts';
import type { PreviewJobV1, PreviewReplyV1 } from './edit-preview-worker.ts';

type Vec2 = [number, number];
type Diagnostic = { code: string; message: string; subjects?: string[] };
type Body = { kind: string; pose: { p: [number, number, number]; yaw: number }; human?: { level?: number } & Record<string, unknown> };
/** What the preview reads of a detached engine copy (MarsEngine; its runtime is the copy's own, private to the engine). */
type CopyV1 = {
  world: { entities: Record<string, Body> };
  applyWorldEditV1(p: WorldEditV1): { relocated: string[]; trapped: string[] };
  standableNearV1(at: Vec2, level?: number, except?: string): Vec2 | null;
};

/** A body a violation names, where it stands, and the nearest point it could stand legally with the edit made. */
export type PreviewBodyV1 = { id: string; level: number; at: Vec2; alternative: Vec2 | null };
/** One rule the edit breaks: the rule, what it names (bodies with their alternative), the invariant's own words. */
export type PreviewViolationV1 = { rule: string; subjects: string[]; bodies: PreviewBodyV1[]; message: string };
export type EditPreviewV1 =
  | { ok: true; violations: PreviewViolationV1[]; relocated: string[]; trapped: string[] }
  | { ok: false; code: 'edit-preview.resumable-boundary-required' }
  /** off-thread only: the factory has no descriptor (Eden core), or the worker failed; the message names why */
  | { ok: false; code: 'edit-preview.worker-unavailable'; message: string };

/** A detached copy of the host's engine, restored from its snapshot as an authored install checks its own; null off a
 *  resumable boundary. Nothing done to the copy reaches the world. */
export function detachedEngineV1(host: Pick<WorldHost, 'engine' | 'factory'>): WorldHost['engine'] | null {
  const live = host.engine;
  if (live.canSnapshot?.() === false) return null;
  const copy = host.factory.restore(live.snapshot());
  return copy === live || copy.world === live.world ? null : copy;
}

const keyOf = (d: Diagnostic) => `${d.code}|${[...(d.subjects ?? [])].sort().join(',')}`;
const runInvariants = (copy: CopyV1): Diagnostic[] => {
  // The copy's runtime is the engine's private field; the copy is ours alone (as split/spatial-tap.ts reads it).
  const rt = (copy as unknown as { rt: { invariants: ((rt: unknown) => Diagnostic[])[] } }).rt;
  return rt.invariants.flatMap(inv => inv(rt));
};

/**
 * Apply `edit` to a detached copy of the world (`copy`: detachedEngineV1(host)) and run every invariant on it.
 * Returns the violations the edit makes (those the copy had before it are left out). The engine's own fold walks a body
 * a new solid buries to clear ground (`relocated`) or names it (`trapped`); the preview puts such a body back where it
 * stood before the invariants look, so the edit is judged as it lands. The live world is not touched.
 */
export function previewWorldEditV1(engine: WorldHost['engine'] | null, edit: WorldEditV1): EditPreviewV1 {
  const copy = engine as unknown as CopyV1 | null;
  if (!copy) return { ok: false, code: 'edit-preview.resumable-boundary-required' };
  const before = new Set(runInvariants(copy).map(keyOf));
  const stood = new Map<string, { pose: Body['pose']; human: Body['human'] }>();
  for (const [id, e] of Object.entries(copy.world.entities)) if (e.kind === 'human' && e.human) stood.set(id, structuredClone({ pose: e.pose, human: e.human }));
  // a new object: the producer's prepared physics (entity-physics.ts BUILT) stays for the live fold
  const { relocated, trapped } = copy.applyWorldEditV1({ ...edit });
  for (const id of relocated) { const e = copy.world.entities[id], was = stood.get(id); if (e && was) { e.pose = was.pose; e.human = was.human; } }
  const found = runInvariants(copy).filter(d => !before.has(keyOf(d)));
  const violations = found.map(d => {
    const subjects = d.subjects ?? [];
    const bodies = subjects.flatMap(id => {
      const e = copy.world.entities[id]; if (e?.kind !== 'human' || !e.human) return [];
      const level = e.human.level ?? 0, at: Vec2 = [e.pose.p[0], e.pose.p[2]];
      return [{ id, level, at, alternative: copy.standableNearV1(at, level, id) }];
    });
    return { rule: d.code, subjects, bodies, message: d.message };
  });
  return { ok: true, violations, relocated, trapped };
}

/** The world's checkpoint, taken as its periodic snapshot takes one (world.ts schedulePeriodicSnapshot): the capture owns
 *  its boundary synchronously, then the remaining steps run in slices of at most 4 ms between ticks. */
async function steppedSnapshotV1(engine: WorldHost['engine']): Promise<EngineSnapshot> {
  const captured = engine.captureCheckpoint?.() ?? engine.captureSnapshot?.();
  if (!captured) return engine.snapshot();
  const steps = (captured.steps as () => Generator<void, EngineCheckpoint | EngineSnapshot, void>)();
  for (;;) {
    const start = performance.now();
    let r: IteratorResult<void, EngineCheckpoint | EngineSnapshot>;
    do r = steps.next(); while (!r.done && performance.now() - start < 4);
    if (r.done) return 'physicalHash' in r.value ? r.value.snapshot : r.value;
    await setImmediate();
  }
}

let worker: Worker | null = null, nextId = 0;
const waiting = new Map<number, (r: EditPreviewV1) => void>();
const unavailable = (message: string): EditPreviewV1 => ({ ok: false, code: 'edit-preview.worker-unavailable', message });
function previewWorker(): Worker {
  if (worker) return worker;
  const w = new Worker(new URL('./edit-preview-worker.ts', import.meta.url), { execArgv: [] });
  w.unref();
  const fail = (message: string) => { if (worker === w) worker = null; for (const done of waiting.values()) done(unavailable(message)); waiting.clear(); };
  w.on('message', (m: PreviewReplyV1) => { const done = waiting.get(m.id); waiting.delete(m.id); if (!waiting.size) w.unref(); done?.('error' in m ? unavailable(m.error) : m.result); });
  w.on('error', e => fail(e.message));
  w.on('exit', code => fail(`the preview worker exited (${code})`));
  return (worker = w);
}

/**
 * The preview of `edit` on the world as it stands now, off the world's tick thread: the same result previewWorldEditV1
 * gives on detachedEngineV1(host) at this tick. Only the stepped checkpoint runs on the world's thread.
 */
export async function previewWorldEditOffThreadV1(host: Pick<WorldHost, 'engine' | 'factory'>, edit: WorldEditV1): Promise<EditPreviewV1> {
  const engine = host.engine;
  if (engine.canSnapshot?.() === false) return { ok: false, code: 'edit-preview.resumable-boundary-required' };
  const descriptor = factoryDescriptorV1(host.factory);
  if (!descriptor) return unavailable('the world\'s engine factory has no descriptor');
  const hash = (engine.world as { groundV1?: { recipeHash?: string } }).groundV1?.recipeHash;
  const recipe = hash ? groundRecipe(hash) ?? null : null;
  const snapshot = await steppedSnapshotV1(engine);
  const id = ++nextId, w = previewWorker();
  return new Promise<EditPreviewV1>(resolve => {
    waiting.set(id, resolve); w.ref();
    try { w.postMessage({ id, descriptor, recipe, snapshot, edit } satisfies PreviewJobV1); }
    catch (e) { waiting.delete(id); resolve(unavailable((e as Error).message)); }
  });
}
