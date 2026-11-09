import {test} from 'node:test';
import assert from 'node:assert/strict';
import {WorldModel,coreLibrary,applyBatch,type Op} from '@souls/world-compiler';
import {createTrailSigns} from './trail-sign.ts';
import type {EdgeReceipt} from '../edge/contract.ts';

function setup(){
 const model=new WorldModel({constants:{ground:'land',extent:100},seed:'trail-sign-controls'});model.library=coreLibrary();
 const edit=(ops:Op[])=>{const r=applyBatch(model,{ops},'god',0);assert.equal(r.result.accepted,true,JSON.stringify(r.result));};
 edit([{op:'place',def:'core/trail-sign-site@1',name:'block',p:[0,0],in:{parent:'world'},mode:'strict'}]);
 const block=[...model.entities.values()].find(e=>e.name==='block')!,body={pose:{p:[0,0,1]},human:{}};
 let denied=false,refused=false,commits=0,logs=0,codes:string[]=[];
 const service=createTrailSigns({model,engine:{world:{entities:{ana:body}}},levelAt:()=>0,soul:()=>({id:'s-ana',entity_id:'ana',name:'Ana'}),denied:()=>denied?{code:'object.private',reason:'Private'}:null,
  commit(ops,_note,clientRef){commits++;assert.equal(clientRef,'trail-sign:completed-work');if(refused)return{accepted:false};const r=applyBatch(model,{ops},'god',0).result;if(!r.accepted)codes=r.failures.map(f=>f.code);return{accepted:r.accepted};},log(){logs++;}});
 const receipt={id:'completed-work',soulId:'s-ana',capability:'object:'+block.id+':assemble-sign',phase:'completed',endedTick:400} as EdgeReceipt;
 return{model,block,body,edit,service,receipt,denied:()=>{denied=true;},refused:()=>{refused=true;},commits:()=>commits,codes:()=>codes,logs:()=>logs};
}

test('trail-sign completion rechecks target, stock, access and actual nearby body without consuming on refusal',()=>{
 for(const scenario of ['removed','stock-used','private','moved','body-away','older','refused-batch','not-completed','output-filled','blocked-footprint']){
  const x=setup();
  if(scenario==='removed')x.edit([{op:'remove',id:x.block.id,cascade:true}]);
  if(scenario==='stock-used')x.edit([{op:'set',id:x.block.id,state:{stock:0}}]);
  if(scenario==='private')x.denied();
  if(scenario==='moved')x.edit([{op:'move',id:x.block.id,p:[10,0],mode:'strict'}]);
  if(scenario==='body-away')x.body.pose.p=[8,0,8];
  if(scenario==='older')x.edit([{op:'set',id:x.block.id,state:{lastCompletedTick:401}}]);
  if(scenario==='refused-batch')x.refused();
  if(scenario==='blocked-footprint')x.edit([{op:'place',def:'core/crate@1',name:'blocker',p:[.7,2],in:{parent:'world'},mode:'strict'}]);
  if(scenario==='output-filled')x.edit([{op:'place',def:'core/notice-board@2',name:'existing-output',p:[0,0],in:{parent:x.block.id,slot:'out'},mode:'strict'}]);
  x.service.onReceipt(scenario==='not-completed'?{...x.receipt,phase:'replaced'}:x.receipt);
  assert.equal([...x.model.entities.values()].filter(e=>x.model.resolvedDef(e.def)?.name==='core-notice-board').length,scenario==='output-filled'?1:0,scenario);
  assert.equal(x.commits(),['refused-batch','blocked-footprint'].includes(scenario)?1:0,scenario);
  if(!['removed','stock-used'].includes(scenario))assert.equal(x.model.entities.get(x.block.id)?.state?.stock,1,scenario);
  if(scenario==='refused-batch')assert.equal(x.logs(),1);
  if(scenario==='blocked-footprint')assert.ok(x.codes().includes('overlap.solid'));
 }
});

test('one receipt atomically uses supplied materials and admits one real notice board with credit; duplicate cannot consume again',()=>{
 const x=setup();x.service.onReceipt(x.receipt);assert.equal(x.commits(),1);
 const block=x.model.entities.get(x.block.id)!;assert.equal(block.state?.stock,0);assert.equal(block.state?.lastBy,'Ana');
 assert.equal(block.state?.prepared,true);assert.equal(block.state?.lastReceipt,x.receipt.id);
 x.service.onReceipt(x.receipt);assert.equal(x.commits(),1);assert.equal(x.model.entities.size,2);const board=[...x.model.entities.values()].find(e=>e.name==='sign')!;assert.match(board.about?.what??'',/assembled by Ana.*supplied timber/);
});


