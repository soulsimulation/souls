import {test} from 'node:test';
import assert from 'node:assert/strict';
import {WorldModel,coreLibrary,applyBatch,type Op} from '@souls/world-compiler';
import {createPottery} from './pottery.ts';
import type {EdgeReceipt} from '../edge/contract.ts';

function setup(){
 const model=new WorldModel({constants:{ground:'land',extent:100},seed:'pottery-controls'});model.library=coreLibrary();
 const edit=(ops:Op[])=>{const r=applyBatch(model,{ops},'god',0);assert.equal(r.result.accepted,true,JSON.stringify(r.result));};
 edit([{op:'place',def:'core/pottery-bench@1',name:'block',p:[0,0],in:{parent:'world'},mode:'strict'}]);
 const block=[...model.entities.values()].find(e=>e.name==='block')!,body={pose:{p:[0,0,1]},human:{}};
 let denied=false,refused=false,commits=0,logs=0;
 const service=createPottery({model,engine:{world:{entities:{ana:body}}},levelAt:()=>0,soul:()=>({id:'s-ana',entity_id:'ana',name:'Ana'}),denied:()=>denied?{code:'object.private',reason:'Private'}:null,
  commit(ops,_note,clientRef){commits++;assert.equal(clientRef,'pottery:completed-work');if(refused)return{accepted:false};edit(ops);return{accepted:true};},log(){logs++;}});
 const receipt={id:'completed-work',soulId:'s-ana',capability:'object:'+block.id+':make-blue-vase',phase:'completed',endedTick:400} as EdgeReceipt;
 return{model,block,body,edit,service,receipt,denied:()=>{denied=true;},refused:()=>{refused=true;},commits:()=>commits,logs:()=>logs};
}

test('pottery completion rechecks target, stock, access, output and actual nearby body without consuming on refusal',()=>{
 for(const scenario of ['removed','stock-used','fractional-stock','private','output-occupied','moved','body-away','older','refused-batch','not-completed']){
  const x=setup();
  if(scenario==='removed')x.edit([{op:'remove',id:x.block.id,cascade:true}]);
  if(scenario==='stock-used')x.edit([{op:'set',id:x.block.id,state:{stock:0}}]);
  if(scenario==='fractional-stock')x.edit([{op:'set',id:x.block.id,state:{stock:.5}}]);
  if(scenario==='private')x.denied();
  if(scenario==='output-occupied')x.edit([{op:'place',def:'core/bowl@2',name:'bowl',in:{parent:x.block.id,slot:'out'},p:[0,0],mode:'strict'}]);
  if(scenario==='moved')x.edit([{op:'move',id:x.block.id,p:[10,0],mode:'strict'}]);
  if(scenario==='body-away')x.body.pose.p=[8,0,8];
  if(scenario==='older')x.edit([{op:'set',id:x.block.id,state:{lastCompletedTick:401}}]);
  if(scenario==='refused-batch')x.refused();
  x.service.onReceipt(scenario==='not-completed'?{...x.receipt,phase:'replaced'}:x.receipt);
  assert.equal([...x.model.entities.values()].filter(e=>e.def==='core-flower-vase@1').length,0,scenario);
  assert.equal(x.commits(),scenario==='refused-batch'?1:0,scenario);
  if(!['removed','stock-used','fractional-stock'].includes(scenario))assert.equal(x.model.entities.get(x.block.id)?.state?.stock,3,scenario);
  if(scenario==='refused-batch')assert.equal(x.logs(),1);
 }
});

test('one receipt atomically records credit and creates one actual child; duplicate completion cannot consume again',()=>{
 const x=setup();x.service.onReceipt(x.receipt);assert.equal(x.commits(),1);
 const block=x.model.entities.get(x.block.id)!;assert.equal(block.state?.stock,2);assert.equal(block.state?.lastBy,'Ana');
 const output=[...x.model.entities.values()].find(e=>e.name==='pottery-vase-1')!;assert.ok(output);assert.match(output.about?.what??'',/Made by Ana.*blue glaze/);assert.equal(output.in.parent,block.id);assert.equal(output.in.slot,'out');assert.equal(output.params?.glaze,'#5f86a6');assert.equal(block.state?.lastGlaze,'blue');assert.equal(block.state?.lastPiece,'pottery-vase-1');
 x.service.onReceipt(x.receipt);assert.equal(x.commits(),1);assert.equal([...x.model.entities.values()].filter(e=>e.name==='pottery-vase-1').length,1);
});


test('terracotta choice comes from the completed capability, not mutable latest selection',()=>{const x=setup();x.service.onReceipt({...x.receipt,capability:'object:'+x.block.id+':make-clay-vase'});const e=[...x.model.entities.values()].find(e=>e.name==='pottery-vase-1')!;assert.equal(e.params?.glaze,'#b96b45');assert.equal(x.model.entities.get(x.block.id)!.state?.lastGlaze,'terracotta');});
