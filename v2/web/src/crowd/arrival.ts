// A new Soul arrives in a light (0.131 parity N-V19, #3677). Today's page greets a viewer in a light (`ArrivalLight`) and
// lifts an idle Soul out in a beam (`WorldFading`); here a Soul that joins the world while the page watches comes down in
// a column of warm light that narrows and fades over ARRIVAL_S of world time, beside the arrival music mark
// (`music/arrival.ts`). Drawn from observed state only: a body id the page has never placed before, at the place its
// track puts it, timed by the world clock (a held clock holds the light). Bodies present when the page first draws them
// are not arrivals, and an id the page has already seen never lights again (a reconnect or a history step re-adds it).
// One instanced draw while any light is on, none otherwise; at most MAX_LIGHTS at once, the oldest giving way.
import * as THREE from 'three';

/** World seconds a light lasts. */
export const ARRIVAL_S = 4;
/** Lights drawn at once. */
export const MAX_LIGHTS = 32;
/** Wall ms after the page first draws bodies during which new ids are the world loading, not arrivals. */
export const SETTLE_MS = 3000;
const COLUMN_H = 7, COLUMN_R = 0.85, DISC_R = 1.6;

/** Which bodies are arrivals: pure, so the rule is tested without a GPU. */
export class ArrivalWatch {
  private readonly known = new Set<string>();
  private firstMs: number | null = null;
  private readonly settleMs: number;
  constructor(settleMs = SETTLE_MS) {
    this.settleMs = settleMs;
  }
  /** Body `id` is placed this frame (wall time `nowMs`); true when it is a Soul arriving now. */
  placed(id: string, nowMs: number): boolean {
    if (this.known.has(id)) return false;
    this.known.add(id);
    this.firstMs ??= nowMs;
    return nowMs - this.firstMs >= this.settleMs;
  }
}

/** How bright a light is at `age` (0 to 1 of its life): up fast, held, then out. */
export function envelope(age: number): number {
  if (age <= 0 || age >= 1) return 0;
  if (age < 0.08) return age / 0.08;
  if (age < 0.45) return 1;
  const k = (age - 0.45) / 0.55;
  return 1 - k * k * (3 - 2 * k);
}

/** The column (open cylinder, fading upward) and a disc on the ground (fading outward), one geometry; `fade` is 0 at
 *  the light's core and 1 at its edge. */
function lightGeometry(): THREE.BufferGeometry {
  const pos: number[] = [], fade: number[] = [], index: number[] = [], seg = 24, rows = 6;
  for (let r = 0; r <= rows; r++) for (let s = 0; s <= seg; s++) {
    const a = (s / seg) * Math.PI * 2, y = (r / rows) * COLUMN_H;
    pos.push(Math.cos(a) * COLUMN_R, y, Math.sin(a) * COLUMN_R);
    fade.push(r / rows);
  }
  for (let r = 0; r < rows; r++) for (let s = 0; s < seg; s++) {
    const a = r * (seg + 1) + s, b = a + seg + 1;
    index.push(a, b, a + 1, a + 1, b, b + 1);
  }
  const centre = pos.length / 3;
  pos.push(0, 0.04, 0);
  fade.push(0);
  for (let s = 0; s <= seg; s++) {
    const a = (s / seg) * Math.PI * 2;
    pos.push(Math.cos(a) * DISC_R, 0.04, Math.sin(a) * DISC_R);
    fade.push(1);
  }
  for (let s = 0; s < seg; s++) index.push(centre, centre + 2 + s, centre + 1 + s);
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
  g.setAttribute('fade', new THREE.Float32BufferAttribute(fade, 1));
  g.setIndex(index);
  return g;
}

const VERTEX = /* glsl */ `
attribute float fade;
attribute float aLight;
varying float vFade;
varying float vLight;
void main() {
  vFade = fade;
  vLight = aLight;
  gl_Position = projectionMatrix * modelViewMatrix * instanceMatrix * vec4(position, 1.0);
}`;
const FRAGMENT = /* glsl */ `
varying float vFade;
varying float vLight;
void main() {
  float a = (1.0 - vFade) * (1.0 - vFade) * vLight * 0.55;
  gl_FragColor = vec4(vec3(1.0, 0.95, 0.82) * a, a);
}`;

type Light = { id: string; from: number; x: number; y: number; z: number };

export class ArrivalLights {
  readonly mesh: THREE.InstancedMesh;
  readonly watch: ArrivalWatch;
  private readonly glow: THREE.InstancedBufferAttribute;
  private lights: Light[] = [];
  private t = 0;
  private readonly m = new THREE.Matrix4();
  private readonly q = new THREE.Quaternion();
  private readonly s = new THREE.Vector3();
  private readonly p = new THREE.Vector3();
  /** Lights begun, for the page's measure and the tests. */
  begun = 0;

  constructor(watch = new ArrivalWatch()) {
    this.watch = watch;
    const g = lightGeometry();
    this.glow = new THREE.InstancedBufferAttribute(new Float32Array(MAX_LIGHTS), 1).setUsage(THREE.DynamicDrawUsage);
    g.setAttribute('aLight', this.glow);
    const material = new THREE.ShaderMaterial({
      vertexShader: VERTEX, fragmentShader: FRAGMENT, transparent: true, depthWrite: false, side: THREE.DoubleSide,
      blending: THREE.CustomBlending, blendSrc: THREE.OneFactor, blendDst: THREE.OneMinusSrcAlphaFactor,
    });
    this.mesh = new THREE.InstancedMesh(g, material, MAX_LIGHTS);
    this.mesh.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
    this.mesh.count = 0;
    this.mesh.visible = false;
    this.mesh.frustumCulled = false;
    this.mesh.renderOrder = 996;
    this.mesh.name = 'arrival lights';
  }

  /** Any light still on. */
  get active(): boolean {
    return this.lights.length > 0;
  }

  /** A frame at world time `t` (µs). */
  begin(t: number): void {
    this.t = t;
  }

  /** Body `id` stands at `x, y, z` this frame; `fresh` when the crowd has not placed it before. */
  place(id: string, x: number, y: number, z: number, fresh: boolean, nowMs: number): void {
    if (fresh && this.watch.placed(id, nowMs)) {
      if (this.lights.length >= MAX_LIGHTS) this.lights.shift();
      this.lights.push({ id, from: this.t, x, y, z });
      this.begun++;
      return;
    }
    if (!this.lights.length) return;
    for (const l of this.lights) if (l.id === id) (l.x = x), (l.y = y), (l.z = z);
  }

  /** The lights' ages at this frame's time (0 to 1), dropping the spent ones (and any the clock stepped back before). */
  ages(): number[] {
    const life = ARRIVAL_S * 1e6;
    this.lights = this.lights.filter((l) => this.t >= l.from && this.t - l.from < life);
    return this.lights.map((l) => (this.t - l.from) / life);
  }

  /** Writes the draw: one instance per light, nothing drawn when none is on. */
  draw(): void {
    const ages = this.ages();
    this.mesh.count = ages.length;
    this.mesh.visible = ages.length > 0;
    if (!ages.length) return;
    const g = this.glow.array as Float32Array;
    ages.forEach((age, k) => {
      const l = this.lights[k], narrow = 1 - 0.55 * age;
      this.m.compose(this.p.set(l.x, l.y, l.z), this.q, this.s.set(narrow, 1, narrow));
      this.mesh.setMatrixAt(k, this.m);
      g[k] = envelope(age);
    });
    this.mesh.instanceMatrix.needsUpdate = true;
    this.glow.needsUpdate = true;
  }
}
