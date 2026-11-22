// Ground-laid areas (paths, lawns, pitches, courts, beds): flat on the drawn ground in their surface's
// colour, as today's page drapes them (apps/web/src/gen-mesh/areas.mesh.ts, paths.mesh.ts), not as a box around
// their solids. A path's surfaces carry their material (#3965, `F_MATERIALS`), drawn as today's roads.mesh.ts draws it
// (`PAVING`); every other area's colour is its kind's default. Each area is its floor's
// surfaces (import-eden's field 14), or its outline (field 11) when it has none, cut into triangles no side longer
// than the ground's 1 m grid, each corner at the ground's height plus the surface's own lift.
import * as THREE from 'three';
import { browserQuality } from './quality-tier.ts';
import { patchWind, windWeights } from '../sky/wind.ts';

/** Today's default surface colour for each ground-laid kind (by its plain name). */
// A terrace is not one: today it draws nothing and levels the ground (generators' terrace/1).
export const DRAPES: Record<string, number> = {
  footpath: 0xb3ac9e, // path/1: gravel
  lawn: 0x6aa84f,
  'sand-patch': 0xd9c38f,
  'garden-bed': 0x6a5136,
  'flower-garden': 0x6a5136,
  'football-pitch': 0x4f8f3a,
  'tennis-court': 0x3f7a5a,
  // shore/1 and river/1's banks (water.mesh.ts BANKS): Eden's shores are pebble (two) and stone (one), its river's banks
  // reeds; the stream carries no material, so these are Eden's.
  shore: 0xa8a090,
  river: 0x6d6a45,
};

/** Kinds whose areas fade from wet at their inner edge to the ground's colour at their outer one (today's shore/1 and
 *  river/1 banks), rather than ending in a hard cut. */
export const BANKS: Record<string, { wet: number; dry: number }> = {
  // shore/1: mix(wet, mix(col, #7d9c56, 0.25), t), wet = col * 0.75
  shore: { wet: 0.75, dry: 0.25 },
  // river/1: mix(wet, dry, k / ACROSS), wet = bank * 0.72, dry = mix(bank, Eden's ground #8a9b6e, 0.35)
  river: { wet: 0.72, dry: 0.35 },
};
const BANK_GREEN: Record<string, number> = { shore: 0x7d9c56, river: 0x8a9b6e };

/** Today's path/1 surfaces by material (apps/web/src/gen-mesh/roads.mesh.ts `BASE`, `GROUT`, setts): the surface's
 *  colour, the grout between its setts and each sett's length along the path and width across it, m (a board runs
 *  the path's whole width); gravel and dirt are speckled (`[cells a metre, least, spread, hash seed]`), dirt has wheel ruts. */
export const PAVING: Record<string, { base: number; grout?: number; sett?: [number, number]; speck?: [number, number, number, number] }> = {
  gravel: { base: 0xb5ad9c, speck: [3, 0.82, 0.3, 1] },
  dirt: { base: 0x8e6d4b, speck: [2, 0.92, 0.14, 3] },
  sand: { base: 0xd6c08c, speck: [2, 0.92, 0.14, 3] },
  asphalt: { base: 0x4d5054 },
  cobble: { base: 0xa49b8c, grout: 0x6f685d, sett: [0.5, 0.34] },
  stone: { base: 0xbdb5a5, grout: 0x8a8273, sett: [0.9, 0.6] },
  wood: { base: 0xa07a4f, sett: [0.25, 0] },
};
/** The shader's code for a material's pattern: 0 none, 1 to 3 setts (cobble, stone, wood), 4 ruts (dirt, sand). */
const PATTERN: Record<string, number> = { cobble: 1, stone: 2, wood: 3, dirt: 4, sand: 4 };

/** Decks over water or ground (piers, bridges, decks): their surfaces are at their own heights, not on the ground. */
export const DECKS: Record<string, number> = {
  pier: 0xa07a4f, // wood
  deck: 0xa07a4f,
  bridge: 0x9a8f80,
};

/** Still water (a lake's, a pond's outline at its level), so what floats on it is seen on water, not over its bed. */
export const WATER = 0x4f7f9a;

/** A kind's plain name, `core:footpath@1` -> `footpath`. */
export const drapeName = (kind: string) => kind.split('@')[0].split(':').pop()!;

/** Lift above the ground, m, at least: enough to stay over the ground's triangles between the grid points. */
const MIN_LIFT = 0.02;
/** Longest side of a drawn triangle, m (the ground's grid). */
const MAX_SIDE = 1;

/** An area's corners `[x, z]` (m); `lift` above the ground, or the height itself when `level` (a deck). A path's
 *  surface names its `material`, and its centre `line` (m, world) and `width` (m) lay its pattern (`bandLine`). */
export type Area = {
  colour: number; lift: number; points: [number, number][]; level?: boolean; bank?: string;
  material?: string; line?: [number, number][]; width?: number;
};

/** A path surface's own centre line and width: today's path bakes are bands (`generators` `band`: one edge forward,
 *  the other back, a point for a point), so each pair of opposite corners straddles the centre (#3965). */
export function bandLine(points: [number, number][]): { line: [number, number][]; width: number } | null {
  const n = points.length >> 1;
  if (n < 2 || points.length % 2) return null;
  const line: [number, number][] = [], across: number[] = [];
  for (let i = 0; i < n; i++) {
    const [ax, az] = points[i], [bx, bz] = points[points.length - 1 - i];
    line.push([(ax + bx) / 2, (az + bz) / 2]);
    across.push(Math.hypot(ax - bx, az - bz));
  }
  return { line, width: across.sort((a, b) => a - b)[n >> 1] };
}

