import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createRequire } from 'node:module';
import { readFileSync, mkdirSync, mkdtempSync } from 'node:fs';
import { join } from 'node:path';
import { counterDrawTools, counterDrawCheckpoint, counterWorldPage, counterBrowserStop, counterFinalization, proveCounterCreator, counterBootBoard, counterSceneBoard } from './counter-match-native-page.mjs';
import { drawnLoad } from '../../playtest/carry-contact/oracle.mjs';
import { defOf } from '../../entry/look.mjs';
const THREE=createRequire(new URL('../../../mars/viewer/package.json',import.meta.url))('three');
const tools=()=>counterDrawTools({vector:()=>new THREE.Vector3(),drawnLoad});
const bootFacts=()=>({format:'souls/import-eden/1',kinds:[{ref:'core-counter_match@1',name:'core:counter_match'}],things:[{
  id:'e_fixture1',name:'counter-match',def:'core-counter_match@1',ref:'core-counter_match@1',parent:null,
  pose:[3000,0,0,0],world:[3000,0,0,0],scale_ppm:1000000}]});
function sceneFixture(){
  const boot=counterBootBoard(bootFacts()),entity={id:boot.origin,def:'core-counter_match@1',in:{parent:'world'},p:[3,0,0],r:0,by:'v2'};
  const creator={id:'e_vfixture2',def:entity.def,in:{parent:'world'},p:[12,0,12],r:0,by:'v2'};
  const model={entities:new Map([[entity.id,entity],[creator.id,creator]]),resolvedDef:()=>({ref:'core-counter_match@1',name:'core-counter_match',version:1})};
  return{boot,entity,creator,model};
}
test('public boot export maps to its exact unnamed scene origin, distinct from an unnamed creator board',()=>{
  const f=sceneFixture();assert.equal(f.boot.origin,'e_fixture1');assert.equal(counterSceneBoard(f.model,f.boot),'e_fixture1');
  assert([...f.model.entities.values()].every(e=>!('name'in e)),'stream-scene never supplies native names');
  const evaluate=Function(`return (${counterSceneBoard.toString()})`)();assert.equal(evaluate(f.model,f.boot),'e_fixture1','serialized helper cannot depend on Node closures');
});
test('boot identity rejects missing/duplicate rows and wrong canonical definition or boot pose',()=>{
  for(const mutate of [f=>f.things=[],f=>f.things.push({...f.things[0],id:'e_fixture2'}),f=>f.things[0].def='other@1',
    f=>f.kinds=[],f=>f.kinds[0].name='other:counter_match',f=>f.things[0].pose=[3001,0,0,0],f=>f.things[0].world=[3001,0,0,0]]){
    const f=bootFacts();mutate(f);assert.throws(()=>counterBootBoard(f),assert.AssertionError);
  }
});
test('scene identity rejects missing origin, mismatched ID/definition and authoritative pose',()=>{
  for(const mutate of [f=>f.model.entities.delete(f.boot.origin),f=>f.entity.id='e_other1',f=>f.entity.def='other@1',
    f=>f.model.resolvedDef=()=>({ref:'core-counter_match@1',name:'other',version:1}),f=>f.entity.p=[3.001,0,0],f=>f.entity.r=.1,
    f=>f.entity.in.parent='other',f=>f.entity.by='other']){
    const f=sceneFixture();mutate(f);assert.throws(()=>counterSceneBoard(f.model,f.boot),/counter drawn board/);
  }
});
function boardFixture(scale=1,color='#bb493e'){
  const scene=new THREE.Scene(),root=new THREE.Group();root.position.set(3,.2,-2);root.rotation.y=.7;scene.add(root);
  const fill=new THREE.Mesh(new THREE.BoxGeometry(.665,.036,.064),new THREE.MeshBasicMaterial({color:'#d9b64c'}));
  fill.userData.role='fill';fill.userData.looksRest={scale:[1,1,1]};fill.position.y=.748;fill.scale.x=scale;root.add(fill);
  const light=new THREE.Mesh(new THREE.BoxGeometry(.1,.014,.08),new THREE.MeshBasicMaterial({color}));
  light.userData.role='light';light.userData.looksRest={scale:[1,1,1]};light.position.set(0,.737,.2);root.add(light);scene.updateMatrixWorld(true);
  return{scene,root,fill,light,layer:{drawn:new Map([['table',{obj:root}]]),instancer:{pools:new Map()}}};
}

test('template projects exact current authored definition/state/table and retains the colliding top',()=>{
  const entry=JSON.parse(readFileSync(new URL('../../../content/kinds/turn_games/counter_match.json',import.meta.url)));
  const template=JSON.parse(readFileSync(new URL('../../../worlds/templates/counter-match-rehearsal.json',import.meta.url)));
  assert.deepEqual(template.batches[0].ops[0].def,defOf(entry));assert.equal(template.batches[0].ops[0].def.make.args.shapes[0].collide,true);
  assert.deepEqual(template.batches[0].ops[1],{op:'place',def:'core/counter_match@1',name:'counter-match',p:[3,0,0]});
});

