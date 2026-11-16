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
  /** off-thread only: the factory has no descriptor (Eden core), or the worker failed, exited or timed out; the message names why */
  | { ok: false; code: 'edit-preview.worker-unavailable'; message: string }
  /** off-thread only: PREVIEW_MAX_PENDING previews are already in flight */
  | { ok: false; code: 'edit-preview.busy'; message: string };

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

/** How long one off-thread preview may take before its worker is terminated (a cold worker also builds its factory). */
export const PREVIEW_TIMEOUT_MS = 20_000;
/** Previews in flight at once (each holds a snapshot: about 5.8 MB on Eden); past it a preview is refused, never queued. */
export const PREVIEW_MAX_PENDING = 2;
type Pool = { w: Worker; waiting: Map<number, (r: EditPreviewV1) => void> };
let live: Pool | null = null, nextId = 0, pending = 0;
let script = new URL('./edit-preview-worker.ts', import.meta.url);
/** Tests only: the script the next preview worker runs (returns the previous one); an idle live worker is retired. */
export function previewWorkerScriptV1(url?: URL): URL {
  const was = script;
  if (url) { script = url; const old = live; live = null; if (old && !old.waiting.size) void old.w.terminate(); }
  return was;
}
const unavailable = (message: string): EditPreviewV1 => ({ ok: false, code: 'edit-preview.worker-unavailable', message });
/** Every handler belongs to its own worker: a late exit of a replaced worker never answers the new one's previews. */
function previewPool(): Pool {
  if (live) return live;
  const pool: Pool = { w: new Worker(script, { execArgv: [] }), waiting: new Map() };
  pool.w.unref();
  const fail = (message: string) => { if (live === pool) live = null; const done = [...pool.waiting.values()]; pool.waiting.clear(); for (const d of done) d(unavailable(message)); };
  pool.w.on('message', (m: PreviewReplyV1) => { const done = pool.waiting.get(m.id); pool.waiting.delete(m.id); if (!pool.waiting.size) pool.w.unref(); done?.('error' in m ? unavailable(m.error) : m.result); });
  pool.w.on('error', e => fail(e.message));
  pool.w.on('exit', code => fail(`the preview worker exited (${code})`));
  return (live = pool);
}

/**
 * The preview of `edit` on the world as it stands now, off the world's tick thread: the same result previewWorldEditV1
 * gives on detachedEngineV1(host) at this tick. Only the stepped checkpoint runs on the world's thread.
 */
export async function previewWorldEditOffThreadV1(host: Pick<WorldHost, 'engine' | 'factory'>, edit: WorldEditV1, opts: { timeoutMs?: number } = {}): Promise<EditPreviewV1> {
  const engine = host.engine;
  if (engine.canSnapshot?.() === false) return { ok: false, code: 'edit-preview.resumable-boundary-required' };
  const descriptor = factoryDescriptorV1(host.factory);
  if (!descriptor) return unavailable('the world\'s engine factory has no descriptor');
  if (pending >= PREVIEW_MAX_PENDING) return { ok: false, code: 'edit-preview.busy', message: `${pending} previews are already in flight (at most ${PREVIEW_MAX_PENDING})` };
  pending++;
  try {
    const hash = (engine.world as { groundV1?: { recipeHash?: string } }).groundV1?.recipeHash;
    const recipe = hash ? groundRecipe(hash) ?? null : null;
    const snapshot = await steppedSnapshotV1(engine);
    const id = ++nextId, pool = previewPool(), ms = opts.timeoutMs ?? PREVIEW_TIMEOUT_MS;
    return await new Promise<EditPreviewV1>(resolve => {
      // on expiry the worker is terminated and every preview it holds answered; the next preview starts a fresh worker
      const timer = setTimeout(() => {
        if (!pool.waiting.has(id)) return;
        if (live === pool) live = null;
        const done = [...pool.waiting.values()]; pool.waiting.clear();
        for (const d of done) d(unavailable(`the preview worker gave no answer within ${ms} ms`));
        void pool.w.terminate();
      }, ms);
      timer.unref();
      pool.waiting.set(id, r => { clearTimeout(timer); resolve(r); }); pool.w.ref();
      try { pool.w.postMessage({ id, descriptor, recipe, snapshot, edit } satisfies PreviewJobV1); }
      catch (e) { pool.waiting.delete(id); clearTimeout(timer); resolve(unavailable((e as Error).message)); }
    });
  } finally { pending--; }
}