/** A point's place on a path: `[q, t]`, how far along its centre line (m, from its start) and how far across it (m,
 *  signed), against the nearest of its segments, as today's setts are laid (`l3-path.ts` `at`). */
export function alongPath(line: [number, number][], x: number, z: number): [number, number] {
  let best = Infinity, q = 0, t = 0, run = 0;
  for (let i = 0; i + 1 < line.length; i++) {
    const [ax, az] = line[i], [bx, bz] = line[i + 1], dx = bx - ax, dz = bz - az, l = Math.hypot(dx, dz);
    if (l > 0) {
      const k = Math.max(0, Math.min(l, ((x - ax) * dx + (z - az) * dz) / l)), px = ax + (dx * k) / l, pz = az + (dz * k) / l, d = Math.hypot(x - px, z - pz);
      if (d < best) (best = d, q = run + k, t = ((x - ax) * -dz + (z - az) * dx) / l);
    }
    run += l;
  }
  return [q, t];
}

/** A bank's colour at a point: wet where the area meets the water (its corners lowest on the ground), the ground's own
 *  colour at its outer edge, as today's shore/1 and river/1 meshes fade them. `t` is 0 at the water, 1 on dry ground. */
export function bankColour(c: THREE.Color, colour: number, bank: string, t: number): THREE.Color {
  const b = BANKS[bank], u = Math.max(0, Math.min(1, t));
  const wet = new THREE.Color(colour).multiplyScalar(b.wet), dry = new THREE.Color(colour).lerp(new THREE.Color(BANK_GREEN[bank]), b.dry);
  return c.copy(wet).lerp(dry, u);
}

/** Where a point stands on its bank, 0 at the water's edge to 1 on dry ground: its height between the lowest and the
 *  highest ground within the bank's width (3 m) around it, so a bank down into a lake or a river's trench reads wet at
 *  its foot and dry at its top, wherever along the water it is. */
export function wetness(x: number, z: number, h: number, heightAt: (x: number, z: number) => number | null): number {
  let lo = h, hi = h;
  for (let k = 0; k < 8; k++) {
    const g = heightAt(x + BANK_REACH * Math.cos((k * Math.PI) / 4), z + BANK_REACH * Math.sin((k * Math.PI) / 4));
    if (g !== null) (lo = Math.min(lo, g), hi = Math.max(hi, g));
  }
  return hi - lo > 0.05 ? (h - lo) / (hi - lo) : 1;
}
const BANK_REACH = 3;

/** One mesh of every area, each corner on the ground (`heightAt`); corners off the ground keep height 0. */
export function drapeMesh(areas: Area[], heightAt: (x: number, z: number) => number | null): THREE.Mesh | null {
  const pos: number[] = [], col: number[] = [], pave: number[] = [];
  const c = new THREE.Color();
  for (const a of areas) {
    if (a.points.length < 3) continue;
    const look = a.material ? PAVING[a.material] : undefined, code = (a.material && a.line && a.width && PATTERN[a.material]) || 0;
    c.setHex(look?.grout ?? a.colour);
    const contour = a.points.map(([x, z]) => new THREE.Vector2(x, z));
    const lift = a.level ? a.lift : Math.max(MIN_LIFT, a.lift);
    const put = (p: THREE.Vector2) => {
      const h = heightAt(p.x, p.y) ?? 0;
      pos.push(p.x, a.level ? lift : h + lift, p.y);
      if (a.bank) bankColour(c, a.colour, a.bank, wetness(p.x, p.y, h, heightAt));
      // today's gravel and dirt: each corner a little lighter or darker, by a hash of where it is
      if (look?.speck) { const [n, lo, span, seed] = look.speck; c.setHex(a.colour).multiplyScalar(lo + h01(Math.round(p.x * n), Math.round(p.y * n), seed) * span); }
      col.push(c.r, c.g, c.b);
      if (code) pave.push(...alongPath(a.line!, p.x, p.y), code, a.width!);
      else pave.push(0, 0, 0, 0);
    };
    const split = (p: THREE.Vector2, q: THREE.Vector2, r: THREE.Vector2): void => {
      const pq = p.distanceTo(q), qr = q.distanceTo(r), rp = r.distanceTo(p), most = Math.max(pq, qr, rp);
      if (most <= MAX_SIDE || a.level) { // a level area needs no corners between its own
        // Facing up whichever way the outline winds.
        if ((q.x - p.x) * (r.y - p.y) - (q.y - p.y) * (r.x - p.x) > 0) (put(p), put(r), put(q));
        else (put(p), put(q), put(r));
        return;
      }
      if (most === pq) {
        const m = p.clone().lerp(q, 0.5);
        (split(p, m, r), split(m, q, r));
      } else if (most === qr) {
        const m = q.clone().lerp(r, 0.5);
        (split(q, m, p), split(m, r, p));
      } else {
        const m = r.clone().lerp(p, 0.5);
        (split(r, m, q), split(m, p, q));
      }
    };
    for (const [i, j, k] of THREE.ShapeUtils.triangulateShape(contour, [])) split(contour[i], contour[j], contour[k]);
  }
  if (!pos.length) return null;
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
  g.setAttribute('color', new THREE.Float32BufferAttribute(col, 3));
  const paved = pave.some((v, i) => i % 4 === 2 && v > 0);
  if (paved) g.setAttribute('pave', new THREE.Float32BufferAttribute(pave, 4));
  g.computeVertexNormals();
  const m = new THREE.MeshLambertMaterial({ vertexColors: true, polygonOffset: true, polygonOffsetFactor: -2, polygonOffsetUnits: -2 });
  if (paved) pavingMaterial(m);
  const mesh = new THREE.Mesh(g, m);
  mesh.receiveShadow = true;
  mesh.name = 'drapes';
  return mesh;
}

