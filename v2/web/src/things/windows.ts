// Lit windows with a room behind them (0.131 parity C10, #3681), carried over from today's building kit
// (`apps/web/src/gen-mesh/building-windows.ts`, its room from `eden-window-interiors.ts`): at night a lit window shows a
// room behind the glass ("interior mapping": a ray from the eye through the pane is traced into a box room with its
// walls, floor, lamp, a picture or shelf, now and then a person, and curtains). Rooms switch on through the evening by
// today's `windowsLitAt` curve (each window keeps its own threshold), only the outdoor side of an outside window shows
// one, and by day nothing changes (every term is scaled by the night strength, `draw/night.ts`). The bake keeps each
// pane's numbers as the glass's `_edenpane` attribute; both GLSL strings are today's byte for byte
// (`today-windows.json` pins them). Presentation only.
import * as THREE from 'three';

/** Today's room behind the glass (`EDEN_ROOM_GLSL`), unchanged. */
export const EDEN_ROOM_GLSL = /* glsl */ `
float edenRh(vec3 p){p=fract(p*vec3(.1031,.1030,.0973));p+=dot(p,p.yxz+33.33);return fract((p.x+p.y)*p.z);}
// o: entry point on the glass in room coordinates (x along the facade from the room's left wall, y up from the
// floor, z = 0 at the glass), d: ray direction in the same frame (z into the room), R: room size, seed: room id.
vec3 edenRoom(vec3 o,vec3 d,vec3 R,float seed,float t){
 vec3 dd=d;dd.z=max(dd.z,.05);
 float tx=((dd.x>0.0?R.x:0.0)-o.x)/(abs(dd.x)>1e-4?dd.x:1e-4);
 float ty=((dd.y>0.0?R.y:0.0)-o.y)/(abs(dd.y)>1e-4?dd.y:1e-4);
 float tz=R.z/dd.z;
 float tt=min(min(max(tx,0.0),max(ty,0.0)),tz);vec3 h=o+dd*tt;
 float s2=fract(seed*13.7),s3=fract(seed*71.3),s4=fract(seed*5.91);
 vec3 paint=s2<.25?vec3(.93,.86,.72):s2<.45?vec3(.95,.78,.66):s2<.62?vec3(.74,.82,.68):s2<.78?vec3(.7,.78,.88):vec3(.96,.93,.86);
 vec3 c;
 if(tt==tz){c=paint;
  // back wall: a picture (or a shelf of books), a dark doorway on some walls
  vec2 b=h.xy;float px=R.x*(.3+.4*s3);
  if(s4<.5){if(abs(b.x-px)<.32&&abs(b.y-1.55)<.24)c=mix(vec3(.25,.2,.15),vec3(.55+.4*s3,.45,.3+.4*s4),step(abs(b.x-px),.27)*step(abs(b.y-1.55),.19));}
  else if(abs(b.y-1.2)<.55&&abs(b.x-px)<.6){float row=fract(b.y*3.4);c=row<.18?vec3(.35,.25,.17):mix(vec3(.55,.2,.18),vec3(.2,.35,.5),step(.5,fract(b.x*9.0+s3)))*.9;}
  if(s3>.8&&abs(b.x-R.x*.85)<.38&&b.y<2.05)c*=.35;
  // a person now and then, drifting across the back wall
  if(s4>.82){float px2=R.x*(.5+.32*sin(t*.07+seed*20.0));vec2 q=b-vec2(px2,0.0);
   float body=length(vec2(q.x/.22,(q.y-1.0)/.62));float head=length(vec2(q.x,q.y-1.72))/.13;
   float sh=1.0-smoothstep(.85,1.1,min(body,head));c*=1.0-.75*sh;}
 }else if(tt==max(ty,0.0)&&dd.y<0.0){ // floor: boards and a rug
  c=vec3(.42,.28,.17)*(.85+.15*step(.5,fract(h.x*4.0+s2)));
  if(abs(h.x-R.x*.5)<R.x*.3&&h.z>R.z*.25&&h.z<R.z*.8)c=mix(vec3(.55,.18,.16),vec3(.2,.32,.45),step(.5,s3))*.9;
 }else if(tt==max(ty,0.0)){c=vec3(.95,.92,.86); // ceiling
 }else c=paint*.92; // side walls
 // a warm lamp hanging near the ceiling, toward the middle of the room
 vec3 lamp=vec3(R.x*.5,R.y*.82,R.z*.55);float dl=length(h-lamp);
 float k=.35+1.15/(1.0+dl*dl*.55);
 vec3 tint=mix(vec3(1.0,.78,.5),vec3(1.0,.9,.75),s2);
 return c*tint*k;
}
// Net or drawn curtains at the glass: a: across the pane 0..1, y: up 0..1, seed.
vec3 edenCurtain(float a,float y,float seed,vec3 room,out float cover){
 float s=fract(seed*31.7);cover=0.0;
 vec3 col=s<.33?vec3(.75,.22,.18):s<.66?vec3(.92,.86,.7):vec3(.38,.55,.42);
 float fold=.82+.18*sin(a*60.0+seed*9.0);
 if(s<.55){float w=.16+.14*fract(seed*7.3);float side=max(1.0-smoothstep(w-.03,w,a),smoothstep(1.0-w,1.0-w+.03,a));cover=side*.92;}
 else{cover=.45;col=vec3(.95,.92,.85);}
 return mix(room,col*(.35+.65*dot(room,vec3(.33)))*fold*1.3,cover);
}
`;

