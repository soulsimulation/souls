// The kinds' drawing files on the page (#3871): a kind's state fields and looks, from `assets/kinds/<namespace>/<name>.json`
// beside the page (written at build time from content/kinds by kind-entries.ts). Fetched once per kind, the first time
// a thing of it needs drawing; a kind with no file (not a content kind, or none published) is null.
import type { EntryLook } from './shape.ts';
import type { StateDef } from './state.ts';
import type { LookRow } from './looks.ts';

export type KindEntry = { kind: string; state: Record<string, StateDef>; looks?: { model?: string; table?: LookRow[]; shape?: EntryLook } };

/** A node's kind (`namespace:name@hash`, or plain) as its drawing file's path, or null when it is not one. */
export function entryPath(kind: string): string | null {
  const m = /^([a-z][a-z0-9_]*):([a-z][a-z0-9_]*)(@|$)/.exec(kind);
  return m ? `assets/kinds/${m[1]}/${m[2]}.json` : null;
}

export class Catalogue {
  private got = new Map<string, Promise<KindEntry | null>>();
  readonly known = new Map<string, KindEntry | null>();
  readonly base: string;
  readonly load: (url: string) => Promise<unknown>;
  constructor(base: string, load: (url: string) => Promise<unknown> = (url) => fetch(url).then((r) => (r.ok ? r.json() : null))) {
    this.base = base;
    this.load = load;
  }
  /** The kind's entry once fetched (null: none); undefined while it is on its way. Asks for it the first time. */
  entry(kind: string): Promise<KindEntry | null> {
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
