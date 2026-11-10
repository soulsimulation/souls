import test from 'node:test';
import assert from 'node:assert/strict';
import {WorldModel,coreLibrary,applyBatch,opSchema} from '@souls/world-compiler';
import {createCandleMolding} from './candle-molding.ts';
import type {EdgeReceipt} from '../edge/contract.ts';
function fixture(){
 const model=new WorldModel({constants:{extent:80,ground:'land'},seed:'candle-molding'});model.library=coreLibrary();
 const edit=(ops:unknown[])=>{const r=applyBatch(model,{ops:ops.map(o=>opSchema.parse(o))},'god',0);assert.equal(r.result.accepted,true,JSON.stringify(r.result));};
 edit([{op:'place',def:'core/candle-mold-bench@1',name:'ana-mold',p:[0,0]}]);
 const id=[...model.entities.values()][0].id,entities:Record<string,any>={ana:{pose:{p:[0,0,1.1]},human:{}},[id]:{pose:{p:[0,0,0]},support:{kind:'ground'}}};let denied=false,refused=false,commits=0;
 const service=createCandleMolding({model,engine:{world:{entities,tick:20}},levelAt:()=>0,soul:()=>({id:'ana',entity_id:'ana',name:'Ana'}),denied:()=>denied?{code:'object.private',reason:'Private mold bench'}:null,commit(ops){commits++;if(refused)return{accepted:false};edit(ops);return{accepted:true};},log(){}}),soul={soulId:'ana',entityId:'ana',name:'Ana'} as never;
 let serial=0;const run=(verb:string,text?:string,change?:()=>void,end=120)=>{service.expect(soul,id,verb,text===undefined?undefined:{text});const r={id:'r'+serial++,soulId:'ana',capability:'object:'+id+':'+verb,phase:'started',acceptedTick:20,startedTick:20} as EdgeReceipt;service.onReceipt(r);change?.();service.onReceipt({...r,phase:'completed',endedTick:end});};
 return{model,id,entities,service,soul,run,get bench(){return model.entities.get(id)!;},outputs:()=>[...model.entities.values()].filter(e=>model.resolvedDef(e.def)?.name==='core-molded-candle'),deny:()=>denied=true,refuse:()=>refused=true,commits:()=>commits,edit};
}
test('all chosen forms and colors consume exactly one matching wax portion and wick into a real candle',()=>{
 for(const form of ['pillar','taper'])for(const color of ['red','blue','ivory']){
  const x=fixture();x.run('choose-form',form);x.run('choose-color',color);x.run('mold-candle');
  assert.equal(x.outputs().length,1);const out=x.outputs()[0];assert.equal(out.state!.form,form);assert.equal(out.state!.waxColor,color);assert.equal(out.state!.maker,'Ana');assert.equal(out.state!.waxUnits,1);assert.equal(out.state!.wickUnits,1);assert.equal(out.in.parent,x.id);assert.equal(out.in.slot,'output');assert.equal(out.params.form,form);assert.equal(out.owner,x.bench.owner);assert.equal(out.access,x.bench.access);
  assert.equal(x.bench.state![color],1);assert.equal(x.bench.state!.wicks,5);assert.equal(x.bench.state!.made,1);for(const other of ['red','blue','ivory'].filter(v=>v!==color))assert.equal(x.bench.state![other],2);
 }
});
test('stale authority, definition, support, body, timing and refused admission preserve finite inputs',()=>{
 for(const key of ['owner','access','def','state','pose','support','hands','away','early','refused']){
  const x=fixture();x.run('mold-candle',undefined,()=>{if(key==='owner')x.bench.owner='soul:other';if(key==='access')x.bench.access='private';if(key==='def')x.bench.def='core-workbench@1';if(key==='state')x.bench.state!.waxColor='red';if(key==='pose')x.entities[x.id].pose.p[0]=.1;if(key==='support')x.entities[x.id].support.kind='in-hand';if(key==='hands')x.entities.ana.human.holding=true;if(key==='away')x.entities.ana.pose.p[0]=40;if(key==='refused')x.refuse();},key==='early'?99:120);
  assert.equal(x.outputs().length,0,key);assert.equal(x.bench.state!.ivory,2,key);assert.equal(x.bench.state!.wicks,6,key);assert.equal(x.bench.state!.made,0,key);
 }
});
test('occupied output, exhausted stock and invalid choices refuse usefully without credit; missing/stale starts do nothing',()=>{
 const x=fixture();x.run('mold-candle');assert.match((x.service.plan(x.soul,x.id,'mold-candle') as any).reason,/clear the output/i);assert.equal(x.bench.state!.made,1);
 const empty=fixture();empty.bench.state!.ivory=0;assert.match((empty.service.plan(empty.soul,empty.id,'mold-candle') as any).reason,/exhausted/);assert.match((empty.service.plan(empty.soul,empty.id,'choose-color',{text:'green'}) as any).reason,/red, blue or ivory/);empty.deny();assert.equal((empty.service.plan(empty.soul,empty.id,'choose-form') as any).code,'object.private');
 for(const key of ['missing','old','wrong-action','wrong-tick']){
  const y=fixture();if(key!=='missing')y.service.expect(y.soul,y.id,'mold-candle');const r={id:'old',soulId:'ana',capability:'object:'+y.id+':'+(key==='wrong-action'?'choose-form':'mold-candle'),phase:'started',acceptedTick:key==='old'?19:20,startedTick:key==='wrong-tick'?19:20} as EdgeReceipt;y.service.onReceipt(r);y.service.onReceipt({...r,phase:'completed',endedTick:120});assert.equal(y.commits(),0,key);assert.equal(y.outputs().length,0,key);assert.equal(y.bench.state!.ivory,2,key);
 }
});
