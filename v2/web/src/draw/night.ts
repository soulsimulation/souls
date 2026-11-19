// Night light pools (Engine v2 V19b, #3508), carried over from today's `apps/web/src/WorldNightLights.ts` as today's
// god-built worlds use it (`world-env.ts` `GodWorldLiving`, `paintOnlySources`): one world-space light map of warm
// pools painted on the CPU from the lamps, which every lit built-in material samples once per pixel (no point lights),
// hugging the ground under each lamp, its strength following the sun so it fades in at dusk. Today a god world's pools
// come from its lamps' lights alone (a lit window glows but casts no pool there); so here. The stream carries no
// light's range or colour, so every lamp has today's defaults: range 8 m, colour #ffe9c4, and a fire's own pool.
import * as THREE from 'three';

export type NightSource = { x: number; z: number; radius: number; intensity: number; color: string; halo?: number; base?: number };
export type NightBounds = { x0: number; z0: number; x1: number; z1: number };

/** Today's pool shape for a god world's lamp (`world-env.ts`: POOL_RADIUS, POOL_LAMP, POOL_HALO), range 8 m. */
const RANGE = 8, POOL_RADIUS = 0.3, POOL_LAMP = 0.8, POOL_HALO = 0.4, LAMP_COLOUR = '#ffe9c4';
/** Ground heights the alpha channel carries (m). */
const BASE_MIN = -10, BASE_RANGE = 100;
const SIZE = [1536, 1024] as const;

/** A lamp's pool (`fire`: a fire's wider, brighter one), as today's god world paints it. */
export function lampPool(x: number, z: number, base: number, fire: boolean): NightSource {
  return { x, z, base, radius: RANGE * (fire ? 0.4 : POOL_RADIUS), intensity: fire ? 1.1 : POOL_LAMP, color: LAMP_COLOUR, halo: RANGE * POOL_HALO };
}

/** Does a kind's state table (V17's `models.json`) say it gives light: a lamp's `on` light or a flame's `lit`? A screen's
 *  `on` is not a light. */
export function givesLight(states: Record<string, string[]> | undefined): boolean {
  if (!states) return false;
  return !!states.lit || !!states.on?.some((p) => p === 'light' || p === '(glow materials)');
}

/** Paints the sources into RGBA bytes: soft-saturated colour, alpha the light-weighted ground height (today's `paintInto`). */
export function paintNight(data: Uint8Array, sources: readonly NightSource[], bounds: NightBounds): void {
  const [w, h] = SIZE, { x0, z0, x1, z1 } = bounds, sx = (x1 - x0) / w, sz = (z1 - z0) / h, acc = new Float32Array(w * h * 4), wsum = new Float32Array(w * h);
  const c = new THREE.Color();
  for (const s of sources) {
    c.set(s.color);
    const halo = s.halo ?? s.radius * 2.5, base = s.base ?? 0, reach = Math.max(s.radius, halo) * 2.2;
    const i0 = Math.max(0, Math.floor((s.x - reach - x0) / sx)), i1 = Math.min(w - 1, Math.ceil((s.x + reach - x0) / sx));
    const j0 = Math.max(0, Math.floor((s.z - reach - z0) / sz)), j1 = Math.min(h - 1, Math.ceil((s.z + reach - z0) / sz));
    const r2 = s.radius * s.radius, h2 = halo * halo;
    for (let j = j0; j <= j1; j++) {
      const dz = z0 + (j + 0.5) * sz - s.z, ez1 = s.intensity * Math.exp(-(dz * dz) / r2), ez2 = s.intensity * Math.exp(-(dz * dz) / h2);
      if (ez1 + 0.18 * ez2 < 1e-4) continue;
      for (let i = i0; i <= i1; i++) {
        const dx = x0 + (i + 0.5) * sx - s.x, q = dx * dx, v = Math.exp(-q / r2) * ez1 + 0.18 * Math.exp(-q / h2) * ez2;
        if (v < 1e-4) continue;
        const k = (j * w + i) * 4;
        acc[k] += v * c.r;
        acc[k + 1] += v * c.g;
        acc[k + 2] += v * c.b;
        acc[k + 3] += v * base;
        wsum[k >> 2] += v;
      }
    }
  }
  const unlitA = Math.round(255 * Math.min(1, Math.max(0, -BASE_MIN / BASE_RANGE)));
  for (let k = 0; k < acc.length; k += 4) {
    const wt = wsum[k >> 2];
    if (wt === 0) {
      data[k] = data[k + 1] = data[k + 2] = 0;
      data[k + 3] = unlitA;
      continue;
    }
    for (let ch = 0; ch < 3; ch++) data[k + ch] = Math.round(255 * Math.min(1, (1.25 * acc[k + ch]) / (1 + acc[k + ch])));
    const base = wt > 1e-4 ? acc[k + 3] / wt : 0;
    data[k + 3] = Math.round(255 * Math.min(1, Math.max(0, (base - BASE_MIN) / BASE_RANGE)));
  }
}

