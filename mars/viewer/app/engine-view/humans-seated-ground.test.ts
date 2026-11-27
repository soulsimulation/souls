import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import * as THREE from 'three';
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';
import { CHARACTER_WIRE, CHARACTER_CLIPS } from './character-wire.ts';
import { createHash } from 'node:crypto';
import { createRig, templateFromGltf, type Template } from './people.ts';
import type { HumanViews as Views, SampledHuman } from './humans.ts';
import { seatedSupportY } from './seated-ground.ts';

// An exact historical module can run the same geometry witness counterfactually, without editing either source.
const { HumanViews, setHumanGround } = await import(process.env.SEATED_HUMANS_SOURCE ?? './humans.ts') as typeof import('./humans.ts');
const rigDir = process.env.HUMAN_RIG_DIR ?? fileURLToPath(new URL('../../public/modular/environment/', import.meta.url));
const templates = new Map<string, Promise<Template>>();
function template(name: keyof typeof CHARACTER_WIRE) {
  let result = templates.get(name);
  if (!result) {
    result = (async () => {
      const loader = new GLTFLoader(), wire = CHARACTER_WIRE[name];
      const load = async (file: string, sha: string) => {
        const bytes = await readFile(rigDir + '/' + file); assert.equal(createHash('sha256').update(bytes).digest('hex'), sha);
        return loader.parseAsync(bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength), '');
      };
      const mesh = await load(wire.mesh, wire.meshSHA256); mesh.animations = (await load(wire.clips, CHARACTER_CLIPS[wire.clips].sha256)).animations;
      return templateFromGltf(name, mesh);
    })();
    templates.set(name, result);
  }
  return result;
}
function skin(views: Views, id: string) {
  const rows: { bone: string; p: THREE.Vector3 }[] = [];
  let meshes = 0;
  views.bodyObject(id)!.traverse(object => {
    const mesh = object as THREE.SkinnedMesh;
    if (!mesh.isSkinnedMesh || !mesh.userData.bodyDraw) return;
    assert(mesh.visible); meshes++;
    const g = mesh.geometry, index = g.index; assert(index, 'production draw is indexed');
    const vertices = new Set<number>();
    for (let k = g.drawRange.start; k < Math.min(index.count, g.drawRange.start + g.drawRange.count); k++) vertices.add(index.getX(k));
    const si = g.getAttribute('skinIndex'), sw = g.getAttribute('skinWeight');
    for (const i of vertices) {
      let k = 0; for (let j = 1; j < 4; j++) if (sw.getComponent(i, j) > sw.getComponent(i, k)) k = j;
      rows.push({ bone: mesh.skeleton.bones[si.getComponent(i, k)].name, p: mesh.getVertexPosition(i, new THREE.Vector3()).applyMatrix4(mesh.matrixWorld) });
    }
  });
  assert.equal(meshes, 1, 'measure the complete actual merged body draw');
  for (const side of ['L', 'R']) for (const part of ['Foot', 'LowerLeg']) assert(rows.filter(p => p.bone === part + side).length > 100, part + side + ' skin is nonempty');
  return rows;
}
function lengths(holder: THREE.Object3D) {
  return ['L', 'R'].flatMap(side => {
    const p = ['UpperLeg', 'LowerLeg', 'Foot'].map(part => holder.getObjectByName(part + side)!.getWorldPosition(new THREE.Vector3()));
    return [p[0].distanceTo(p[1]), p[1].distanceTo(p[2])];
  });
}
const separation = (a: ReturnType<typeof skin>, b: ReturnType<typeof skin>) => Math.max(...a.map((p, i) => p.p.distanceTo(b[i].p)));
const base: SampledHuman = { id: 'seated-support', p: [1, 0, -1], yaw: .25, walk: 0, walkDist: 0, activity: 'sit', baseActivity: 'sit', seatHeight: .465, activityAge: 2 };

