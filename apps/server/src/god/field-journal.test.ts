import{test}from'node:test';import assert from'node:assert/strict';
import{WorldModel,coreLibrary,applyBatch,type Op}from'@souls/world-compiler';
import{createFieldJournal}from'./field-journal.ts';import type{EdgeReceipt}from'../edge/contract.ts';
function setup(){const model=new WorldModel({constants:{ground:'land',extent:100},seed:'linen-dye-controls'});model.library=coreLibrary();const edit=(ops:Op[])=>{const r=applyBatch(model,{ops},'god',0);assert.equal(r.result.accepted,true,JSON.stringify(r.result));};
 edit([{op:'place',def:'core/field-writing-desk@1',name:'bench',in:{parent:'world'},p:[0,0],mode:'strict'},{op:'place',def:'core/field-journal@1',name:'journal',in:{parent:'bench',slot:'journal'},p:[0,0],mode:'strict'}]);
 const bench=[...model.entities.values()].find(e=>e.name==='bench')!,linen=[...model.entities.values()].find(e=>e.name==='journal')!,body={pose:{p:[.25,0,.8]},human:{}},support={kind:'resting-on',on:bench.id};let denied='',refused=false,commits=0,bodyId='ana';
 const service=createFieldJournal({model,engine:{world:{entities:{ana:body,[linen.id]:{support}}}},levelAt:(_x,_z,y)=>y>2?1:0,soul:()=>({id:'s-ana',entity_id:bodyId,name:'Ana'}),denied:id=>id===denied?{code:'object.private',reason:'Private'}:null,commit(ops,_note,clientRef){commits++;assert.match(clientRef,/^field-journal:/);if(refused)return{accepted:false};edit(ops);return{accepted:true};},log(){}});
 edit([{op:'set',id:linen.id,state:{draft:'First camp observation.'}}]);
 const receipt={id:'work',soulId:'s-ana',capability:'object:'+bench.id+':append-entry',phase:'completed',endedTick:400}as EdgeReceipt;
 return{model,bench,linen,body,support,service,receipt,edit,deny:(id:string)=>{denied=id;},refuse:()=>{refused=true;},swapBody:()=>{bodyId='other';},commits:()=>commits};}
test('append binds the exact journal, draft, history, ink, body and desk until natural completion',()=>{
 for(const scenario of['ink-used','missing','moved','replacement','native-detached','private-journal','private-desk','body-away','desk-moved','draft-changed','history-changed','wrong-floor','body-changed','hands-filled','older','batch-refused','interrupted','no-start']){
  const x=setup();if(scenario!=='no-start')x.service.onReceipt({...x.receipt,phase:'started'});
  if(scenario==='ink-used')x.edit([{op:'set',id:x.bench.id,state:{ink:0}}]);
  if(scenario==='missing'||scenario==='replacement')x.edit([{op:'remove',id:x.linen.id,cascade:false}]);
  if(scenario==='replacement')x.edit([{op:'place',def:'core/field-journal@1',name:'replacement',in:{parent:x.bench.id,slot:'journal'},p:[0,0],mode:'strict'}]);
  if(scenario==='moved')x.edit([{op:'move',id:x.linen.id,in:{parent:'world'},p:[8,0],mode:'strict'}]);if(scenario==='native-detached')x.support.kind='in-hand';
  if(scenario==='private-journal')x.deny(x.linen.id);if(scenario==='private-desk')x.deny(x.bench.id);if(scenario==='body-away')x.body.pose.p=[8,0,8];
  if(scenario==='desk-moved')x.edit([{op:'move',id:x.bench.id,p:[.1,0],mode:'strict'}]);if(scenario==='draft-changed')x.edit([{op:'set',id:x.linen.id,state:{draft:'Changed during work'}}]);
  if(scenario==='history-changed')x.edit([{op:'set',id:x.linen.id,state:{history:'[{}]'}}]);
  if(scenario==='wrong-floor')x.body.pose.p[1]=3;if(scenario==='body-changed')x.swapBody();if(scenario==='hands-filled')x.body.human={holding:true}as never;
  if(scenario==='older')x.edit([{op:'set',id:x.bench.id,state:{lastCompletedTick:401}}]);if(scenario==='batch-refused')x.refuse();
  x.service.onReceipt(scenario==='interrupted'?{...x.receipt,phase:'replaced'}:x.receipt);
  assert.equal(x.commits(),scenario==='batch-refused'?1:0,scenario);assert.equal(x.model.entities.get(x.bench.id)?.state?.ink,scenario==='ink-used'?0:5,scenario);assert.equal(x.model.entities.get(x.linen.id)?.state?.count??0,0,scenario);
 }
});
test('five ordered signed entries consume five ink, preserve all earlier words and reject duplicates/full journal',()=>{
 const x=setup(),original=x.linen.id,soul={soulId:'s-ana',entityId:'ana',name:'Ana'}as never;
 for(let i=0;i<5;i++){
  const text=`Observation ${i+1}`;x.edit([{op:'set',id:original,state:{draft:text}}]);const r={...x.receipt,id:'entry-'+i,endedTick:400+i*210};
  x.service.onReceipt({...r,phase:'started'});assert.equal(x.model.entities.get(original)?.state?.count,i);x.service.onReceipt(r);x.service.onReceipt(r);
  const state=x.model.entities.get(original)!.state!,history=JSON.parse(String(state.history));assert.equal(state.count,i+1);assert.equal(state.draft,'');assert.equal(x.model.entities.get(x.bench.id)?.state?.ink,4-i);assert.deepEqual(history.map((e:{entry:string})=>e.entry),Array.from({length:i+1},(_,j)=>`Observation ${j+1}`));assert.ok(history.every((e:{by:string;writer:string})=>e.by==='Ana'&&e.writer==='s-ana'));
 }
 assert.equal(x.commits(),5);assert.match(JSON.stringify(x.service.plan(soul,x.bench.id,'append-entry',()=>({p:[.25,.8],level:0}))),/full/);assert.match(x.service.facts(original)?.fieldJournal??'',/Observation 1.*Observation 5/);
});
test('only exact desk append uses native writing/pen; blank draft and occupied hands block',()=>{
 const x=setup(),soul={soulId:'s-ana',entityId:'ana',name:'Ana'}as never,p=x.service.plan(soul,x.bench.id,'append-entry',()=>({p:[.25,.8],level:0}))!;assert.ok('steps'in p);assert.deepEqual(p.steps[2].params,{activity:'write',seconds:10,prop:'pen',face:[.12,0]});
 x.edit([{op:'set',id:x.linen.id,state:{draft:''}}]);assert.match(JSON.stringify(x.service.plan(soul,x.bench.id,'append-entry',()=>({p:[.25,.8],level:0}))),/Draft/);assert.equal(x.service.plan(soul,x.linen.id,'append-entry',()=>null),null);assert.equal(x.service.plan(soul,x.bench.id,'draft-entry',()=>null),null);
});

test('native approach is bound to the actual journal and retains no-clear-route refusal',()=>{const x=setup(),soul={soulId:'s-ana',entityId:'ana',name:'Ana'}as never;let observed='';const p=x.service.plan(soul,x.bench.id,'append-entry',(id,_soul,_front,radius)=>{observed=id;assert.equal(radius,1.5);return{p:[.9,.8],level:0};})!;assert.equal(observed,x.linen.id);assert.ok('steps'in p);assert.deepEqual(p.steps[1].params,{x:.9,z:.8,level:0});assert.match(JSON.stringify(x.service.plan(soul,x.bench.id,'append-entry',()=>null)),/ordinary reachable/);});
