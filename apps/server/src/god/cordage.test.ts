import{test}from'node:test';import assert from'node:assert/strict';
import{WorldModel,coreLibrary,applyBatch,type Op}from'@souls/world-compiler';
import{createCordage}from'./cordage.ts';import type{EdgeReceipt}from'../edge/contract.ts';
function setup(){const model=new WorldModel({constants:{ground:'land',extent:100},seed:'cordage-controls'});model.library=coreLibrary();const edit=(ops:Op[])=>{const r=applyBatch(model,{ops},'god',0);assert.equal(r.result.accepted,true,JSON.stringify(r.result));};
 edit([{op:'place',def:'core/cordage-board@1',name:'bench',in:{parent:'world'},p:[0,0],mode:'strict'},{op:'place',def:'core/camp-cord@1',name:'cord',in:{parent:'bench',slot:'cord'},p:[0,0],mode:'strict'}]);
 const bench=[...model.entities.values()].find(e=>e.name==='bench')!,cord=[...model.entities.values()].find(e=>e.name==='cord')!,body={pose:{p:[.25,0,.8]},human:{}},support={kind:'resting-on',on:bench.id};let denied='',refused=false,commits=0,bodyId='ana';
 const service=createCordage({model,engine:{world:{entities:{ana:body,[cord.id]:{support}}}},levelAt:(_x,_z,y)=>y>2?1:0,soul:()=>({id:'s-ana',entity_id:bodyId,name:'Ana'}),denied:id=>id===denied?{code:'object.private',reason:'Private'}:null,commit(ops,_note,clientRef){commits++;assert.match(clientRef,/^cordage:/);if(refused)return{accepted:false};edit(ops);return{accepted:true};},log(){}});
 const receipt={id:'work',soulId:'s-ana',capability:'object:'+bench.id+':tie-loop',phase:'completed',endedTick:400}as EdgeReceipt;
 return{model,bench,cord,body,support,service,receipt,edit,deny:(id:string)=>{denied=id;},refuse:()=>{refused=true;},swapBody:()=>{bodyId='other';},commits:()=>commits};}
test('Cord completion rechecks exact cord/finish, supplies, support, access, actor/body/floor and terminal receipt',()=>{
 for(const scenario of['binding-used','missing','moved','replacement','native-detached','private-cord','private-bench','body-away','bench-moved','form-changed','wrong-floor','body-changed','hands-filled','older','batch-refused','interrupted','no-start','different-treatment']){
  const x=setup();if(scenario!=='no-start')x.service.onReceipt({...x.receipt,phase:'started'});
  if(scenario==='binding-used')x.edit([{op:'set',id:x.bench.id,state:{bindings:0}}]);
  if(scenario==='missing'||scenario==='replacement')x.edit([{op:'remove',id:x.cord.id,cascade:false}]);
  if(scenario==='replacement')x.edit([{op:'place',def:'core/camp-cord@1',name:'replacement',in:{parent:x.bench.id,slot:'cord'},p:[0,0],mode:'strict'}]);
  if(scenario==='moved')x.edit([{op:'move',id:x.cord.id,in:{parent:'world'},p:[8,0],mode:'strict'}]);if(scenario==='native-detached')x.support.kind='in-hand';
  if(scenario==='private-cord')x.deny(x.cord.id);if(scenario==='private-bench')x.deny(x.bench.id);if(scenario==='body-away')x.body.pose.p=[8,0,8];
  if(scenario==='bench-moved')x.edit([{op:'move',id:x.bench.id,p:[10,0],mode:'strict'}]);if(scenario==='form-changed')x.edit([{op:'set',id:x.cord.id,state:{form:2}}]);
  if(scenario==='wrong-floor')x.body.pose.p[1]=3;if(scenario==='body-changed')x.swapBody();if(scenario==='hands-filled')x.body.human={holding:true}as never;
  if(scenario==='older')x.edit([{op:'set',id:x.bench.id,state:{lastCompletedTick:401}}]);if(scenario==='batch-refused')x.refuse();
  x.service.onReceipt(scenario==='interrupted'?{...x.receipt,phase:'replaced'}:scenario==='different-treatment'?{...x.receipt,capability:'object:'+x.bench.id+':tie-guyline'}:x.receipt);
  assert.equal(x.commits(),scenario==='batch-refused'?1:0,scenario);assert.equal(x.model.entities.get(x.bench.id)?.state?.bindings,scenario==='binding-used'?0:1,scenario);const c=x.model.entities.get(x.cord.id);if(c&&scenario!=='form-changed')assert.equal(c.state?.form,0,scenario);
 }
});
test('prepare, undo and choose another form on the same cord; binding is conserved and duplicate completion cannot apply twice',()=>{
 const x=setup(),n=x.model.entities.size;
 const finish=(r:EdgeReceipt)=>{x.service.onReceipt({...r,phase:'started'});x.service.onReceipt(r);x.service.onReceipt(r);};
 finish(x.receipt);assert.equal(x.commits(),1);assert.equal(x.model.entities.get(x.cord.id)?.state?.form,1);assert.equal(x.model.entities.get(x.bench.id)?.state?.bindings,0);assert.match(x.model.entities.get(x.cord.id)?.about?.what??'',/loop prepared by Ana/);
 assert.match(JSON.stringify(x.service.plan({soulId:'s-ana',entityId:'ana',name:'Ana'}as never,x.bench.id,'tie-guyline')),/untie/);
 finish({...x.receipt,id:'undo',capability:'object:'+x.bench.id+':untie',endedTick:700});assert.equal(x.model.entities.get(x.cord.id)?.state?.form,0);assert.equal(x.model.entities.get(x.bench.id)?.state?.bindings,1);
 finish({...x.receipt,id:'guyline',capability:'object:'+x.bench.id+':tie-guyline',endedTick:1000});assert.equal(x.commits(),3);assert.equal(x.model.entities.size,n);assert.equal(x.model.entities.get(x.cord.id)?.state?.form,2);assert.equal(x.model.entities.get(x.bench.id)?.state?.bindings,0);assert.match(x.model.entities.get(x.cord.id)?.about?.what??'',/guyline prepared by Ana/);
});
test('new exact-def actions use native craft/tool, empty hands and the actual body floor',()=>{
 const x=setup(),soul={soulId:'s-ana',entityId:'ana',name:'Ana'}as never,p=x.service.plan(soul,x.bench.id,'tie-loop')!;assert.ok('steps'in p);assert.deepEqual(p.steps[2].params,{activity:'craft',seconds:10,prop:'tool',face:[.2,0]});
 x.body.pose.p[1]=3;assert.match(JSON.stringify(x.service.plan(soul,x.bench.id,'tie-loop')),/same floor/);x.body.pose.p[1]=0;x.body.human={holding:true}as never;assert.match(JSON.stringify(x.service.plan(soul,x.bench.id,'tie-loop')),/Put down/);assert.equal(x.service.plan(soul,x.cord.id,'tie-loop'),null);assert.equal(x.service.plan(soul,x.bench.id,'other'),null);
});