// Today's setts (roads.mesh.ts, step 2): rows `len` m along the path, `nAcross = round(w / wid)` stones across in a
// running bond (every other row shifted half a stone), a 5 cm grout joint (3 cm between boards), each stone its own
// tone (0.86 to 1.1 of its colour, by a hash of its row and place); slivers under 8 cm at the edges stay grout. Dirt's
// two wheel ruts (0.22 of the width either side of the centre, 0.5 m wide) are 0.8 of its colour. The vertex colour is
// the grout (or the surface); `pave` is each corner's `[q, t]` on the path, its pattern code and the path's width.
const lin = (hex: number) => { const c = new THREE.Color(hex); return `vec3(${c.r.toFixed(5)},${c.g.toFixed(5)},${c.b.toFixed(5)})`; };
const SETTS = /* glsl */`
uint paveHash(int a,int b,int c){uint h=uint(a)*374761393u+uint(b)*668265263u+uint(c)*2147483647u;h=(h^(h>>13u))*1274126177u;h^=h>>16u;return h;}
float paveH01(int a,int b,int c){return float(paveHash(a,b,c))/4294967296.;}
`;
const PAVE = /* glsl */`
if(vPave.z>.5){
 float q=vPave.x,t=vPave.y,w=vPave.w;int code=int(vPave.z+.5);
 if(code==4){ if(abs(abs(t)-w*.22)<.25) diffuseColor.rgb*=.8; }
 else{
  vec3 stone=code==1?${lin(PAVING.cobble.base)}:code==2?${lin(PAVING.stone.base)}:${lin(PAVING.wood.base)};
  float len=code==1?${PAVING.cobble.sett![0].toFixed(2)}:code==2?${PAVING.stone.sett![0].toFixed(2)}:${PAVING.wood.sett![0].toFixed(2)};
  float wid=code==1?${PAVING.cobble.sett![1].toFixed(2)}:code==2?${PAVING.stone.sett![1].toFixed(2)}:w;
  float gap=code==3?.03:.05;
  float nA=max(1.,floor(w/wid+.5)),ww=w/nA;
  int row=int(floor(q/len));
  float off=code==3?0.:float(row-2*(row/2))*ww*.5;
  float s=w*.5+off-t;int k=int(floor(s/ww));
  float t0=min(w*.5,w*.5-float(k)*ww+off),t1=max(-w*.5,w*.5-float(k)*ww+off-ww+gap);
  if(q-float(row)*len<len-gap&&t<t0&&t>t1&&t0-t1>=.08) diffuseColor.rgb=stone*(.86+paveH01(row,k,7)*.24);
 }
}
`;
function pavingMaterial(m: THREE.MeshLambertMaterial) {
  m.onBeforeCompile = (sh) => {
    sh.vertexShader = 'attribute vec4 pave;\nvarying vec4 vPave;\n' + sh.vertexShader.replace('#include <begin_vertex>', '#include <begin_vertex>\nvPave=pave;');
    sh.fragmentShader = 'varying vec4 vPave;\n' + SETTS + sh.fragmentShader.replace('#include <color_fragment>', `#include <color_fragment>\n${PAVE}`);
  };
  m.customProgramCacheKey = () => 'v2-drapes-paving-1';
}

// ---------------------------------------------------------------- the turf (today's WorldEdenRealism ground class)
// Today's Eden terrain takes the realism shader's ground branch: lush and sun-dried swathes, warm and cool patches, a
// mid-scale mottle and earthier banks. Here that branch's colour, as today computes it beyond the 40 m detail range (the
// fine blade texture is the ground cover's job up close), patched into the ground's own material.
const TURF = /* glsl */`
{
 vec3 w=vTurfW,n=normalize(vTurfN);
 float macro=turfNoise(w.xz*.045)*.65+turfNoise(w.xz*.14+7.3)*.35,temp=turfNoise(w.xz*.028+31.);
 vec3 tint=mix(vec3(.74,.97,.86),vec3(1.24,1.08,.7),smoothstep(.28,.78,macro))*(.82+.3*macro);
 tint*=mix(vec3(.94,1.,1.06),vec3(1.06,1.,.9),temp);
 tint*=(.8+.36*turfNoise(w.xz*.43+3.1))*.87;
 tint=mix(tint,tint*vec3(1.02,.94,.8),smoothstep(.97,.82,n.y)*.8);
 diffuseColor.rgb*=tint;
}
`;
const TURF_NOISE = /* glsl */`
varying vec3 vTurfW;
varying vec3 vTurfN;
float turfHash(vec2 p){p=fract(p*vec2(123.34,456.21));p+=dot(p,p+45.32);return fract(p.x*p.y);}
float turfNoise(vec2 p){vec2 i=floor(p),f=fract(p),d=fwidth(p);f=f*f*(3.-2.*f);
 float n=mix(mix(turfHash(i),turfHash(i+vec2(1.,0.)),f.x),mix(turfHash(i+vec2(0.,1.)),turfHash(i+vec2(1.,1.)),f.x),f.y);
 return mix(n,.5,smoothstep(.3,.9,max(d.x,d.y)));}
`;
/** The ground's material: its vertex colours (the palette) under today's Eden turf field. */
export function turfMaterial(): THREE.MeshLambertMaterial {
  const m = new THREE.MeshLambertMaterial({ vertexColors: true });
  m.name = 'eden turf';
  m.onBeforeCompile = (sh) => {
    sh.vertexShader = 'varying vec3 vTurfW;\nvarying vec3 vTurfN;\n' + sh.vertexShader.replace('#include <worldpos_vertex>',
      '#include <worldpos_vertex>\nvTurfW=(modelMatrix*vec4(transformed,1.)).xyz;vTurfN=normalize(mat3(modelMatrix)*objectNormal);');
    sh.fragmentShader = TURF_NOISE + sh.fragmentShader.replace('#include <color_fragment>', `#include <color_fragment>\n${TURF}`);
  };
  m.customProgramCacheKey = () => 'v2-eden-turf-1';
  return m;
}