/** Today's glass patch (`building-windows.ts` ROOM), unchanged. */
export const PANE_GLSL = /* glsl */ `
if (abs(vEdenPane.z) > .01 && uEdenNight.x > .001) {
 vec3 wp = vEdenNightWorld, vW = normalize(wp - cameraPosition), nF = normalize(vEdenPaneN), N = nF * sign(vEdenPane.z);
 if (dot(N, vW) < 0.0) {
  vec3 T = normalize(vec3(nF.z, 0.0, -nF.x) + vec3(1e-5, 0.0, 0.0));
  float W = abs(vEdenPane.z);
  vec3 R = vec3(max(W + 1.6, 3.0), 2.8, 3.4);
  vec3 c = wp - T * (vEdenPane.x - W * .5) - vec3(0.0, vEdenPane.y, 0.0);
  float seed = edenRh(floor(c * 2.0 + .5) + vec3(17.0, 3.0, 5.0));
  vec3 o = vec3((R.x - W) * .5 + vEdenPane.x, vEdenPane.w + vEdenPane.y, 0.0), d = vec3(dot(vW, T), vW.y, dot(vW, -N));
  float k = uEdenNight.x * step(seed, uEdenWindows.x);
  vec3 room = edenRoom(o, d, R, seed, uEdenWindows.y); float cover; room = edenCurtain(vEdenPane.x / W, 0.0, seed, room, cover);
  totalEmissiveRadiance = mix(totalEmissiveRadiance, room * .7, k);
  diffuseColor.rgb *= 1.0 - k;
  diffuseColor.a = mix(diffuseColor.a, 1.0, k);
 }
}`;

/** [fraction of rooms lit, seconds within the hour] (today's `uEdenWindows`); 0.6 lit until the page gives the hour. */
const WINDOWS = { value: { x: 0.6, y: 0, z: 0, w: 0 } };

/** Fraction of rooms with a light on by local hour (today's `windowsLitAt`): people come home at dusk, the evening is
 *  busy, the late night has only a few lights, early risers before dawn. */
export function windowsLitAt(hour: number): number {
  const h = ((hour % 24) + 24) % 24, k = [[0, 0.32], [1, 0.16], [4.5, 0.12], [6, 0.34], [8, 0.3], [16.5, 0.4], [18.5, 0.72], [22, 0.7], [23.5, 0.42], [24, 0.32]];
  for (let i = 1; i < k.length; i++) if (h <= k[i][0]) {
    const [a, va] = k[i - 1], [b, vb] = k[i], t = (h - a) / (b - a);
    return va + (vb - va) * t * t * (3 - 2 * t);
  }
  return 0.32;
}

/** The world's local hour (null: none yet) and seconds, as today's `setWindowLife`. */
export function setWindowLife(hour: number | null, seconds: number): void {
  WINDOWS.value.x = hour === null ? 0.6 : windowsLitAt(hour);
  WINDOWS.value.y = seconds % 3600;
}
export const windowLife = () => ({ ...WINDOWS.value });

/** Is this the building kit's window glass (its material's name, as the bake keeps it)? */
export const isNightGlass = (m: THREE.Material) => / \(night rooms\)$/.test(m.name);

const done = new WeakSet<THREE.Material>();
/** Patches the window glass once: rooms behind lit windows at night. The pane's normal is turned by the batch's or
 *  instance's matrix too, since the thing layer draws the glass batched or instanced where today's page drew a clone. */
export function nightWindows(m: THREE.Material): THREE.Material {
  if (done.has(m)) return m;
  done.add(m);
  m.onBeforeCompile = (sh) => {
    if (!sh.uniforms.uEdenNight) return; // no night lighting installed: plain glass
    sh.uniforms.uEdenWindows = WINDOWS;
    sh.vertexShader = sh.vertexShader
      .replace('void main() {', 'attribute vec4 edenPane;\nvarying vec4 vEdenPane;\nvarying vec3 vEdenPaneN;\nvoid main() {')
      .replace('#include <begin_vertex>', `#include <begin_vertex>
vEdenPane = edenPane;
vec3 edenPaneN = objectNormal;
#ifdef USE_BATCHING
edenPaneN = mat3(batchingMatrix) * edenPaneN;
#endif
#ifdef USE_INSTANCING
edenPaneN = mat3(instanceMatrix) * edenPaneN;
#endif
vEdenPaneN = mat3(modelMatrix) * edenPaneN;`);
    sh.fragmentShader = sh.fragmentShader
      .replace('void main() {', `uniform vec4 uEdenWindows;\nvarying vec4 vEdenPane;\nvarying vec3 vEdenPaneN;\n${EDEN_ROOM_GLSL}\nvoid main() {`)
      .replace('#include <emissivemap_fragment>', `#include <emissivemap_fragment>\n${PANE_GLSL}`);
  };
  m.customProgramCacheKey = () => 'v2-building-night-windows-1';
  return m;
}
