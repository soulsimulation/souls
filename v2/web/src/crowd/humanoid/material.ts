// One palette material per humanoid look on the v2 page (#3998), ported unchanged in what it draws from
// apps/web/src/humanoid/material.ts and the finish it reuses (mars/viewer/app/engine-view/content/details/human-presets/
// finish.ts: skin mottling, weave, hair strands, eye glints), because the page imports nothing from apps/ and keeps one
// copy of three. Change them together. The kit's per-vertex [palette slot, finish role, roughness·255] rides in the
// crowd's `color` attribute (its LOD levels keep a corner's attributes exactly), so a whole look is one draw; the
// crowd's own skinning patch runs after this one (`../shader.ts`).
import * as THREE from 'three';

export const HUMANOID_PROGRAM_KEY = 'v2-humanoid2-v1';

const VERTEX_HEAD = /* glsl */`varying vec3 vHumanP;
varying float edenHumanRole;
varying float hSlot;
varying float hRough;
`;
// Bind-space position: detail stays glued to the garment and skin as limbs move.
const VERTEX_BODY = /* glsl */`
edenHumanRole=color.y;hSlot=color.x;hRough=color.z;
vHumanP=position;`;
const FRAGMENT_HEAD = /* glsl */`varying float edenHumanRole;
varying float hSlot;
varying float hRough;
uniform vec3 hPalette[16];
uniform float hPattern;
varying vec3 vHumanP;
float hHash(vec3 p){p=fract(p*vec3(.1031,.1030,.0973));p+=dot(p,p.yzx+33.33);return fract((p.x+p.y)*p.z);}
// 3D value noise that settles to its mean once a cell nears pixel size (no shimmer at distance).
float hNoise(vec3 p){vec3 i=floor(p),f=fract(p),d=fwidth(p);f=f*f*(3.-2.*f);
 float n=mix(mix(mix(hHash(i),hHash(i+vec3(1,0,0)),f.x),mix(hHash(i+vec3(0,1,0)),hHash(i+vec3(1,1,0)),f.x),f.y),
  mix(mix(hHash(i+vec3(0,0,1)),hHash(i+vec3(1,0,1)),f.x),mix(hHash(i+vec3(0,1,1)),hHash(i+vec3(1,1,1)),f.x),f.y),f.z);
 return mix(n,.5,smoothstep(.35,.9,max(d.x,max(d.y,d.z))));}
`;
// Palette colour, then an optional procedural pattern on the cloth of the top (bind space: glued to the garment).
const PALETTE = /* glsl */`
{
 int hs=int(hSlot+.5);vec3 hc=hPalette[hs];
 if(hPattern>.5&&(hs==6||hs==7)&&edenHumanRole>1.5&&edenHumanRole<2.5){
  vec3 ho=hPalette[hs==6?7:6],hp=vHumanP;float hm=0.,hf=0.;
  if(hPattern<1.5){float q=hp.y*16.;hm=step(.5,fract(q));hf=fwidth(q);} // stripes
  else if(hPattern<2.5){vec2 q=vec2(hp.y,hp.x+hp.z*.6)*13.;hm=mod(floor(q.x)+floor(q.y),2.);hf=max(fwidth(q.x),fwidth(q.y));} // checks
  else{float q=atan(hp.x,hp.z-.04)*26.;hm=smoothstep(.25,.75,abs(fract(q)-.5)*2.)*.55+.2*step(.5,fract(hp.y*40.));hf=fwidth(q);} // knit ribs
  hm=mix(hm,.5,smoothstep(.35,.9,hf));
  hc=mix(hc,ho,hm*.85);
 }
 diffuseColor.rgb=hc;
}
`;
const FRAGMENT_BODY = /* glsl */`
float humanRough=1.,humanBump=0.,humanBumpAmt=0.;
{
 float role=edenHumanRole;vec3 hp=vHumanP;
 float hnear=1.-smoothstep(12.,20.,length(vViewPosition));bool hdetail=hnear>.001;
 vec3 tint=vec3(1.);
 if(role<1.5){
  float zone=hNoise(hp*7.+3.1),m=hdetail?mix(.5,hNoise(hp*70.),hnear):.5;
  tint=mix(vec3(.985,.99,1.),vec3(1.03,.985,.965),zone)*(.975+.05*m);
  humanRough=.93+.14*m;humanBump=m*.0006;humanBumpAmt=hnear;
 }else if(role<3.5){
  float dye=hNoise(hp*3.3+7.),pill=hdetail?mix(.5,hNoise(hp*36.),hnear):.5,weave=0.;
  if(hdetail){vec3 a=abs(normalize(cross(dFdx(hp),dFdy(hp))));vec2 q=a.z>max(a.x,a.y)?hp.xy:(a.x>a.y?hp.zy:hp.xy);
   q*=role<2.5?1150.:900.;float wv=role<2.5?sin(q.x)*sin(q.y):sin(q.x+q.y)*.8+.2*sin(q.x-q.y);vec2 fw=fwidth(q);
   weave=wv*(1.-smoothstep(.5,1.3,max(fw.x,fw.y)))*hnear;}
  tint=vec3(.93+.12*dye)*(.95+.08*pill)*(1.+.035*weave);
  if(role>2.5){
   vec3 nb=normalize(cross(dFdx(hp),dFdy(hp)));tint*=mix(1.,1.1,smoothstep(.2,.8,nb.z)*smoothstep(.25,.55,hp.y)*(1.-smoothstep(.75,.95,hp.y)));
  }
  humanRough=1.+.06*(pill-.5);humanBump=pill*.0012+weave*.00025;humanBumpAmt=hnear;
 }else if(role<4.5){
  float c=hdetail?mix(.5,hNoise(hp*vec3(60.,24.,60.)),hnear):.5,s=hNoise(hp*9.+2.);
  tint=vec3(.92+.14*s)*(.96+.06*c);humanRough=.85+.35*c;humanBump=c*.0008;humanBumpAmt=hnear;
 }else if(role<5.5){
  tint=vec3(.9+.08*hNoise(hp*20.))*mix(.92,1.,smoothstep(.0,.06,hp.y));humanRough=1.08;
 }else if(role<6.5){
  vec3 c=hp-vec3(0.,1.685,.035);float r=length(c*vec3(1.,.92,1.));
  float strand=hdetail?mix(.5,hNoise(vec3(hp.x*260.,hp.y*16.,hp.z*260.)),hnear):.5,clump=hNoise(hp*vec3(40.,8.,40.));
  float roots=1.-smoothstep(.095,.14,r);
  tint=vec3(.88+.24*strand)*(.92+.14*clump)*mix(1.,.62,roots);
  humanRough=.78+.5*strand;humanBump=strand*.0008;humanBumpAmt=hnear;
 }else if(role<7.5){
  tint=vec3(.85+.2*(hdetail?mix(.5,hNoise(hp*vec3(600.,120.,600.)),hnear):.5));humanRough=1.05;
 }else if(role<8.5){
  float r=length(vec2(abs(hp.x)-.045,hp.y-1.694))/.0125;
  tint=r<.38?vec3(.45):mix(vec3(2.6,2.2,1.9),vec3(1.),smoothstep(.62,.95,r));
 }
 diffuseColor.rgb*=tint;
}
`;
const LIGHT_BODY = /* glsl */`
{
 float role=edenHumanRole;vec3 hp=vHumanP;
 vec3 wn=inverseTransformDirection(normal,viewMatrix);
 float ao=mix(.64,1.,clamp(wn.y*.5+.5,0.,1.))*mix(.8,1.,smoothstep(.02,.5,hp.y));
 ao*=1.-.22*(1.-smoothstep(.025,.075,abs(hp.x)))*smoothstep(.55,.85,hp.y)*(1.-smoothstep(.9,1.02,hp.y));
 if(role>7.5&&role<8.5)ao=1.;
 reflectedLight.indirectDiffuse*=ao;reflectedLight.directDiffuse*=mix(1.,ao,.3);
 vec3 V=normalize(vViewPosition);float facing=clamp(dot(normal,V),0.,1.),rim=pow(1.-facing,3.);
 float amb=dot(reflectedLight.indirectDiffuse,vec3(.333))/max(dot(diffuseColor.rgb,vec3(.333)),1e-3);
 if(role<1.5){
  float base=max(dot(diffuseColor.rgb,vec3(.333)),1e-3),irr=dot(reflectedLight.directDiffuse,vec3(.333))/base;
  float term=smoothstep(0.,.06,irr)*(1.-smoothstep(.06,.3,irr));
  reflectedLight.directDiffuse+=diffuseColor.rgb*vec3(.15,.05,.02)*term;
  reflectedLight.indirectDiffuse*=vec3(1.035,.995,.97);
  reflectedLight.indirectDiffuse+=diffuseColor.rgb*vec3(1.,.74,.64)*rim*.16*amb;
 }else if(role<3.5){
  reflectedLight.indirectDiffuse+=diffuseColor.rgb*rim*.22*amb;
 }else if(role>7.5&&role<8.5){
  vec3 L=normalize(vec3(.35,.5,1.));float glint=smoothstep(.88,.95,dot(normal,L));
  reflectedLight.directSpecular+=vec3(.6)*glint;
 }
}
`;
const BUMP = /* glsl */`if(humanBumpAmt>0.){vec3 sx=dFdx(-vViewPosition),sy=dFdy(-vViewPosition),r1=cross(sy,normal),r2=cross(normal,sx);float det=dot(sx,r1);
 vec3 grad=sign(det)*(dFdx(humanBump)*r1+dFdy(humanBump)*r2);normal=normalize(abs(det)*normal-grad*humanBumpAmt);}`;

