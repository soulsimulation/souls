// What a placed copy holds when the world starts: a world map row's `with` (content/worlds/<world>/map.json), such as
// today's guitar in its stand's cradle or a piano's bench at its seat. Today's page draws these as part of their
// holder's def. The new engine needs each as a thing of its own: the guitar for the stand's `take`, the bench beside
// its piano. Each one is a thing of its entry's kind, in the holder's slot (`slot`, by the slot's name in the
// holder's entry) or beside it (`at_mm`, `yaw_mdeg`, in the holder's frame).
import { createHash } from 'node:crypto';
import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';

export type With = { entry: string; slot?: string; at_mm?: [number, number, number]; yaw_mdeg?: number; why?: string };
type Row = { def: string; entry?: string; with?: With[] };
/** A content entry, the fields read here. */
type Entry = { kind: string; slots?: Record<string, { at_mm?: number[] }> };

const mapKey = (ref: string) => ref.replace(/^core\//, 'core-');

/** Each def ref's `with` rows from a world map, by ref (`core/piano@1` and `core-piano@1` alike). */
export function withMap(mapPath: string): (ref: string) => With[] {
  const rows = (JSON.parse(readFileSync(mapPath, 'utf8')).rows as Row[]).filter((r) => r.with?.length);
  const by = new Map(rows.map((r) => [mapKey(r.def), r.with!]));
  return (ref) => by.get(mapKey(ref)) ?? [];
}

/** Every content entry (`content/kinds/<family>/<name>.json`) by its kind, with its text's SHA-256. */
export function entriesIn(dir: string): Map<string, { entry: Entry; hash: string }> {
  const out = new Map<string, { entry: Entry; hash: string }>();
  for (const family of readdirSync(dir, { withFileTypes: true })) {
    if (!family.isDirectory()) continue;
    for (const f of readdirSync(join(dir, family.name))) {
      if (!f.endsWith('.json')) continue;
      const text = readFileSync(join(dir, family.name, f), 'utf8');
      let e: Entry;
      try { e = JSON.parse(text) as Entry; } catch { continue; }
      if (typeof e?.kind === 'string') out.set(e.kind, { entry: e, hash: createHash('sha256').update(text).digest('hex') });
    }
  }
  return out;
}

/** The facts kind of a `with` thing: named as its entry, its hash its entry's (no def of today's draws it alone). */
export const withKind = (entry: string, hash: string) => ({ ref: `entry:${entry}`, hash, name: entry, form: 'point', layer: null, door: false, mesh: false, slots: 0 });

type Pose = { x: number; y: number; z: number; yaw: number };
/** `l` (metres and radians, in `f`'s frame) in the frame `f` is in, as the exporter composes poses. */
const compose = (f: Pose, l: Pose): Pose => {
  const c = Math.cos(f.yaw), s = Math.sin(f.yaw);
  return { x: f.x + l.x * c + l.z * s, y: f.y + l.y, z: f.z - l.x * s + l.z * c, yaw: f.yaw + l.yaw };
};

/**
 * The facts things a holder's `with` rows add, and each slot they fill as the facts give a holder its slots (`{n, id,
 * kind, at, yaw}`, mm): today's def draws the guitar as part of its stand and bakes no slot, so the holder's kind
 * gets the slot from here. `holder`: its id and name, its tree parent and slot as its own facts
 * thing has them, its pose there (`pose`, metres and radians) and its scale. `place(pose)` writes a pose as the facts
 * do. A slot is numbered as the holder's entry numbers it (its slots in order, from 1); a slot the entry does not have
 * is refused, as is an entry the content does not have.
 */
export function withThings(
  holder: { id: string; name?: string; entry?: string; parent: string | null; slot?: unknown; pose: Pose; world: Pose; scale: number },
  rows: readonly With[],
  entries: ReadonlyMap<string, { entry: Entry; hash: string }>,
  place: (p: { x: number; y: number; z: number; yaw: number }) => number[],
): { kind: ReturnType<typeof withKind>; thing: Record<string, unknown>; slot?: { n: number; id: string; kind: string; at: number[]; yaw: number } }[] {
  return rows.map((w, k) => {
    const made = entries.get(w.entry);
    if (!made) throw new Error(`${holder.id}: with ${w.entry}, an entry the content does not have`);
    const plain = w.entry.split(':').pop()!, base = holder.name ?? holder.id;
    const thing: Record<string, unknown> = { id: `${holder.id}-with-${k + 1}`, def: w.entry, ref: `entry:${w.entry}`, name: `${base}-${plain}`, entry: w.entry, scale_ppm: 1_000_000 };
    if (w.slot !== undefined) {
      const slots = entries.get(holder.entry ?? '')?.entry.slots ?? {}, n = Object.keys(slots).indexOf(w.slot) + 1;
      if (!n) throw new Error(`${holder.id}: with ${w.entry} in slot ${w.slot}, which ${holder.entry ?? 'its entry'} does not have`);
      // in the slot, at its point: the facts give a slotted thing's pose from its parent's origin (the import takes the
      // slot's point off)
      const at = (slots[w.slot]?.at_mm ?? [0, 0, 0]).map((v) => Math.round(v * holder.scale)), [ax, ay, az] = at.map((v) => v / 1000);
      Object.assign(thing, { parent: holder.id, slot: { n, id: w.slot }, pose: [...at, 0], world: place(compose(holder.world, { x: ax, y: ay, z: az, yaw: 0 })) });
      return { kind: withKind(w.entry, made.hash), thing, slot: { n, id: w.slot, kind: 'thing', at, yaw: 0 } };
    } else {
      // beside it, in its frame: a child of the holder's own parent (in its room, not in a slot one thing holds)
      const [x, y, z] = (w.at_mm ?? [0, 0, 0]).map((v) => (v / 1000) * holder.scale), l = { x, y, z, yaw: ((w.yaw_mdeg ?? 0) / 180_000) * Math.PI };
      Object.assign(thing, { parent: holder.parent, ...((holder.slot as { room?: string } | undefined)?.room ? { slot: holder.slot } : {}), pose: place(compose(holder.pose, l)), world: place(compose(holder.world, l)) });
    }
    return { kind: withKind(w.entry, made.hash), thing };
  });
}
