// Fountain water (0.131 parity C8, #3679), carried over from today's `apps/web/src/fx/water-jets.ts` (its `fountain`
// jets) and `apps/web/src/fx/water.ts` (its falling-water sheets), but for the clock (`FX_TIME`, world seconds) and a
// cheaper form on the phone tier. Three fifths of the jet's drops rise from the top, open like an umbrella and fall
// into the upper bowl; the rest spill over the bowl's rim as a curtain that falls to the basin pool. Both splash and
// fade where they land. Each drop is a GPU point whose place is a pure function of the clock and its seeds, so the CPU
// does nothing per frame. A sheet of streaks falls from each water disc's rim to the wider disc below it (a tiered
// fountain's overflow). The phone tier draws the sheets and a third of the drops.
import * as THREE from 'three';
import { FX_TIME } from './clock.ts';

/** A still-water disc of a model (its water surface): centre and radius, m, in the model's frame. */
export type Disc = { x: number; y: number; z: number; r: number };

const JET_GLSL = `
    float az = r1 * 6.2831853;
    vec3 out_ = vec3(cos(az), 0.0, sin(az));
    if (aSeed.y < 60.0) {
      float el = 0.2 * sqrt(r2), v = uSpeed * (0.82 + 0.18 * r3);
      vec3 d = vec3(sin(el) * out_.x, cos(el), sin(el) * out_.z);
      float tl = (v * d.y + sqrt(v * v * d.y * d.y + 2.0 * 9.8 * uBowl.x)) / 9.8;
      float fa = min(a, tl);
      p = d * v * fa + vec3(0.0, -4.9 * fa * fa, 0.0);
      if (a > tl) { float s = a - tl; p += out_ * (0.15 + 0.3 * r4) * s + vec3(0.0, 0.45 * s - 4.9 * s * s, 0.0); alpha = clamp(1.0 - s / 0.14, 0.0, 1.0) * 0.7; size *= 0.7; }
      else alpha = 0.9;
    } else {
      float fall = uBowl.z - uBowl.x, sp = 0.22 + 0.18 * r2;
      vec3 o = out_ * uBowl.y + vec3(0.0, -uBowl.x + 0.03, 0.0), v = out_ * sp + vec3(0.0, -0.05, 0.0);
      float tl = (v.y + sqrt(v.y * v.y + 2.0 * 9.8 * fall)) / 9.8;
      float fa = min(a, tl);
      p = o + v * fa + vec3((r3 - 0.5) * 0.02, -4.9 * fa * fa, (r4 - 0.5) * 0.02);
      if (a > tl) { float s = a - tl, ang = r3 * 6.2831853; p += (out_ * 0.2 + vec3(cos(ang), 0.0, sin(ang)) * 0.3 * r4) * s + vec3(0.0, 0.5 * s - 4.9 * s * s, 0.0); alpha = clamp(1.0 - s / 0.16, 0.0, 1.0) * 0.7; size *= 0.75; }
      else alpha = 0.85;
    }`;
/** Today's fountain: drop count, life (s), drop size (m) and streak. */
const JET = { n: 3600, life: 0.9, size: 0.03, streak: 0.45 };

function jetMaterial(): THREE.ShaderMaterial {
  const k = JET;
  return new THREE.ShaderMaterial({
    name: 'water jets (fountain)', transparent: true, depthWrite: false,
    uniforms: { uFxTime: FX_TIME, uSpeed: { value: 2.4 }, uBowl: { value: new THREE.Vector3(0.22, 0.5, 1.0) } },
    vertexShader: /* glsl */`uniform float uFxTime; uniform float uSpeed; uniform vec3 uBowl; attribute vec4 aSeed; varying float vAlpha;
      float h(float x){ return fract(sin(x * 91.3458) * 47453.5453); }
      void main(){
        float t = uFxTime, life = ${k.life.toFixed(3)}, u = t / life + aSeed.x, cyc = floor(u), a = (u - cyc) * life;
        float r1 = h(aSeed.y + cyc * 1.37), r2 = h(aSeed.z + cyc * 2.11), r3 = h(aSeed.w + cyc * 0.73), r4 = h(aSeed.y * 3.1 + cyc);
        vec3 p = vec3(0.0); float alpha = 1.0, size = ${k.size.toFixed(3)};
        ${JET_GLSL}
        vAlpha = alpha;
        vec4 mv = modelViewMatrix * vec4(p, 1.0);
        gl_Position = projectionMatrix * mv;
        gl_PointSize = clamp(size * 900.0 / max(0.1, -mv.z), 1.5, 24.0);
      }`,
    // falling water reads as short vertical streaks
    fragmentShader: /* glsl */`varying float vAlpha;
      void main(){ vec2 c = gl_PointCoord - 0.5; float d = length(vec2(c.x * ${(1 + 2.6 * k.streak).toFixed(2)}, c.y)); if (d > 0.5) discard;
        float body = smoothstep(0.5, 0.12, d), glint = smoothstep(0.2, 0.0, length(c - vec2(-0.06, -0.14)));
        gl_FragColor = vec4(mix(mix(vec3(0.36, 0.55, 0.72), vec3(0.62, 0.80, 0.92), smoothstep(0.5, 0.0, d)), vec3(1.0), glint * 0.85), body * vAlpha * 0.95); }`,
  });
}
const jetGeometries = new Map<boolean, THREE.BufferGeometry>();
function jetGeometry(cheap: boolean): THREE.BufferGeometry {
  let g = jetGeometries.get(cheap); if (g) return g;
  const n = Math.round(JET.n * (cheap ? 1 / 3 : 1)), seed = new Float32Array(n * 4); let s = 1;
  const rnd = () => ((s = Math.imul(s ^ (s >>> 15), 2246822519) + 3266489917 | 0) >>> 0) / 4294967296;
  for (let i = 0; i < n; i++) { seed[i * 4] = i / n; seed[i * 4 + 1] = rnd() * 100; seed[i * 4 + 2] = rnd() * 100; seed[i * 4 + 3] = rnd() * 100; }
  g = new THREE.BufferGeometry(); g.setAttribute('position', new THREE.BufferAttribute(new Float32Array(n * 3), 3)); g.setAttribute('aSeed', new THREE.BufferAttribute(seed, 4));
  jetGeometries.set(cheap, g); return g;
}

