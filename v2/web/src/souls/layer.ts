// Chips and speech on screen (W4, #2748): one 2D canvas over the view, drawn in one pass a frame, never a page element
// per Soul (1,000 elements was today's fault, #2554). Labels are placed nearest first, and one that would overlap a
// placed one is left out, so far ones give way first; at most `MAX_LABELS` a frame. Speech is placed before chips.
// Every word is drawn with `fillText`: text only, never markup, and nothing in it becomes a link.

/** One Soul on screen this frame: where its head projects (CSS px), how far it is (m), and what to draw. */
export type Candidate = { id: string; x: number; y: number; dist: number; chip: string; status: string; speech: string | null };
export type Placed = { id: string; x: number; y: number; w: number; h: number; lines: string[]; speech: boolean; status: string };

export const MAX_LABELS = 160;
const FONT = '12px system-ui, sans-serif', SMALL = '10px system-ui, sans-serif', LINE = 15, PAD = 5, SPEECH_W = 240;

/** What the layer needs from a 2D context; the page's canvas, or a recorder in a test. */
export type Ctx = Pick<CanvasRenderingContext2D, 'fillText' | 'measureText' | 'fillRect' | 'clearRect' | 'setTransform' | 'beginPath' | 'moveTo' | 'lineTo' | 'fill'> & {
  font: string; fillStyle: string | CanvasGradient | CanvasPattern; textBaseline: CanvasTextBaseline;
};

/** Places labels: speech first, then chips, each nearest first; a label overlapping one already placed is left out. */
export function place(cands: Candidate[], width: (s: string, small?: boolean) => number, wrapLines: (s: string) => string[], vw: number, vh: number): Placed[] {
  const out: Placed[] = [];
  const order = [...cands].sort((a, b) => Number(!a.speech) - Number(!b.speech) || a.dist - b.dist);
  for (const c of order) {
    if (out.length >= MAX_LABELS) break;
    const lines = c.speech ? wrapLines(c.speech) : [c.chip];
    const w = Math.max(...lines.map((l) => width(l)), c.speech ? 0 : width(c.status, true)) + 2 * PAD;
    const h = (c.speech ? lines.length * LINE : LINE + 11) + 2 * PAD;
    const x = c.x - w / 2, y = c.y - h - (c.speech ? 8 : 2);
    if (x + w < 0 || y + h < 0 || x > vw || y > vh) continue;
    if (out.some((p) => x < p.x + p.w && p.x < x + w && y < p.y + p.h && p.y < y + h)) continue;
    out.push({ id: c.id, x, y, w, h, lines, speech: !!c.speech, status: c.status });
  }
  return out;
}

/** Draws placed labels, farthest first so the nearest are on top. */
export function paint(ctx: Ctx, placed: Placed[]): void {
  ctx.textBaseline = 'top';
  for (let i = placed.length - 1; i >= 0; i--) {
    const p = placed[i];
    ctx.fillStyle = p.speech ? 'rgba(250, 248, 240, 0.94)' : 'rgba(16, 20, 26, 0.72)';
    ctx.fillRect(p.x, p.y, p.w, p.h);
    if (p.speech) {
      ctx.beginPath();
      ctx.moveTo(p.x + p.w / 2 - 5, p.y + p.h);
      ctx.lineTo(p.x + p.w / 2 + 5, p.y + p.h);
      ctx.lineTo(p.x + p.w / 2, p.y + p.h + 7);
      ctx.fill();
    }
    ctx.fillStyle = p.speech ? '#1b1d22' : '#f2efe8';
    ctx.font = FONT;
    p.lines.forEach((l, k) => ctx.fillText(l, p.x + PAD, p.y + PAD + k * LINE));
    if (!p.speech) {
      ctx.font = SMALL;
      ctx.fillStyle = '#b8c4cf';
      ctx.fillText(p.status, p.x + PAD, p.y + PAD + LINE);
    }
  }
}

/** Measures text with the context, by string, cached: the same names are measured once, not every frame. */
export function measurer(ctx: Ctx): (s: string, small?: boolean) => number {
  const cache = new Map<string, number>();
  return (s, small = false) => {
    const k = small ? `\u0000${s}` : s;
    let w = cache.get(k);
    if (w === undefined) {
      ctx.font = small ? SMALL : FONT;
      w = ctx.measureText(s).width;
      if (cache.size > 20_000) cache.clear();
      cache.set(k, w);
    }
    return w;
  };
}

export { SPEECH_W };
