// N-V7 (#3690): today's birds, gulls, ducks and butterflies (`apps/web/src/atmosphere/fauna.ts`), carried to the v2
// page: ONE instanced draw, every motion computed in the vertex shader from the page clock's world time and
// per-instance constants. No engine state and no CPU per frame beyond a uniform write. Where they go comes from the
// world's own facts (`anchors.ts`), never from a world's name: flocks over its land, landers where birds are heard,
// ducks on its water, gulls over its largest water, butterflies where bees are heard. Purely decorative: never
// raycast, casts and receives no shadow.
import * as THREE from 'three';
import { hash01, type Anchors } from './anchors.ts';

export const MAX_FLOCK_BIRDS = 8 * 7, LANDERS = 8, GULLS = 7, DUCKS = 14, MAX_BUTTERFLIES = 18;
const VERT=/* glsl */`
uniform vec4 uFauna; // x time, y bird visibility, z butterfly visibility, w daylight
uniform vec4 uFauna2; // x waterfowl visibility
uniform vec2 uWindDir;
attribute float aWing; // 0 body .. 1 wing tip (signed x carries the side)
attribute vec4 aA; // centre x, centre z, radius, phase
attribute vec4 aB; // altitude, angular speed (signed), size, mode (0 flock, 1 lander, 2 butterfly, 3 duck)
attribute vec4 aC; // perch / flower xyz, landing period offset
attribute vec3 aCol;
varying vec3 vCol;
varying float vShade;
vec3 circle(float t){float a=aA.w+t*aB.y;return vec3(aA.x+cos(a)*aA.z,aB.x+sin(t*.31+aA.w*3.0)*1.4,aA.y+sin(a)*aA.z);}
float landK(float t){float u=mod(t+aC.w,74.0);return u<54.0?smoothstep(40.0,48.0,u):1.0-smoothstep(62.0,67.0,u);}
vec3 lander(float t){float k=landK(t);vec3 c=circle(t),q=aC.xyz;vec3 p=mix(c,q,k);p.y+=sin(k*3.14159)*2.5*(1.0-k);
 float u=mod(t+aC.w,74.0);if(k>.98){float hop=floor(u/3.0);p.xz+=vec2(sin(hop*2.1+aA.w),cos(hop*1.7+aA.w))*.25*fract(sin(hop*12.9+aA.w)*43758.5)*(u>48.0&&u<62.0?1.0:0.0);}
 return p;}
vec3 butterfly(float t){float ph=aA.w;vec3 c=aC.xyz;
 return c+vec3(sin(t*.53+ph)*1.3+sin(t*1.9+ph*2.3)*.35,.45+.3*sin(t*.9+ph*1.7)+.18*sin(t*4.3+ph),cos(t*.41+ph*1.3)*1.3+cos(t*2.3+ph*.7)*.35);}
vec3 duck(float t){float a=aA.w+t*aB.y;return aC.xyz+vec3(cos(a)*aA.z,.02+sin(t*1.7+aA.w*3.0)*.012,sin(a)*aA.z);}
vec3 at(float t){return aB.w<.5?circle(t):aB.w<1.5?lander(t):aB.w<2.5?butterfly(t):duck(t);}
void main(){
 float t=uFauna.x,mode=aB.w;
 float vis=mode<1.5?uFauna.y:mode<2.5?uFauna.z:uFauna2.x;
 vec3 p=at(t),q=at(t+.12),f=q-p;
 float perched=mode>.5&&mode<1.5?step(.98,landK(t)):0.0;
 if(length(f)<1e-4)f=vec3(sin(aA.w*7.0),0.0,cos(aA.w*7.0));
 if(perched>.5){float u=mod(t+aC.w,74.0);float y=aA.w*6.0+floor(u/3.5)*1.3;f=vec3(sin(y),0.0,cos(y));}
 f=normalize(f);vec3 r=normalize(cross(f,vec3(0.0,1.0,0.0))+vec3(1e-5));vec3 up=cross(r,f);
 vec3 l=position;float side=sign(l.x);float w=aWing;
 if(mode<1.5){
  float env=perched>.5?0.0:smoothstep(-.3,.35,sin(t*.5+aA.w*5.0))+(mode>.5?smoothstep(.75,.95,landK(t))*(1.0-perched)*2.0:0.0);
  float flap=sin(t*(9.0+fract(aA.w*3.0)*3.0)+aA.w*11.0);
  l.y+=w*.34*(flap*.55*min(env,1.5)+.06);
  if(perched>.5){l.x*=.4;l.y+=w*.03;float u=mod(t+aC.w,74.0);float peck=smoothstep(.0,.15,fract(u*.7+aA.w))*step(.6,fract(u*.31+aA.w));l.y-=peck*.04*step(.1,l.z);}
  // bank toward the circle centre
  if(mode<.5)l.y+=l.x*.25*sign(aB.y);
 }else if(mode>2.5){
  // swimming: wings folded along the body, head-bob
  l.x*=mix(1.4,.28,step(.01,w));l.y+=w*.03+step(.1,l.z)*.035*(1.0+sin(t*3.0+aA.w*7.0)*.3);
 }else{
  float a=sin(t*19.0+aA.w*9.0)*1.15;l=vec3(l.x*cos(a),abs(l.x)*sin(a)+l.y,l.z);
 }
 l*=aB.z*vis;
 vec3 world=p+r*l.x+up*l.y+f*l.z;
 vCol=aCol;vShade=.35+.65*uFauna.w+.15*w;
 gl_Position=projectionMatrix*viewMatrix*vec4(world,1.0);
 if(vis<=.001)gl_Position=vec4(2.0,2.0,2.0,1.0);
}`;
const FRAG=/* glsl */`
varying vec3 vCol;
varying float vShade;
void main(){gl_FragColor=vec4(vCol*vShade,1.0);
 #include <colorspace_fragment>
}`;
export function birdGeometry(){
 const P:number[]=[],W:number[]=[];
 const tri=(a:number[],b:number[],c:number[],wa:number,wb:number,wc:number)=>{P.push(...a,...b,...c);W.push(wa,wb,wc);};
 tri([0,0,.2],[.035,0,-.08],[-.035,0,-.08],0,0,0);
 tri([.035,0,-.08],[0,0,-.2],[-.035,0,-.08],0,0,0);
 tri([0,.0,-.16],[.06,0,-.24],[-.06,0,-.24],0,0,0);
 // a vertical keel (back + head) so a bird reads from the side when perched or swimming, not as a flat line
 tri([0,0,.22],[0,.07,.1],[0,.02,-.04],0,0,0);tri([0,.02,-.04],[0,.07,.1],[0,.05,-.14],0,0,0);tri([0,0,.22],[0,.02,-.04],[0,-.03,.04],0,0,0);
 for(const s of [1,-1]){
  tri([0,0,.07],[s*.16,0,.03],[0,0,-.06],0,.5,0);
  tri([0,0,-.06],[s*.16,0,.03],[s*.16,0,-.07],0,.5,.5);
  tri([s*.16,0,.03],[s*.36,0,-.09],[s*.16,0,-.07],.5,1,.5);
 }
 const g=new THREE.InstancedBufferGeometry();g.setAttribute('position',new THREE.Float32BufferAttribute(P,3));g.setAttribute('aWing',new THREE.Float32BufferAttribute(W,1));
 return g;
}
const BUTTERFLY_COLOURS = ['#f2c14e', '#f7f3e8', '#e8833a', '#9fc2e8', '#f2a6c4', '#fbe7a1'];
/** Rows of a fixed layout: [flock birds][landers][gulls][ducks][butterflies]; an unused row is drawn at size 0. */
const ROWS = MAX_FLOCK_BIRDS + LANDERS + GULLS + DUCKS + MAX_BUTTERFLIES;

