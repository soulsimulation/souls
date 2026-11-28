import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {fileURLToPath} from 'node:url';
import * as THREE from 'three';
import {GLTFLoader} from 'three/addons/loaders/GLTFLoader.js';
import {templateFromGltf} from './people.ts';
import {CHARACTER_WIRE} from './character-wire.ts';
import {HumanViews, setHumanGround, type SampledHuman} from './humans.ts';

// Real production skin and animation, not an ankle diagnostic or a replacement clip.
const rigDir = process.env.HUMAN_RIG_DIR ?? fileURLToPath(new URL('../../public/modular/environment/', import.meta.url));
async function template(name: string) {
  const loader = new GLTFLoader();
  loader.register(() => ({name:'gesture-test-material', loadMaterial:async()=>new THREE.MeshStandardMaterial()}));
  const read = async (file:string) => {const b=await readFile(rigDir+'/'+file);return loader.parseAsync(b.buffer.slice(b.byteOffset,b.byteOffset+b.byteLength),'');};
  const wire=CHARACTER_WIRE[name as keyof typeof CHARACTER_WIRE];
  const mesh=await read(wire.mesh), clips=await read(wire.clips);
  mesh.animations=clips.animations;
  return templateFromGltf(name,mesh);
}

type Skin = Record<string,{count:number;min:number}>;
function skin(views:HumanViews,id:string):Skin {
  const result:Skin={};
  views.bodyObject(id)!.traverse(object=>{
    const mesh=object as THREE.SkinnedMesh;
    if(!mesh.isSkinnedMesh||mesh.userData.bodyDraw)return;
    const positions=mesh.geometry.getAttribute('position'),indices=mesh.geometry.getAttribute('skinIndex'),weights=mesh.geometry.getAttribute('skinWeight');
    if(!positions||!indices||!weights)return;
    const p=new THREE.Vector3();
    for(let i=0;i<positions.count;i++) {
      let k=0;for(let j=1;j<4;j++)if(weights.getComponent(i,j)>weights.getComponent(i,k))k=j;
      const bone=mesh.skeleton.bones[indices.getComponent(i,k)]?.name??'';
      const part=/^(Foot|Toe)/.test(bone)?'foot':/^(UpperLeg|LowerLeg)/.test(bone)?'leg':null;
      const side=/L$/.test(bone)?'L':/R$/.test(bone)?'R':null;
      if(!part||!side)continue;
      mesh.getVertexPosition(i,p).applyMatrix4(mesh.matrixWorld);
      const row=result[part+side]??={count:0,min:Infinity};row.count++;row.min=Math.min(row.min,p.y);
    }
  });
  for(const part of ['footL','footR','legL','legR'])assert((result[part]?.count??0)>100,part+' must sample actual nonempty production skin');
  return result;
}

const distance=(a:ReturnType<HumanViews['meshPoints']>,b:ReturnType<HumanViews['meshPoints']>)=>Math.max(...a.map((v,i)=>Math.hypot(...v.p.map((x,j)=>x-b[i].p[j]))));