test('reachable 465mm seats ground both actual production shoes without changing root, pelvis or leg lengths', async t => {
  setHumanGround(() => 0);
  try { for (const name of ['casual', 'punk', 'woman'] as const) {
    const source = await template(name), views = new HumanViews(); views.setTemplates([source]);
    const reference = createRig(source); reference.holder.updateMatrixWorld(true); const originalLengths = lengths(reference.holder); reference.mixer.stopAllAction();
    try { for (const activity of ['sit', 'nod', 'tell-story']) {
      views.setFrame([{ ...base, activity }], 70); views.render(1);
      const holder = views.bodyObject(base.id)!; assert.deepEqual(holder.position.toArray(), base.p);
      assert(Math.abs(views.bones()[base.id].hipY - .555) < .001, 'existing seat plus pelvis thickness stays fixed');
      lengths(holder).forEach((length, i) => assert(Math.abs(length - originalLengths[i]) < 1e-5, 'no anatomical segment stretches'));
      const points = skin(views, base.id);
      for (const side of ['L', 'R']) {
        const foot = points.filter(p => /^(Foot|Toe)/.test(p.bone) && p.bone.endsWith(side));
        const leg = points.filter(p => /^(UpperLeg|LowerLeg)/.test(p.bone) && p.bone.endsWith(side));
        const low = Math.min(...foot.map(p => p.p.y));
        t.diagnostic(name + ' ' + activity + ' ' + side + ' minimum drawn shoe ' + low);
        assert(low >= -.001 && low <= .007, name + ' ' + side + ' shoe must reach support, observed ' + low);
        assert(Math.min(...leg.map(p => p.p.y)) >= -.001, 'the lowered shin does not penetrate support: ' + Math.min(...leg.map(p=>p.p.y)));
      }
    } } finally { views.clear(); }
  } } finally { setHumanGround(null); }
});

test('recorded platforms and nearby sloping ground support reachable feet; high seats remain unreachable', async () => {
  const source = await template('woman'), views = new HumanViews(); views.setTemplates([source]);
  try {
    for (const [root, ground, seat] of [[.1, () => 0, .465], [0, (x: number) => Math.max(0, .05 * (x - 1)), .465], [0, () => 0, 1.1]] as const) {
      setHumanGround(ground); views.setFrame([{ ...base, p: [1, root, -1], seatHeight: seat }], 70); views.render(1);
      assert.deepEqual(views.bodyObject(base.id)!.position.toArray(), [1, root, -1]);
      for (const side of ['L', 'R']) {
        const foot = skin(views, base.id).filter(p => /^(Foot|Toe)/.test(p.bone) && p.bone.endsWith(side));
        const low = Math.min(...foot.map(p => p.p.y - seatedSupportY(root, ground(p.p.x))));
        if (seat === 1.1) assert(low > .1, 'a genuinely high seat keeps dangling feet instead of changing the seat or stretching');
        else assert(low >= -.001 && low <= .007, 'shoe fits actual support without descending through the platform');
      }
    }
  } finally { views.clear(); setHumanGround(null); }
});

test('seated fitting stays continuous at its own entry/exit fade endpoints and repeats on seek', async () => {
  const views = new HumanViews(); views.setTemplates([await template('woman')]); setHumanGround(() => 0);
  // This isolates the authored transition's fit. The older sit-down→sit activity
  // handoff has its own full-pose snap, recorded separately for the coordinator.
  const draw = (activity: 'sit-down' | 'stand-up', age: number) => {
    views.setFrame([{ ...base, activity, baseActivity: activity, activityAge: age }], 70 + age);
    views.render(1); assert.deepEqual(views.bodyObject(base.id)!.position.toArray(), base.p); return skin(views, base.id);
  };
  try {
    for (const [activity, end] of [['sit-down', .9], ['stand-up', .8]] as const) {
      for (const boundary of [0, end]) {
        const a = draw(activity, boundary - 1e-5), b = draw(activity, boundary + 1e-5);
        assert(separation(a, b) < .001, activity + ' fitting fade has no new contact snap');
      }
      for (const age of [.1, .4, end - .05]) for (const p of draw(activity, age)) if (/^(Foot|Toe|LowerLeg)/.test(p.bone)) assert(p.p.y >= -.001, 'entry/exit lower skin clears support');
    }
    const a = draw('sit-down', .4); draw('stand-up', .3); const b = draw('sit-down', .4);
    assert(separation(a, b) < 1e-5, 'intervening actions never seed a different seated foot origin on seek');
  } finally { views.clear(); setHumanGround(null); }
});