// ---------------------------------------------------------------- ground cover (today's gen-mesh/ground-cover.ts, W4)
// Old Eden's field: tall swaying grass, short tufts and wildflowers, drawn around the camera from the ground itself,
// never as things. As today: 8 m cells dealt from a fixed hash (the same blade always in the same place), nearest first
// within a millisecond a frame, each cell's instances sorted by rank so a cell gives a prefix that shrinks with distance,
// and the shader shrinks the far ones away instead of popping. Today's recipe (ground-cover-recipe.ts) for Eden's
// meadow palette: bare below the plain (shores, beds, banks), on steep ground, on paths, beds, shores and under every
// footprint; a lawn mown to tufts with a long rim; verges a little longer, with flowers. Off on the phone tier, `?cover=0|1`.
export const COVER_CELL = 8;
export const COVER_KINDS = ['tall', 'tuft', 'flower'] as const;
type CoverKind = (typeof COVER_KINDS)[number];
const STEP: Record<CoverKind, number> = { tall: 0.62, tuft: 0.42, flower: 0.7 };
const LOD: Record<CoverKind, { d0: number; dmax: number; exp: number; maxScale: number; cap: number }> = {
  tall: { d0: 16, dmax: 90, exp: 1.45, maxScale: 1.6, cap: 26000 },
  tuft: { d0: 8, dmax: 28, exp: 1.4, maxScale: 1.35, cap: 12000 },
  flower: { d0: 16, dmax: 70, exp: 1.25, maxScale: 1.5, cap: 7000 },
};
/** Today's meadow palette's growth (ground-cover-recipe.ts PALETTE.meadow). */
const MEADOW_COVER = { tall: 0.16, tuft: 0.85, flower: 0.12, h: 0.55, rockFrom: 0.75, snow: 150 };
export const FLOWER_COLOURS = ['#f6f3ea', '#f3cf3f', '#d8402e', '#7f93e0', '#b27ad6', '#f08cb6', '#f6f3ea', '#ffb347'];
const keepAt = (k: CoverKind, d: number) => { const l = LOD[k]; if (d >= l.dmax) return 0; const f = Math.pow(l.d0 / Math.max(d, l.d0), l.exp); const e = (d - l.dmax * 0.75) / (l.dmax * 0.25); return e > 0 ? f * (1 - e * e * (3 - 2 * e)) : f; };
const MAX_D = Math.max(...Object.values(LOD).map((l) => l.dmax));
const MOVE = 2.5, DEAL_MS = 1, KEEP_CELLS = 1400, REC = 10, SITES = 4;

export function h01(a: number, b = 0, c = 0): number { let h = (Math.imul(a | 0, 374761393) + Math.imul(b | 0, 668265263) + Math.imul(c | 0, 2147483647)) | 0; h = Math.imul(h ^ (h >>> 13), 1274126177); h = (h ^ (h >>> 16)) >>> 0; return h / 4294967296; }
function vn(x: number, z: number, seed: number): number {
  const xi = Math.floor(x), zi = Math.floor(z), fx = x - xi, fz = z - zi, u = fx * fx * (3 - 2 * fx), v = fz * fz * (3 - 2 * fz);
  const a = h01(xi, zi, seed), b = h01(xi + 1, zi, seed), c = h01(xi, zi + 1, seed), d = h01(xi + 1, zi + 1, seed);
  return a + (b - a) * u + (c - a) * v + (a - b - c + d) * u * v;
}
const ss = (a: number, b: number, x: number) => { const t = Math.max(0, Math.min(1, (x - a) / (b - a))); return t * t * (3 - 2 * t); };
const fr = Math.fround, fract = (v: number) => v - Math.floor(v);
function edenHash(x: number, y: number) { let px = fract(fr(x * 123.34)), py = fract(fr(y * 456.21)); const d = px * (px + 45.32) + py * (py + 45.32); px = fr(px + d); py = fr(py + d); return fract(fr(px * py)); }
function edenNoise(x: number, y: number) {
  const ix = Math.floor(x), iy = Math.floor(y); let fx = x - ix, fy = y - iy; fx = fx * fx * (3 - 2 * fx); fy = fy * fy * (3 - 2 * fy);
  const a = edenHash(ix, iy), b = edenHash(ix + 1, iy), c = edenHash(ix, iy + 1), d = edenHash(ix + 1, iy + 1);
  return a + (b - a) * fx + (c + (d - c) * fx - (a + (b - a) * fx)) * fy;
}
/** The turf shader's lush / sun-dried field, so a blade takes the tone of the turf it stands in. */
const realismMacro = (x: number, z: number) => edenNoise(x * 0.045, z * 0.045) * 0.65 + edenNoise(x * 0.14 + 7.3, z * 0.14 + 7.3) * 0.35;

/** What the cover reads of the world: the drawn ground, the ground's paint, where nothing grows (paths, beds, shores,
 *  footprints) and the lawns (mown short, their rim long). */
