// Lying on the page (#3791): a body the world lays down plays today's lying pose, `LayToIdle` held at its first
// frame (`mars/viewer/app/engine-view/clip-library.ts`: a lie or nap), laid out as today's renderer lays it
// (`humans.ts`: the hips over the body point, the head along the body's back), baked once as `Lie` (`./bake.ts`).
// A body lies while its node's public stance field says so (2: lie), in a bed's slot or on the ground where the
// wind-down laid it (B16); `../draw/world.ts` reads it as it reads the body's parent and slot, so a page opened after
// the body lay down draws it lying. It blends in over `FADE` from the world time the page saw it lie down and out over
// `FADE` from when it stood, as today's clip fade (`CLIP_FADE`); a held clock holds the pose.

/** Seconds a lie takes to blend in or out: today's CLIP_FADE. */
export const FADE = 0.35;
/** The baked lying clip's name. */
export const LIE_CLIP = 'Lie';

/** A stretch of lying, world µs: from when it lay down to when it stood (null: still lying). */
export type Span = { from: number; to: number | null };

const smooth = (u: number) => (u <= 0 ? 0 : u >= 1 ? 1 : u * u * (3 - 2 * u));

/** How far into its lying pose a body is at world time `t` (0 standing, 1 lying), from its spans in time order. */
export function lyingAt(spans: readonly Span[], t: number): number {
  for (let i = spans.length - 1; i >= 0; i--) {
    const s = spans[i];
    if (s.from > t) continue;
    const out = s.to === null ? 0 : smooth((t - s.to) / (FADE * 1e6));
    return smooth((t - s.from) / (FADE * 1e6)) * (1 - out);
  }
  return 0;
}

/** Keeps at most this many spans a body: the last is all a frame draws. */
const KEEP = 4;

/** Every body's lying spans, as the page saw its stance. */
export class Lying {
  readonly spans = new Map<string, Span[]>();

  /** Body `id` lies from `at` (nothing when it already does). */
  down(id: string, at: number): void {
    const list = this.spans.get(id) ?? this.spans.set(id, []).get(id)!;
    const last = list[list.length - 1];
    if (last && last.to === null) return;
    if (last && last.from === at) return;
    list.push({ from: at, to: null });
    if (list.length > KEEP) list.shift();
  }

  /** Body `id` stands from `at` (nothing when it is not lying). */
  up(id: string, at: number): void {
    const last = this.spans.get(id)?.at(-1);
    if (last && last.to === null) last.to = Math.max(at, last.from);
  }

  at(id: string, t: number): number {
    const list = this.spans.get(id);
    return list ? lyingAt(list, t) : 0;
  }

  forget(id: string): void {
    this.spans.delete(id);
  }
}