test('recorded storytelling and gesture entry, short gaps, interruption and recovery keep skin continuous',async t=>{
  const [{TakePeople},{Runtime},{Spatial},{emptyWorld,human},{TakeRecorder},{openGround}]=await Promise.all([
    import('./take-replay.ts'),import('../../engine/runtime/runtime.ts'),import('../../engine/spatial/service.ts'),
    import('../../engine/world/factory.ts'),import('../../engine/take/recorder.ts'),import('../../engine/test/frame-fixtures.ts')]);
  const scene=openGround(),world=emptyWorld('gesture-continuity',scene),id='gesture-boundary-control',body=human(id,1,-1,{yaw:.3});
  world.entities[id]=body;body.human!.baseActivity='idle';
  const runtime=new Runtime(world,new Map(),{spatial:new Spatial(scene)},[]),recorder=new TakeRecorder(runtime,{rulesVersion:'gesture-continuity'});
  const ticks=[40,51,53,58,61,72,80,83],acts=['tell-story','idle','wave','clap','nod','tell-story','point','idle'];
  for(let k=0;k<100;k++) {
    let index=-1;while(index+1<ticks.length&&k>=ticks[index+1])index++;
    body.human!.activity=index<0?'idle':acts[index];runtime.step();
  }
  const take=recorder.finish(),people=new TakePeople(take);people.setTemplates([await template('woman')]);
  const views=(people as unknown as {humans:HumanViews}).humans,frames:SampledHuman[][]=[];
  const original=views.setFrame.bind(views);
  views.setFrame=(samples,...args)=>{frames.push(structuredClone(samples));return original(samples,...args);};
  setHumanGround(()=>0);
  try {
    const boundaries=take.changes.filter(c=>c[1]===id&&c[2]==='activity'&&c[0]>1);
    assert.equal(boundaries.length,acts.length,'all changes, including the two-tick gap, are recorded');
    const draw=(seconds:number,clock:number)=>{
      people.show(seconds,clock);const sampled=frames.at(-1)!.find(p=>p.id===id)!;
      assert.deepEqual(sampled.p,[1,0,-1]);assert(Math.abs(sampled.yaw-.3)<1e-12);
      assert(views.bodyObject(id)!.position.distanceTo(new THREE.Vector3(...sampled.p))<1e-8);
      return {sampled,all:views.meshPoints(id,1),points:views.meshPoints(id,1).filter(p=>p.part==='leg'||p.part==='foot')};
    };
    const deltas:number[]=[],whole:number[]=[];
    for(const [tick,,,activity]of boundaries) {
      const boundary=tick*take.dt,clock=boundary,before=draw(boundary-1e-5,clock),after=draw(boundary+1e-5,clock);
      assert.deepEqual(after.sampled.p,before.sampled.p);assert.equal(after.sampled.yaw,before.sampled.yaw);
      assert.equal(after.sampled.activity,activity);
      assert.equal(after.sampled.prevActivity,before.sampled.activity,'actual bridge carries the outgoing activity');
      assert((after.sampled.activityAge??Infinity)<2e-5,'actual bridge carries time since the boundary');

      deltas.push(distance(before.points,after.points));whole.push(distance(before.all,after.all));
    }
    t.diagnostic('recorded transition lower-body deltas metres '+JSON.stringify(deltas));
    t.diagnostic('recorded transition whole-pose deltas metres '+JSON.stringify(whole));
    assert(whole.every(delta=>delta<.001),'whole pose must move less than1mm across a20microsecond boundary');
    // A fresh random seek must reconstruct exactly the same recorded origins as continuous playback.
    const times=[2.05,2.6,2.7,2.83,2.95,3.1,3.22,3.65,3.8,4.1];
    const continuous=new Map<number,ReturnType<HumanViews['meshPoints']>>();
    const minima:Record<string,number>={};
    for(let n=0;n<=500;n++){
      const time=n/100;people.show(time,time);if(times.includes(time))continuous.set(time,views.meshPoints(id,1));
      for(const [part,row]of Object.entries(skin(views,id)))minima[part]=Math.min(minima[part]??Infinity,row.min);
    }
    t.diagnostic('dense actual skin minima metres '+JSON.stringify(minima));
    for(const part of ['footL','footR'])assert(minima[part]>=-.0001,part+' stays within the0.1mm numerical contact budget through interpolated history; standalone positive support is tested separately');
    for(const part of ['legL','legR'])assert(minima[part]>=-.001,part+' does not penetrate the ground');
    const compactSeekMs:number[]=[];
    for(const time of times){
      const fresh=new TakePeople(take);fresh.setTemplates([await template('woman')]);
      try{const started=performance.now();fresh.show(time,time);compactSeekMs.push(performance.now()-started);const h=(fresh as unknown as {humans:HumanViews}).humans;assert(distance(continuous.get(time)!,h.meshPoints(id,1))<1e-5,'fresh seek at'+time+' must match continuous whole pose');}
      finally{fresh.dispose();}
    }
    t.diagnostic('compact fresh-seek milliseconds '+JSON.stringify(compactSeekMs));
    assert(deltas.every(delta=>delta<.001),'recorded support activation/release moves lower-body skin '+Math.max(...deltas)+' m');
  } finally {people.dispose();setHumanGround(null);}
});


