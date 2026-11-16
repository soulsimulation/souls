// #2197 eat pose on the three visitors, standing, on a seat and on the grass, over a whole eating cycle: no leg vertex
// comes within a forearm's thickness of a forearm or hand axis (the arms stay clear of the legs), and the food is drawn
// in the hand that goes to the mouth (it rises to the face, not left on the lap).
// node apps/web/test/eat-pose.cpu.mjs   (GLB_DIR=… to check another export)
// BODY_GLBS=a.glb,… also checks those humanoid-rig bodies: the monster preset is the other body that can eat (a local
// world serves it at /v1/edge/body/assets/<asset>.glb); the centaur and Pip are refused eat by their action profiles,
// and the ghost, the Martians and the creatures have no arms.
import assert from 'node:assert/strict';import {readFileSync} from 'node:fs';import {createRequire} from 'node:module';
import*as THREE from 'three';
const M=new URL('../../../mars/viewer/',import.meta.url).pathname;
{const {registerHooks}=await import('node:module');const esbuild=createRequire(M+'package.json')('esbuild');
 registerHooks({resolve(spec,ctx,next){try{return next(spec,ctx);}catch(e){if(ctx.parentURL?.startsWith('file://'+M)&&spec.startsWith('.'))return next(spec+'.ts',ctx);throw e;}},load(url,ctx,next){if(url.startsWith('file://'+M)&&url.endsWith('.ts')){const src=readFileSync(new URL(url),'utf8');return {format:'module',source:esbuild.transformSync(src,{loader:'ts',format:'esm'}).code,shortCircuit:true};}return next(url,ctx);}});}
const DIR=process.env.GLB_DIR??M+'public/modular/environment/';
globalThis.location??={href:'http://local/'};
globalThis.fetch=async url=>{const name=String(url).split('/').pop().split('?')[0];const b=readFileSync(DIR+name);return new Response(b.buffer.slice(b.byteOffset,b.byteOffset+b.byteLength));};
const {loadTemplates}=await import(M+'app/engine-view/people.ts');
const {HumanViews}=await import(M+'app/engine-view/humans.ts');
const {ThreeResources}=await import(M+'lib/three-resources.ts');
const ts=await loadTemplates(new AbortController().signal,new ThreeResources());
const views=new HumanViews(false);views.setTemplates(ts);
const bodies=new Map();
if(process.env.BODY_GLBS){const {GLTFLoader}=await import('three/addons/loaders/GLTFLoader.js');const {templateFromGltf}=await import(M+'app/engine-view/people.ts');
 for(const f of process.env.BODY_GLBS.split(',')){const b=readFileSync(f),name=f.split('/').pop().replace(/\.glb$/,'');
  const gltf=await new GLTFLoader().parseAsync(b.buffer.slice(b.byteOffset,b.byteOffset+b.byteLength),'');bodies.set(name,templateFromGltf(name,gltf));}
 views.setBodyTemplates(bodies);}
const idFor=(name,base)=>{for(let k=0;k<500;k++){const id=`${base}-${k}`;let h=0;for(const ch of id)h=(h*31+ch.charCodeAt(0))>>>0;if(ts[h%ts.length].name===name)return id;}};
const V=()=>new THREE.Vector3();
const toSeg=(q,a,c)=>{const u=V().subVectors(c,a),k=Math.max(0,Math.min(1,V().subVectors(q,a).dot(u)/u.dot(u)));return V().copy(a).addScaledVector(u,k).distanceTo(q);};
/** A leg vertex this close to a forearm / hand bone axis is inside the arm (the rigs' forearms are about 3.5 cm thick). */
const CLEAR=0.04;
const CASES={standing:{baseActivity:'idle'},seat:{baseActivity:'sit',seatHeight:.45},grass:{baseActivity:'sit-ground'}};
const out={},fails=[];
for(const t of [...ts,...[...bodies.values()].map(b=>({...b,body:true}))])for(const [k,c] of Object.entries(CASES)){
 const id=t.body?`${t.name}-eat-${k}`:idFor(t.name,`${t.name}-eat-${k}`);let clear=Infinity,shown=0,n=0,nearest=Infinity;
 for(let s=0;s<12;s+=0.25,n++){
  views.setFrame([{id,p:[0,0,0],yaw:0,walk:0,walkDist:0,activity:'eat',prop:'food',activityAge:5+s,...c,...(t.body?{bodyModel:t.name}:{})}],100+s);views.render(1);
  views.group.updateMatrixWorld(true);const h=views.group.getObjectByName(id),b=n=>h.getObjectByName(n).getWorldPosition(V());
  const axes=['L','R'].flatMap(sd=>[[b('LowerArm'+sd),b('Wrist'+sd)],[b('Wrist'+sd),b('Middle1'+sd)]]),p=V();
  h.traverse(o=>{if(!o.isSkinnedMesh)return;const si=o.geometry.attributes.skinIndex,sw=o.geometry.attributes.skinWeight,bones=o.skeleton.bones;
   for(let i=0;i<si.count;i+=2){let best=0,bw=-1;for(let j=0;j<4;j++){const w=sw.getComponent(i,j);if(w>bw){bw=w;best=si.getComponent(i,j);}}
    if(!/^(UpperLeg|LowerLeg)/.test(bones[best]?.name??''))continue;o.getVertexPosition(i,p);o.localToWorld(p);
    for(const [a,e] of axes)clear=Math.min(clear,toSeg(p,a,e));}});
  let prop=null;h.traverse(o=>{if(o.name==='activity prop: food')prop=o;});
  if(prop?.visible){shown++;nearest=Math.min(nearest,V().setFromMatrixPosition(prop.matrixWorld).distanceTo(b('Head')));}
 }
 out[`${t.name}/${k}`]={clear:+clear.toFixed(3),shown:`${shown}/${n}`,foodToHead:+nearest.toFixed(2)};
 if(!(clear>=CLEAR))fails.push(`${t.name} ${k}: a leg vertex ${clear.toFixed(3)} m from a forearm axis (arm through the leg)`);
 if(shown!==n)fails.push(`${t.name} ${k}: food drawn in ${shown}/${n} frames`);
 if(!(nearest<0.25))fails.push(`${t.name} ${k}: the food never comes up to the face (${nearest.toFixed(2)} m from the head)`);
}
console.log(JSON.stringify(out));if(fails.length){console.log(fails.join('\n'));process.exit(1);}console.log('eat pose cpu PASS');
