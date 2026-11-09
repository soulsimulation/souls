import {test} from 'node:test';
import assert from 'node:assert/strict';
import {WorldModel,coreLibrary,applyBatch,type Op} from '@souls/world-compiler';
import {createCampFish} from './camp-fish.ts';
import type {EdgeReceipt} from '../edge/contract.ts';
function setup(){
 const model=new WorldModel({constants:{ground:'land',extent:100},seed:'camp-cooking-controls'});model.library=coreLibrary();
 const edit=(ops:Op[])=>{const r=applyBatch(model,{ops},'god',0);assert.equal(r.result.accepted,true,JSON.stringify(r.result));};
 edit([{op:'place',def:'core/camp-grill@1',name:'grill',in:{parent:'world'},p:[0,0],state:{on:true},mode:'strict'},{op:'place',def:'core/camp-fish@1',name:'fish',in:{parent:'grill',slot:'food'},p:[0,0],mode:'strict'}]);
 const g=[...model.entities.values()].find(e=>e.name==='grill')!,fish=[...model.entities.values()].find(e=>e.name==='fish')!,body={pose:{p:[0,0,.95]},human:{}},support={kind:'resting-on',on:g.id};let denied='',refused=false,commits=0;
 const service=createCampFish({model,engine:{world:{entities:{ana:body,[fish.id]:{support}}}},levelAt:()=>0,soul:()=>({id:'s-ana',entity_id:'ana',name:'Ana'}),denied:id=>id===denied?{code:'object.private',reason:'Private'}:null,commit(ops,_note,clientRef){commits++;assert.equal(clientRef,'camp-fish:work');if(refused)return{accepted:false};edit(ops);return{accepted:true};},log(){}});
 const receipt={id:'work',soulId:'s-ana',capability:'object:'+g.id+':cook-fish',phase:'completed',endedTick:400} as EdgeReceipt;
 return{model,g,fish,body,support,service,receipt,edit,deny:(id:string)=>{denied=id;},refuse:()=>{refused=true;},commits:()=>commits};
}
test('cooking binds the actual initial fish and atomically rechecks food, support, heat, fuel, access and actor at natural completion',()=>{
 for(const scenario of['cold','fuel-used','missing','moved','replacement','native-detached','private-fish','private-grill','body-away','grill-moved','already-cooked','older','batch-refused','interrupted','no-start']){
  const x=setup();if(scenario!=='no-start')x.service.onReceipt({...x.receipt,phase:'started'});
  if(scenario==='cold')x.edit([{op:'set',id:x.g.id,state:{on:false}}]);
  if(scenario==='fuel-used')x.edit([{op:'set',id:x.g.id,state:{fuel:0}}]);
  if(scenario==='missing'||scenario==='replacement')x.edit([{op:'remove',id:x.fish.id,cascade:false}]);
  if(scenario==='replacement')x.edit([{op:'place',def:'core/camp-fish@1',name:'fish',in:{parent:x.g.id,slot:'food'},p:[0,0],mode:'strict'}]);
  if(scenario==='moved')x.edit([{op:'move',id:x.fish.id,in:{parent:'world'},p:[8,0],mode:'strict'}]);
  if(scenario==='native-detached')x.support.kind='in-hand';
  if(scenario==='private-fish')x.deny(x.fish.id);if(scenario==='private-grill')x.deny(x.g.id);
  if(scenario==='body-away')x.body.pose.p=[8,0,8];
  if(scenario==='grill-moved')x.edit([{op:'move',id:x.g.id,p:[10,0],mode:'strict'}]);
  if(scenario==='already-cooked')x.edit([{op:'set',id:x.fish.id,state:{cooked:true,left:.5}}]);
  if(scenario==='older')x.edit([{op:'set',id:x.g.id,state:{lastCompletedTick:401}}]);
  if(scenario==='batch-refused')x.refuse();
  x.service.onReceipt(scenario==='interrupted'?{...x.receipt,phase:'replaced'}:x.receipt);
  assert.equal(x.commits(),scenario==='batch-refused'?1:0,scenario);
  assert.equal(x.model.entities.get(x.g.id)?.state?.fuel,scenario==='fuel-used'?0:1,scenario);
  const f=x.model.entities.get(x.fish.id);if(f&&scenario!=='already-cooked')assert.equal(f.state?.cooked,false,scenario);
 }
});
test('one started/completed receipt cooks the same fish exactly once with lasting provenance, without an entity birth',()=>{
 const x=setup(),n=x.model.entities.size;x.service.onReceipt({...x.receipt,phase:'started'});x.service.onReceipt(x.receipt);x.service.onReceipt(x.receipt);
 assert.equal(x.commits(),1);assert.equal(x.model.entities.size,n);const f=x.model.entities.get(x.fish.id)!;assert.equal(f.state?.cooked,true);assert.equal(f.state?.left,1);assert.equal(f.in.parent,x.g.id);assert.match(f.about!.what!,/Ana/);assert.equal(x.model.entities.get(x.g.id)?.state?.fuel,0);assert.equal(x.model.entities.get(x.g.id)?.state?.on,false);
});
test('raw state refuses eating even if an authored portion has a positive leftover field',()=>{
 const x=setup();x.edit([{op:'set',id:x.fish.id,state:{left:1}}]);const soul={soulId:'s-ana',entityId:'ana',name:'Ana'} as never;
 for(const action of['eat','bite'])assert.match(JSON.stringify(x.service.plan(soul,x.fish.id,action)),/raw/);
});
