import{test}from'node:test';import assert from'node:assert/strict';
import{WorldModel,coreLibrary,applyBatch,type Op}from'@souls/world-compiler';
import{createClothDyeing}from'./cloth-dyeing.ts';import type{EdgeReceipt}from'../edge/contract.ts';
function setup(){const model=new WorldModel({constants:{ground:'land',extent:100},seed:'cloth-dye-controls'});model.library=coreLibrary();const edit=(ops:Op[])=>{const r=applyBatch(model,{ops},'god',0);assert.equal(r.result.accepted,true,JSON.stringify(r.result));};
 edit([{op:'place',def:'core/cloth-dye-bench@1',name:'bench',in:{parent:'world'},p:[0,0],mode:'strict'},{op:'place',def:'core/dyeable-cloth@1',name:'cloth',in:{parent:'bench',slot:'cloth'},p:[0,0],mode:'strict'}]);
 const bench=[...model.entities.values()].find(e=>e.name==='bench')!,cloth=[...model.entities.values()].find(e=>e.name==='cloth')!,body={pose:{p:[.25,0,.8]},human:{}},support={kind:'resting-on',on:bench.id};let denied='',refused=false,commits=0,bodyId='ana';
 const service=createClothDyeing({model,engine:{world:{entities:{ana:body,[cloth.id]:{support}}}},levelAt:(_x,_z,y)=>y>2?1:0,soul:()=>({id:'s-ana',entity_id:bodyId,name:'Ana'}),denied:id=>id===denied?{code:'object.private',reason:'Private'}:null,commit(ops,_note,clientRef){commits++;assert.match(clientRef,/^cloth-dyeing:/);if(refused)return{accepted:false};edit(ops);return{accepted:true};},log(){}});
 const receipt={id:'work',soulId:'s-ana',capability:'object:'+bench.id+':dye-indigo-banded',phase:'completed',endedTick:400}as EdgeReceipt;
 return{model,bench,cloth,body,support,service,receipt,edit,deny:(id:string)=>{denied=id;},refuse:()=>{refused=true;},swapBody:()=>{bodyId='other';},commits:()=>commits};}
test('dye completion rechecks exact cloth/finish, supplies, support, access, actor/body/floor and terminal receipt',()=>{
 for(const scenario of['pigment-used','water-used','missing','moved','replacement','native-detached','private-cloth','private-bench','body-away','bench-moved','finish-changed','wrong-floor','body-changed','hands-filled','older','batch-refused','interrupted','no-start','different-treatment']){
  const x=setup();if(scenario!=='no-start')x.service.onReceipt({...x.receipt,phase:'started'});
  if(scenario==='pigment-used')x.edit([{op:'set',id:x.bench.id,state:{indigo:0}}]);if(scenario==='water-used')x.edit([{op:'set',id:x.bench.id,state:{water:0}}]);
  if(scenario==='missing'||scenario==='replacement')x.edit([{op:'remove',id:x.cloth.id,cascade:false}]);
  if(scenario==='replacement')x.edit([{op:'place',def:'core/dyeable-cloth@1',name:'replacement',in:{parent:x.bench.id,slot:'cloth'},p:[0,0],mode:'strict'}]);
  if(scenario==='moved')x.edit([{op:'move',id:x.cloth.id,in:{parent:'world'},p:[8,0],mode:'strict'}]);if(scenario==='native-detached')x.support.kind='in-hand';
  if(scenario==='private-cloth')x.deny(x.cloth.id);if(scenario==='private-bench')x.deny(x.bench.id);if(scenario==='body-away')x.body.pose.p=[8,0,8];
  if(scenario==='bench-moved')x.edit([{op:'move',id:x.bench.id,p:[10,0],mode:'strict'}]);if(scenario==='finish-changed')x.edit([{op:'set',id:x.cloth.id,state:{dye:2}}]);
  if(scenario==='wrong-floor')x.body.pose.p[1]=3;if(scenario==='body-changed')x.swapBody();if(scenario==='hands-filled')x.body.human={holding:true}as never;
  if(scenario==='older')x.edit([{op:'set',id:x.bench.id,state:{lastCompletedTick:401}}]);if(scenario==='batch-refused')x.refuse();
  x.service.onReceipt(scenario==='interrupted'?{...x.receipt,phase:'replaced'}:scenario==='different-treatment'?{...x.receipt,capability:'object:'+x.bench.id+':dye-rust-solid'}:x.receipt);
  assert.equal(x.commits(),scenario==='batch-refused'?1:0,scenario);assert.equal(x.model.entities.get(x.bench.id)?.state?.water,scenario==='water-used'?0:2,scenario);const c=x.model.entities.get(x.cloth.id);if(c&&scenario!=='finish-changed')assert.equal(c.state?.dye,0,scenario);
 }
});
test('finite choices can re-dye the same persistent cloth without birth; duplicate delivery consumes once',()=>{
 const x=setup(),n=x.model.entities.size;x.service.onReceipt({...x.receipt,phase:'started'});x.service.onReceipt(x.receipt);x.service.onReceipt(x.receipt);assert.equal(x.commits(),1);let c=x.model.entities.get(x.cloth.id)!;assert.equal(c.state?.dye,1);assert.equal(c.state?.banded,true);assert.match(c.about!.what!,/Indigo banded cloth dyed by Ana/);assert.equal(x.model.entities.get(x.bench.id)?.state?.water,1);
 const second={...x.receipt,id:'second',capability:'object:'+x.bench.id+':dye-rust-solid',endedTick:700};x.service.onReceipt({...second,phase:'started'});x.service.onReceipt(second);x.service.onReceipt(second);c=x.model.entities.get(x.cloth.id)!;assert.equal(x.commits(),2);assert.equal(x.model.entities.size,n);assert.equal(c.state?.dye,2);assert.equal(c.state?.banded,false);assert.match(c.about!.what!,/Rust solid cloth dyed by Ana/);assert.equal(x.model.entities.get(x.bench.id)?.state?.water,0);assert.equal(x.model.entities.get(x.bench.id)?.state?.indigo,0);assert.equal(x.model.entities.get(x.bench.id)?.state?.rust,0);
});
test('new exact-def actions use native craft/brush, empty hands and the actual body floor',()=>{
 const x=setup(),soul={soulId:'s-ana',entityId:'ana',name:'Ana'}as never,p=x.service.plan(soul,x.bench.id,'dye-indigo-solid')!;assert.ok('steps'in p);assert.deepEqual(p.steps[2].params,{activity:'craft',seconds:10,prop:'brush',face:[.25,0]});
 x.body.pose.p[1]=3;assert.match(JSON.stringify(x.service.plan(soul,x.bench.id,'dye-indigo-solid')),/same floor/);x.body.pose.p[1]=0;x.body.human={holding:true}as never;assert.match(JSON.stringify(x.service.plan(soul,x.bench.id,'dye-indigo-solid')),/Put down/);assert.equal(x.service.plan(soul,x.cloth.id,'dye-indigo-solid'),null);assert.equal(x.service.plan(soul,x.bench.id,'other'),null);
});
