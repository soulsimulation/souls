// classroom-tv/1 (#2302): the four pictures of the library television (core-television@2, television.family.ts PICTURES),
// drawn on a classroom TV's screen canvas. Same parts, same colours, same order (tv-pictures.test.ts checks them against the
// def). A part is [u, v, w, h, colour, disc?]: u across (-0.5 left … 0.5 right), v up, w and h as fractions of the screen.
type Part = readonly [u: number, v: number, w: number, h: number, color: string, disc?: true];
export const TV_PICTURE_ART: Readonly<Record<'garden' | 'sea' | 'stars' | 'test-card', readonly Part[]>> = {
  garden: [[0, 0.2, 1, 0.6, '#8fc9ef'], [0, -0.3, 1, 0.4, '#4f9a45'], [0.22, -0.08, 0.56, 0.12, '#7bb35a'], [-0.26, 0.24, 0.16, 0.2, '#ffd75e', true]],
  sea: [[0, 0.22, 1, 0.56, '#f4b37a'], [0, -0.28, 1, 0.44, '#2a5d8f'], [0, -0.02, 0.2, 0.26, '#ffe08a', true], [0, -0.26, 0.06, 0.36, '#f7c873']],
  stars: [[0, 0, 1, 1, '#0d1636'], [0.28, 0.2, 0.18, 0.24, '#f2efd8', true],
    ...([[-0.38, 0.32], [-0.12, 0.08], [-0.3, -0.26], [0.34, -0.28]] as const).map(([u, v]): Part => [u, v, 0.025, 0.035, '#ffffff'])],
  'test-card': ['#f2f2f2', '#f2e14a', '#4ad7e0', '#52c24a', '#d24ad6', '#e0453a', '#3a4ee0'].map((c, i): Part => [-0.5 + (i + 0.5) / 7, 0, 1 / 7, 1, c]),
};
export const isTvPicture = (p: unknown): p is keyof typeof TV_PICTURE_ART => typeof p === 'string' && Object.hasOwn(TV_PICTURE_ART, p);

/** Paint one picture over the whole `w` × `h` canvas, back to front. */
export function drawTvPicture(ctx: CanvasRenderingContext2D, picture: keyof typeof TV_PICTURE_ART, w: number, h: number) {
  ctx.fillStyle = '#000000'; ctx.fillRect(0, 0, w, h);
  for (const [u, v, pw, ph, color, disc] of TV_PICTURE_ART[picture]) {
    const cx = (u + 0.5) * w, cy = (0.5 - v) * h;
    ctx.fillStyle = color;
    if (disc) { ctx.beginPath(); ctx.arc(cx, cy, Math.min(pw * w, ph * h) / 2, 0, Math.PI * 2); ctx.fill(); }
    else ctx.fillRect(cx - (pw * w) / 2, cy - (ph * h) / 2, pw * w, ph * h);
  }
}
