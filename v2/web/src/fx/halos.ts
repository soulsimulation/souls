// Lamp halos at night (0.131 parity A2, #3724), copied from today's `apps/web/src/atmosphere/halos.ts` (v2/web imports
// nothing from today's app): the same sprite, kinds, sizes, colours and flicker. Left out: today's authored light
// patterns (`WorldNightLights.ts` `edenPattern`) and the moving sources of carried lights, which the v2 stream does not
// carry; a fire's halo flickers by its seed as today's does without a pattern.
import * as THREE from 'three';

/** `[x, y, z, kind, scale]`: where the light's thing stands (its foot, world m), today's halo kind and its scale. */
export type HaloSource = readonly [number, number, number, string, number];
/** Lamp bloom without a post pass: one instanced draw of camera-facing glow sprites at every night light. Additive,
 * depth-tested (a lamp behind a wall is hidden), depth-write off, pulled a little toward the camera so the sprite never
 * cuts into the lamp head. Far lamps keep a minimum pixel size so a lit street still sparkles from the overview. Fires
 * flicker. Strength follows night (0 by day: no draw). */
const VERT = /* glsl */ `
attribute vec4 aHalo; // rgb colour premultiplied by intensity, w flicker seed (<0: steady)
uniform vec4 uHalo; // x strength, y time, z pixels per radian (viewport height / fov), w unused
varying vec2 vUv;varying vec3 vCol;
void main(){
 vec4 c=modelViewMatrix*vec4(instanceMatrix[3].xyz,1.0);
 float size=length(instanceMatrix[0].xyz);
 float dist=max(-c.z,.1);
 // keep at least ~5 px wide; shrink the brightness with that floor so distant lamps read as points
 float minSize=dist*5.0/uHalo.z;float grown=max(size,minSize);
 c.xyz+=normalize(-c.xyz)*min(.45,dist*.5);
 c.xy+=position.xy*grown;
 vUv=position.xy*2.0;
 float flick=aHalo.w<0.0?1.0:.82+.12*sin(uHalo.y*11.0+aHalo.w*17.0)+.06*sin(uHalo.y*23.0+aHalo.w*5.0);
 vCol=aHalo.rgb*uHalo.x*flick*(size/grown)*(1.0-smoothstep(160.0,420.0,dist)*.6);
 gl_Position=projectionMatrix*c;
}`;
const FRAG = /* glsl */ `
varying vec2 vUv;varying vec3 vCol;
void main(){
 float r2=dot(vUv,vUv);if(r2>1.0)discard;
 float a=exp(-r2*5.0)*.55+exp(-r2*38.0)*.9;
 gl_FragColor=vec4(vCol*a,1.0);
}`;
type Kind = { height: (scale: number) => number; size: number; color: string; intensity: number; flicker: boolean };
/** Today's kinds: head heights match the lamp models (street and park lamps: 3 m post, head at 3.2). */
export const KINDS: Record<string, Kind> = {
  lamp: { height: (s) => 3.4 * s - 0.2, size: 0.85, color: '#ffcf86', intensity: 0.9, flicker: false },
  'park-lamp': { height: (s) => 3.4 * s - 0.2, size: 0.75, color: '#ffcf86', intensity: 0.8, flicker: false },
  lantern: { height: (s) => 1.4 * s + 0.2, size: 0.55, color: '#ffc777', intensity: 0.75, flicker: false },
  fire: { height: () => 0.55, size: 1.5, color: '#ff9a4a', intensity: 0.75, flicker: true },
  'paper-lantern': { height: () => 0, size: 0.6, color: '#ffd9a0', intensity: 0.55, flicker: false },
  festoon: { height: () => 0, size: 0.32, color: '#ffe2a8', intensity: 0.7, flicker: false },
  torch: { height: () => 0, size: 1.1, color: '#ff9a4a', intensity: 0.6, flicker: true },
};
export class Halos {
  readonly mesh: THREE.InstancedMesh;
  readonly uniforms = { uHalo: { value: new THREE.Vector4(0, 0, 800, 0) } };
  private count = 0;
  private key = '';
  constructor(max = 640) {
    const g = new THREE.PlaneGeometry(1, 1);
    g.setAttribute('aHalo', new THREE.InstancedBufferAttribute(new Float32Array(max * 4), 4));
    const m = new THREE.ShaderMaterial({ vertexShader: VERT, fragmentShader: FRAG, uniforms: this.uniforms, transparent: true, depthWrite: false, depthTest: true, blending: THREE.AdditiveBlending, fog: false });
    this.mesh = new THREE.InstancedMesh(g, m, max);
    this.mesh.count = 0;
    this.mesh.name = 'lamp glow';
    this.mesh.frustumCulled = false;
    this.mesh.renderOrder = 1e6 + 1;
    this.mesh.raycast = () => {};
    this.mesh.visible = false;
    const size = new THREE.Vector2(), u = this.uniforms.uHalo.value;
    // today's pixel scale, set where the renderer and camera are known
    this.mesh.onBeforeRender = (renderer, _s, camera) => {
      renderer.getDrawingBufferSize(size);
      const fov = (camera as THREE.PerspectiveCamera).isPerspectiveCamera ? (camera as THREE.PerspectiveCamera).fov : 50;
      u.z = size.y / ((fov * Math.PI) / 180);
    };
  }
  /** A sprite at every light (rebuilt only when the set changes); two within 30 cm of each other are one. */
  setSources(list: readonly HaloSource[]): void {
    const key = JSON.stringify(list);
    if (key === this.key) return;
    this.key = key;
    const attr = this.mesh.geometry.getAttribute('aHalo') as THREE.InstancedBufferAttribute, m = new THREE.Matrix4(), c = new THREE.Color();
    const placed: number[][] = [];
    let n = 0;
    for (const [x, y, z, kind, scale] of list) {
      const k = KINDS[kind];
      if (!k || n >= attr.count) continue;
      const s = Number.isFinite(scale) ? scale : 1, hy = y + k.height(s);
      if (placed.some((p) => Math.abs(p[0] - x) < 0.3 && Math.abs(p[1] - hy) < 0.3 && Math.abs(p[2] - z) < 0.3)) continue;
      placed.push([x, hy, z]);
      const size = k.size * Math.max(0.6, Math.min(1.5, s));
      m.makeScale(size, size, size).setPosition(x, hy, z);
      this.mesh.setMatrixAt(n, m);
      c.set(k.color).multiplyScalar(k.intensity);
      attr.setXYZW(n, c.r, c.g, c.b, k.flicker ? (n * 0.618) % 1 : -1);
      n++;
    }
    this.count = n;
    this.mesh.count = n;
    this.mesh.instanceMatrix.needsUpdate = true;
    attr.needsUpdate = true;
  }
  get size(): number {
    return this.count;
  }
  /** Night strength 0..1 and world seconds (the fires' flicker). */
  update(seconds: number, night: number): void {
    const u = this.uniforms.uHalo.value;
    u.x = night;
    u.y = seconds % 600;
    this.mesh.visible = night > 0.01 && this.count > 0;
  }
  dispose(): void {
    this.mesh.removeFromParent();
    this.mesh.geometry.dispose();
    (this.mesh.material as THREE.Material).dispose();
  }
}