test('actual submitted fill width/scale and light color survive root rotation and zero fill',()=>{
  for(const scale of [1,.857,0]){
    const f=boardFixture(scale,scale===.857?'#3d6baf':'#bb493e'),read=tools()(f.layer,f.scene,'table');
    assert(Math.abs(read.fill.spanX-.665*scale)<1e-6);assert.equal(read.fill.relativeScale[0],scale);
    assert.deepEqual(read.light.materials,[scale===.857?'3d6baf':'bb493e']);assert.equal(read.source,'visible-root');
    assert(read.fill.matrices.every(m=>m.matrix.length===16&&m.vertices>0));
  }
});

test('hidden/material-excluded/submitted-range failures cannot supply visual-state evidence',()=>{
  const f=boardFixture();f.fill.visible=false;assert.throws(()=>tools()(f.layer,f.scene,'table'),/hidden or detached/);f.fill.visible=true;
  f.light.material.visible=false;assert.throws(()=>tools()(f.layer,f.scene,'table'),/submitted geometry\/material/);f.light.material.visible=true;
  f.fill.geometry.setDrawRange(0,0);assert.throws(()=>tools()(f.layer,f.scene,'table'),/submitted geometry\/material/);
});

test('unexpected instancing validates the actual slot but fails closed without role association',()=>{
  const f=boardFixture(),mesh=new THREE.InstancedMesh(new THREE.BoxGeometry(1,1,1),new THREE.MeshBasicMaterial(),2);
  mesh.setMatrixAt(0,new THREE.Matrix4().makeTranslation(99,0,0));mesh.setMatrixAt(1,new THREE.Matrix4().makeTranslation(3,0,0));mesh.count=2;f.scene.add(mesh);f.scene.updateMatrixWorld(true);
  f.layer.drawn.set('table',{obj:new THREE.Object3D(),inst:'pool',shown:true});
  f.layer.instancer.pools.set('pool',{slots:new Map([['table',1]]),parts:[{local:new THREE.Matrix4()}],meshes:[mesh]});
  assert.throws(()=>tools()(f.layer,f.scene,'table'),/unexpected instanced role identity unavailable/);
  f.layer.instancer.pools.get('pool').slots.set('table',3);assert.throws(()=>tools()(f.layer,f.scene,'table'),/instance part unavailable/);
});

test('role roots and nested descendants reject InstancedMesh before sampling base geometry',()=>{
  for(const asRoot of [false,true]){
    const f=boardFixture(),instance=new THREE.InstancedMesh(new THREE.BoxGeometry(.665,.036,.064),new THREE.MeshBasicMaterial(),2);
    instance.count=2;instance.setMatrixAt(0,new THREE.Matrix4().makeTranslation(20,0,0));instance.setMatrixAt(1,new THREE.Matrix4().makeTranslation(-20,0,0));
    let baseReads=0;instance.getVertexPosition=()=>{baseReads++;throw Error('must not sample base geometry');};
    if(asRoot){f.root.remove(f.fill);instance.userData.role='fill';instance.userData.looksRest={scale:[1,1,1]};f.root.add(instance);}
    else f.fill.add(instance);
    f.scene.updateMatrixWorld(true);
    assert.throws(()=>tools()(f.layer,f.scene,'table'),/nested instanced role geometry unsupported/);
    assert.equal(baseReads,0,'instance count/matrices cannot be ignored in favor of base vertices');
  }
});

const sample=(n,remaining=6,turn='second')=>({tick:n*5,frame:n,currentCanvas:true,bodies:[{activity:'idle'},{activity:'idle'},{activity:'idle'}],state:{remaining,turn},board:{fill:{relativeScale:[Math.trunc(remaining*1000/7)/1000,1,1],spanX:.665*Math.trunc(remaining*1000/7)/1000},light:{materials:[turn==='first'?'bb493e':'3d6baf']}}});
test('state checkpoints reject stale clocks, stale visual fill/tint and missing people',()=>{
  assert(counterDrawCheckpoint([sample(1),sample(2)],{remaining:6,turn:'second'}));
  assert.throws(()=>counterDrawCheckpoint([sample(1),sample(1)],{remaining:6,turn:'second'}),/clock/);
  const bad=sample(2);bad.board.fill.relativeScale[0]=1;assert.throws(()=>counterDrawCheckpoint([sample(1),bad],{remaining:6,turn:'second'}),/fill scale/);
  bad.board.fill.relativeScale[0]=.857;bad.board.light.materials=['bb493e'];assert.throws(()=>counterDrawCheckpoint([sample(1),bad],{remaining:6,turn:'second'}),/turn light/);
  const missing=sample(2);missing.bodies.pop();assert.throws(()=>counterDrawCheckpoint([sample(1),missing],{remaining:6,turn:'second'}),/full group/);
});

test('public world selection rejects foreign and ambiguous pages',()=>{
  const row={name:'Counter match rehearsal',template:'counter-match-rehearsal',url:'/w/counter/'};
  assert.equal(counterWorldPage({worlds:[row]},'https://example.test'),'https://example.test/w/counter/');
  assert.throws(()=>counterWorldPage({worlds:[row,row]},'https://example.test'),/ambiguous/);
  assert.throws(()=>counterWorldPage({worlds:[{...row,url:'https://other.test/w/counter/'}]},'https://example.test'),/owned origin/);
});