export class Fauna {
  readonly mesh: THREE.Mesh<THREE.InstancedBufferGeometry, THREE.ShaderMaterial>;
  readonly uniforms = { uFauna: { value: new THREE.Vector4() }, uFauna2: { value: new THREE.Vector4() }, uWindDir: { value: new THREE.Vector2(1, 0) } };
  /** How many of each are placed (for tests and the page's measure). */
  placed = { birds: 0, landers: 0, gulls: 0, ducks: 0, butterflies: 0 };
  private readonly A = new Float32Array(ROWS * 4);
  private readonly B = new Float32Array(ROWS * 4);
  private readonly C = new Float32Array(ROWS * 4);
  private readonly K = new Float32Array(ROWS * 3);
  constructor() {
    const g = birdGeometry();
    for (const [name, a, n] of [['aA', this.A, 4], ['aB', this.B, 4], ['aC', this.C, 4], ['aCol', this.K, 3]] as const) g.setAttribute(name, new THREE.InstancedBufferAttribute(a, n));
    g.instanceCount = ROWS;
    const m = new THREE.ShaderMaterial({ vertexShader: VERT, fragmentShader: FRAG, uniforms: this.uniforms, side: THREE.DoubleSide });
    this.mesh = new THREE.Mesh(g, m);
    this.mesh.name = 'atmosphere: birds and butterflies';
    this.mesh.frustumCulled = false;
    this.mesh.raycast = () => {};
    this.mesh.castShadow = this.mesh.receiveShadow = false;
    this.mesh.visible = false;
  }
  /** Places every creature from the world's anchors (rarely: when the world's things or ground change). The same
   *  anchors give the same rows. */
  setAnchors(an: Anchors, heightAt: (x: number, z: number) => number | null = () => 0): void {
    this.A.fill(0), this.B.fill(0), this.C.fill(0), this.K.fill(0);
    let seed = 1, i = 0;
    const r = () => hash01(seed++, 991);
    const row = (v: number[]) => {
      this.A.set(v.slice(0, 4), i * 4), this.B.set(v.slice(4, 8), i * 4), this.C.set(v.slice(8, 12), i * 4), this.K.set(v.slice(12, 15), i * 3);
      i++;
    };
    // Flocks: altitude over the ground at their centre, as today's flock altitudes were over Eden's flat town.
    let birds = 0;
    for (const [cx, cz, rad, alt, n] of an.flocks) {
      const base = r() * 6.283, dir = r() < 0.5 ? -1 : 1, speed = (dir * (5.5 + r() * 2)) / rad, ground = heightAt(cx, cz) ?? 0;
      for (let k = 0; k < n && birds < MAX_FLOCK_BIRDS; k++, birds++) row([cx + (r() - 0.5) * 4, cz + (r() - 0.5) * 4, rad + (r() - 0.5) * 7, base + (r() - 0.5) * 0.55, ground + alt + (r() - 0.5) * 4, speed * (1 + (r() - 0.5) * 0.06), 0.8 + r() * 0.35, 0, 0, 0, 0, 0, 0.16, 0.16, 0.18]);
    }
    i = MAX_FLOCK_BIRDS;
    // Landers circle above their perch, come down to peck for a while, and fly up again (a 74 s cycle).
    const landers = an.perches.length ? LANDERS : 0;
    for (let k = 0; k < landers; k++) {
      const p = an.perches[k % an.perches.length], rad = 10 + r() * 6, dir = r() < 0.5 ? -1 : 1;
      row([p[0] + (r() - 0.5) * 6, p[2] + (r() - 0.5) * 6, rad, r() * 6.283, p[1] + 11 + r() * 5, (dir * 6) / rad, 0.75 + r() * 0.2, 1, p[0] + (r() - 0.5) * 0.6, p[1], p[2] + (r() - 0.5) * 0.6, r() * 74, 0.2, 0.19, 0.2]);
    }
    i = MAX_FLOCK_BIRDS + LANDERS;
    // A white gull flock over the largest water.
    const gulls = an.gulls ? GULLS : 0;
    if (an.gulls) {
      const base = r() * 6.283, [gx, gz] = an.gulls, ground = heightAt(gx, gz) ?? 0;
      for (let k = 0; k < GULLS; k++) row([gx + (r() - 0.5) * 5, gz + (r() - 0.5) * 5, 20 + (r() - 0.5) * 8, base + (r() - 0.5) * 0.8, ground + 13 + (r() - 0.5) * 4, -(6 + r() * 2) / 20, 0.95 + r() * 0.3, 0, 0, 0, 0, 0, 0.82, 0.82, 0.8]);
    }
    i = MAX_FLOCK_BIRDS + LANDERS + GULLS;
    // Ducks paddle in slow circles on the water.
    const ducks = an.water.length ? DUCKS : 0;
    for (let k = 0; k < ducks; k++) {
      const p = an.water[k % an.water.length], brown = k % 3 !== 0;
      row([0, 0, 0.6 + r() * 1.4, r() * 6.283, 0, (r() < 0.5 ? -1 : 1) * (0.05 + r() * 0.06), 0.85 + r() * 0.2, 3, p[0], p[1], p[2], 0, brown ? 0.23 : 0.75, brown ? 0.17 : 0.74, brown ? 0.11 : 0.7]);
    }
    i = MAX_FLOCK_BIRDS + LANDERS + GULLS + DUCKS;
    const butterflies = an.flowers.length ? MAX_BUTTERFLIES : 0;
    for (let k = 0; k < butterflies; k++) {
      const f = an.flowers[k % an.flowers.length], c = new THREE.Color(BUTTERFLY_COLOURS[k % BUTTERFLY_COLOURS.length]).convertSRGBToLinear();
      row([0, 0, 0, r() * 50, 0, 0, 0.3 + r() * 0.08, 2, f[0] + (r() - 0.5) * 1.2, f[1], f[2] + (r() - 0.5) * 1.2, 0, c.r, c.g, c.b]);
    }
    for (const name of ['aA', 'aB', 'aC', 'aCol']) (this.mesh.geometry.getAttribute(name) as THREE.InstancedBufferAttribute).needsUpdate = true;
    this.placed = { birds, landers, gulls, ducks, butterflies };
  }
  /** World seconds (the page clock), visibilities 0..1 and daylight 0..1. */
  update(seconds: number, birds: number, butterflies: number, daylight: number, ducks: number): void {
    this.uniforms.uFauna.value.set(seconds % 7200, birds, butterflies, daylight);
    this.uniforms.uFauna2.value.x = ducks;
    const p = this.placed;
    this.mesh.visible = (birds > 0.001 && p.birds + p.landers + p.gulls > 0) || (butterflies > 0.001 && p.butterflies > 0) || (ducks > 0.001 && p.ducks > 0);
  }
  dispose(): void {
    this.mesh.removeFromParent();
    this.mesh.geometry.dispose();
    this.mesh.material.dispose();
  }
}
