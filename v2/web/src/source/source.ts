// A source of the world for the page (V5, #2714): something that says where the world is (a pointer), how it starts
// (a snapshot) and what changed (parts). V1's stream of numbered files is the first; V9 (history) and V13 add theirs
// by implementing `Source`. Times are world microseconds; positions micrometres in the node's parent frame (T4).

import type { Happened } from '../sound/record.ts';
import type { SkyFields } from '../sky/record.ts';
import type { Fields } from '../kinds/state.ts';

/** One node as the page needs it, read from R1's replica after a part. */
export type NodeRec = {
  id: string;
  kind: string;
  parent: string | null;
  slot: number | null;
  /** Position in the parent's frame, µm. */
  pos: [number, number, number];
  /** Orientation `[w, x, y, z]`, each scaled by 2^30. */
  rot: [number, number, number, number];
  /** The world time of its newest motion sample, when it has moved (a body). */
  at: number | null;
  /** Today's id of an imported thing (import-eden's field 1), the key of V17's model table (V8). */
  origin?: string;
  /** Soul grant from the existing public body-of link; null when missing or ambiguous. */
  soul?: string | null;
  /** Solids `[cx, cz, hx, hz, yaw mdeg, y0, y1, tag, abs]` mm in its own frame (import-eden's field 12). */
  solids?: number[][];
  /** Slots `[n, x, y, z, yaw mdeg, capacity]` mm (field 13). */
  slots?: number[][];
  /** An area's outline `[x, z]` mm, world (import-eden's field 11). */
  outline?: number[][];
  /** A floor's surfaces `[y, [[x, z] …]]` mm in its thing's frame (field 14). */
  surfaces?: [number, number[][]][];
  /** A floor's surfaces' materials by surface (`cobble`, `gravel` …; a hole where a surface names none), from
   *  `replica::fields::F_MATERIALS` (#3965). */
  materials?: string[];
  /** A water's level, mm (field 18). */
  waterLevel?: number;
  /** Scale in parts per million (field 23). */
  scale?: number;
  /** The open ground's terrain tiles: side mm (field 24) and `[tx, tz, heights, classes]` (field 25). */
  tileSize?: number;
  tiles?: [number, number, Uint8Array, Uint8Array][];
  /** A body's public name and one-line description (fields 30, 31, by reference; V1b), null while unknown. */
  name?: string | null;
  description?: string | null;
  /** Exact recorded body-kind hash (field32); absent is the stated default. */
  body?: string;
  /** A named place's (or room's, or thing's) public name: import-eden's field 4, by its hash, with the words from the
   *  text files' `[hash, words]` rows (#3574); null while unknown. */
  placeName?: string | null;
  /** The world node's day, night and weather fields (E6; V19, `sky/record.ts`). */
  sky?: SkyFields;
  /** A moving node's course (field 80, `replica::schedule::F_COURSE`), its value's canonical bytes, for the replica's
   *  `courseAt` (#3603). */
  course?: Uint8Array;
  /** Its plain fields by number (record key 6: whole numbers, texts, timed values), which hold its kind's state by each
   *  state field's `n` (#3871, `kinds/state.ts`); absent when it has none. */
  fields?: Fields;
};

/** Where the world is: its newest part's end, world time against wall time, and the world time up to which a still
 * world wrote nothing (V5b, #3460); the worker gives the latest `quietUntil` it found with every part before it
 * played, and keeps it after (it never steps back). */
export type Pointer = { newest: number | null; newestTo: number | null; period: number; anchorWorld: number; anchorWallMs: number; quietUntil: number | null };

/** One motion sample, as the part carried it: node, frame (parent node and slot), world time µs, position µm (V6). */
export type SampleRec = [string, string, number | null, number, number, number, number];

/** One `souls:said` event (V1b): the speaker's body, world time µs, length µs, reach mm, its words' reference and the
 * words from the part's text file (null when the file does not hold them, e.g. removed). */
export type SaidRec = { speaker: string; at: number; length: number; reach: number; ref: string; words: string | null; private?: Private };
/** A private turn's public record (`souls:said-privately`, #3775): the conversation and its members; never words. */
export type Private = { conversation: string; members: string[] };

/** What one part changed, in the order played; `samples` is every motion sample in it, in entry order; `said` every
 * utterance in it (V1b). */
export type PartRec = { number: number; from: number; to: number; nodes: NodeRec[]; removed: string[]; samples: SampleRec[]; hash: boolean | null; said?: SaidRec[]; happened?: Happened[] };

/** The COMPLETE currently drawable public state, including no opaque-frame descendants. A new source/worker
 * cannot know the caller's previous nodes. No invented part time, effects, events or motion. */
export type SnapshotRec = { nodes: NodeRec[]; removed: string[] };

/** Reconcile a full snapshot against the actual caller's retained state, including a history/live/source restart. */
export function reconcileSnapshot(previous: Iterable<string>, snapshot: SnapshotRec): SnapshotRec {
  const present = new Set(snapshot.nodes.map(n => n.id));
  const removed = new Set(snapshot.removed);
  for (const id of previous) if (!present.has(id)) removed.add(id);
  return { nodes: snapshot.nodes, removed: [...removed] };
}

export type SourceEvents = {
  snapshot?(s: SnapshotRec): void;
  pointer(p: Pointer): void;
  part(p: PartRec): void;
  error(message: string): void;
};

export interface Source {
  start(on: SourceEvents): void;
  stop(): void;
}

/** R1 query node key9 is [link id, type, other id, audience], not the Merkle node layout.
 * Only a unique public body-of relation names a Soul; malformed or ambiguous relations stay unknown. */
export function publicSoul(links: unknown): string | null {
  if (!Array.isArray(links)) return null;
  const souls = new Set<string>();
  for (const link of links) {
    if (!Array.isArray(link) || typeof link[1] !== 'string' || link[1].split('@')[0] !== 'souls:body-of') continue;
    const id = link[2], audience = link[3];
    if (!(audience instanceof Map) || audience.size !== 1 || audience.get(1) !== 1
        || !Array.isArray(id) || id.length !== 2 || !(id[0] instanceof Uint8Array) || id[0].length !== 16
        || !((typeof id[1] === 'number' && Number.isSafeInteger(id[1]) && id[1] >= 0)
          || (typeof id[1] === 'bigint' && id[1] >= 0n && id[1] <= 0xffffffffffffffffn))) return null;
    const scope = Array.from(id[0], (b: number) => b.toString(16).padStart(2, '0')).join('');
    souls.add(`soul-${scope}-${id[1]}`);
  }
  return souls.size === 1 ? [...souls][0] : null;
}