export type CoverGround = {
  heightAt: (x: number, z: number) => number | null;
  colour: (c: THREE.Color, y: number, slope: number, x: number, z: number) => void;
  blocked: (x: number, z: number) => boolean;
  lawn: (x: number, z: number) => { edge: number; rim: number } | null;
  base: number;
};
export type Site = { tall: number; tuft: number; flower: number; h: number; short: number; r: number; g: number; b: number; dry: number };
const _c = new THREE.Color();
/** Today's `siteAt` for Eden's meadow ground: null where nothing grows, else densities, tall height and turf colour. */
export function siteAt(gr: CoverGround, x: number, z: number, verge: boolean): Site | null {
  const P = MEADOW_COVER, y = gr.heightAt(x, z);
  if (y === null) return null;
  const h = y - gr.base;
  if (h < -0.15) return null;                                        // shore, banks below the plain, beds, under water
  const e = 0.5, slope = Math.hypot(((gr.heightAt(x + e, z) ?? y) - (gr.heightAt(x - e, z) ?? y)) / (2 * e), ((gr.heightAt(x, z + e) ?? y) - (gr.heightAt(x, z - e) ?? y)) / (2 * e));
  const steep = 1 - ss(P.rockFrom * 0.55, P.rockFrom, slope), high = h > P.snow ? 0 : 1 - 0.65 * ss(40, 110, h), base = steep * high;
  if (base <= 0) return null;
  const drift = vn(x / 13 + 0.37, z / 13 + 0.71, 5), swathe = 0.1 + 1.9 * ss(0.4, 0.8, drift);
  let short = 1, tall = P.tall * swathe, tuft = P.tuft, flower = P.flower * (0.4 + 1.2 * vn(x / 9, z / 9, 9)), ht = P.h * (0.8 + 0.4 * drift);
  const lawn = gr.lawn(x, z);
  if (lawn) {
    const rim = 1 - ss(lawn.edge * 0.6, lawn.edge + 1.2, lawn.rim);
    tall = Math.max(tall, 0.45) * rim; ht *= 0.75 + 0.25 * rim;
    tuft = 0.55; short = 0.65 + 0.35 * rim; flower = Math.max(flower * rim, 0.03);
  }
  if (verge) { tall = Math.max(tall, lawn ? tall : 0.5); flower = Math.max(flower, lawn ? flower : 0.2); ht *= 1.08; }
  tall *= base; tuft *= base; flower *= base;
  gr.colour(_c, y, slope, x, z);
  const macro = realismMacro(x, z), t = ss(0.28, 0.78, macro), k = 0.82 + 0.3 * macro;
  return { tall, tuft, flower, h: ht, short, r: _c.r * (0.74 + 0.5 * t) * k, g: _c.g * (0.97 + 0.11 * t) * k, b: _c.b * (0.86 - 0.16 * t) * k, dry: t };
}

type CellSites = (Site | null)[];
function cellSites(gr: CoverGround, ci: number, cj: number): CellSites {
  const x0 = ci * COVER_CELL, z0 = cj * COVER_CELL, out: CellSites = [];
  const near = (x: number, z: number) => gr.blocked(x + 1.3, z) || gr.blocked(x - 1.3, z) || gr.blocked(x, z + 1.3) || gr.blocked(x, z - 1.3);
  for (let j = 0; j <= SITES; j++) for (let i = 0; i <= SITES; i++) {
    const x = x0 + (i * COVER_CELL) / SITES, z = z0 + (j * COVER_CELL) / SITES;
    out.push(siteAt(gr, x, z, gr.blocked(x, z) || near(x, z)));
  }
  return out;
}
/** Today's `cellKind`: one kind's instances in one cell, REC floats each (x, y, z, yaw, width, height, r, g, b, rank),
 *  sorted by rank. */
export function cellKind(gr: CoverGround, ci: number, cj: number, k: number, sites: CellSites): Float32Array {
  const x0 = ci * COVER_CELL, z0 = cj * COVER_CELL, kind = COVER_KINDS[k], step = STEP[kind], n1 = Math.round(COVER_CELL / step), list: number[][] = [];
  const at = (x: number, z: number) => sites[Math.round(((z - z0) / COVER_CELL) * SITES) * (SITES + 1) + Math.round(((x - x0) / COVER_CELL) * SITES)];
  for (let j = 0; j < n1; j++) for (let i = 0; i < n1; i++) {
    const gi = ci * n1 + i, gj = cj * n1 + j;
    const x = x0 + (i + 0.1 + 0.8 * h01(gi, gj, 11 + k)) * step, z = z0 + (j + 0.1 + 0.8 * h01(gi, gj, 21 + k)) * step;
    const s = at(x, z); if (!s) continue;
    const want = kind === 'tall' ? s.tall : kind === 'tuft' ? s.tuft : s.flower;
    if (h01(gi, gj, 31 + k) >= want || gr.blocked(x, z)) continue;
    const y = gr.heightAt(x, z); if (y === null) continue;
    const v = h01(gi, gj, 41 + k), w = h01(gi, gj, 51 + k);
    let r = s.r, g = s.g, b = s.b, sc = 1, ht = 1;
    if (kind === 'tall') {
      sc = 0.8 + 0.5 * v; ht = s.h * (0.7 + 0.6 * w);
      const tone = 0.9 + 0.22 * h01(gi, gj, 61); r *= tone; g *= tone; b *= tone;
      if (s.dry > 0.55 && h01(gi, gj, 71) < (s.dry - 0.55) * 1.6) { r = r * 0.55 + 0.42 * 0.45; g = g * 0.55 + 0.36 * 0.45; b = b * 0.55 + 0.16 * 0.45; }
    } else if (kind === 'tuft') { sc = 0.75 + 0.6 * v; ht = (0.6 + 0.9 * w) * s.short; const tone = 0.92 + 0.16 * h01(gi, gj, 62); r *= tone; g *= tone; b *= tone; }
    else {
      const dom = Math.floor(vn(x / 6 + 3.1, z / 6 + 1.7, 13) * FLOWER_COLOURS.length * 0.999), sp = h01(gi, gj, 81) < 0.72 ? dom : Math.floor(h01(gi, gj, 82) * FLOWER_COLOURS.length);
      _c.set(FLOWER_COLOURS[sp]); r = _c.r; g = _c.g; b = _c.b; sc = 0.75 + 0.5 * v; ht = (0.55 + 0.6 * w) * Math.max(0.7, s.h / 0.62);
    }
    list.push([x, y, z, h01(gi, gj, 91 + k) * Math.PI * 2, sc, ht, r, g, b, h01(gi, gj, 101 + k)]);
  }
  list.sort((a, b) => a[9] - b[9]);
  const out = new Float32Array(list.length * REC); list.forEach((p, i) => out.set(p, i * REC));
  return out;
}
function prefix(rec: Float32Array, keep: number): number {
  let lo = 0, hi = rec.length / REC;
  while (lo < hi) { const mid = (lo + hi) >> 1; if (rec[mid * REC + 9] < keep) lo = mid + 1; else hi = mid; }
  return lo;
}

