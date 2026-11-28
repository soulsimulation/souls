import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {fileURLToPath} from 'node:url';
import * as THREE from 'three';
import {GLTFLoader} from 'three/addons/loaders/GLTFLoader.js';
import {V2Bridge} from './bridge.ts';
import {entityWithLook,defaultLookOf} from './take-bodies.ts';
import {sampleTake} from '../../../../mars/viewer/engine/take/replay.ts';
import type {Take} from '../../../../mars/viewer/engine/take/types.ts';
import {TakePeople} from '../../../../mars/viewer/app/engine-view/take-replay.ts';
import {HumanViews,setHumanGround,type SampledHuman} from '../../../../mars/viewer/app/engine-view/humans.ts';
import {templateFromGltf,type Template} from '../../../../mars/viewer/app/engine-view/people.ts';
import {CHARACTER_WIRE} from '../../../../mars/viewer/app/engine-view/character-wire.ts';

const Q=2**30,T0=1_000_000_000_000,E=entityWithLook('v2_b_7',defaultLookOf('b.7'));
function projection({posture='stand',limbs=['souls:hand-left','souls:eyes'],target:stringTarget='question.a' as string|null,retarget=false,cut=false,futureTarget=false}={}) {
  const b=new V2Bridge({rulesVersion:'point-aim/1'}),node=(id:string,parent:string|null,pos:number[],extra={})=>({id,parent,pos:pos as [number,number,number],kind:'souls:place@1',slot:null,rot:[Q,0,0,0] as [number,number,number,number],at:null,...extra});
  const kind='fixture:station@1';
  b.receive({t:'snapshot',s:{nodes:[node('w.0',null,[0,0,0]),node('p.1','w.0',[0,0,4_000_000],{kind,rot:[0,0,Q,0]}),
    node('k.1',null,[0,0,0],{kind:'souls:kind@1',defines:kind,entry:new TextEncoder().encode(JSON.stringify({owner:'thing',slots:{place:{admits:'body',at_mm:[0,posture==='sit'?450:100,-350],posture}}}))}),
    node('question.a','w.0',[3_000_000,0,3_000_000],{at:futureTarget?T0+1_200_000:null}),node('question.b','w.0',[-3_000_000,0,3_000_000]),
    node('b.7','p.1',[0,0,0],{kind:'souls:body@1',soul:'fixture-presenter',slot:1,at:T0})],removed:[]}});
  for(let n=0;n<19;n++)b.receive({t:'part',p:{number:n,from:T0+n*500_000,to:T0+(n+1)*500_000,nodes:[],removed:[],samples:[],
    moves:n===2?[{body:'b.7',name:'souls:point',target:stringTarget,limbs,contact:'souls:argument',run:'first',start:T0+1_000_000,ends:[T0+1_300_000,T0+1_800_000]}]
      :retarget&&n===3?[{body:'b.7',name:'souls:point',target:'question.b',limbs:['souls:hand-right'],run:'second',start:T0+1_500_000,ends:[T0+1_800_000,T0+2_300_000]}]
      :retarget&&n===5?[{body:'b.7',name:'souls:clap',target:null,run:'next',start:T0+2_500_000,ends:[T0+3_500_000]}]:[],
    ...((retarget||cut)&&n===3?{runEnds:[{body:'b.7',run:'first',at:T0+1_500_000}]}:{})}});
  const takes=b.view.takes.chunks.map(c=>c.take as unknown as Take);
  const takeAt=(seconds:number)=>takes.find(t=>t.startTick<=T0/50_000+seconds/.05&&T0/50_000+seconds/.05<t.startTick+t.ticks)!;
  const at=(seconds:number)=>{const t=takeAt(seconds);return sampleTake(t,(T0/50_000-t.startTick)*.05+seconds).entities[E];};
  return {takes,takeAt,at};
}
async function template(name:'casual'|'woman') {
  const dir=process.env.HUMAN_RIG_DIR??fileURLToPath(new URL('../../../../mars/viewer/public/modular/environment/',import.meta.url));
  const loader=new GLTFLoader();loader.register(()=>({name:'point-test-material',loadMaterial:async()=>new THREE.MeshStandardMaterial()}));
  const load=async(file:string)=>{const bytes=await readFile(dir+'/'+file);return loader.parseAsync(bytes.buffer.slice(bytes.byteOffset,bytes.byteOffset+bytes.byteLength),'');};
  const wire=CHARACTER_WIRE[name],mesh=await load(wire.mesh),clips=await load(wire.clips);mesh.animations=clips.animations;return templateFromGltf(name,mesh);
}
function player(f:ReturnType<typeof projection>,source:Template) {
  const p=new TakePeople(f.takes[0]);p.setTemplates([source]);p.setWaterHistory(f.takes);
  const views=(p as unknown as {humans:HumanViews}).humans,frames:SampledHuman[][]=[];
  const original=views.setFrame.bind(views);views.setFrame=(samples,...args)=>{frames.push(structuredClone(samples));return original(samples,...args);};
  const show=(seconds:number)=>{const t=f.takeAt(seconds);p.setTake(t);p.setWaterHistory(f.takes);p.show((T0/50_000-t.startTick)*.05+seconds,seconds);return frames.at(-1)!.find(x=>x.id===E)!;};
  return {p,views,show,frames,clear:()=>views.clear()};
}
const maxDelta=(a:ReturnType<HumanViews['meshPoints']>,b:ReturnType<HumanViews['meshPoints']>)=>Math.max(...a.map((x,i)=>Math.hypot(...x.p.map((n,j)=>n-b[i].p[j]))));

