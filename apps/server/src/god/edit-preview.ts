// Legal by construction 1a (#2134, design note docs/design/legal-by-construction.md part 1): a god world-edit batch
// previewed on a detached copy of the world, the check-on-a-copy path authored installs already use (engine.ts
// previewCommonsFoodDeliveryV1: snapshot, restore detached, run every invariant). A preview and nothing else: it refuses
// nothing, and `commitBatch`, BUILDSAFE and the walk-outs are unchanged. 1b reads it to refuse.
import type { WorldEditV1 } from '@souls/engine-mars';
import type { WorldHost } from '../world.ts';

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
  | { ok: false; code: 'edit-preview.resumable-boundary-required' };

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
