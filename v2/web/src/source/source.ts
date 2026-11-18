// A source of the world for the page (V5, #2714): something that says where the world is (a pointer), how it starts
// (a snapshot) and what changed (parts). V1's stream of numbered files is the first; V9 (history) and V13 add theirs
// by implementing `Source`. Times are world microseconds; positions micrometres in the node's parent frame (T4).

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
  /** Solids `[cx, cz, hx, hz, yaw mdeg, y0, y1, tag, abs]` mm in its own frame (import-eden's field 12). */
  solids?: number[][];
  /** Slots `[n, x, y, z, yaw mdeg, capacity]` mm (field 13). */
  slots?: number[][];
  /** Scale in parts per million (field 23). */
  scale?: number;
  /** The open ground's terrain tiles: side mm (field 24) and `[tx, tz, heights, classes]` (field 25). */
  tileSize?: number;
  tiles?: [number, number, Uint8Array, Uint8Array][];
};

/** Where the world is: its newest part's end, and world time against wall time. */
export type Pointer = { newest: number | null; newestTo: number | null; period: number; anchorWorld: number; anchorWallMs: number };

/** What one part changed, in the order played. */
export type PartRec = { number: number; from: number; to: number; nodes: NodeRec[]; removed: string[]; hash: boolean | null };

export type SourceEvents = {
  pointer(p: Pointer): void;
  part(p: PartRec): void;
  error(message: string): void;
};

export interface Source {
  start(on: SourceEvents): void;
  stop(): void;
}