test('point metadata preserves exact selected resource, target, phases and cut without mutating published takes',()=>{
  const f=projection({cut:true}),before=JSON.stringify(f.takeAt(1.2));
  assert.deepEqual(f.at(1.2).state.pointAim,{target:'question.a',at:[3,3],hand:'left',start:T0+1_000_000,ends:[T0+1_300_000,T0+1_800_000],contact:'souls:argument',run:'first',cut:T0+1_500_000});
  assert.equal(f.at(2.1).state.pointAim,null);assert.equal(JSON.stringify(f.takeAt(1.2)),before);
  for(const options of [{limbs:[]},{limbs:['souls:hand-left','souls:hand-right']},{target:null},{target:'not-public'},{futureTarget:true}])assert.equal(projection(options).at(1.6).state.pointAim,null,'unknown or future association retains legacy');
});

test('real bridge to TakePeople aims the recorded arm at the named target while preserving slot/seat roots and legs',async t=>{
  setHumanGround(()=>0);
  try {for(const name of ['casual','woman'] as const)for(const posture of ['stand','sit'])await t.test(name+' '+posture,async()=>{
    const f=projection({posture}),source=await template(name),r=player(f,source);
    try {
      const sample=r.show(1.6),diag=r.views.bones(E)[E],arm=diag.arms.find(a=>a.side==='left')!;
      assert(arm.target,'actual selected arm goal');
      const expected=new THREE.Vector2(3-arm.shoulder[0],3-arm.shoulder[2]).normalize(),actual=new THREE.Vector2(arm.palm[0]-arm.shoulder[0],arm.palm[2]-arm.shoulder[2]).normalize();
      assert(expected.dot(actual)>.999,'actual selected palm points toward independent public target, not the slot front');
      assert(Math.abs(sample.yaw+Math.PI/2)<.002,'declared slot/seat front remains authoritative');
      assert.equal(sample.pointAim?.hand,'left');assert.deepEqual(sample.pointAim?.at,[3,3]);
      const points=r.views.meshPoints(E,1),root=r.views.bodyObject(E)!.matrixWorld.toArray(),lengths=diag.arms.map(a=>a.len);
      const plain=new HumanViews();plain.setTemplates([source]);
      try {plain.setFrame([{...sample,pointAim:undefined,pointAimTime:undefined,clipOrigin:undefined}],1.6);plain.render(1);
        const legs=(p:typeof points)=>p.filter(x=>x.part==='leg'||x.part==='foot');assert(maxDelta(legs(points),legs(plain.meshPoints(E,1)))<1e-5,'every indexed lower-body point stays unchanged');
        assert.deepEqual(root,plain.bodyObject(E)!.matrixWorld.toArray(),'no root movement or yaw');assert.deepEqual(lengths,plain.bones(E)[E].arms.map(a=>a.len),'fixed arm lengths');
      }finally{plain.clear();}
      const settled=r.show(2.4);assert.equal(settled.pointAim,undefined,'normal return metadata expires');
    }finally{r.clear();}
  });}finally{setHumanGround(null);}
});

test('point retargets and cuts retain OLD targets in immutable clip origins across cold/backward/adjacent seeks',async()=>{
  const f=projection({retarget:true}),source=await template('woman'),r=player(f,source);setHumanGround(()=>0);
  try {
    const changed=r.show(1.6);assert.equal(changed.pointAim?.target,'question.b');assert.equal(changed.clipOrigin?.sample.pointAim?.target,'question.a');
    const saved=structuredClone(changed),cold=player(f,source);
    try {cold.show(1.6);const a=r.views.meshPoints(E,1),b=cold.views.meshPoints(E,1);assert(maxDelta(a,b)<1e-5,'cold retarget pose');}finally{cold.clear();}
    r.show(2.6);assert.deepEqual(changed,saved,'later activity does not mutate published origin');
    const forward=r.show(1.6);assert.equal(forward.clipOrigin?.sample.pointAim?.target,'question.a');
    const a=r.views.meshPoints(E,1);r.show(3.6);r.show(1.6);assert(maxDelta(a,r.views.meshPoints(E,1))<1e-5,'backward seek reconstructs the same target-specific skin');
    const after=r.show(2.6),history=after.clipOrigin;
    assert(history?.sample.pointAim?.target==='question.b'||history?.history?.some(s=>s.sample.pointAim?.target==='question.b'),'later clip origin keeps the old second target');
  }finally{r.clear();setHumanGround(null);}
});