/** The shader patch: today's finish and palette, with the kit's info read from `color` (exported for the test). */
export function humanoidCompile(shader: { uniforms: Record<string, THREE.IUniform>; vertexShader: string; fragmentShader: string }, palette: Float32Array, pattern: { value: number }): void {
  for (const chunk of ['#include <begin_vertex>', '#include <color_fragment>', '#include <roughnessmap_fragment>', '#include <normal_fragment_maps>', '#include <aomap_fragment>']) {
    if (!(shader.vertexShader + shader.fragmentShader).includes(chunk)) throw new Error('body.humanoid-shader-layout');
  }
  shader.uniforms.hPalette = { value: palette };
  shader.uniforms.hPattern = pattern;
  shader.vertexShader = VERTEX_HEAD + shader.vertexShader.replace('#include <begin_vertex>', '#include <begin_vertex>' + VERTEX_BODY);
  shader.fragmentShader = FRAGMENT_HEAD + shader.fragmentShader
    .replace('#include <color_fragment>', '#include <color_fragment>' + PALETTE + FRAGMENT_BODY)
    .replace('#include <roughnessmap_fragment>', '#include <roughnessmap_fragment>\nroughnessFactor=hRough;\nroughnessFactor=clamp(roughnessFactor*humanRough,.04,1.);')
    .replace('#include <normal_fragment_maps>', '#include <normal_fragment_maps>\n' + BUMP)
    .replace('#include <aomap_fragment>', '#include <aomap_fragment>\n' + LIGHT_BODY);
}

export function humanoidMaterial(palette: Float32Array, patternId: number): THREE.MeshStandardMaterial {
  const m = new THREE.MeshStandardMaterial({ color: 0xffffff, roughness: 0.5, metalness: 0, side: THREE.DoubleSide, vertexColors: true });
  m.name = 'humanoid@2';
  const pattern = { value: patternId };
  m.userData.humanoid = { palette, pattern };
  m.onBeforeCompile = (shader) => humanoidCompile(shader, palette, pattern);
  m.customProgramCacheKey = () => HUMANOID_PROGRAM_KEY;
  return m;
}
