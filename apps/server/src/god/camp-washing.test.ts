import {test} from 'node:test';
import assert from 'node:assert/strict';
import {WorldModel,coreLibrary,applyBatch,type Op} from '@souls/world-compiler';
import {createCampWashing} from './camp-washing.ts';
import type {EdgeReceipt} from '../edge/contract.ts';
function setup(){
 const model=new WorldModel({constants:{ground:'land',extent:100},seed:'camp-washing-controls'});model.library=coreLibrary();
 const edit=(ops:Op[])=>{const r=applyBatch(model,{ops},'god',0);assert.equal(r.result.accepted,true,JSON.stringify(r.result));};
 edit([{op:'place',def:'core/camp-wash-station@1',name:'grill',in:{parent:'world'},p:[0,0],mode:'strict'},{op:'place',def:'core/camp-mess-kit@1',name:'bowl',in:{parent:'grill',slot:'wash'},p:[0,0],mode:'strict'}]);
 const g=[...model.entities.values()].find(e=>e.name==='grill')!,bowl=[...model.entities.values()].find(e=>e.name==='bowl')!,body={pose:{p:[0,0,.95]},human:{}},support={kind:'resting-on',on:g.id};let denied='',refused=false,commits=0;
 const service=createCampWashing({model,engine:{world:{entities:{ana:body,[bowl.id]:{support}}}},levelAt:()=>0,soul:()=>({id:'s-ana',entity_id:'ana',name:'Ana'}),denied:id=>id===denied?{code:'object.private',reason:'Private'}:null,commit(ops,_note,clientRef){commits++;assert.equal(clientRef,'camp-washing:work');if(refused)return{accepted:false};edit(ops);return{accepted:true};},log(){}});
 const receipt={id:'work',soulId:'s-ana',capability:'object:'+g.id+':wash-messkit',phase:'completed',endedTick:400} as EdgeReceipt;
 return{model,g,bowl,body,support,service,receipt,edit,deny:(id:string)=>{denied=id;},refuse:()=>{refused=true;},commits:()=>commits};
}
test('washing binds the actual initial bowl and atomically rechecks food, support, water, access and actor at natural completion',()=>{
 for(const scenario of['water-used','missing','moved','replacement','native-detached','private-bowl','private-grill','body-away','grill-moved','already-clean','older','batch-refused','interrupted','no-start']){
  const x=setup();if(scenario!=='no-start')x.service.onReceipt({...x.receipt,phase:'started'});
  if(scenario==='water-used')x.edit([{op:'set',id:x.g.id,state:{water:0}}]);
  if(scenario==='missing'||scenario==='replacement')x.edit([{op:'remove',id:x.bowl.id,cascade:false}]);
  if(scenario==='replacement')x.edit([{op:'place',def:'core/camp-mess-kit@1',name:'bowl',in:{parent:x.g.id,slot:'wash'},p:[0,0],mode:'strict'}]);
  if(scenario==='moved')x.edit([{op:'move',id:x.bowl.id,in:{parent:'world'},p:[8,0],mode:'strict'}]);
  if(scenario==='native-detached')x.support.kind='in-hand';
  if(scenario==='private-bowl')x.deny(x.bowl.id);if(scenario==='private-grill')x.deny(x.g.id);
  if(scenario==='body-away')x.body.pose.p=[8,0,8];
  if(scenario==='grill-moved')x.edit([{op:'move',id:x.g.id,p:[10,0],mode:'strict'}]);
  if(scenario==='already-clean')x.edit([{op:'set',id:x.bowl.id,state:{clean:true}}]);
  if(scenario==='older')x.edit([{op:'set',id:x.g.id,state:{lastCompletedTick:401}}]);
  if(scenario==='batch-refused')x.refuse();
  x.service.onReceipt(scenario==='interrupted'?{...x.receipt,phase:'replaced'}:x.receipt);
  assert.equal(x.commits(),scenario==='batch-refused'?1:0,scenario);
  assert.equal(x.model.entities.get(x.g.id)?.state?.water,scenario==='water-used'?0:1,scenario);
  const f=x.model.entities.get(x.bowl.id);if(f&&scenario!=='already-clean')assert.equal(f.state?.clean,false,scenario);
 }
});
test('one started/completed receipt cleans the same bowl exactly once with lasting provenance, without an entity birth',()=>{
 const x=setup(),n=x.model.entities.size;x.service.onReceipt({...x.receipt,phase:'started'});x.service.onReceipt(x.receipt);x.service.onReceipt(x.receipt);
 assert.equal(x.commits(),1);assert.equal(x.model.entities.size,n);const f=x.model.entities.get(x.bowl.id)!;assert.equal(f.state?.clean,true);assert.equal(f.in.parent,x.g.id);assert.match(f.about!.what!,/Ana/);assert.equal(x.model.entities.get(x.g.id)?.state?.water,0);
});
test('washing uses existing ten-second craft/brush steps and empty hands, scoped to the new station',()=>{
 const x=setup(),soul={soulId:'s-ana',entityId:'ana',name:'Ana'} as never;
 const p=x.service.plan(soul,x.g.id,'wash-messkit')!;assert.ok('steps' in p);assert.deepEqual(p.steps[2].params,{activity:'craft',seconds:10,prop:'brush',face:[.25,0]});
 x.body.human={holding:true} as never;assert.match(JSON.stringify(x.service.plan(soul,x.g.id,'wash-messkit')),/Put down/);
 assert.equal(x.service.plan(soul,x.bowl.id,'wash-messkit'),null);assert.equal(x.service.plan(soul,x.g.id,'other'),null);
});
