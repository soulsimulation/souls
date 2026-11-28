import {test} from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {readFile} from 'node:fs/promises';
import {createHash} from 'node:crypto';
import {fileURLToPath} from 'node:url';
import {registerHooks} from 'node:module';
import * as THREE from 'three';
import {GLTFLoader} from 'three/addons/loaders/GLTFLoader.js';
import {WorldModel,coreLibrary} from '@souls/world-compiler';
import {HumanViews,setHumanGround,type SampledHuman} from './humans.ts';
import {templateFromGltf} from './people.ts';
import {TakePeople} from './take-replay.ts';
import {chunkOf} from '../../../../apps/web/src/v2-engine/takes.ts';
import type {Take} from '../../engine/take/types.ts';
import {CHARACTER_WIRE} from './character-wire.ts';
import {CreatorKinds,setHeldKinds,entityId} from '../../../../apps/web/src/v2-engine/creator-kinds.ts';
import '../../../../apps/web/src/gen-mesh/kit.mesh.ts';

const Q=2**30;
test('canonical held quantity, owner and arrival controls follow production palms without moving the rig',async()=>{
  const dir=process.env.HUMAN_RIG_DIR??fileURLToPath(new URL('../../public/modular/environment/',import.meta.url));
  const manifest=JSON.parse(readFileSync(new URL('../../../../tools/assets/manifest.json',import.meta.url),'utf8'));
  const loader=new GLTFLoader(); // Production texture-free GLBs retain their real palette materials and merged draw.
  const load=async(file:string)=>{
    const bytes=await readFile(dir+'/'+file),pin=manifest.files.find((f:{path:string})=>f.path==='mars/viewer/public/modular/environment/'+file);
    assert(pin);assert.equal(createHash('sha256').update(bytes).digest('hex'),pin.sha256);
    return loader.parseAsync(bytes.buffer.slice(bytes.byteOffset,bytes.byteOffset+bytes.byteLength),'');
  };
  const wire=CHARACTER_WIRE.casual,mesh=await load(wire.mesh);mesh.animations=(await load(wire.clips)).animations;
  const template=templateFromGltf('casual',mesh),views=new HumanViews(),reference=new HumanViews();
  views.setTemplates([template]);reference.setTemplates([template]);views.setBodyTemplates(new Map([['casual',template]]));reference.setBodyTemplates(new Map([['casual',template]]));setHumanGround(()=>0);
  (globalThis as {location?:unknown}).location??=new URL('http://offline.invalid/w/fixture');
  const index=new URL('../../../../apps/web/src/gen-mesh/index.ts',import.meta.url).href;
  const hook=registerHooks({load(url,context,next){return url===index?{format:'module',shortCircuit:true,source:"export {meshFor} from './registry.ts';"}:next(url,context);}});
  const {WorldEntityLayer}=await import('../../../../apps/web/src/WorldEntityLayer.ts').finally(()=>hook.deregister());
  const layer=new WorldEntityLayer(p=>p);
  (layer as unknown as {model:WorldModel}).model=new WorldModel({constants:{ground:'land'},seed:'canonical-held'});
  (layer as unknown as {model:WorldModel}).model.library=coreLibrary();
  const bowl=JSON.parse(readFileSync(new URL('../../../../content/kinds/food/soup_bowl.json',import.meta.url),'utf8'));
  const kinds=new CreatorKinds();kinds.apply([{id:'entry:bowl',kind:'souls:kind',parent:null,defines:'eden:soup_bowl@aa',entry:new TextEncoder().encode(JSON.stringify(bowl))}],[]);setHeldKinds(kinds);
  const builds:THREE.Object3D[]=[],disposed:THREE.Object3D[]=[];
  views.setHeldPictureFactory((entry,mode)=>{const picture=layer.heldPicture(entry,mode);if(!picture)return null;if(mode==='probe')return picture;builds.push(picture.object);return {...picture,dispose(){disposed.push(picture.object);picture.dispose();}};});
  const nativeHands={body:'native-body',kindHash:'ab'.repeat(32),resources:[['souls:hand-left',2,7],['souls:hand-right',2,4]] as const};
  const sample:SampledHuman={id:'declared-body',bodyModel:'casual',p:[2,0,3],yaw:.7,walk:0,walkDist:0,activity:'sit',seatHeight:.5,baseActivity:'sit',nativeHands};
  const bones=(h:THREE.Object3D)=>{h.updateMatrixWorld(true);const out:Record<string,number[]>={};h.traverse(o=>{if((o as THREE.Bone).isBone)out[o.name]=o.matrixWorld.elements.slice();});return out;};
  const vertices=(o:THREE.Object3D)=>{let n=0;o.traverse(c=>{const mesh=c as THREE.Mesh;if(mesh.isMesh&&mesh.geometry)n+=mesh.geometry.getAttribute('position').count;});return n;};
  try{
    const drawn=(layer as unknown as {drawn:Map<string,unknown>}).drawn;
    const duplicate={id:'same-bowl',kind:'eden:soup_bowl@aa',origin:'other-origin',parent:'native-body',slot:7,pos:[0,0,0] as const,rot:[Q,0,0,0] as const,fields:{28:2}};
    drawn.set(entityId(duplicate.id),{obj:new THREE.Group()});
    try { assert.equal(layer.heldPicture(duplicate),null,'native entity drawn during handoff blocks duplicate even with a different origin'); } finally { drawn.delete(entityId(duplicate.id)); }
    const retry=layer.heldPicture(duplicate);assert(retry,'same observation can acquire canonical picture after world draw retires');retry.dispose();
    for(const soup of [2,1,0]){
      const entry={...duplicate,fields:{28:soup}},live=layer.heldPicture(entry)!;assert(live);
      const internals=layer as unknown as {geoRefs:Map<unknown,number>;geometryOwners:Map<unknown,unknown>;steamers:Map<unknown,unknown>;pours:Map<unknown,unknown>};
      const refs=[...internals.geoRefs],owners=internals.geometryOwners.size,materials=(layer.lib as unknown as{cache:Map<string,THREE.Material>}).cache;
      const materialEntries=[...materials],effects=[internals.steamers.size,internals.pours.size];let sharedDisposed=0;
      live.object.traverse(o=>{const m=o as THREE.Mesh;if(!m.isMesh)return;m.geometry.addEventListener('dispose',()=>sharedDisposed++);for(const mat of Array.isArray(m.material)?m.material:[m.material])mat.addEventListener('dispose',()=>sharedDisposed++);});
      const probe=layer.heldPicture(entry,'probe')!;assert(probe);assert.deepEqual(probe.bounds,live.bounds,'pure canonical recipe matches actual live soup '+soup);
      assert.equal(probe.object.children.length,0,'probe returns no rendered geometry');probe.dispose();probe.dispose();
      assert.deepEqual([...internals.geoRefs],refs);assert.equal(internals.geometryOwners.size,owners);assert.deepEqual([...materials],materialEntries);assert.deepEqual([internals.steamers.size,internals.pours.size],effects);assert.equal(sharedDisposed,0,'probe never disposes shared live geometry/material');live.dispose();
    }
    const counts:number[]=[];
    for(const soup of [2,1,0,2]){
      const held={observedAt:soup,entries:[{id:'same-bowl',kind:'eden:soup_bowl@aa',parent:'native-body',slot:7,pos:[0,0,0] as const,rot:[Q,0,0,0] as const,fields:{28:soup}}]};
      views.setFrame([{...sample,prop:'plate',heldEntries:held}],8999);views.render(1);
      views.setFrame([{...sample,prop:'plate',heldEntries:held}],9000);views.render(1);
      reference.setFrame([sample],9000);reference.render(1);
      const actual=bones(views.bodyObject(sample.id)!),base=bones(reference.bodyObject(sample.id)!);
      const selected=new Set<string>();views.bodyObject(sample.id)!.getObjectByName('ShoulderL')!.traverse(o=>selected.add(o.name));
      for(const [name,matrix] of Object.entries(actual)) if(!selected.has(name)) assert.deepEqual(matrix,base[name],name+' root/pelvis/feet/opposite arm preserved');
      const obj=builds.at(-1)!;assert(obj?.parent);counts.push(vertices(obj));
      const palm=views.bones(sample.id)[sample.id].arms.find(a=>a.side==='left')!.palm;
      assert(obj.localToWorld(new THREE.Vector3(.12,.06,0)).distanceTo(new THREE.Vector3(...palm))<.00009,'actual declared hand and canonical grip coincide within diagnostic rounding');
      assert.equal(views.group.children.filter(o=>builds.includes(o)).length,1,'one canonical object');
    }
    assert(counts[0]>counts[2]);assert.equal(counts[0],counts[3]);assert.equal(disposed.length,3,'quantity rebuild retires only old instances');
    views.setFrame([{...sample,heldEntries:{observedAt:10,entries:[]}}],9000);views.render(1);assert.equal(disposed.length,4,'release removes picture');
    const held={observedAt:11,entries:[{id:'same-bowl',kind:'eden:soup_bowl@aa',parent:'native-body',slot:7,pos:[0,0,0] as const,rot:[Q,0,0,0] as const,fields:{28:1}}]};
    views.setFrame([{...sample,heldEntries:held}],9000);views.render(1);assert.equal(builds.length,5,'rapid re-lift');
    const unchanged=builds.at(-1)!;
    const swapped={...nativeHands,resources:[['souls:hand-left',2,4],['souls:hand-right',2,7]] as const};
    views.setFrame([{...sample,prop:'plate',nativeHands:swapped,heldEntries:held}],9001);views.render(1);
    assert.equal(builds.at(-1),unchanged,'same entry reuses the instance after resource mapping changes');
    const remappedPalm=views.bones(sample.id)[sample.id].arms.find(a=>a.side==='right')!.palm;
    assert(unchanged.localToWorld(new THREE.Vector3(.12,.06,0)).distanceTo(new THREE.Vector3(...remappedPalm))<.00009,'cached instance follows updated declared hand');
    for (const scenario of [{activity:'idle',hand:'left',yaw:.7,rot:[Q,0,0,0]}, {activity:'sit',hand:'right',yaw:-1.1,rot:[Q,0,0,0]},
      {activity:'idle',hand:'right',yaw:1.8,rot:[0,0,Q,0]}, {activity:'sit',hand:'left',yaw:.2,rot:[0,0,Q,0]}] as const) {
      views.clear();reference.clear();
      const f={...sample,activity:scenario.activity,baseActivity:scenario.activity,yaw:scenario.yaw};
      const observation={observedAt:12,entries:[{...held.entries[0],slot:scenario.hand==='left'?7:4,rot:scenario.rot}]};
      views.setFrame([{...f,prop:'plate',heldEntries:observation}],9000);views.render(1);
      views.setFrame([{...f,prop:'plate',heldEntries:observation}],9001);views.render(1);
      reference.setFrame([f],9001);reference.render(1);
      const holder=views.bodyObject(sample.id)!,baseHolder=reference.bodyObject(sample.id)!;
      const actual=bones(holder),base=bones(baseHolder),selected=new Set<string>();
      holder.getObjectByName(scenario.hand==='left'?'ShoulderL':'ShoulderR')!.traverse(o=>selected.add(o.name));
      for(const [name,matrix] of Object.entries(actual)) if(!selected.has(name)) assert.deepEqual(matrix,base[name],name+' remains on base while selected '+scenario.hand+' holds');
      const obj=builds.at(-1)!,inverse=holder.matrixWorld.clone().invert(),box=new THREE.Box3();
      obj.traverse(o=>{const m=o as THREE.Mesh;if(!m.isMesh||m.userData.shadowProxy)return;const p=m.geometry.getAttribute('position');for(let i=0;i<p.count;i++)box.expandByPoint(new THREE.Vector3().fromBufferAttribute(p,i).applyMatrix4(m.matrixWorld).applyMatrix4(inverse));});
      let torsoFront=-Infinity,bodyVertices=0;
      holder.traverse(o=>{const m=o as THREE.SkinnedMesh;if(!m.isSkinnedMesh||!m.userData.bodyDraw||!m.visible)return;
        const g=m.geometry,index=g.index;assert(index,'submitted body is indexed');
        const materials=Array.isArray(m.material)?m.material:[m.material],drawn=new Set<number>();
        for(const group of g.groups.length?g.groups:[{start:0,count:index.count,materialIndex:0}]){
          if(!materials[group.materialIndex??0]?.visible)continue;
          const from=Math.max(group.start,g.drawRange.start),to=Math.min(group.start+group.count,g.drawRange.start+g.drawRange.count,index.count);
          for(let at=from;at<to;at++)drawn.add(index.getX(at));
        }
        const si=g.getAttribute('skinIndex'),sw=g.getAttribute('skinWeight');
        for(const i of drawn){let k=0;for(let j=1;j<4;j++)if(sw.getComponent(i,j)>sw.getComponent(i,k))k=j;
          const name=m.skeleton.bones[si.getComponent(i,k)]?.name??'';if(/Arm|Wrist|Hand|Thumb|Index|Middle|Ring|Pinky|Shoulder/.test(name))continue;
          const point=m.getVertexPosition(i,new THREE.Vector3()).applyMatrix4(m.matrixWorld).applyMatrix4(inverse);bodyVertices++;
          if(point.y>=box.min.y&&point.y<=box.max.y&&point.z>=box.min.z&&point.z<=box.max.z)torsoFront=Math.max(torsoFront,point.x);
        }});
      assert(bodyVertices>1000);assert(torsoFront<box.min.x,scenario.activity+' '+scenario.hand+' canonical bowl clears submitted torso/leg witnesses in this steady pose');
      const palm=views.bones(sample.id)[sample.id].arms.find(a=>a.side===scenario.hand)!.palm;
      assert(obj.localToWorld(new THREE.Vector3(.12,.06,0)).distanceTo(new THREE.Vector3(...palm))<.00009);
    }
    const letter=JSON.parse(readFileSync(new URL('../../../../content/kinds/correspondence/sealed_letter.json',import.meta.url),'utf8'));
    kinds.apply([{id:'entry:letter',kind:'souls:kind',parent:null,defines:'eden:sealed_letter@bb',entry:new TextEncoder().encode(JSON.stringify(letter))}],[]);
    views.clear();
    const letterHeld={observedAt:20,entries:[{...held.entries[0],id:'letter',kind:'eden:sealed_letter@bb',slot:4,fields:{}}]};
    const letterFrame={...sample,activity:'idle',baseActivity:'idle',prop:'letter',heldEntries:letterHeld};
    views.setFrame([letterFrame],9000);views.render(1);views.setFrame([letterFrame],9001);views.render(1);
    const letterObject=builds.at(-1)!;assert(letterObject.parent,'actual non-food canonical mesh uses the same provider');
    const right=views.bones(sample.id)[sample.id].arms.find(a=>a.side==='right')!.palm;
    assert(letterObject.localToWorld(new THREE.Vector3(0,.12,0)).distanceTo(new THREE.Vector3(...right))<.00009,'declared right hand, not legacy prop side');
    views.clear();reference.clear();
    const noLegacy={...sample,activity:'idle',baseActivity:'idle',heldEntries:letterHeld};
    views.setFrame([noLegacy],9000);views.render(1);reference.setFrame([{...noLegacy,heldEntries:undefined}],9000);reference.render(1);
    assert.deepEqual(bones(views.bodyObject(sample.id)!),bones(reference.bodyObject(sample.id)!),'canonical kind without legacy prop begins at attained base arm pose');
    const firstPalm=views.bones(sample.id)[sample.id].arms.find(a=>a.side==='right')!.palm;
    views.setFrame([noLegacy],9000.2);views.render(1);const midPalm=views.bones(sample.id)[sample.id].arms.find(a=>a.side==='right')!.palm;
    views.setFrame([noLegacy],9001);views.render(1);const lastPalm=views.bones(sample.id)[sample.id].arms.find(a=>a.side==='right')!.palm;
    assert(new THREE.Vector3(...midPalm).distanceTo(new THREE.Vector3(...firstPalm))>.001,'arrival progresses through carry ease');
    assert(new THREE.Vector3(...midPalm).distanceTo(new THREE.Vector3(...lastPalm))>.001,'arrival is not full weight at mid ease');
    const waving={...noLegacy,activity:'wave',since:1};
    views.setFrame([waving],9002);views.render(1);reference.setFrame([{...waving,heldEntries:undefined}],9002);reference.render(1);
    assert.deepEqual(bones(views.bodyObject(sample.id)!),bones(reference.bodyObject(sample.id)!),'active wave keeps limb pose while canonical object follows its palm');
    assert(builds.at(-1)?.parent,'wave retains actual object rather than generic replacement');
    views.setFrame([{...waving,heldArmKnown:true,heldArmOrigin:{at:1,age:.1,hands:['right'],sample:{...noLegacy,heldEntries:{observedAt:0,entries:[]}}}}],9002);views.render(1);
    assert.deepEqual(bones(views.bodyObject(sample.id)!),bones(reference.bodyObject(sample.id)!),'active clip owner also wins over an observed held-arm origin');
    const priorDisposed=disposed.length,priorBuilds=builds.length;
    views.setFrame([{...sample,nativeHands:undefined,prop:'plate',heldEntries:held}],9000);views.render(1);assert.equal(disposed.length,priorDisposed+1,'unknown default metadata cannot attach');
    views.setFrame([{...sample,heldEntries:held,hands:{left:[2,1,3]}}],9000);views.render(1);assert.equal(builds.length,priorBuilds,'native hand owner wins');
    // The ordinary take path, with display clock intentionally unrelated to world time.
    const observed=(at:number,soup?:number,slot=7)=>({observedAt:at,entries:soup===undefined?[]:[{id:'same-bowl',kind:'eden:soup_bowl@aa',parent:'native-body',slot,pos:[0,0,0] as const,rot:[Q,0,0,0] as const,fields:{28:soup}}]});
    const skin=(holder:THREE.Object3D)=>{holder.updateMatrixWorld(true);const out:number[]=[];holder.traverse(o=>{const m=o as THREE.SkinnedMesh;if(!m.isSkinnedMesh||!m.userData.bodyDraw||!m.visible)return;const g=m.geometry,index=g.index!,materials=Array.isArray(m.material)?m.material:[m.material],seen=new Set<number>();for(const group of g.groups.length?g.groups:[{start:0,count:index.count,materialIndex:0}]){if(!materials[group.materialIndex??0]?.visible)continue;for(let i=Math.max(group.start,g.drawRange.start);i<Math.min(group.start+group.count,g.drawRange.start+g.drawRange.count,index.count);i++)seen.add(index.getX(i));}for(const i of seen)out.push(...m.getVertexPosition(i,new THREE.Vector3()).applyMatrix4(m.matrixWorld).toArray());});assert(out.length>3000);return out;};
    const close=(a:number[],b:number[],why:string,epsilon=1e-6)=>{assert.equal(a.length,b.length);let max=0;for(let i=0;i<a.length;i++)max=Math.max(max,Math.abs(a[i]-b[i]));assert(max<epsilon,why+' max='+max);};
    for(const seated of [false,true]){
      const observations=[observed(0),observed(100000,2),observed(200000,1),observed(250000),observed(300000,2),observed(400000,0),observed(450000)];
      const b={entity:sample.id,soul:'soul',name:'Person',heading:sample.yaw,samples:[{at:0,p:[2000,0,3000] as [number,number,number]}],held:[{at:100000,prop:'plate'},{at:250000,prop:null},{at:300000,prop:'plate'},{at:450000,prop:null}],heldEntries:observations,look:{family:'humanoid',model:'casual',params:{},nativeBody:'native-body',nativeKindHash:nativeHands.kindHash,nativeResources:nativeHands.resources}};
      const take=chunkOf([b],0,{rulesVersion:'held-arm-rig',datetime:null},40).take as unknown as Take;
      if(seated){take.changes.push([0,sample.id,'activity','sit'],[0,sample.id,'baseActivity','sit'],[0,sample.id,'seatHeight',.5]);take.changes.sort((a,b)=>a[0]-b[0]);}
      const create=()=>{const p=new TakePeople(take,{heldPicture:(entry,mode)=>layer.heldPicture(entry,mode)});p.setTemplates([template]);p.setBodyTemplates(new Map([['casual',template]]));return p;};
      const warm=create();try{
        for(const boundary of [.1,.25,.3,.45]){warm.show(boundary-1e-7,9000);const before=skin(warm.bodyObject(sample.id)!);warm.show(boundary,9000);close(skin(warm.bodyObject(sample.id)!),before,'submitted skin continuous '+seated+' at '+boundary,2e-5);if(boundary===.25||boundary===.45)assert.equal(warm.group.getObjectsByProperty('name','entity same-bowl').length,0,'object gone at release while arm returns');}
        for(const t of [.12,.23,.275,.325,.425,.5,.8,.12]){
          warm.show(t,9000);const cold=create();try{cold.show(t,9000);close(skin(cold.bodyObject(sample.id)!),skin(warm.bodyObject(sample.id)!),'fresh/backward seek skin '+seated+' at '+t);const a=bones(warm.bodyObject(sample.id)!),other=bones(cold.bodyObject(sample.id)!);for(const name of ['Root','Hips','FootL','FootR','UpperArmR','LowerArmR','WristR'])assert.deepEqual(a[name],other[name],name+' remains deterministic and authoritative');}finally{cold.dispose();}
        }
      }finally{warm.dispose();}
    }
    // More contributing boundaries than the bounded pose cache: no recursive/truncated chain.
    const rapid=[observed(0),...Array.from({length:45},(_,i)=>observed(50000*(i+1),i%3===2?undefined:2,i%4<2?7:4))];
    const rapidBody={entity:sample.id,soul:'soul',name:'Person',heading:sample.yaw,samples:[{at:0,p:[2000,0,3000] as [number,number,number]}],held:[],heldEntries:rapid,look:{family:'humanoid',model:'casual',params:{},nativeBody:'native-body',nativeKindHash:nativeHands.kindHash,nativeResources:nativeHands.resources}};
    const rapidTake=chunkOf([rapidBody],0,{rulesVersion:'held-arm-rapid',datetime:null},80).take as unknown as Take;
    const createRapid=()=>{const p=new TakePeople(rapidTake,{heldPicture:(entry,mode)=>layer.heldPicture(entry,mode)});p.setTemplates([template]);p.setBodyTemplates(new Map([['casual',template]]));return p;};
    const warmRapid=createRapid();try{
      for(const t of [2.245,2.255,2.245]){warmRapid.show(t,9000);const cold=createRapid();try{cold.show(t,9000);close(skin(warmRapid.bodyObject(sample.id)!),skin(cold.bodyObject(sample.id)!),'45-boundary cold/backward chain at '+t);}finally{cold.dispose();}}
      const hv=(warmRapid as unknown as{humans:{views:Map<string,{heldArmCache:Map<string,unknown>}>}}).humans;
      assert.equal(hv.views.get(sample.id)!.heldArmCache.size,32,'old prefixes evicted without changing the pose');
      for(const t of [.1,.2,2.2,2.25]){warmRapid.show(t-1e-7,9000);const before=skin(warmRapid.bodyObject(sample.id)!);warmRapid.show(t,9000);close(skin(warmRapid.bodyObject(sample.id)!),before,'rapid hand/release boundary '+t,2e-5);}
    }finally{warmRapid.dispose();}
  }finally{views.clear();reference.clear();setHeldKinds(null);layer.dispose();setHumanGround(()=>0);}
});