// Today's three geometries, unchanged (root at the origin, up = +y, normals up).
function geo(p: number[], c: number[], petal?: number[]) {
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.Float32BufferAttribute(p, 3)); g.setAttribute('color', new THREE.Float32BufferAttribute(c, 3));
  const n = new Float32Array(p.length); for (let i = 1; i < n.length; i += 3) n[i] = 1; g.setAttribute('normal', new THREE.BufferAttribute(n, 3));
  if (petal) g.setAttribute('coverPetal', new THREE.Float32BufferAttribute(petal, 1));
  g.computeBoundingSphere(); return g;
}
function tallGeometry() {
  const p: number[] = [], c: number[] = [];
  const root = [0.45, 0.55, 0.38], mid = [0.78, 0.88, 0.66], tip = [1.02, 1.06, 0.78], seed = [1.05, 0.95, 0.62];
  for (let k = 0; k < 7; k++) {
    const a = k * 2.39 + 0.4, lean = 0.12 + 0.2 * ((k * 5) % 7) / 6, hf = 0.62 + 0.38 * ((k * 3) % 7) / 6, w = k % 3 === 2 ? 0.012 : 0.026, ca = Math.cos(a), sa = Math.sin(a);
    const ox = ca * 0.05, oz = sa * 0.05, px = -sa * w, pz = ca * w;
    const B1 = [ox - px, 0, oz - pz], B2 = [ox + px, 0, oz + pz];
    const mx = ox + ca * lean * 0.3 * hf, mz = oz + sa * lean * 0.3 * hf, M1 = [mx - px * 0.7, 0.55 * hf, mz - pz * 0.7], M2 = [mx + px * 0.7, 0.55 * hf, mz + pz * 0.7];
    const T = [ox + ca * lean * hf, hf, oz + sa * lean * hf];
    p.push(...B1, ...B2, ...M2, ...B1, ...M2, ...M1, ...M1, ...M2, ...T);
    c.push(...root, ...root, ...mid, ...root, ...mid, ...mid, ...mid, ...mid, ...tip);
    if (k % 3 === 2) {
      const hx = T[0] + ca * 0.02, hz = T[2] + sa * 0.02, top = hf + 0.14, hw = 0.022;
      const L = [hx - sa * hw, hf + 0.06, hz + ca * hw], R = [hx + sa * hw, hf + 0.06, hz - ca * hw], U = [hx + ca * 0.03, top, hz + sa * 0.03];
      p.push(...T, ...R, ...U, ...T, ...U, ...L); for (let i = 0; i < 6; i++) c.push(...seed);
    }
  }
  return geo(p, c);
}
function tuftGeometry() {
  const p: number[] = [], c: number[] = [], base = [0.55, 0.65, 0.46], tip = [1.0, 1.06, 0.8];
  for (let k = 0; k < 7; k++) {
    const a = k * 0.9 + 0.3 * (k % 3), lean = 0.05 + 0.05 * (k % 3) / 2, h = 0.16 + 0.12 * ((k * 7) % 5) / 4, w = 0.026;
    const ox = Math.cos(a) * 0.035, oz = Math.sin(a) * 0.035, tx = Math.cos(a) * lean, tz = Math.sin(a) * lean, px = -Math.sin(a) * w, pz = Math.cos(a) * w;
    p.push(ox - px, 0, oz - pz, ox + px, 0, oz + pz, ox + tx, h, oz + tz); c.push(...base, ...base, ...tip);
  }
  return geo(p, c);
}
function flowerGeometry() {
  const p: number[] = [], c: number[] = [], f: number[] = [], stem = [0.32, 0.5, 0.24], leaf = [0.4, 0.62, 0.3], eye = [0.95, 0.68, 0.14], white = [1, 1, 1];
  const H = 0.42, tri = (a: number[], b: number[], d: number[], col: number[], petal = 0) => { p.push(...a, ...b, ...d); for (let i = 0; i < 3; i++) { c.push(...col); f.push(petal); } };
  for (const [ax, az] of [[1, 0], [0, 1]]) { const w = 0.007; tri([-w * ax, 0, -w * az], [w * ax, 0, w * az], [0.03, H, 0], stem); }
  tri([0, 0.08, 0], [0.09, 0.16, 0.03], [0.012, 0.14, 0], leaf); tri([0.005, 0.15, 0], [-0.08, 0.24, -0.03], [0.01, 0.21, 0], leaf);
  const cx = 0.03, cy = H, tilt = 0.61, ct = Math.cos(tilt), st = Math.sin(tilt);
  const P = (u: number, v: number, lift = 0) => [cx + u * ct - lift * st, cy + u * st + lift * ct, v];
  for (let k = 0; k < 5; k++) {
    const a0 = (k / 5) * Math.PI * 2, a1 = a0 + 0.55, a2 = a0 - 0.55, r = 0.075, ri = 0.012;
    tri(P(Math.cos(a0) * ri, Math.sin(a0) * ri), P(Math.cos(a2) * r, Math.sin(a2) * r), P(Math.cos(a1) * r, Math.sin(a1) * r), white, 1);
  }
  for (let k = 0; k < 5; k++) { const a0 = (k / 5) * Math.PI * 2, a1 = ((k + 1) / 5) * Math.PI * 2, r = 0.02; tri(P(0, 0, 0.004), P(Math.cos(a0) * r, Math.sin(a0) * r, 0.004), P(Math.cos(a1) * r, Math.sin(a1) * r, 0.004), eye); }
  return geo(p, c, f);
}
const FADE = /* glsl */`
{
 vec3 cvO=(modelMatrix*instanceMatrix*vec4(0.,0.,0.,1.)).xyz;float cvD=length(cameraPosition-cvO);
 float cvK=pow(uCover.x/max(cvD,uCover.x),uCover.z)*(1.-smoothstep(uCover.y*.75,uCover.y,cvD));
 float cvS=cvK>1e-4?(1.-smoothstep(cvK*.7,cvK,coverRank))*min(uCover.w,pow(max(cvK,1e-3),-.3)):0.;
 transformed*=cvS;
}
`;
const PETALS = THREE.ShaderChunk.color_vertex.replace('vColor.rgb *= instanceColor.rgb;', 'vColor.rgb *= mix( vec3( 1.0 ), instanceColor.rgb, coverPetal );');
function coverMaterial(kind: CoverKind) {
  const m = new THREE.MeshLambertMaterial({ vertexColors: true, side: THREE.DoubleSide });
  m.name = `ground cover ${kind}`;
  const l = LOD[kind], uCover = { value: new THREE.Vector4(l.d0, l.dmax, l.exp, l.maxScale) };
  m.onBeforeCompile = (shader) => {
    shader.uniforms.uCover = uCover;
    shader.vertexShader = `attribute float coverRank;\nuniform vec4 uCover;\n${kind === 'flower' ? 'attribute float coverPetal;\n' : ''}` + shader.vertexShader
      .replace('#include <begin_vertex>', `#include <begin_vertex>\n${FADE}`)
      .replace('#include <color_vertex>', kind === 'flower' ? PETALS : '#include <color_vertex>');
    shader.fragmentShader = shader.fragmentShader.replace('#include <normal_fragment_begin>', THREE.ShaderChunk.normal_fragment_begin.replace('gl_FrontFacing ? 1.0 : - 1.0', '1.0'));
  };
  m.customProgramCacheKey = () => `v2-ground-cover-1:${kind}`;
  return m;
}