test('sustained rapid changes fold exactly without recursive skeleton evaluation',async t=>{
  const [{TakePeople},{Runtime},{Spatial},{emptyWorld,human},{TakeRecorder},{openGround}]=await Promise.all([
    import('./take-replay.ts'),import('../../engine/runtime/runtime.ts'),import('../../engine/spatial/service.ts'),
    import('../../engine/world/factory.ts'),import('../../engine/take/recorder.ts'),import('../../engine/test/frame-fixtures.ts')]);
  const scene=openGround(),world=emptyWorld('rapid-clip-history',scene),id='rapid-control',body=human(id,0,0);
  world.entities[id]=body;body.human!.baseActivity='idle';
  const runtime=new Runtime(world,new Map(),{spatial:new Spatial(scene)},[]),recorder=new TakeRecorder(runtime,{rulesVersion:'rapid-clip-history'});
  let chunk=new TakeRecorder(runtime,{rulesVersion:'rapid-clip-history'});const chunks:import('../../engine/take/types.ts').Take[]=[];
  for(let tick=0;tick<645;tick++){body.human!.activity=tick<40||tick>=641?'idle':tick%2?'nod':'clap';runtime.step();if(tick===639){chunks.push(chunk.finish());chunk=new TakeRecorder(runtime,{rulesVersion:'rapid-clip-history'});}}chunks.push(chunk.finish());
  const take=recorder.finish(),people=new TakePeople(take);people.setTemplates([await template('woman')]);
  const views=(people as unknown as {humans:HumanViews}).humans,original=HumanViews.prototype.setFrame;
  let sourceEvaluations=0,maxDepth=0,depth=0,latest:SampledHuman|undefined;
  HumanViews.prototype.setFrame=function(samples,...args){
    if(this!==views){sourceEvaluations++;maxDepth=Math.max(maxDepth,++depth);}
    else latest=samples.find(sample=>sample.id===id);
    try{return original.call(this,samples,...args);}finally{if(this!==views)depth--;}
  };
  setHumanGround(()=>0);
  try{
    const time=640.1*take.dt;
    const started=performance.now();people.show(time,time);const coldMs=performance.now()-started,cold=sourceEvaluations,points=views.meshPoints(id,1);
    assert((latest?.clipOrigin?.history?.length??0)>590,'the actual sustained chain remains represented, without an arbitrary history cutoff');
    assert.equal(maxDepth,1,'source skeleton evaluations are iterative rather than recursively nested');
    const warmStart=performance.now();people.show(time,time);const warmMs=performance.now()-warmStart;assert.equal(sourceEvaluations,cold,'a warm frame reuses the complete collapsed boundary pose');
    assert(distance(points,views.meshPoints(id,1))<1e-5,'the cached collapse is the exact same whole pose');
    people.show(time+.05,time+.05);const newBoundary=sourceEvaluations-cold;
    assert.equal(newBoundary,1,'one new rapid boundary evaluates one new source, retaining the collapsed prefix');
    const retained=(views as unknown as {views:Map<string,{clipOrigins?:Map<string,unknown>}>}).views.get(id)!.clipOrigins!.size;
    assert(retained<=32,'the evaluation cache retains fixed-size poses within its existing bound');
    const rolled=new TakePeople(chunks[0]);rolled.setTemplates([await template('woman')]);
    const outer=views;const rollViews=(rolled as unknown as {humans:HumanViews}).humans;
    try{
      // Count only isolated source evaluations, not the rolled outer view.
      HumanViews.prototype.setFrame=function(samples,...args){if(this!==outer&&this!==rollViews)sourceEvaluations++;return original.call(this,samples,...args);};
      rolled.show(chunks[0].ticks*take.dt,chunks[0].ticks*take.dt);const priorCount=sourceEvaluations;
      rolled.setTake(chunks[1]);rolled.setWaterHistory(chunks);
      const rollStart=performance.now();rolled.show(.005,chunks[1].startTick*take.dt+.005);const rolloverMs=performance.now()-rollStart;
      assert.equal(sourceEvaluations,priorCount,'normal exact adjacent-window rollover preserves the collapsed source cache');
      people.show(chunks[1].startTick*take.dt+.005,chunks[1].startTick*take.dt+.005);
      assert(distance(views.meshPoints(id,1),rollViews.meshPoints(id,1))<.001,'adjacent rollover matches the full recording whole pose');
      const context=(rolled as unknown as {clipContext:object}).clipContext;
      rolled.setTake({...chunks[1],baselineStateHash:'foreign-recording'});
      assert.notEqual((rolled as unknown as {clipContext:object}).clipContext,context,'a foreign/discontinuous recording invalidates origins');
      t.diagnostic(JSON.stringify({rolloverSourceEvaluations:sourceEvaluations-priorCount,rolloverMs}));
    }finally{rolled.dispose();}
    t.diagnostic(JSON.stringify({boundaries:latest?.clipOrigin?.history?.length,coldSourceEvaluations:cold,warmSourceEvaluations:0,nextBoundaryEvaluations:newBoundary,maxEvaluationDepth:maxDepth,cachedPoses:retained,coldMs,warmMs}));
  }finally{HumanViews.prototype.setFrame=original;people.dispose();setHumanGround(null);}
});