test('seated foot support does not retarget native hands, held objects or paired contacts', async () => {
  const views = new HumanViews(); views.setTemplates([await template('casual')]);
  const hands = { left: [1.3, 1.15, -1.2] as [number, number, number], right: [1.3, 1.15, -.8] as [number, number, number] };
  try { for (const owner of [{ hands }, { prop: 'cup' }, { handHold: { with: 'partner', hand: 'left', since: 0 } as SampledHuman['handHold'], handGameTick: 1400, handGameDt: .05 }]) {
    const draw = (ground: number) => {
      setHumanGround(() => ground);
      views.setFrame([{ ...base, ...owner }, { ...base, id: 'partner', p: [1.8, 0, -1] }], 70); views.render(1);
      if ('hands' in owner) for (const side of ['left', 'right'] as const) { const palm = new THREE.Vector3(); assert(views.palmOf(base.id, side, palm)); assert(palm.distanceTo(new THREE.Vector3(...hands[side])) < .001); }
      return skin(views, base.id).filter(p => /^(UpperArm|LowerArm|Wrist|Index|Middle|Ring|Pinky|Thumb)/.test(p.bone));
    };
    const a = draw(0), b = draw(.05); assert(a.length > 1000); assert(separation(a, b) < 1e-5, 'lower support changes cannot acquire an existing hand/contact owner');
  } } finally { views.clear(); setHumanGround(null); }
});

test('the procedural fallback preserves an intentional crossed leg and grounds its support leg', async () => {
  const source = await template('casual');
  const fallback = { ...source, gltf: { ...source.gltf, animations: source.gltf.animations.filter(a => !a.name.startsWith('Sitting_')) } };
  const views = new HumanViews(); views.setTemplates([fallback]); setHumanGround(() => 0);
  try {
    let crossed = false;
    for (const id of ['cross-0', 'cross-1', 'cross-2', 'cross-3']) {
      views.setFrame([{ ...base, id }], 70); views.render(1);
      const points = skin(views, id), minimum = (side: string) => Math.min(...points.filter(p => /^(Foot|Toe)/.test(p.bone) && p.bone.endsWith(side)).map(p => p.p.y));
      assert(minimum('L') >= -.001 && minimum('L') <= .007, 'the support foot reaches the floor');
      if (minimum('R') > .1) { crossed = true; break; }
    }
    assert(crossed, 'a deterministic crossed-leg variant remains intentionally raised');
  } finally { views.clear(); setHumanGround(null); }
});

// Ordinary v2 body samples feed the existing chunk adapter and production replay.
const { chunkOf, TICK_US } = await import('../../../../apps/web/src/v2-engine/takes.ts');
const { TakePeople } = await import(process.env.SEATED_REPLAY_SOURCE ?? './take-replay.ts') as typeof import('./take-replay.ts');
import type { Take } from '../../engine/take/types.ts';
const takeBody = (seat: number, root: number, interruptions = false) => {
  const at = (s: number) => (100 + s) * 1e6;
  const sample = (s: number, sitting: boolean) => ({ at: at(s), p: [1000, root * 1000, -1000] as [number, number, number], ...(sitting ? { seat: { height: seat * 1000, lie: false, heading: .25 } } : {}) });
  return { entity: base.id, soul: 'source-test', name: 'Seat source', heading: .25,
    samples: interruptions ? [sample(0,false),sample(1,true),sample(1.3,false),sample(1.5,true),sample(4,false),sample(6,false)] : [sample(0,false),sample(1,true),sample(4,false),sample(6,false)],
    gestures: [{ start: at(2.3), end: at(2.5), activity: 'nod' }, { start: at(2.55), end: at(2.8), activity: 'tell-story' }, { start: at(4.15), end: at(4.6), activity: 'clap' }]
  };
};
const takeOf = (seat: number, root: number, interruptions = false, fromTick = 100e6 / TICK_US, ticks = 120) => chunkOf([takeBody(seat,root,interruptions)], fromTick, { rulesVersion: 'seat-source-test/1', datetime: '2026-01-01T00:00:00.000Z' }, ticks).take as unknown as Take;