/** On or off for this page: off on the phone tier, `?cover=0|1` overrides either way (today's `coverSetting`). */
export function coverSetting(search: string, tier: { tier: string; reason: string }): { enabled: boolean; reason: string } {
  const q = new URLSearchParams(search).get('cover');
  if (q === '0' || q === '1') return { enabled: q === '1', reason: `?cover=${q}` };
  return tier.tier === 'phone' ? { enabled: false, reason: `phone tier (${tier.reason})` } : { enabled: true, reason: tier.reason };
}
function pageCover() {
  try { return coverSetting(typeof location === 'undefined' ? '' : location.search, browserQuality()); } catch { return { enabled: true, reason: 'no screen' }; }
}

type Layer = { kind: CoverKind; k: number; mesh: THREE.InstancedMesh; rank: THREE.InstancedBufferAttribute };
type Want = { key: string; ci: number; cj: number; d: number; kinds: number[] };

/** The ground cover around the camera. `update` once a frame with the drawing camera; `invalidate` when the ground's
 *  paths, areas or footprints changed. */
export class GroundCover {
  readonly group = new THREE.Group();
  readonly setting: { enabled: boolean; reason: string };
  readonly instances: Record<string, number> = {};
  private layers: Layer[];
  private cells = new Map<string, { gen: number; sites: CellSites; kinds: (Float32Array | null)[]; used: number }>();
  private want: Want[] = [];
  private gen = 0;
  private frame = 0;
  private pending = 0;
  private dirty = true;
  private last = new THREE.Vector3(Infinity, Infinity, Infinity);
  private v = new THREE.Vector3();
  private ground: CoverGround;

  constructor(ground: CoverGround, setting = pageCover()) {
    this.ground = ground;
    this.setting = setting;
    this.group.name = 'ground cover';
    this.group.visible = setting.enabled;
    const geos = { tall: tallGeometry(), tuft: tuftGeometry(), flower: flowerGeometry() };
    this.layers = COVER_KINDS.map((kind, k) => {
      // #3783: every blade, tuft and flower sways with the world's wind as today's (`edenWindMode: 'grass'`): each
      // vertex's height above the blade's root is its share of the bend, read by the shared wind uniform.
      const g = geos[kind], material = coverMaterial(kind), weights = windWeights(g, new THREE.Matrix4(), 'grass');
      if (weights) (g.setAttribute('edenWind', new THREE.BufferAttribute(weights, 1)), patchWind(material, 'grass'));
      const cap = LOD[kind].cap, mesh = new THREE.InstancedMesh(g, material, cap);
      mesh.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
      mesh.instanceColor = new THREE.InstancedBufferAttribute(new Float32Array(cap * 3), 3).setUsage(THREE.DynamicDrawUsage);
      const rank = new THREE.InstancedBufferAttribute(new Float32Array(cap), 1).setUsage(THREE.DynamicDrawUsage);
      mesh.geometry.setAttribute('coverRank', rank);
      mesh.count = 0; mesh.frustumCulled = false; mesh.castShadow = false; mesh.receiveShadow = true; mesh.raycast = () => {};
      mesh.name = `ground cover: ${kind}`;
      this.group.add(mesh);
      return { kind, k, mesh, rank };
    });
  }

