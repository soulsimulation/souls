// The kinds' drawing files on the page (#3871): a kind's state fields and looks, from `assets/kinds/<namespace>/<name>.json`
// beside the page (written at build time from content/kinds by kind-entries.ts). Fetched once per kind, the first time
// a thing of it needs drawing; a kind with no file (not a content kind, or none published) is null.
//
// A creator's own kinds (#3697) have no file: each is a node of the engine's generic kind `souls:kind` at the world's
// root, holding its full name (`ns:name@<hash>`, field 1) and its canonical `souls-entry/1` record (field 2;
// `replica::kinds::defined`). The page learns them from the stream (`learn`) and answers a thing of one from its record:
// its `geometry.parts` (today's kit shapes in mm, millidegrees and permille, as `souls-god define-kit` writes them) and
// `geometry.palette` are the kind's shape. A record with no parts leaves the thing its box.
import type { EntryLook, EntryShape } from './shape.ts';
import type { StateDef } from './state.ts';
import type { LookRow } from './looks.ts';
import type { NodeRec } from '../source/source.ts';

export type KindEntry = { kind: string; state: Record<string, StateDef>; looks?: { model?: string; table?: LookRow[]; shape?: EntryLook } };

/** A node's kind (`namespace:name@hash`, or plain) as its drawing file's path, or null when it is not one. */
export function entryPath(kind: string): string | null {
  const m = /^([a-z][a-z0-9_]*):([a-z][a-z0-9_]*)(@|$)/.exec(kind);
  return m ? `assets/kinds/${m[1]}/${m[2]}.json` : null;
}

/** The engine's generic kind a creator's definition is a node of. */
export const DEFINITION = 'souls:kind';

type Json = Record<string, unknown>;
const obj = (v: unknown): Json | null => (v && typeof v === 'object' && !Array.isArray(v) ? (v as Json) : null);
const point = (v: unknown): v is [number, number, number] => Array.isArray(v) && v.length === 3 && v.every((x) => typeof x === 'number' && Number.isFinite(x));

/** A part as the shape builder reads it (it places each shape at `at`): one written `from`/`to` stands at their middle,
 *  turned along them and as long as they are apart. */
function shapeOf(p: Json): EntryShape | null {
  if (typeof p.kind !== 'string') return null;
  if (point(p.at)) return p as EntryShape;
  if (!point(p.from) || !point(p.to)) return null;
  const a = p.from, b = p.to, d = [b[0] - a[0], b[1] - a[1], b[2] - a[2]], len = Math.hypot(d[0], d[1], d[2]);
  const at = a.map((x, i) => Math.round(x + d[i] / 2)) as [number, number, number];
  if (len === 0) return { ...p, at } as EntryShape;
  // YXZ: the pitch tips +y towards +z, then the yaw turns it about +y, so +y runs from `from` to `to`
  const pitch = Math.round((Math.acos(d[1] / len) * 180_000) / Math.PI), yaw = Math.round((Math.atan2(d[0], d[2]) * 180_000) / Math.PI);
  return { ...p, at, pitch, yaw, h: typeof p.h === 'number' ? p.h : Math.round(len) } as EntryShape;
}

/** A creator's kind's record (its bytes) as the entry the kind layer draws, or null when it is not a `souls-entry/1`
 *  record. It has no state fields or looks table here. */
export function recordEntry(full: string, bytes: Uint8Array): KindEntry | null {
  let entry: Json | null;
  try {
    entry = obj(JSON.parse(new TextDecoder().decode(bytes)));
  } catch {
    return null;
  }
  if (!entry || entry.format !== 'souls-entry/1') return null;
  const g = obj(entry.geometry) ?? {};
  const shapes = (Array.isArray(g.parts) ? g.parts : []).map((p) => (obj(p) ? shapeOf(p as Json) : null)).filter((s): s is EntryShape => !!s);
  const palette = Object.fromEntries(Object.entries(obj(g.palette) ?? {}).filter(([, v]) => typeof v === 'string')) as Record<string, string>;
  return { kind: full, state: {}, looks: shapes.length ? { shape: { shapes, palette } } : {} };
}

export class Catalogue {
  private got = new Map<string, Promise<KindEntry | null>>();
  readonly known = new Map<string, KindEntry | null>();
  /** A creator's kinds by full name, and the full name each `souls:kind` node defines (#3697). */
  private defined = new Map<string, KindEntry>();
  private definers = new Map<string, string>();
  readonly base: string;
  readonly load: (url: string) => Promise<unknown>;
  constructor(base: string, load: (url: string) => Promise<unknown> = (url) => fetch(url).then((r) => (r.ok ? r.json() : null))) {
    this.base = base;
    this.load = load;
  }
  /** Learns the creator's kinds among `nodes` (their `souls:kind` nodes) and forgets those `removed`; the page calls
   *  it before it draws a batch's things, so a thing placed with its kind's definition finds it. */
  learn(nodes: NodeRec[], removed: string[]): void {
    for (const id of removed) {
      const full = this.definers.get(id);
      if (full === undefined) continue;
      this.definers.delete(id);
      if (![...this.definers.values()].includes(full)) this.defined.delete(full);
    }
    for (const n of nodes) {
      if (n.kind.split('@')[0] !== DEFINITION || !n.defines || !n.entry || this.definers.get(n.id) === n.defines) continue;
      const e = recordEntry(n.defines, n.entry);
      if (!e) continue;
      this.definers.set(n.id, n.defines);
      this.defined.set(n.defines, e);
    }
  }
  /** The kind's entry once fetched (null: none); undefined while it is on its way. Asks for it the first time. A
   *  creator's kind the world has defined is answered from its record, with no fetch. */
  entry(kind: string): Promise<KindEntry | null> {
    const own = this.defined.get(kind);
    if (own) return Promise.resolve(own);
    const path = entryPath(kind);
    if (!path) return Promise.resolve(null);
    let p = this.got.get(path);
    if (!p) {
      p = this.load(new URL(path, this.base).href).then((e) => (e && typeof e === 'object' && 'kind' in e ? (e as KindEntry) : null), () => null);
      p.then((e) => this.known.set(path, e));
      this.got.set(path, p);
    }
    return p;
  }
}