const creatorKind='eden:counter_match@1220b0a7c599c29450758b906827b46e9ac0daa8154927f9d9a43c84ec525f7fab0c';
test('creator places the exact qualified registry key and reads back the public plain kind and returned identity',async()=>{
  const calls=[],creator={label:'creator',cli:async(...words)=>{calls.push(words);if(words[0]==='place')return{ok:true,sequence:7,names:{1:'returned-thing'}};
    if(words.length===1)return{ok:true,kinds:{[creatorKind]:{}},nodes:[{id:'ground',kind:'souls:ground'}]};
    return{ok:true,id:'returned-thing',kind:'eden:counter_match',in:[{id:'ground'}],at:[12,0,12]};}};
  const result=await proveCounterCreator({creator});assert.equal(result.id,'returned-thing');assert.deepEqual(calls.at(-1),['describe','returned-thing']);
  assert.deepEqual(calls.filter(w=>w[0]==='place'),[['place',creatorKind,'--in','ground','--at','12,0,12']]);
  assert.equal(result.kind,creatorKind);assert.equal(result.readbackKind,'eden:counter_match');
  const bad={...creator,cli:async(...words)=>words[0]==='place'?{ok:false,code:'place-refused'}:creator.cli(...words)};
  await assert.rejects(proveCounterCreator({creator:bad}),/place refused/);
});

test('creator plain-kind readback still rejects wrong kind, identity, parent and coordinates',async()=>{
  const correct={ok:true,id:'returned-thing',kind:'eden:counter_match',in:[{id:'ground'}],at:[12,0,12]};
  for(const changed of [{kind:'other:counter_match'},{kind:'eden:counter_match_extra'},{kind:creatorKind},{id:'another-thing'},{in:[{id:'another-ground'}]},{at:[12,0,13]}]){
    const creator={label:'creator',cli:async(...words)=>words[0]==='place'?{ok:true,sequence:7,names:{1:'returned-thing'}}:
      words.length===1?{ok:true,kinds:{[creatorKind]:{}},nodes:[{id:'ground',kind:'souls:ground'}]}:{...correct,...changed}};
    await assert.rejects(proveCounterCreator({creator}),assert.AssertionError);
  }
});

test('creator never places a plain or malformed registry key',async()=>{
  for(const key of ['eden:counter_match','eden:counter_match@revision']){
    let placed=false;const creator={label:'creator',cli:async(...words)=>{if(words[0]==='place')placed=true;return{ok:true,kinds:{[key]:{}},nodes:[{id:'ground',kind:'souls:ground'}]};}};
    await assert.rejects(proveCounterCreator({creator}),/revision-qualified kind missing/);assert.equal(placed,false);
  }
});

test('browser stop and host finalization cache failures and preserve command receipts before collection',async()=>{
  const old=globalThis.window;let stops=0;const original=()=>{},show=()=>{},prototype={show};
  try{globalThis.window={__counterDrawObserver:{samples:[{measurementMs:2}],failures:[],sampleLimit:361,prototype,show,original,stopRender:()=>stops++}};
    const result=counterBrowserStop();assert.equal(counterBrowserStop(),result);assert.equal(stops,1);assert.equal(prototype.show,original);
    const other=()=>{};window.__counterDrawObserver={samples:[],prototype:{show:other},show,original,stopRender:()=>stops++};
    assert.throws(()=>counterBrowserStop(),/ownership/);assert.throws(()=>counterBrowserStop(),/ownership/);assert.equal(stops,2);assert.equal(window.__counterDrawObserver.prototype.show,other);
  }finally{globalThis.window=old;}
  mkdirSync(new URL('../../../.local',import.meta.url),{recursive:true});const dir=mkdtempSync(new URL('../../../.local/counter-source-test-',import.meta.url).pathname);
  const state={rows:[{receipt:'kept'}],stages:[],observerInstalled:true};let calls=0;
  const page={evaluate:async()=>{calls++;assert.equal(JSON.parse(readFileSync(join(dir,'command-counter-sequence.json'))).rows[0].receipt,'kept');return undefined;}};
  counterFinalization(page,{dir},state);await assert.rejects(state.finalize(),/collector missing/);await assert.rejects(state.finalize(),/collector missing/);assert.equal(calls,1);
});


test('intermediate count scale follows integer permille truncation without rerunning the looks evaluator',()=>{
  assert(counterDrawCheckpoint([sample(1,3,'second'),sample(2,3,'second')],{remaining:3,turn:'second'}));
  const wrong=sample(2,3,'second');wrong.board.fill.relativeScale[0]=.429;wrong.board.fill.spanX=.665*.429;
  assert.throws(()=>counterDrawCheckpoint([sample(1,3,'second'),wrong],{remaining:3,turn:'second'}),/fill scale/);
  assert(counterDrawCheckpoint([sample(1,2,'first'),sample(2,2,'first')],{remaining:2,turn:'first'}));
});