  invalidate(): void { this.gen++; this.dirty = true; }

  /** Deal what the camera now needs (a millisecond at most) and refill the instances when it moved a few metres. */
  update(camera: THREE.Camera): void {
    if (!this.setting.enabled) return;
    this.frame++;
    camera.getWorldPosition(this.v);
    const gy = this.ground.heightAt(this.v.x, this.v.z), above = this.v.y - (gy ?? 0);
    if (gy === null || above > MAX_D) { this.clear(); return; }
    const moved = this.v.distanceTo(this.last) >= MOVE;
    if (!moved && !this.dirty && !this.pending) return;
    if (moved || this.dirty) { this.want = this.wanted(this.v, above); this.last.copy(this.v); }
    const t0 = performance.now(); let dealt = 0, pending = 0;
    for (const w of this.want) {
      const e = this.cells.get(w.key);
      if (e && e.gen === this.gen && w.kinds.every((k) => e.kinds[k])) continue;
      if (performance.now() - t0 > DEAL_MS) { pending++; continue; }
      const entry = e && e.gen === this.gen ? e : { gen: this.gen, sites: cellSites(this.ground, w.ci, w.cj), kinds: [null, null, null] as (Float32Array | null)[], used: this.frame };
      for (const k of w.kinds) entry.kinds[k] ??= cellKind(this.ground, w.ci, w.cj, k, entry.sites);
      this.cells.set(w.key, entry); dealt++;
    }
    this.pending = pending;
    if (!moved && !this.dirty && !dealt) return;
    this.dirty = false;
    this.fill();
    if (this.cells.size > KEEP_CELLS) {
      const old = [...this.cells].sort((a, b) => a[1].used - b[1].used);
      for (let i = 0; i < old.length - KEEP_CELLS * 0.8; i++) this.cells.delete(old[i][0]);
    }
  }

  private wanted(cam: THREE.Vector3, above: number): Want[] {
    const R = Math.sqrt(Math.max(0, MAX_D * MAX_D - above * above)) + COVER_CELL;
    const i0 = Math.floor((cam.x - R) / COVER_CELL), i1 = Math.floor((cam.x + R) / COVER_CELL), j0 = Math.floor((cam.z - R) / COVER_CELL), j1 = Math.floor((cam.z + R) / COVER_CELL);
    const out: Want[] = [];
    for (let cj = j0; cj <= j1; cj++) for (let ci = i0; ci <= i1; ci++) {
      const nx = Math.max(ci * COVER_CELL, Math.min(cam.x, (ci + 1) * COVER_CELL)), nz = Math.max(cj * COVER_CELL, Math.min(cam.z, (cj + 1) * COVER_CELL));
      const d = Math.max(0, Math.hypot(nx - cam.x, nz - cam.z, above) - MOVE);
      const kinds = COVER_KINDS.flatMap((k, i) => (d < LOD[k].dmax ? [i] : []));
      if (kinds.length) out.push({ key: `${ci},${cj}`, ci, cj, d, kinds });
    }
    return out.sort((a, b) => a.d - b.d);
  }

  private fill(): void {
    for (const L of this.layers) {
      const cap = LOD[L.kind].cap, mat = L.mesh.instanceMatrix.array as Float32Array, col = L.mesh.instanceColor!.array as Float32Array, rk = L.rank.array as Float32Array;
      let n = 0;
      for (const w of this.want) {
        const e = this.cells.get(w.key), rec = e?.kinds[L.k]; if (!rec) continue;
        e.used = this.frame;
        const keep = keepAt(L.kind, w.d); if (keep <= 0) continue;
        const cnt = Math.min(prefix(rec, keep), cap - n);
        for (let i = 0; i < cnt; i++, n++) {
          const o = i * REC, c = Math.cos(rec[o + 3]), s = Math.sin(rec[o + 3]), ws = rec[o + 4], hs = rec[o + 5], m = n * 16;
          mat[m] = c * ws; mat[m + 1] = 0; mat[m + 2] = -s * ws; mat[m + 3] = 0; mat[m + 4] = 0; mat[m + 5] = hs; mat[m + 6] = 0; mat[m + 7] = 0;
          mat[m + 8] = s * ws; mat[m + 9] = 0; mat[m + 10] = c * ws; mat[m + 11] = 0; mat[m + 12] = rec[o]; mat[m + 13] = rec[o + 1]; mat[m + 14] = rec[o + 2]; mat[m + 15] = 1;
          col[n * 3] = rec[o + 6]; col[n * 3 + 1] = rec[o + 7]; col[n * 3 + 2] = rec[o + 8]; rk[n] = rec[o + 9];
        }
        if (n >= cap) break;
      }
      L.mesh.count = n; this.instances[L.kind] = n;
      for (const a of [L.mesh.instanceMatrix, L.mesh.instanceColor!, L.rank]) { a.clearUpdateRanges(); a.addUpdateRange(0, n * a.itemSize); a.needsUpdate = true; }
    }
  }

  private clear(): void { for (const L of this.layers) { L.mesh.count = 0; this.instances[L.kind] = 0; } this.last.set(Infinity, Infinity, Infinity); }
}
