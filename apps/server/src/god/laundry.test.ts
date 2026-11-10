import{test}from'node:test';import assert from'node:assert/strict';
import{WorldModel,coreLibrary,applyBatch,type Op}from'@souls/world-compiler';
import{createLaundry}from'./laundry.ts';import type{EdgeReceipt}from'../edge/contract.ts';
function setup(){const model=new WorldModel({constants:{ground:'land',extent:100},seed:'linen-dye-controls'});model.library=coreLibrary();const edit=(ops:Op[])=>{const r=applyBatch(model,{ops},'god',0);assert.equal(r.result.accepted,true,JSON.stringify(r.result));};
 edit([{op:'place',def:'core/laundry-board@1',name:'bench',in:{parent:'world'},p:[0,0],mode:'strict'},{op:'place',def:'core/camp-linen@1',name:'linen',in:{parent:'bench',slot:'linen'},p:[0,0],mode:'strict'}]);
 const bench=[...model.entities.values()].find(e=>e.name==='bench')!,linen=[...model.entities.values()].find(e=>e.name==='linen')!,body={pose:{p:[.25,0,.8]},human:{}},support={kind:'resting-on',on:bench.id};let denied='',refused=false,commits=0,bodyId='ana';
 const service=createLaundry({model,engine:{world:{entities:{ana:body,[linen.id]:{support}}}},levelAt:(_x,_z,y)=>y>2?1:0,soul:()=>({id:'s-ana',entity_id:bodyId,name:'Ana'}),denied:id=>id===denied?{code:'object.private',reason:'Private'}:null,commit(ops,_note,clientRef){commits++;assert.match(clientRef,/^laundry:/);if(refused)return{accepted:false};edit(ops);return{accepted:true};},log(){}});
 const receipt={id:'work',soulId:'s-ana',capability:'object:'+bench.id+':wash-linen',phase:'completed',endedTick:400}as EdgeReceipt;
 return{model,bench,linen,body,support,service,receipt,edit,deny:(id:string)=>{denied=id;},refuse:()=>{refused=true;},swapBody:()=>{bodyId='other';},commits:()=>commits};}
test('Laundry completion rechecks exact linen/finish, supplies, support, access, actor/body/floor and terminal receipt',()=>{
 for(const scenario of['soap-used','water-used','missing','moved','replacement','native-detached','private-linen','private-bench','body-away','bench-moved','stage-changed','wrong-floor','body-changed','hands-filled','older','batch-refused','interrupted','no-start','different-treatment']){
  const x=setup();if(scenario!=='no-start')x.service.onReceipt({...x.receipt,phase:'started'});
  if(scenario==='soap-used')x.edit([{op:'set',id:x.bench.id,state:{soap:0}}]);if(scenario==='water-used')x.edit([{op:'set',id:x.bench.id,state:{water:0}}]);
  if(scenario==='missing'||scenario==='replacement')x.edit([{op:'remove',id:x.linen.id,cascade:false}]);
  if(scenario==='replacement')x.edit([{op:'place',def:'core/camp-linen@1',name:'replacement',in:{parent:x.bench.id,slot:'linen'},p:[0,0],mode:'strict'}]);
  if(scenario==='moved')x.edit([{op:'move',id:x.linen.id,in:{parent:'world'},p:[8,0],mode:'strict'}]);if(scenario==='native-detached')x.support.kind='in-hand';
  if(scenario==='private-linen')x.deny(x.linen.id);if(scenario==='private-bench')x.deny(x.bench.id);if(scenario==='body-away')x.body.pose.p=[8,0,8];
  if(scenario==='bench-moved')x.edit([{op:'move',id:x.bench.id,p:[10,0],mode:'strict'}]);if(scenario==='stage-changed')x.edit([{op:'set',id:x.linen.id,state:{stage:2}}]);
  if(scenario==='wrong-floor')x.body.pose.p[1]=3;if(scenario==='body-changed')x.swapBody();if(scenario==='hands-filled')x.body.human={holding:true}as never;
  if(scenario==='older')x.edit([{op:'set',id:x.bench.id,state:{lastCompletedTick:401}}]);if(scenario==='batch-refused')x.refuse();
  x.service.onReceipt(scenario==='interrupted'?{...x.receipt,phase:'replaced'}:scenario==='different-treatment'?{...x.receipt,capability:'object:'+x.bench.id+':fold-linen'}:x.receipt);
  assert.equal(x.commits(),scenario==='batch-refused'?1:0,scenario);assert.equal(x.model.entities.get(x.bench.id)?.state?.water,scenario==='water-used'?0:1,scenario);const c=x.model.entities.get(x.linen.id);if(c&&scenario!=='stage-changed')assert.equal(c.state?.stage,0,scenario);
 }
});
test('wash, wring and fold the same linen; finite washing supplies and duplicate completion conserve state',()=>{
 const x=setup(),n=x.model.entities.size,finish=(r:EdgeReceipt)=>{x.service.onReceipt({...r,phase:'started'});x.service.onReceipt(r);x.service.onReceipt(r);};
 finish(x.receipt);assert.equal(x.commits(),1);assert.equal(x.model.entities.get(x.linen.id)?.state?.stage,1);assert.equal(x.model.entities.get(x.bench.id)?.state?.soap,0);assert.equal(x.model.entities.get(x.bench.id)?.state?.water,0);assert.match(x.model.entities.get(x.linen.id)?.about?.what??'',/Clean wet linen, washed by Ana/);
 assert.match(JSON.stringify(x.service.plan({soulId:'s-ana',entityId:'ana',name:'Ana'}as never,x.bench.id,'fold-linen')),/Wring/);
 finish({...x.receipt,id:'wring',capability:'object:'+x.bench.id+':wring-linen',endedTick:700});assert.equal(x.model.entities.get(x.linen.id)?.state?.stage,2);assert.match(x.model.entities.get(x.linen.id)?.about?.what??'',/Wrung damp linen/);
 finish({...x.receipt,id:'fold',capability:'object:'+x.bench.id+':fold-linen',endedTick:1000});assert.equal(x.commits(),3);assert.equal(x.model.entities.size,n);assert.equal(x.model.entities.get(x.linen.id)?.state?.stage,3);assert.equal(x.model.entities.get(x.bench.id)?.state?.water,0);assert.equal(x.model.entities.get(x.bench.id)?.state?.soap,0);assert.match(x.service.facts(x.linen.id)?.campLinen??'',/Folded damp linen.*folded by Ana/);
});
test('new exact-def actions use native craft/brush, empty hands and the actual body floor',()=>{
 const x=setup(),soul={soulId:'s-ana',entityId:'ana',name:'Ana'}as never,p=x.service.plan(soul,x.bench.id,'wash-linen')!;assert.ok('steps'in p);assert.deepEqual(p.steps[2].params,{activity:'craft',seconds:10,prop:'brush',face:[.2,0]});
 x.body.pose.p[1]=3;assert.match(JSON.stringify(x.service.plan(soul,x.bench.id,'wash-linen')),/same floor/);x.body.pose.p[1]=0;x.body.human={holding:true}as never;assert.match(JSON.stringify(x.service.plan(soul,x.bench.id,'wash-linen')),/Put down/);assert.equal(x.service.plan(soul,x.linen.id,'wash-linen'),null);assert.equal(x.service.plan(soul,x.bench.id,'other'),null);
});
