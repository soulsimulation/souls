// The page's Souls (W4, #2748): names, descriptions, status and speech, kept from the parts the page already plays
// (V1b's said events and the body's fields 30 and 31, with their words from the part's text file). Nothing here
// fetches: every chip, line of speech and Soul page is a query on this copy. Times are world microseconds.
//
// A Soul's status is derived from the copy, never sent: speaking while a sentence of its own is on, seated while it is
// in a slot, walking while its track has samples ahead of the clock or within the last second, else standing.
// The page draws every utterance its view carries and no other: who may read one (its audience) and how far it carries
// (its reach) were fixed when it was written, and the public view never holds a whisper.
import type { NodeRec, PartRec, SaidRec } from '../source/source.ts';

/** How many of a Soul's recent public events its page lists. */
export const RECENT = 8;
const WALKING_US = 1_000_000;

export type Soul = { id: string; name: string | null; description: string | null; soul?: string | null };
export type Status = 'speaking' | 'seated' | 'walking' | 'standing';
/** What the copy needs from the world view to say where a Soul is and how it moves. */
export type Bodies = { nodes: Map<string, NodeRec>; tracks: Map<string, { samples: { at: number }[] }> };

const plain = (kind: string) => kind.split('@')[0];
/** Is this node a Soul's body: one that moves (has samples), a body kind, or one with a public name? */
export const isSoul = (n: NodeRec) => n.at !== null || plain(n.kind).endsWith(':body') || n.name !== undefined;

export class SoulsCopy {
  readonly souls = new Map<string, Soul>();
  /** Each Soul's recent public utterances, oldest first, at most `RECENT`. */
  readonly recent = new Map<string, SaidRec[]>();
  /** Utterances that may still be on screen (their time not over at the newest part's end). */
  private live: SaidRec[] = [];

  /** Reconcile authorized nodes without changing speech, event history or time. */
  snapshot(nodes: NodeRec[], removed: string[]): void {
    for (const n of nodes) {
      if (!isSoul(n)) continue;
      const had = this.souls.get(n.id);
      // A part that does not carry the name field leaves the name it had.
      this.souls.set(n.id, {
        id: n.id,
        soul: n.soul !== undefined ? n.soul : had?.soul,
        name: n.name !== undefined ? n.name : had?.name ?? null,
        description: n.description !== undefined ? n.description : had?.description ?? null,
      });
    }
    for (const id of removed) {
      this.souls.delete(id);
      this.recent.delete(id);
    }
  }

  apply(p: Pick<PartRec, 'nodes' | 'removed' | 'said' | 'to'>): void {
    this.snapshot(p.nodes, p.removed);
    for (const s of p.said ?? []) {
      if (s.words === null) continue; // not in the public text file: not drawn
      const r = this.recent.get(s.speaker) ?? this.recent.set(s.speaker, []).get(s.speaker)!;
      r.push(s);
      if (r.length > RECENT) r.shift();
      this.live.push(s);
    }
    this.live = this.live.filter((s) => s.at + s.length > p.to - 60_000_000);
  }

  /** The sentence each Soul is saying at world time `t` (its newest, when two overlap). */
  speaking(t: number): Map<string, SaidRec> {
    const out = new Map<string, SaidRec>();
    for (const s of this.live) if (s.at <= t && t < s.at + s.length && (out.get(s.speaker)?.at ?? -Infinity) <= s.at) out.set(s.speaker, s);
    return out;
  }

  status(id: string, t: number, bodies: Bodies, speaking?: Map<string, SaidRec>): Status {
    if ((speaking ?? this.speaking(t)).has(id)) return 'speaking';
    const n = bodies.nodes.get(id);
    if (n && n.slot !== null) return 'seated';
    const s = bodies.tracks.get(id)?.samples;
    const last = s?.[s.length - 1];
    if (s && s.length > 1 && last && last.at > t - WALKING_US) return 'walking';
    return 'standing';
  }

  /** What a Soul's page shows, all of it public: name, description, status and recent public events. */
  page(id: string, t: number, bodies: Bodies): { name: string; description: string; status: Status; recent: SaidRec[] } | null {
    const s = this.souls.get(id);
    if (!s) return null;
    return { name: label(s), description: s.description ?? '', status: this.status(id, t, bodies), recent: [...(this.recent.get(id) ?? [])].reverse() };
  }
}

/** A Soul's chip text: its public name, or its id's counter while the name is unknown. */
export const label = (s: Soul) => s.name ?? `Soul ${s.id.split('.').pop()}`;

/** Breaks `text` into lines no wider than `max` (by `width`), at most `lines`, the last cut with an ellipsis. Text only:
 *  nothing in it is read as markup or an address. */
export function wrap(text: string, max: number, width: (s: string) => number, lines = 3): string[] {
  const out: string[] = [];
  let line = '';
  for (const word of text.split(/\s+/).filter(Boolean)) {
    const next = line ? `${line} ${word}` : word;
    if (width(next) <= max || !line) line = next;
    else {
      out.push(line);
      line = word;
    }
  }
  if (line) out.push(line);
  if (out.length <= lines) return out;
  const kept = out.slice(0, lines);
  let last = kept[lines - 1];
  while (last.length > 1 && width(`${last}…`) > max) last = last.slice(0, -1);
  kept[lines - 1] = `${last}…`;
  return kept;
}

/** One immutable status lookup per public Soul identity, only opened cards trigger it.
 * Unknown/failed results never assert that a Soul is ordinary; stale results cannot change another card. */
export class TestMark {
  private readonly cache = new Map<string, Promise<boolean | null>>();
  private generation = 0;
  private readonly load: (soul: string) => Promise<boolean | null>;
  constructor(load: (soul: string) => Promise<boolean | null>) { this.load = load; }
  open(soul: string | null, show: (test: boolean | null) => void): void {
    const generation = ++this.generation;
    show(null);
    if (!soul) return;
    let result = this.cache.get(soul);
    if (!result) {
      result = this.load(soul).catch(() => null);
      this.cache.set(soul, result);
    }
    result.then((test) => { if (generation === this.generation) show(test); });
  }
}