/** Where a fountain's water goes, from its water discs and its top (m, the model's frame), or null with no disc: the
 *  nozzle over the highest disc, the jet into that disc (the bowl) and the spill from its rim to the disc below it. */
export function fountainPlan(discs: readonly Disc[], top: number): { nozzle: [number, number, number]; bowl: [number, number, number] } | null {
  if (!discs.length) return null;
  const sorted = [...discs].sort((a, b) => a.y - b.y), bowl = sorted.at(-1)!;
  const pool = [...sorted].reverse().find((d) => d.y < bowl.y - 0.15 && d.r > bowl.r * 1.15) ?? bowl;
  const nozzle: [number, number, number] = [bowl.x, Math.max(top, bowl.y + 0.1), bowl.z];
  return { nozzle, bowl: [nozzle[1] - bowl.y, bowl.r + 0.05, nozzle[1] - pool.y] };
}

/** A fountain's jets at its nozzle, in its model's frame: their own material (each fountain's bowl). */
export function fountainJets(plan: NonNullable<ReturnType<typeof fountainPlan>>, cheap = false): THREE.Points {
  const m = jetMaterial();
  (m.uniforms.uBowl.value as THREE.Vector3).set(...plan.bowl);
  const pts = new THREE.Points(jetGeometry(cheap), m);
  pts.name = 'water jets (fountain)'; pts.position.set(...plan.nozzle); pts.frustumCulled = false; pts.renderOrder = 2;
  return pts;
}

let sheet: THREE.ShaderMaterial | null = null;
/** Falling water: bright streaks scrolling down a translucent sheet (uv.y = 1 at the top). Shared by every fountain. */
export function fallingWaterMaterial(): THREE.ShaderMaterial {
  return sheet ??= new THREE.ShaderMaterial({
    name: 'falling water', transparent: true, depthWrite: false, side: THREE.DoubleSide,
    uniforms: { uFxTime: FX_TIME },
    vertexShader: /* glsl */`varying vec2 vUv; void main(){ vUv = uv; gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0); }`,
    fragmentShader: /* glsl */`uniform float uFxTime; varying vec2 vUv;
      float h(vec2 p){ return fract(sin(dot(p, vec2(127.1, 311.7))) * 43758.5453); }
      void main(){
        float t = uFxTime, cx = vUv.x * 64.0, col = floor(cx), s = h(vec2(col, 1.7));
        float lane = smoothstep(0.0, 0.35, fract(cx)) * smoothstep(1.0, 0.65, fract(cx));
        float f = fract((vUv.y + t * (1.1 + 0.6 * s) + s * 7.0) * (2.0 + 2.0 * s));
        float streak = lane * smoothstep(0.35, 0.8, f) * smoothstep(1.0, 0.85, f);
        float edge = smoothstep(0.0, 0.12, vUv.y) * smoothstep(1.0, 0.85, vUv.y);
        float a = (0.18 + 0.5 * streak) * edge * (0.6 + 0.4 * h(vec2(col, 9.3)));
        gl_FragColor = vec4(mix(vec3(0.62, 0.78, 0.86), vec3(0.95, 0.98, 1.0), streak), a);
      }`,
  });
}

/** Which disc each disc overflows into: the highest wider disc below it whose rim contains it, or none. */
export function overflows(discs: readonly Disc[]): [Disc, Disc][] {
  const out: [Disc, Disc][] = [];
  for (const a of discs) {
    let below: Disc | null = null;
    for (const b of discs) if (b !== a && b.y < a.y - 0.15 && b.r > a.r * 1.15 && Math.hypot(b.x - a.x, b.z - a.z) < b.r - a.r && (!below || b.y > below.y)) below = b;
    if (below) out.push([a, below]);
  }
  return out;
}
/** Overflow sheets between stacked water discs (today's `fallingWaterSheets`), in the model's frame. */
export function fallingWaterSheets(discs: readonly Disc[]): THREE.Mesh[] {
  return overflows(discs).map(([a, below]) => {
    const h = a.y - below.y, g = new THREE.CylinderGeometry(a.r * 1.01, a.r * 1.08, h, 32, 1, true);
    const m = new THREE.Mesh(g, fallingWaterMaterial());
    m.position.set(a.x, below.y + h / 2, a.z); m.name = 'falling water'; m.castShadow = false; m.renderOrder = 3;
    return m;
  });
}