test('recorded owner and instrument context is sampled at its boundary, never inherited from the next action',async()=>{
  const [{TakePeople},{Runtime},{Spatial},{emptyWorld,human},{TakeRecorder},{openGround}]=await Promise.all([
    import('./take-replay.ts'),import('../../engine/runtime/runtime.ts'),import('../../engine/spatial/service.ts'),
    import('../../engine/world/factory.ts'),import('../../engine/take/recorder.ts'),import('../../engine/test/frame-fixtures.ts')]);
  const scene=openGround(),world=emptyWorld('clip-owner-history',scene),id='recorded-owner',body=human(id,0,0);world.entities[id]=body;
  const runtime=new Runtime(world,new Map(),{spatial:new Spatial(scene)},[]),recorder=new TakeRecorder(runtime,{rulesVersion:'clip-owner-history'});
  for(let tick=0;tick<70;tick++){
    body.human!.activity=tick<40?'idle':tick<50?'clap':'nod';
    body.human!.instrument=tick>=40&&tick<50?'guitar':undefined;
    body.human!.handActuator=tick>=52&&tick<54?{target:'switch',at:[.2,1,0],startTick:52}:undefined;
    runtime.step();
  }
  const people=new TakePeople(recorder.finish());people.setTemplates([await template('woman')]);
  const views=(people as unknown as {humans:HumanViews}).humans,original=views.setFrame.bind(views);let sample:SampledHuman|undefined;
  views.setFrame=(samples,...args)=>{sample=samples.find(s=>s.id===id);return original(samples,...args);};
  try{
    people.show(2.56,2.56);assert.equal(sample!.instrument,undefined);assert.equal(sample!.clipOrigin!.sample.instrument,'guitar','prior instrument comes from the old record');
    assert.equal(sample!.clipOrigin!.sample.seatHeight,undefined,'an absent historical seat stays absent');
    people.show(2.66,2.66);assert(sample!.handActuator,'the actual recorder carries its native owner');assert.equal(sample!.clipOrigin,undefined,'a recorded actuator never enters the cosmetic whole-body blend');
    people.show(2.81,2.81);assert.equal(sample!.handActuator,undefined);assert.equal(sample!.activity,'nod');assert.equal(sample!.clipOrigin,undefined,'releasing an owner without an activity change cannot resume the unrelated older free origin');
    const fresh=new TakePeople(people.take);fresh.setTemplates([await template('woman')]);
    const history=(fresh as unknown as {clipOrigin(id:string,tick:number,current:SampledHuman):unknown});
    assert.equal(history.clipOrigin(id,2.81/people.take.dt,sample!),undefined,'a fresh seek sees the same recorded ownership barrier');fresh.dispose();
  }finally{people.dispose();}
});

test('dedicated seats, floor, locomotion, paired and held owners ignore upright clip history',async()=>{
  const source=await template('woman'),id='clip-owner-control';setHumanGround(()=>0);
  const controls:Partial<SampledHuman>[]=[
    {activity:'nod',baseActivity:'sit',seatHeight:.45},
    {activity:'stargaze',activityAge:2},
    {activity:'pushups',activityAge:1.2},
    {activity:'walk',walk:1,walkDist:1.3,speed:1},
    {activity:'handshake',activityAge:.7,partner:'partner'},
    {activity:'idle',prop:'cup'},
    {activity:'idle',instrument:'guitar'},
    {activity:'nod',hands:{left:[.3,1,0]}},
    {activity:'idle',handActuator:{target:'switch',at:[.2,1,0],startTick:0},handActuatorTime:.3},
    {activity:'idle',formPress:[{hand:'left',start:0,contact:250000,end:550000}]},
    {activity:'jump',activityAge:.4},
  ];
  const draw=(extra:Partial<SampledHuman>,history:boolean,speaking=false)=>{
    const views=new HumanViews();views.setTemplates([source]);
    try{
      const sample:SampledHuman={id,p:[0,0,0],yaw:.25,walk:0,walkDist:0,activity:'nod',activityAge:.1,...extra};
      if(history)sample.clipOrigin={age:.1,sample:{id,p:[0,0,0],yaw:.25,walk:0,walkDist:0,activity:'wave',activityAge:.6}};
      views.setFrame([sample,{id:'partner',p:[.85,0,0],yaw:Math.PI,walk:0,walkDist:0,activity:'handshake',activityAge:.7,partner:id}],.3);
      if(speaking)views.setSpeaking(new Set([id]));views.render(1);
      return {points:views.meshPoints(id,1),root:views.bodyObject(id)!.position.toArray(),bones:views.bones()[id]};
    }finally{views.clear();}
  };
  try{
    for(const control of controls){const a=draw(control,false),b=draw(control,true);assert(distance(a.points,b.points)<1e-5,JSON.stringify(control)+' retains its existing whole pose');assert.deepEqual(a.root,b.root);assert.deepEqual(a.bones,b.bones);}
    assert(distance(draw({},false,true).points,draw({},true,true).points)<1e-5,'live speaking is an explicit unrecorded owner and is not reconstructed from a silent origin');
  }finally{setHumanGround(null);}
});


