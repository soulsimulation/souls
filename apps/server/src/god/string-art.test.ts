import {test} from 'node:test';import assert from 'node:assert/strict';
import {WorldModel,coreLibrary,applyBatch,type Op} from '@souls/world-compiler';
import {createStringArt} from './string-art.ts';import type {EdgeReceipt} from '../edge/contract.ts';
function setup(){const model=new WorldModel({constants:{ground:'land',extent:100},seed:'string-art'});model.library=coreLibrary();
 const edit=(ops:Op[])=>{const r=applyBatch(model,{ops},'god',0);assert.equal(r.result.accepted,true,JSON.stringify(r.result));};
 edit([{op:'place',def:'core/shop-counter@1',name:'counter',in:{parent:'world'},p:[0,0],mode:'strict'},{op:'place',def:'core/string-art-board@1',name:'board',in:{parent:'counter',slot:'top'},p:[0,0],mode:'strict'}]);
 const counter=[...model.entities.values()].find(e=>e.name==='counter')!,board=[...model.entities.values()].find(e=>e.name==='board')!,body={pose:{p:[.3,0,1]},human:{}},support={kind:'resting-on',on:counter.id};let denied='',refused=false,commits=0,bodyId='ana';
 const service=createStringArt({model,engine:{world:{entities:{ana:body,[board.id]:{support}}}},levelAt:(_x,_z,y)=>y>2?1:0,soul:()=>({id:'s-ana',entity_id:bodyId,name:'Ana'}),denied:id=>id===denied?{code:'object.private',reason:'Private'}:null,commit(ops,_note,ref){commits++;assert.match(ref,/^string-art:/);if(refused)return{accepted:false};edit(ops);return{accepted:true};},log(){}});
 const receipt={id:'work',soulId:'s-ana',capability:'object:'+board.id+':string-path',phase:'completed',endedTick:400}as EdgeReceipt;
 return{model,counter,board,body,support,service,receipt,edit,deny:(id:string)=>{denied=id;},refuse:()=>{refused=true;},swapBody:()=>{bodyId='other';},commits:()=>commits};
}
test('completion preserves board/selection/composition/stock/support/access/body and interruption controls',()=>{
 for(const scenario of['stock-used','missing','moved','native-detached','private-board','private-counter','body-away','counter-moved','choice-changed','composition-changed','wrong-floor','body-changed','hands-filled','older','batch-refused','interrupted','no-start','wrong-operation']){
  const x=setup();if(scenario!=='no-start')x.service.onReceipt({...x.receipt,phase:'started'});
  if(scenario==='stock-used')x.edit([{op:'set',id:x.board.id,state:{red:0}}]);if(scenario==='missing')x.edit([{op:'remove',id:x.board.id,cascade:false}]);
  if(scenario==='moved')x.edit([{op:'move',id:x.board.id,in:{parent:'world'},p:[8,0],mode:'strict'}]);if(scenario==='native-detached')x.support.kind='in-hand';
  if(scenario==='private-board')x.deny(x.board.id);if(scenario==='private-counter')x.deny(x.counter.id);if(scenario==='body-away')x.body.pose.p=[8,0,8];
  if(scenario==='counter-moved')x.edit([{op:'move',id:x.counter.id,p:[.1,0],mode:'strict'}]);if(scenario==='choice-changed')x.edit([{op:'set',id:x.board.id,state:{to:'D'}}]);if(scenario==='composition-changed')x.edit([{op:'set',id:x.board.id,state:{cd:2}}]);
  if(scenario==='wrong-floor')x.body.pose.p[1]=3;if(scenario==='body-changed')x.swapBody();if(scenario==='hands-filled')x.body.human={holding:true}as never;
  if(scenario==='older')x.edit([{op:'set',id:x.board.id,state:{lastCompletedTick:401}}]);if(scenario==='batch-refused')x.refuse();
  x.service.onReceipt(scenario==='interrupted'?{...x.receipt,phase:'replaced'}:scenario==='wrong-operation'?{...x.receipt,capability:'object:'+x.board.id+':unstring-path'}:x.receipt);
  assert.equal(x.commits(),scenario==='batch-refused'?1:0,scenario);const b=x.model.entities.get(x.board.id);if(b){assert.equal(b.state?.ab,0,scenario);assert.equal(b.state?.red,scenario==='stock-used'?0:2,scenario);}
 }
});
test('independent chosen paths conserve each colour, reverse endpoint identity, duplicate completion and actual-colour refund',()=>{
 const x=setup(),finish=(r:EdgeReceipt)=>{x.service.onReceipt({...r,phase:'started'});x.service.onReceipt(r);x.service.onReceipt(r);},state=()=>x.model.entities.get(x.board.id)!.state!,choose=(from:string,to:string,colour:string)=>x.edit([{op:'set',id:x.board.id,state:{from,to,colour}}]);
 finish(x.receipt);assert.equal(state().ab,1);assert.equal(state().red,1);assert.equal(x.commits(),1);
 choose('C','A','blue');finish({...x.receipt,id:'blue',endedTick:700});assert.equal(state().ac,2);assert.equal(state().ab,1);assert.equal(state().blue,1);
 choose('D','A','red');finish({...x.receipt,id:'red2',endedTick:1000});assert.equal(state().ad,1);assert.equal(state().red,0);
 choose('B','D','red');x.service.onReceipt({...x.receipt,id:'empty',phase:'started'});x.service.onReceipt({...x.receipt,id:'empty',endedTick:1300});assert.equal(x.commits(),3);assert.equal(state().bd,0);
 choose('B','A','gold');finish({...x.receipt,id:'remove',capability:'object:'+x.board.id+':unstring-path',endedTick:1500});assert.equal(state().ab,0);assert.equal(state().red,1);assert.equal(state().gold,2);assert.equal(state().ac,2);assert.equal(x.commits(),4);assert.match(x.service.facts(x.board.id)?.stringArt??'',/AC blue.*AD red.*red 1.*blue 1.*gold 2/);
});
test('native craft delegates standing point to the existing approach callback; unsupported or invalid choices refuse',()=>{
 const x=setup(),soul={soulId:'s-ana',entityId:'ana',name:'Ana'}as never;let args:unknown[]=[];
 const p=x.service.plan(soul,x.board.id,'string-path',(...a)=>{args=a;return{p:[.5,1],level:0};})!;assert.ok('steps'in p);assert.equal(args[0],x.board.id);assert.deepEqual(p.steps[1].params,{x:.5,z:1,level:0});assert.deepEqual(p.steps[2].params,{activity:'craft',seconds:10,prop:'tool',face:[.3,.15]});
 assert.match(JSON.stringify(x.service.plan(soul,x.board.id,'string-path',()=>null)),/reachable standing point/);x.edit([{op:'set',id:x.board.id,state:{from:'A',to:'A'}}]);assert.match(JSON.stringify(x.service.plan(soul,x.board.id,'string-path',()=>null)),/different pegs/);assert.equal(x.service.plan(soul,x.counter.id,'string-path',()=>null),null);assert.equal(x.service.plan(soul,x.board.id,'choose-path',()=>null),null);
});
