// Rain near the camera (Engine v2 V19, #2763), carried over from today's `apps/web/src/atmosphere/rain.ts` (its rain
// streaks; the leaves and motes are not carried): one draw of camera-facing streaks, each drop anchored in a box that
// wraps round the camera, falling and slanting with the wind in the vertex shader. Its time is the world's (seconds of
// world time), so a seek to a moment draws the same drops as playing to it.
import * as THREE from 'three';

const VERT = /* glsl */ `
uniform vec4 uRain; // x world seconds, y intensity 0..1, z daylight
uniform vec3 uCam;
uniform vec3 uWind;
attribute vec4 aSeed; // xyz 0..1 position seeds, w 0 top / 1 tail
attribute float aSide; // -1 / 1 across the streak
varying float vA;
varying vec3 vC;
const float BOX=24.0;const float H=15.0;
void main(){
 vC=mix(vec3(.4,.43,.5),vec3(.86,.89,.94),uRain.z);
 float speed=10.0+aSeed.y*3.0;
 vec3 base=vec3(aSeed.x*BOX,fract(aSeed.y*7.31)*H,aSeed.z*BOX);
 float y=mod(base.y-uRain.x*speed-uCam.y,H);
 vec3 p=vec3(uCam.x+mod(base.x-uCam.x,BOX)-BOX*.5,uCam.y-H*.45+y,uCam.z+mod(base.z-uCam.z,BOX)-BOX*.5);
 vec3 vel=normalize(vec3(uWind.x,-speed,uWind.z));
 p.xz+=vec2(uWind.x,uWind.z)*(y/speed);
 p-=vel*aSeed.w*(.6+aSeed.x*.35);
 float on=step(fract(aSeed.x*13.7+aSeed.z*7.9),uRain.y);
 vec3 toCam=uCam-p;float dist=length(toCam);
 p+=normalize(cross(vel,toCam))*aSide*max(.006,dist*.0011);
 vA=on*smoothstep(.8,3.0,dist)*(1.0-smoothstep(BOX*.3,BOX*.5,length(p.xz-uCam.xz)))*(.17+.33*uRain.z)*(1.0-aSeed.w*.75);
 gl_Position=projectionMatrix*viewMatrix*vec4(p,1.0);
 if(on<.5)gl_Position=vec4(2.0,2.0,2.0,1.0);
}`;
const FRAG = /* glsl */ `
varying float vA;
varying vec3 vC;
void main(){gl_FragColor=vec4(vC,vA);
 #include <colorspace_fragment>
}`;

/** Today's 32-bit hash to [0, 1) (`atmosphere/weather.ts`), so the drops are seeded as today's. */
export function hash01(a: number, b = 0) {
  let h = (Math.imul(a | 0, 0x27d4eb2d) ^ Math.imul(b | 0, 0x165667b1)) >>> 0;
  h = Math.imul(h ^ (h >>> 15), 0x85ebca6b) >>> 0;
  h = Math.imul(h ^ (h >>> 13), 0xc2b2ae35) >>> 0;
  return ((h ^ (h >>> 16)) >>> 0) / 4294967296;
}

export const RAIN_DROPS = 4200;

export class Rain {
  readonly mesh: THREE.Mesh<THREE.BufferGeometry, THREE.ShaderMaterial>;
  readonly uniforms = { uRain: { value: new THREE.Vector4() }, uCam: { value: new THREE.Vector3() }, uWind: { value: new THREE.Vector3() } };
  constructor() {
    const N = RAIN_DROPS, g = new THREE.BufferGeometry(), S = new Float32Array(N * 24), A = new Float32Array(N * 6);
    const corners = [[0, -1], [0, 1], [1, 1], [0, -1], [1, 1], [1, -1]];
    for (let i = 0; i < N; i++) {
      const a = hash01(i, 11), b = hash01(i, 12), c = hash01(i, 13);
      corners.forEach(([w, side], k) => { S.set([a, b, c, w], (i * 6 + k) * 4); A[i * 6 + k] = side; });
    }
    g.setAttribute('position', new THREE.BufferAttribute(new Float32Array(N * 18), 3));
    g.setAttribute('aSeed', new THREE.BufferAttribute(S, 4));
    g.setAttribute('aSide', new THREE.BufferAttribute(A, 1));
    const m = new THREE.ShaderMaterial({ vertexShader: VERT, fragmentShader: FRAG, uniforms: this.uniforms, transparent: true, depthWrite: false, side: THREE.DoubleSide });
    this.mesh = new THREE.Mesh(g, m);
    Object.assign(this.mesh, { name: 'sky: rain', frustumCulled: false, renderOrder: 6, visible: false });
    this.mesh.raycast = () => {};
  }
  /** `seconds` of world time; `intensity` 0..1 (none drawn at 0); `wind` 0..1 slants the streaks along +x. */
  update(seconds: number, intensity: number, daylight: number, camera: THREE.Camera, wind: number): void {
    this.mesh.visible = intensity > 0.01;
    if (!this.mesh.visible) return;
    this.uniforms.uRain.value.set(seconds % 7200, intensity, daylight, 0);
    camera.getWorldPosition(this.uniforms.uCam.value);
    this.uniforms.uWind.value.set(1.5 + wind * 5.5, 0, 0);
  }
}
