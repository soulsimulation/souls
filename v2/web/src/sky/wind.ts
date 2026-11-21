// Wind sway (0.131 parity C9, #3680), carried over from today's `apps/web/src/atmosphere/wind.ts` and its driver in
// `WorldAtmosphere.ts`: trees, plants and hanging cloth bend with the world's wind in the vertex shader. Every swaying
// material reads ONE shared uniform (time, strength, direction), so a frame costs one object write; geometry, bounds,
// draws and the CPU's per-thing work are untouched, and with strength 0 the displacement is exactly zero.
//
// Today finds plants and cloth by their meshes' names at runtime. The page here draws V17's baked models, so a part is
// chosen when its model loads (`models.ts`): a kit plant's trunk and foliage by their material's name (`kit plant
// trunk`, `kit plant foliage`, as today's kit builder tags them `trunk` and `crown`), cloth by its kind's name (today's
// words). A baked model is one merged mesh, so the cloth in it is found by shape: each connected piece thin in one
// direction and broad in the other two (a flag, a banner, a sheet on the line, a pennant) sways, pinned on the edge
// today pins (the pole side of a flag, the top of washing and bunting); poles, posts, lines and ropes stay. A baked
// banner is a box with vertices only at its corners, so today's pin at top and bottom would hold it still: it hangs
// from its beam instead, its lower edge swaying.
// What each vertex needs is one number baked into its geometry (`edenWind`): its height above the model's root for a
// plant, its share of the sway for cloth.
import * as THREE from 'three';

export type WindMode = 'trunk' | 'crown' | 'grass' | 'hang' | 'flag';

/** x time (s, wrapped), y strength, zw unit direction (xz): today's `WIND`. */
export const WIND = { value: { x: 0, y: 0, z: 1, w: 0 } };

/** Today's `ROOTED` plant parameters: bend per m² of height, (origin term unused), flutter (m). */
const ROOTED: Record<'trunk' | 'crown' | 'grass', [number, number, number]> = { grass: [0.2, 0, 0.012], crown: [0.012, 0, 0.018], trunk: [0.012, 0, 0] };

const clamp = (x: number) => Math.max(0, Math.min(1, x));
const smooth = (x: number) => {
  const t = clamp(x);
  return t * t * (3 - 2 * t);
};
/** Today's `visualWindStrength`: above 0.75 the wind comes in seeded heavy and light spells (repeatable on a seek). */
export function visualWind(seconds: number, wind: number): number {
  if (wind <= 0.75) return wind;
  const x = seconds / 37, i = Math.floor(x), t = smooth(x - i);
  const hash = (n: number) => {
    let h = Math.imul(n + 83, 374761393);
    h = Math.imul(h ^ (h >>> 13), 1274126177);
    return ((h ^ (h >>> 16)) >>> 0) / 4294967296;
  };
  const noise = hash(i) + (hash(i + 1) - hash(i)) * t, strong = smooth((noise - 0.28) / 0.6);
  const weight = smooth((wind - 0.75) / 0.2), spell = 0.75 + (wind - 0.75) * strong;
  return wind + (spell - wind) * weight;
}

/** The sway's strength for a wind level 0..1 (today: 0.15 in still air up to 1.1 in a gale; 0 for reduced motion). */
export const windStrength = (seconds: number, wind: number, still = false) => (still ? 0 : 0.15 + visualWind(seconds, wind) * 0.95);

let reduced: MediaQueryList | null | undefined;
/** The viewer asked for reduced motion: today's page holds plants and cloth still then. */
function stillPreferred(): boolean {
  if (reduced === undefined) reduced = typeof matchMedia === 'function' ? matchMedia('(prefers-reduced-motion: reduce)') : null;
  return !!reduced?.matches;
}

/** Sets the shared uniform for world time `seconds`, the world's wind 0..1 and the day's wind bearing `bearing`
 *  (radians; today's `windDirection`: the day's hashed bearing, wandering ±0.35 rad over 42 minutes). */
export function setWind(seconds: number, wind: number, bearing: number, still = stillPreferred()): void {
  const a = bearing + Math.sin(seconds / 420) * 0.35;
  WIND.value.x = ((seconds % 7200) + 7200) % 7200;
  WIND.value.y = windStrength(seconds, wind, still);
  WIND.value.z = Math.cos(a);
  WIND.value.w = Math.sin(a);
}

/** Which way a part sways: a kit plant's trunk or foliage by its material's name, cloth by its kind's name (today's
 *  words: washing, bunting and banners hang, flags fly from a pole), or not at all. */
export function windModeOf(material: string, kind = ''): WindMode | null {
  const m = material.toLowerCase(), k = kind.toLowerCase();
  if (/^kit plant trunk$/.test(m)) return 'trunk';
  if (/^kit plant foliage$/.test(m)) return /litter|fallen/.test(k) ? null : 'crown';
  if (/grass|reed|meadow/.test(m) && !/stone|ground|soil/.test(m)) return 'grass';
  if (/laundry|washing|clothes-?line|towel|bunting|banner/.test(k)) return 'hang';
  if (/flag|pennant|windsock/.test(k)) return 'flag';
  return null;
}