test('actual v2 take history preserves seated completion and gesture handoffs on drawn production skin', async t => {
  setHumanGround(() => 0);
  try { for (const [name, seat, root] of [['casual',.25,0],['woman',.465,0],['punk',1.1,0],['woman',.465,.1]] as const) {
    const take = takeOf(seat,root), people = new TakePeople(take), source=await template(name); people.setTemplates([source]);
    const reference=createRig(source);reference.holder.updateMatrixWorld(true);const expectedLengths=lengths(reference.holder);reference.mixer.stopAllAction();
    const views=(people as unknown as {humans:Views}).humans;
    let sampled:SampledHuman;const set=views.setFrame.bind(views);views.setFrame=(f,...args)=>{sampled=f[0];return set(f,...args);};
    const draw = (seconds: number) => { people.show(seconds,100+seconds); assert.deepEqual(views.bodyObject(base.id)!.position.toArray(),base.p.map((v,i)=>i===1?root:v)); return skin(views,base.id); };
    try {
      const deltas=[];
      for (const boundary of [1,1.9,2.3,2.5,2.55,2.8,4,4.8]) {
        const before=draw(boundary-1e-5), after=draw(boundary+1e-5), delta=separation(before,after);deltas.push(delta);
        if(delta>=.001)t.diagnostic(JSON.stringify({boundary,largest:before.map((p,i)=>({bone:p.bone,delta:p.p.distanceTo(after[i].p),before:p.p.toArray(),after:after[i].p.toArray()})).sort((a,b)=>b.delta-a.delta).slice(0,3),beforeLow:Math.min(...before.map(p=>p.p.y)),afterLow:Math.min(...after.map(p=>p.p.y))}));
        assert(delta<.001,name+' '+seat+' boundary '+boundary+' delta '+delta);
      }
      t.diagnostic(JSON.stringify({name,seat,root,deltas}));
      draw(4.45);assert.equal(sampled!.seatHeight,undefined,'departed current seat stays absent');assert.equal(sampled!.seatOrigin?.height,seat,'the original recorded seat remains available after the upright fade expires');
      let lengthError=0,attachmentError=0;
      for (let at=1;at<=5.1;at+=.05) {
        const points=draw(at);lengths(views.bodyObject(base.id)!).forEach((n,i)=>{lengthError=Math.max(lengthError,Math.abs(n-expectedLengths[i]));});
        const rig=(views as unknown as {views:Map<string,{legs:{foot:THREE.Object3D;lower:THREE.Object3D}[];ankle:THREE.Vector3[]}>}).views.get(base.id)!;
        rig.legs.forEach((leg,i)=>{attachmentError=Math.max(attachmentError,leg.foot.getWorldPosition(new THREE.Vector3()).distanceTo(leg.lower.localToWorld(rig.ankle[i].clone())));});
        for(const side of ['L','R']) for(const part of ['Foot','Toe','LowerLeg']) {
          const rows=points.filter(p=>p.bone.startsWith(part)&&p.bone.endsWith(side));
          if(rows.length)assert(Math.min(...rows.map(p=>p.p.y-root))>=-.001,name+' '+part+side+' penetrates at '+at);
        }
      }
      t.diagnostic(JSON.stringify({name,seat,maxLengthError:lengthError,maxAnkleJointGap:attachmentError}));
      assert(attachmentError<.001,'the actual shoe origin must meet its anatomical shin endpoint, gap '+attachmentError);
      assert(lengthError<.001,'seated interpolation must retain attached fixed-length legs, error '+lengthError);
    } finally { views.clear(); }
  } } finally { setHumanGround(null); }
});

test('actual seat cancellation, immediate re-entry, following gesture and fresh seeks use the same immutable origins', async t => {
  setHumanGround(()=>0);
  const take=takeOf(.465,0,true), source=await template('woman'), people=new TakePeople(take);people.setTemplates([source]);
  const views=(people as unknown as {humans:Views}).humans;
  const draw=(seconds:number)=>{people.show(seconds,100+seconds);return skin(views,base.id);};
  try {
    const deltas=[];
    for(const at of [1,1.3,1.5,1.9,2.3,2.5,2.55,2.8,4,4.15,4.6,4.8]){
      const delta=separation(draw(at-1e-5),draw(at+1e-5));deltas.push(delta);if(delta>=.001){const a=draw(at-1e-5),b=draw(at+1e-5);t.diagnostic(JSON.stringify({at,largest:a.map((p,i)=>({bone:p.bone,delta:p.p.distanceTo(b[i].p)})).sort((a,b)=>b.delta-a.delta).slice(0,3)}));}assert(delta<.001,'interrupted boundary '+at+' delta '+delta);
    }
    t.diagnostic(JSON.stringify({deltas}));
    for(const at of [1.12,1.3,1.42,1.5,1.73,2.49,2.57,4.17,4.6,4.95]){
      const continuous=draw(at),fresh=new TakePeople(take);fresh.setTemplates([source]);
      try{fresh.show(at,100+at);assert(separation(continuous,skin((fresh as unknown as {humans:Views}).humans,base.id))<1e-5,'fresh seek '+at);}
      finally{(fresh as unknown as {humans:Views}).humans.clear();}
      for(const p of continuous)if(/^(Foot|Toe|LowerLeg)/.test(p.bone))assert(p.p.y>=-.001,'interruption shoe/cuff support '+at);
    }
  }finally{views.clear();setHumanGround(null);}
});