test('epoch-clock procedural exits stay within their authored lift and recorded age',async t=>{
  const [{TakePeople},{Runtime},{Spatial},{emptyWorld,human},{TakeRecorder},{openGround},{activityFrame}]=await Promise.all([
    import('./take-replay.ts'),import('../../engine/runtime/runtime.ts'),import('../../engine/spatial/service.ts'),
    import('../../engine/world/factory.ts'),import('../../engine/take/recorder.ts'),import('../../engine/test/frame-fixtures.ts'),import('./activity-poses.ts')]);
  const clock=1795673464.302144,age=.15214385,boundary=clock-age;
  // One-off envelopes must finish at zero, never extrapolate the smoothstep polynomial after its domain.
  for(const act of ['shrug','slump','look','touch'])for(const since of [-.01,0,.175,.35,.8,1,1.5,2,3.7,4.99]){
    const f=activityFrame(act,'idle',clock,'epoch-control-1',{since})!;
    assert(f.hop>=0&&f.hop<=.03,act+' keeps its authored vertical range');
    assert(Math.abs(f.lean)<=.281&&Math.abs(f.look)<=.401,act+' keeps its authored body range');
    for(const hand of f.hands??[])for(const component of hand??[])assert(Math.abs(component)<=1,act+' keeps finite natural hand targets');
  }
  assert.equal(activityFrame('shrug','idle',clock,'epoch-control-1',{since:.5})!.hop,.03,'the held shrug profile is preserved');
  assert.equal(activityFrame('shrug','idle',clock,'epoch-control-1',{since:2})!.hop,0,'a completed envelope stays completed');
  for(const name of ['woman','casual']){
    const scene=openGround(),world=emptyWorld('epoch-gesture',scene),id='epoch-control-1',body=human(id,1,-1,{yaw:1.571});world.entities[id]=body;
    const runtime=new Runtime(world,new Map(),{spatial:new Spatial(scene)},[]),recorder=new TakeRecorder(runtime,{rulesVersion:'epoch-gesture'});
    for(let tick=0;tick<80;tick++){body.human!.activity=tick>=40&&tick<50?'shrug':'idle';runtime.step();}
    const people=new TakePeople(recorder.finish()),rig=await template(name);people.setTemplates([rig]);
    const views=(people as unknown as {humans:HumanViews}).humans;
    const idle=people.take.changes.filter(c=>c[1]===id&&c[2]==='activity').at(-1)![0]*people.take.dt;
    const draw=(time:number)=>{people.show(time,boundary+time-idle);return views.meshPoints(id,1);};
    setHumanGround(()=>0);
    try{
      let maxLift=0;const minima:Record<string,number>={};
      for(let n=0;n<=120;n++){
        draw(idle-.6+n*.01);const root=views.bodyObject(id)!.position;
        assert(Math.abs(root.x-1)<1e-8&&Math.abs(root.z+1)<1e-8,'native horizontal anchor is unchanged');
        maxLift=Math.max(maxLift,root.y);assert(root.y>=0&&root.y<=.030001,'only the authored three-centimetre hop may move the drawn holder');
        for(const [part,row] of Object.entries(skin(views,id)))minima[part]=Math.min(minima[part]??Infinity,row.min);
      }
      for(const part of ['footL','footR','legL','legR'])assert(minima[part]>=-.0001,part+' remains within the existing numerical contact budget');
      const before=draw(idle-1e-5),after=draw(idle+1e-5);t.diagnostic(JSON.stringify({name,exitDelta:distance(before,after)}));assert(distance(before,after)<.001,'recorded outgoing age keeps the whole-pose exit continuous');
      const continuous=draw(idle+age),fresh=new TakePeople(people.take);fresh.setTemplates([rig]);
      try{fresh.show(idle+age,clock);assert(distance(continuous,(fresh as unknown as {humans:HumanViews}).humans.meshPoints(id,1))<1e-5,'epoch-clock fresh seek matches continuous playback');}finally{fresh.dispose();}
      t.diagnostic(JSON.stringify({rig:name,maxLift,minima,boundaryDelta:distance(before,after)}));
    }finally{people.dispose();setHumanGround(null);}
  }
});