/** A cloth piece is thin one way (under 10 cm and a quarter of its width) and broad the other two (at least 10 cm,
 *  and its width a tenth of its length: a line or rope strung between posts, however it sags, stays). */
const isCloth = ([thin, width, length]: number[]) => thin < 0.1 && thin < 0.25 * width && width >= 0.1 && width >= 0.1 * length;

/** Each vertex's share of the sway (`edenWind`), from the geometry in the model's frame (`matrix`): a plant's height
 *  above the model's root (m), or a cloth vertex's pin weight 0..1 (0 on the pinned edge and on every rigid piece).
 *  Null when the part has nothing that sways. */
export function windWeights(g: THREE.BufferGeometry, matrix: THREE.Matrix4, mode: WindMode): Float32Array | null {
  const pos = g.getAttribute('position'), n = pos.count, out = new Float32Array(n), v = new THREE.Vector3();
  const p = new Float32Array(n * 3);
  for (let i = 0; i < n; i++) v.fromBufferAttribute(pos, i).applyMatrix4(matrix).toArray(p, i * 3);
  if (mode === 'trunk' || mode === 'crown' || mode === 'grass') {
    for (let i = 0; i < n; i++) out[i] = Math.max(0, p[i * 3 + 1]);
    return out;
  }
  // Connected pieces: vertices at one place are one, and a triangle joins its corners.
  const parent = new Int32Array(n).map((_, i) => i), at = new Map<string, number>();
  const find = (i: number): number => {
    while (parent[i] !== i) i = parent[i] = parent[parent[i]];
    return i;
  };
  const join = (a: number, b: number) => void (parent[find(a)] = find(b));
  for (let i = 0; i < n; i++) {
    const key = `${Math.round(p[i * 3] * 1e4)},${Math.round(p[i * 3 + 1] * 1e4)},${Math.round(p[i * 3 + 2] * 1e4)}`;
    const j = at.get(key);
    if (j === undefined) at.set(key, i);
    else join(i, j);
  }
  const idx = g.index, tris = idx ? idx.count : n, corner = (k: number) => (idx ? idx.getX(k) : k);
  for (let k = 0; k + 2 < tris; k += 3) (join(corner(k), corner(k + 1)), join(corner(k), corner(k + 2)));
  type Piece = { lo: number[]; hi: number[]; r: [number, number] };
  const pieces = new Map<number, Piece>();
  for (let i = 0; i < n; i++) {
    const root = find(i), r = Math.hypot(p[i * 3], p[i * 3 + 2]);
    const c = pieces.get(root) ?? pieces.set(root, { lo: [Infinity, Infinity, Infinity], hi: [-Infinity, -Infinity, -Infinity], r: [Infinity, -Infinity] }).get(root)!;
    for (let a = 0; a < 3; a++) (c.lo[a] = Math.min(c.lo[a], p[i * 3 + a]), c.hi[a] = Math.max(c.hi[a], p[i * 3 + a]));
    c.r = [Math.min(c.r[0], r), Math.max(c.r[1], r)];
  }
  let any = false;
  for (let i = 0; i < n; i++) {
    const c = pieces.get(find(i))!, size = [0, 1, 2].map((a) => c.hi[a] - c.lo[a]).sort((a, b) => a - b);
    if (!isCloth(size)) continue;
    const y = (p[i * 3 + 1] - c.lo[1]) / Math.max(c.hi[1] - c.lo[1], 1e-3);
    // A flag is pinned on the side nearest the pole (the model's upright axis); washing, bunting and banners at the top.
    const w = mode === 'flag' ? (Math.hypot(p[i * 3], p[i * 3 + 2]) - c.r[0]) / Math.max(c.r[1] - c.r[0], 1e-3) : 1 - y;
    out[i] = clamp(w);
    any ||= out[i] > 0;
  }
  return any ? out : null;
}

const HEAD = /* glsl */ `
uniform vec4 uEdenWind;
uniform vec4 uEdenWindP;
attribute float edenWind;
`;
/** The world matrix of this vertex's instance (instanced, batched or plain). */
const WM = /* glsl */ `
 mat4 edenWM=modelMatrix;
 #ifdef USE_INSTANCING
  edenWM=modelMatrix*instanceMatrix;
 #endif
 #ifdef USE_BATCHING
  edenWM=modelMatrix*batchingMatrix;
 #endif
`;
/** A world offset to the vertex's local frame: column projections (exact for rotation × scale). */
const TO_LOCAL = (v: string) => `transformed+=vec3(dot(edenWM[0].xyz,${v})/dot(edenWM[0].xyz,edenWM[0].xyz),dot(edenWM[1].xyz,${v})/dot(edenWM[1].xyz,edenWM[1].xyz),dot(edenWM[2].xyz,${v})/dot(edenWM[2].xyz,edenWM[2].xyz));`;
/** Today's rooted plant sway: the trunk and crown share one bend curve from the root, gust fronts travel downwind
 *  across the world and read as a lighter sheen on grass and crowns; flutter grows from the root. */
