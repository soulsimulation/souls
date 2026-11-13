import {test} from 'node:test';
import assert from 'node:assert/strict';
import {WorldModel,coreLibrary,applyBatch,type Op} from '@souls/world-compiler';
import {createWeeding} from './weeding.ts';
import {dryingOps} from './garden.ts';
import type {EdgeReceipt} from '../edge/contract.ts';

function setup(){
 const model=new WorldModel({constants:{ground:'land',extent:100},seed:'weeding-controls'});model.library=coreLibrary();
 const edit=(ops:Op[])=>{const r=applyBatch(model,{ops},'god',0);assert.equal(r.result.accepted,true,JSON.stringify(r.result));};
 edit([{op:'place',def:'core/garden-planter@4',name:'block',p:[0,0],in:{parent:'world'},mode:'strict'}]);
 const block=[...model.entities.values()].find(e=>e.name==='block')!,body={pose:{p:[0,0,1]},human:{}};
 let denied=false,refused=false,commits=0,logs=0;
 const service=createWeeding({model,engine:{world:{entities:{ana:body}}},levelAt:()=>0,soul:()=>({id:'s-ana',entity_id:'ana',name:'Ana'}),denied:()=>denied?{code:'object.private',reason:'Private'}:null,
  commit(ops,_note,clientRef){commits++;assert.equal(clientRef,'weeding:completed-work');if(refused)return{accepted:false};edit(ops);return{accepted:true};},log(){logs++;}});
 const receipt={id:'completed-work',soulId:'s-ana',capability:'object:'+block.id+':weed-bed',phase:'completed',endedTick:400} as EdgeReceipt;
 return{model,block,body,edit,service,receipt,denied:()=>{denied=true;},refused:()=>{refused=true;},commits:()=>commits,logs:()=>logs};
}

test('weeding completion rechecks target, weeds, access and actual nearby body without consuming on refusal',()=>{
 for(const scenario of ['removed','weeds-used','private','moved','body-away','older','refused-batch','not-completed','output-filled']){
  const x=setup();
  if(scenario==='removed')x.edit([{op:'remove',id:x.block.id,cascade:true}]);
  if(scenario==='weeds-used')x.edit([{op:'set',id:x.block.id,state:{weeds:0}}]);
  if(scenario==='private')x.denied();
  if(scenario==='moved')x.edit([{op:'move',id:x.block.id,p:[10,0],mode:'strict'}]);
  if(scenario==='body-away')x.body.pose.p=[8,0,8];
  if(scenario==='older')x.edit([{op:'set',id:x.block.id,state:{lastCompletedTick:401}}]);
  if(scenario==='refused-batch')x.refused();
  if(scenario==='output-filled')x.edit([{op:'place',def:'core/weed-bundle@1',name:'existing-output',p:[0,0],in:{parent:x.block.id,slot:'out'},mode:'strict'}]);
  x.service.onReceipt(scenario==='not-completed'?{...x.receipt,phase:'replaced'}:x.receipt);
  assert.equal([...x.model.entities.values()].filter(e=>x.model.resolvedDef(e.def)?.name==='core-weed-bundle').length,scenario==='output-filled'?1:0,scenario);
  assert.equal(x.commits(),scenario==='refused-batch'?1:0,scenario);
  if(!['removed','weeds-used'].includes(scenario))assert.equal(x.model.entities.get(x.block.id)?.state?.weeds,1,scenario);
  if(scenario==='refused-batch')assert.equal(x.logs(),1);
 }
});

test('one receipt atomically clears weeds and places one bundle and records credit; duplicate cannot consume again',()=>{
 const x=setup();x.service.onReceipt(x.receipt);assert.equal(x.commits(),1);
 const block=x.model.entities.get(x.block.id)!;assert.equal(block.state?.weeds,0);assert.equal(block.state?.lastBy,'Ana');
 assert.equal(block.state?.growth,2);assert.equal(block.state?.lastReceipt,x.receipt.id);
 x.service.onReceipt(x.receipt);assert.equal(x.commits(),1);assert.equal(x.model.entities.size,2);
});


test('weeding retains native plant growth and daily drying for both revisions',()=>{
 const x=setup();x.edit([{op:'set',id:x.block.id,state:{moisture:1}},{op:'place',def:'core/garden-planter@2',name:'old',p:[3,0],in:{parent:'world'},mode:'strict',state:{moisture:1,growth:2}}]);
 const old=[...x.model.entities.values()].find(e=>e.name==='old')!;
 for(const id of[x.block.id,old.id])assert.equal((dryingOps(x.model,1).find(op=>'id'in op&&op.id===id) as {state:Record<string,unknown>}).state.growth,3);
 x.service.onReceipt(x.receipt);assert.equal(x.model.entities.get(x.block.id)!.state?.growth,2);
});