test('recorded wave overlap keeps its dedicated owner when the earlier tail expires',async t=>{
  const [{TakePeople},{Runtime},{Spatial},{emptyWorld,human},{TakeRecorder},{openGround}]=await Promise.all([
    import('./take-replay.ts'),import('../../engine/runtime/runtime.ts'),import('../../engine/spatial/service.ts'),
    import('../../engine/world/factory.ts'),import('../../engine/take/recorder.ts'),import('../../engine/test/frame-fixtures.ts')]);
  for(const name of ['casual','woman'])for(const gap of [16,21]){
    const scene=openGround(),world=emptyWorld('wave-owned-overlap',scene),id='wave_boundary',body=human(id,0,0);world.entities[id]=body;
    const runtime=new Runtime(world,new Map(),{spatial:new Spatial(scene)},[]),recorder=new TakeRecorder(runtime,{rulesVersion:'wave-owned-overlap'});
    for(let tick=0;tick<220;tick++){body.human!.activity=tick>=17&&tick<65||tick>=65+gap&&tick<113+gap?'wave':'idle';runtime.step();}
    const take=recorder.finish(),people=new TakePeople(take),rig=await template(name);people.setTemplates([rig]);let previous:number[][]|undefined,max=0;
    try{
      for(let tick=10;tick<210;tick++){
        people.show(tick*take.dt,tick*take.dt);const palms=people.bones(id)[id].arms.map(a=>a.palm);
        if(previous)for(let arm=0;arm<2;arm++)max=Math.max(max,Math.hypot(...palms[arm].map((n,j)=>n-previous![arm][j])));previous=palms;
        if(tick>=65+gap&&tick<=65+gap+8){
          const fresh=new TakePeople(take);fresh.setTemplates([rig]);
          try{fresh.show(tick*take.dt,tick*take.dt);assert(palms.every((p,i)=>Math.hypot(...p.map((n,j)=>n-fresh.bones(id)[id].arms[i].palm[j]))<.0003),'a fresh seek preserves the same wave-owned overlap through expiry');}finally{fresh.dispose();}
        }
      }
      assert(max<=.08,'existing wave owner keeps the unchanged 80 mm / 50 ms palm bound');t.diagnostic(JSON.stringify({rig:name,gap:gap*take.dt,maxPalmStep:max}));
    }finally{people.dispose();}
  }
});


test('nod then short wave and short idle retains the drawn pose on a second wave entry',async t=>{
  const [{TakePeople},{Runtime},{Spatial},{emptyWorld,human},{TakeRecorder},{openGround}]=await Promise.all([
    import('./take-replay.ts'),import('../../engine/runtime/runtime.ts'),import('../../engine/spatial/service.ts'),
    import('../../engine/world/factory.ts'),import('../../engine/take/recorder.ts'),import('../../engine/test/frame-fixtures.ts')]);
  const scene=openGround(),world=emptyWorld('short-wave-chain',scene),id='short-wave-chain',body=human(id,0,0);world.entities[id]=body;
  const runtime=new Runtime(world,new Map(),{spatial:new Spatial(scene)},[]),recorder=new TakeRecorder(runtime,{rulesVersion:'short-wave-chain'});
  for(let tick=0;tick<100;tick++){body.human!.activity=tick<40?'idle':tick<50?'nod':tick<52?'wave':tick<54?'idle':tick<84?'wave':'idle';runtime.step();}
  const take=recorder.finish(),people=new TakePeople(take);people.setTemplates([await template('woman')]);const views=(people as unknown as {humans:HumanViews}).humans;
  const deltas:number[]=[];try{
    for(const [tick] of take.changes.filter(c=>c[1]===id&&c[2]==='activity')){
      if(tick<1)continue;const boundary=tick*take.dt;people.show(boundary-1e-5,boundary);const before=views.meshPoints(id,1);people.show(boundary+1e-5,boundary);deltas.push(distance(before,views.meshPoints(id,1)));
    }
    t.diagnostic('short wave chain whole-pose boundary deltas metres '+JSON.stringify(deltas));assert(deltas.every(d=>d<.001),'all whole-pose boundaries retain the unchanged 1 mm limit');
  }finally{people.dispose();}
});