test('retained adjacent native take chunks give fresh seat exits the same exact origin',async()=>{
 const chunks=Array.from({length:6},(_,i)=>takeOf(1.1,.1,true,2000+i*20,20));
 const full=new TakePeople(takeOf(1.1,.1,true)),source=await template('punk');full.setTemplates([source]);setHumanGround(()=>0);
 try{for(const at of [1.12,1.42,1.73,2.49,2.57,4.17,4.6,4.95]){
   full.show(at,100+at);const expected=skin((full as unknown as {humans:Views}).humans,base.id);
   const index=Math.floor(at),part=new TakePeople(chunks[index]);part.setWaterHistory(chunks);part.setTemplates([source]);
   try{part.show(at-index,100+at);assert(separation(expected,skin((part as unknown as {humans:Views}).humans,base.id))<1e-5,'exact chunk origin at '+at);}
   finally{(part as unknown as {humans:Views}).humans.clear();}
 }}finally{(full as unknown as {humans:Views}).humans.clear();setHumanGround(null);}
});

test('actual held props and direct native hands retain seated continuity and authoritative contact',async t=>{
 setHumanGround(()=>0);const source=await template('woman');
 const native={left:[1300,1150,-1200],right:[1300,1150,-800]};
 try{for(const owner of ['hands','prop'] as const){
  const take=takeOf(.465,0,true);take.changes.push([0,base.id,owner==='prop'?'prop':'hands',owner==='prop'?'cup':native]);take.changes.sort((a,b)=>a[0]-b[0]);
  const people=new TakePeople(take);people.setTemplates([source]);const views=(people as unknown as {humans:Views}).humans;
  const reference=createRig(source);reference.holder.updateMatrixWorld(true);const anatomical=lengths(reference.holder);reference.mixer.stopAllAction();
  const draw=(at:number)=>{people.show(at,100+at);assert.deepEqual(views.bodyObject(base.id)!.position.toArray(),base.p);
   lengths(views.bodyObject(base.id)!).forEach((length,i)=>assert(Math.abs(length-anatomical[i])<.001,owner+' fixed anatomical segment '+i));
   const rig=(views as unknown as {views:Map<string,{legs:{foot:THREE.Object3D;lower:THREE.Object3D}[];ankle:THREE.Vector3[]}>}).views.get(base.id)!;
   rig.legs.forEach((leg,i)=>assert(leg.foot.getWorldPosition(new THREE.Vector3()).distanceTo(leg.lower.localToWorld(rig.ankle[i].clone()))<.001,owner+' attached shoe/shin endpoint'));
   if(owner==='hands')for(const side of ['left','right']as const){const p=new THREE.Vector3();assert(views.palmOf(base.id,side,p));assert(p.distanceTo(new THREE.Vector3(...native[side].map(n=>n/1000)))<.001,'native '+side+' target retains exact authority');}
   else{const prop=(views as unknown as {views:Map<string,{prop?:{obj:THREE.Object3D}}>}).views.get(base.id)!.prop;assert(prop?.obj.visible,'the held prop remains drawn');const palm=new THREE.Vector3();assert(views.palmOf(base.id,'right',palm));assert(prop.obj.getWorldPosition(new THREE.Vector3()).distanceTo(palm)<1e-5,'prop stays attached to the final drawn palm');}
   return skin(views,base.id);
  };
  try{
   const deltas=[];for(const at of [1,1.3,1.5,2.3,2.5,2.55,2.8,4,4.15,4.6,4.8]){const a=draw(at-1e-5),b=draw(at+1e-5),delta=separation(a,b);deltas.push(delta);if(delta>=.001)t.diagnostic(JSON.stringify({owner,at,largest:[...new Map(a.map((p,i)=>({bone:p.bone,delta:p.p.distanceTo(b[i].p)})).sort((a,b)=>b.delta-a.delta).map(p=>[p.bone,p])).values()].slice(0,15)}));assert(delta<.001,owner+' handoff '+at+' delta '+delta);}
   t.diagnostic(JSON.stringify({owner,deltas}));
   for(const at of [1.12,1.42,1.73,2.49,2.57,4.17,4.6,4.85,4.95]){const expected=draw(at),fresh=new TakePeople(take);fresh.setTemplates([source]);try{fresh.show(at,100+at);assert(separation(expected,skin((fresh as unknown as {humans:Views}).humans,base.id))<1e-5,owner+' fresh seek '+at);}finally{(fresh as unknown as {humans:Views}).humans.clear();}
    for(const p of expected)if(/^(Foot|Toe|LowerLeg)/.test(p.bone))assert(p.p.y>=-.001,owner+' shoe/cuff support '+at);
   }
   draw(3);assert(Math.abs(views.bones()[base.id].hipY-.555)<.001,'native hands retain the recorded465mm seat instead of a default');
  }finally{views.clear();}
 }}finally{setHumanGround(null);}
});