const PLANT = /* glsl */ `
vEdenGust=0.0;
{
${WM}
 float edenS=uEdenWind.y;
 if(edenS>0.0){
  vec3 edenO=edenWM[3].xyz;vec2 edenD=uEdenWind.zw;float edenT=uEdenWind.x;
  float edenHL=edenWind*length(edenWM[1].xyz);
  float edenPh=dot(edenO.xz,vec2(.31,.17));
  float edenTr=dot(edenO.xz,edenD)*.05-edenT*1.1;
  float edenG=.5+.5*sin(edenTr)*sin(edenTr*.43+1.3);
  vEdenGust=edenS*(edenG-.45)*min(edenHL*2.0+.3,1.0);
  float edenSw=edenS*(.55+.9*edenG*edenS)*(.7+.3*sin(edenT*1.6+edenPh)+.15*sin(edenT*2.9+edenPh*1.9));
  float edenB=uEdenWindP.x*edenHL*edenHL;
  vec3 edenV=vec3(edenD.x,0.0,edenD.y)*edenSw*edenB;
  edenV.xz+=vec2(-edenD.y,edenD.x)*edenB*edenS*.3*sin(edenT*2.2+edenPh*1.3);
  vec3 edenWp=(edenWM*vec4(transformed,1.0)).xyz;
  edenV+=uEdenWindP.z*edenS*(.6+edenG)*vec3(sin(edenT*7.0+edenWp.x*3.1+edenWp.y*2.0),.5*sin(edenT*8.3+edenWp.z*2.7),cos(edenT*6.4+edenWp.z*3.3+edenWp.y*1.7))*min(edenHL,1.0);
  ${TO_LOCAL('edenV')}
 }
}
`;
/** Today's cloth: a travelling ripple, stronger downwind, the pinned edge still. */
const CLOTH = /* glsl */ `
{
${WM}
 float edenS=uEdenWind.y;
 if(edenS>0.0&&edenWind>0.0){
  vec2 edenD=uEdenWind.zw;float edenT=uEdenWind.x;vec3 edenWp=(edenWM*vec4(transformed,1.0)).xyz;
  float edenTr=dot(edenWp.xz,edenD)*.05-edenT*1.1;float edenG=.5+.5*sin(edenTr)*sin(edenTr*.43+1.3);
  float edenAmp=edenWind*(.04+.16*edenS*(.5+edenG));
  float edenWave=sin(edenT*(5.0+3.0*edenS)+dot(edenWp.xz,vec2(3.1,2.3))+transformed.y*4.0+transformed.x*3.0);
  vec3 edenOff=vec3(edenD.x,0.0,edenD.y)*edenAmp*(.55+.25*edenWave)+vec3(-edenD.y,0.0,edenD.x)*edenAmp*.45*edenWave;
  edenOff.y+=edenAmp*.25*max(edenWave,0.0);
  ${TO_LOCAL('edenOff')}
 }
}
`;
const KEY = 'v2-wind-1';
/** Today's gust sheen on grass and crowns. */
const SHEEN: Record<WindMode, string> = { grass: '.32', crown: '.12', trunk: '0.0', hang: '', flag: '' };

/** Makes `material` sway as `mode`; its geometries carry `edenWind` (`windWeights`). Keeps any hook it already has. */
export function patchWind(material: THREE.Material, mode: WindMode): void {
  const previous = material.onBeforeCompile, previousKey = material.customProgramCacheKey;
  const plant = mode === 'trunk' || mode === 'crown' || mode === 'grass';
  const p = plant ? ROOTED[mode] : [0, 0, 0];
  const params = { value: { x: p[0], y: p[1], z: p[2], w: 0 } };
  material.onBeforeCompile = function (shader, renderer) {
    previous.call(this, shader, renderer);
    if (!shader.vertexShader.includes('#include <begin_vertex>')) return;
    shader.uniforms.uEdenWind = WIND;
    shader.uniforms.uEdenWindP = params;
    shader.vertexShader = HEAD + (plant ? 'varying float vEdenGust;\n' : '') + shader.vertexShader.replace('#include <begin_vertex>', '#include <begin_vertex>\n' + (plant ? PLANT : CLOTH));
    if (plant) shader.fragmentShader = 'varying float vEdenGust;\n' + shader.fragmentShader.replace('#include <color_fragment>', `#include <color_fragment>\ndiffuseColor.rgb*=1.0+vEdenGust*${SHEEN[mode]};`);
  };
  material.customProgramCacheKey = function () {
    return previousKey.call(this) + '|' + KEY + ':' + mode;
  };
  material.userData.windMode = mode;
  material.needsUpdate = true;
}