const NIGHT = { x: 0, y: 0, z: 0, w: 0 };
const MAP = { map: null as THREE.Texture | null, bounds: { x: 0, y: 0, z: 1, w: 1 }, raw: 0 };
class SharedDataTexture extends THREE.DataTexture {
  override clone() {
    return this as this;
  }
}
let texture: SharedDataTexture | null = null;

/** Patches three's shared shader chunks once, before any lit program compiles (today's `installNightLighting`). */
export function installNightLighting(): void {
  if (texture) return;
  const [w, h] = SIZE;
  texture = new SharedDataTexture(new Uint8Array(w * h * 4), w, h, THREE.RGBAFormat);
  Object.assign(texture, { magFilter: THREE.LinearFilter, minFilter: THREE.LinearMipmapLinearFilter, generateMipmaps: true, needsUpdate: true });
  MAP.map = texture;
  const f = (n: number) => n.toFixed(4);
  THREE.ShaderChunk.common += '\nvarying vec3 vEdenNightWorld;\n';
  THREE.ShaderChunk.project_vertex += `
vec4 edenNightWorld=vec4(transformed,1.0);
#ifdef USE_BATCHING
edenNightWorld=batchingMatrix*edenNightWorld;
#endif
#ifdef USE_INSTANCING
edenNightWorld=instanceMatrix*edenNightWorld;
#endif
vEdenNightWorld=(modelMatrix*edenNightWorld).xyz;
`;
  THREE.ShaderChunk.lights_pars_begin += '\nstruct EdenNightMap { sampler2D map; vec4 bounds; float raw; };\nuniform EdenNightMap uEdenLightMap;\nuniform vec4 uEdenNight;\n';
  THREE.ShaderChunk.lights_fragment_end += `
if(uEdenNight.x>0.0){
 vec2 edenUv=(vEdenNightWorld.xz-uEdenLightMap.bounds.xy)/uEdenLightMap.bounds.zw;
 if(edenUv.x>0.0&&edenUv.x<1.0&&edenUv.y>0.0&&edenUv.y<1.0){
  vec4 edenLight=texture2D(uEdenLightMap.map,edenUv);
  float edenHeight=clamp(1.0-max(0.0,vEdenNightWorld.y-(${f(BASE_MIN)}+edenLight.a*${f(BASE_RANGE)})-1.0)/7.0,0.2,1.0);
  reflectedLight.indirectDiffuse+=diffuseColor.rgb*edenLight.rgb*(uEdenNight.x*edenHeight);
 }
}
`;
  for (const name of ['lambert', 'phong', 'standard', 'physical', 'toon'] as const) {
    const lib = THREE.ShaderLib[name];
    if (!lib) continue;
    lib.uniforms.uEdenLightMap = { value: MAP };
    lib.uniforms.uEdenNight = { value: NIGHT };
  }
}

/** Repaints the pools (only when the sources change: `key` names them). */
let painted = '';
export function paintNightSources(sources: readonly NightSource[], bounds: NightBounds): void {
  const key = JSON.stringify([sources, bounds]);
  if (!texture || key === painted) return;
  painted = key;
  paintNight(texture.image.data as Uint8Array, sources, bounds);
  texture.needsUpdate = true;
  Object.assign(MAP.bounds, { x: bounds.x0, y: bounds.z0, z: bounds.x1 - bounds.x0, w: bounds.z1 - bounds.z0 });
}

const FIRE = /fire|hearth|brazier|campfire|torch/;
/** The pools of every thing on the page that gives light, at its place on the ground; the map covers the world's ground. */
export function nightPools(world: { nodes: Map<string, { id: string; kind: string; origin?: string }>; extent: [number, number, number, number] | null; frame(id: string): THREE.Matrix4; heightAt(x: number, z: number): number | null },
  index: { things: Record<string, string>; states: Map<string, Record<string, string[]>> }): { sources: NightSource[]; bounds: NightBounds } | null {
  if (!world.extent) return null;
  const sources: NightSource[] = [], p = new THREE.Vector3();
  for (const n of world.nodes.values()) {
    const hash = n.origin && index.things[n.origin];
    if (!hash || !givesLight(index.states.get(hash))) continue;
    p.setFromMatrixPosition(world.frame(n.id));
    sources.push(lampPool(p.x, p.z, world.heightAt(p.x, p.z) ?? p.y, FIRE.test(n.kind)));
  }
  const [x0, z0, x1, z1] = world.extent;
  return { sources, bounds: { x0, z0, x1, z1 } };
}

/** 0 by day, rising through dusk to full at night (today's `setNightLightStrength`). */
export function setNightStrength(daylight: number): void {
  NIGHT.x = Math.pow(1 - Math.max(0, Math.min(1, daylight)), 1.5);
}
export const nightStrength = () => NIGHT.x;