test('actual selected-arm skin stays continuous at native cut, normal return and immediate target/action changes',async()=>{
  const source=await template('woman');setHumanGround(()=>0);
  try {for(const options of [{},{cut:true},{retarget:true}]){
    const f=projection(options),r=player(f,source);
    try {for(const boundary of options.retarget?[1.5,2.3,2.5]:options.cut?[1.5,2]:[1.8,2.3]){
      r.show(boundary-.00001);const before=r.views.meshPoints(E,1);r.show(boundary+.00001);
      assert(maxDelta(before,r.views.meshPoints(E,1))<.004,`existing4mm full-skin continuity bar at ${boundary}`);
      const cold=player(f,source);try{cold.show(boundary+.00001);const delta=maxDelta(cold.views.meshPoints(E,1),r.views.meshPoints(E,1));assert(delta<1e-5,`cut/return reconstructs the same cold pose ${JSON.stringify(options)} boundary ${boundary}, delta ${delta}`);}finally{cold.clear();}
    }}finally{r.clear();}
  }}finally{setHumanGround(null);}
});

test('point bearing yields to existing hand/held/paired/press owners',async()=>{
  const f=projection(),source=await template('woman'),r=player(f,source);setHumanGround(()=>0);
  try {
    const nativeHands={body:'native-owner',kindHash:'ab'.repeat(32),resources:[['souls:hand-left',2,7]] as const};
    const presentHeld={observedAt:T0,entries:[{id:'owned-cup',kind:'eden:cup@aa',parent:'native-owner',slot:7,pos:[0,0,0] as const,rot:[Q,0,0,0] as const}]};
    const base=r.show(1.6),controls:Partial<SampledHuman>[]=[{hands:{left:[.2,1.2,4.1]}},{prop:'cup'},{grip:'held'},
      {prop:'cup',nativeHands,heldEntries:presentHeld},
      {handHold:{with:'peer',hand:'left',since:0},handGameTick:30,handGameDt:.05},{rps:{start:0,shoot:20,shape:'rock'},handGameTick:30,handGameDt:.05},
      {activity:'handshake',partner:'peer'},{formPress:[{hand:'left',start:T0+1_000_000,contact:T0+1_300_000,end:T0+1_800_000}]}];
    // A bare partner id on idle is not a paired-contact owner. Keep the actual handshake above, and exercise
    // genuine held/native owners during the recorded return after the point ends, not a fabricated early idle.
    for(const owner of [...controls,...controls.filter(owner=>!owner.activity).map(owner=>({...owner,activity:'idle'}))]){const skins=[];
      const sample=owner.activity==='idle'?r.show(1.9):base;
      // Legacy prop ownership is unknown, whereas the native present/empty cases remain explicit.
      for(const enabled of [false,true]){const v=new HumanViews();v.setTemplates([source]);try{v.setFrame([{...sample,...owner,...(owner.prop&&!owner.heldEntries?{heldEntries:undefined}:{}),pointAim:enabled?sample.pointAim:undefined,pointAimTime:enabled?sample.pointAimTime:undefined,clipOrigin:undefined},
        {id:'peer',p:[.62,0,4.35],yaw:Math.PI,walk:0,walkDist:0,activity:owner.partner?'handshake':'idle',...(owner.handHold?{handHold:{with:E,hand:'right',since:0},handGameTick:30,handGameDt:.05}:{})}],sample.pointAimTime!/1e6);v.render(1);skins.push(v.meshPoints(E,1));}finally{v.clear();}}
      assert(maxDelta(skins[0],skins[1])<1e-5,`existing owner keeps its exact full skin ${JSON.stringify(owner)} delta ${maxDelta(skins[0],skins[1])}`);
    }
    const emptySkins=[];
    for(const prop of [undefined,'cup']){const v=new HumanViews();v.setTemplates([source]);try{v.setFrame([{...base,prop,nativeHands,heldEntries:{observedAt:T0,entries:[]},clipOrigin:undefined}],base.pointAimTime!/1e6);v.render(1);emptySkins.push(v.meshPoints(E,1));}finally{v.clear();}}
    assert(maxDelta(emptySkins[0],emptySkins[1])<1e-5,'known-empty native ownership suppresses a stale generic prop instead of blocking the actual point');
  }finally{r.clear();setHumanGround(null);}
});