test('actual seated active and cancelled form presses keep their selected hand owner through phase boundaries and seeks',async t=>{
 const {armLen}=await import('./rig.ts');
 const source=await template('woman');setHumanGround(()=>0);
 const at=(seconds:number)=>(100+seconds)*1e6;
 try{for(const cancelled of [false,true]){
  const body=takeBody(.465,0,cancelled);
  const presses=[.75,3.75].map(start=>({start:at(start),end:at(start+(cancelled?.37:.8)),activity:'operate',press:{hand:'left' as const,start:at(start),contact:at(start+.25),end:at(start+.8)}}));
  body.gestures=[...body.gestures,...presses].sort((a,b)=>a.start-b.start);
  const take=chunkOf([body],2000,{rulesVersion:'seat-source-test/1',datetime:'2026-01-01T00:00:00.000Z'},120).take as unknown as Take;
  const people=new TakePeople(take);people.setTemplates([source]);const views=(people as unknown as {humans:Views}).humans;
  const draw=(time:number)=>{people.show(time,100+time);assert.deepEqual(views.bodyObject(base.id)!.position.toArray(),base.p);return skin(views,base.id);};
  try{
   for(const time of [1,4]){
    draw(time);const rig=(views as unknown as {views:Map<string,{arms:import('./rig.ts').Arm[]}>}).views.get(base.id)!;const arm=rig.arms.find(a=>a.upper.name.endsWith('L'))!;assert(arm);
    const shoulder=arm.upper.getWorldPosition(new THREE.Vector3()),fwd=new THREE.Vector3(Math.cos(.25),0,Math.sin(.25)),right=new THREE.Vector3(-Math.sin(.25),0,Math.cos(.25));
    const target=shoulder.clone().add(fwd.multiplyScalar(.6).addScaledVector(right,.18).add(new THREE.Vector3(0,-.3,0)).clampLength(0,armLen(arm)*.98));
    const palm=new THREE.Vector3();assert(views.palmOf(base.id,'left',palm));const error=palm.distanceTo(target);t.diagnostic(JSON.stringify({cancelled,time,contactError:error}));assert(error<.001,'selected press contact cannot be diluted by the seat blend: '+error);
   }
   for(const time of [1,1.12,1.3,1.5,1.55,1.9,4,4.12,4.55,4.8]){const change=separation(draw(time-1e-5),draw(time+1e-5));assert(change<.001,'press seated full-skin boundary '+time+' delta '+change);}
   for(const time of [1.01,1.12,1.25,1.42,1.52,1.92,4.01,4.12,4.25,4.52,4.95]){const expected=draw(time),fresh=new TakePeople(take);fresh.setTemplates([source]);try{fresh.show(time,100+time);assert(separation(expected,skin((fresh as unknown as {humans:Views}).humans,base.id))<1e-5,'press fresh seek '+time);}finally{(fresh as unknown as {humans:Views}).humans.clear();}
    for(const p of expected)if(/^(Foot|Toe|LowerLeg)/.test(p.bone))assert(p.p.y>=-.001,'press shoe/cuff support '+time);
   }
  }finally{views.clear();}
 }}finally{setHumanGround(null);}
});
