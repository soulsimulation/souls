import{test}from'node:test';import assert from'node:assert/strict';
import{chunkOf}from'../../../../apps/web/src/v2-engine/takes.ts';
import{TakePeople}from'./take-replay.ts';import type{HumanViews,SampledHuman}from'./humans.ts';import type{Take}from'../../engine/take/types.ts';
import{heldArmBinding}from'./held-arm-origin.ts';
const Q=2**30,resources=[['souls:hand-left',2,7],['souls:hand-right',2,4]];
const held=(at:number,soup?:number)=>({observedAt:at,entries:soup===undefined?[]:[{id:'same',kind:'eden:soup_bowl@aa',parent:'native',slot:7,pos:[0,0,0] as const,rot:[Q,0,0,0] as const,fields:{28:soup}}]});
const body=(observations:ReturnType<typeof held>[])=>({entity:'person',soul:'soul',name:'Person',heading:0,samples:[{at:0,p:[0,0,0] as [number,number,number]}],held:[],heldEntries:observations,look:{family:'humanoid',nativeBody:'native',nativeKindHash:'ab'.repeat(32),nativeResources:resources}});
const take=(observations:ReturnType<typeof held>[],from=0,rulesVersion='held-arm')=>chunkOf([body(observations)],from,{rulesVersion,datetime:null},40).take as unknown as Take;
function reader(t:Take,history:Take[]=[]){const p=new TakePeople(t);if(history.length)p.setWaterHistory(history);let current:SampledHuman|undefined;(p as unknown as{humans:HumanViews}).humans.setFrame=f=>{current=f[0];};return{at(time:number){p.show(time,9000);return current!;},dispose:()=>p.dispose()};}
test('held binding ignores quantity but ambiguous occupants remain unknown',()=>{
 const hands={body:'native',kindHash:'ab'.repeat(32),resources:resources as [string,number,number][]};
 assert.equal(heldArmBinding({nativeHands:hands,heldEntries:held(0,2)}),heldArmBinding({nativeHands:hands,heldEntries:held(1,0)}));
 const same=held(0,2);assert.equal(heldArmBinding({nativeHands:hands,heldEntries:{...same,entries:[...same.entries,{...same.entries[0],id:'duplicate'}]}}),undefined);
});
test('actual replay forwards absolute entry/release/re-lift predecessors and quantity does not restart',()=>{
 const r=reader(take([held(0),held(100000,2),held(200000,1),held(250000),held(300000,2)]));try{
  const entry=r.at(.15);assert.equal(entry.heldArmKnown,true);assert(Math.abs(entry.heldArmOrigin!.at-.1)<1e-12);assert(Math.abs(entry.heldArmOrigin!.age-.05)<1e-12);assert.equal(entry.heldArmOrigin!.sample.heldEntries!.entries.length,0);
  const quantity=r.at(.225);assert.equal(quantity.heldArmOrigin!.at,.1);
  const release=r.at(.275);assert.equal(release.heldEntries!.entries.length,0);assert.equal(release.heldArmOrigin!.sample.heldEntries!.entries[0].fields![28],1);
  const relift=r.at(.325);assert(Math.abs(relift.heldArmOrigin!.at-.3)<1e-12);assert.equal(relift.heldArmOrigin!.history!.length,2);assert.deepEqual(relift.heldArmOrigin!.hands,['left']);
  assert.deepEqual(JSON.parse(JSON.stringify(r.at(.15).heldArmOrigin)),JSON.parse(JSON.stringify(entry.heldArmOrigin)),'backward seek reconstructs immutable same predecessor');
 }finally{r.dispose();}
});
test('first already-held observation has no invented empty predecessor',()=>{const r=reader(take([held(0,2)]));try{assert.equal(r.at(.2).heldArmKnown,false);assert.equal(r.at(.2).heldArmOrigin,undefined);}finally{r.dispose();}});
test('adjacent exact history carries a predecessor across cuts; real/foreign gaps do not',()=>{
 const records=[held(0),held(1900000,2),held(1950000),held(2050000,2)],a=take(records),b=take(records,40),r=reader(b,[a,b]);try{assert.equal(r.at(.1).heldArmKnown,true);assert(Math.abs(r.at(.1).heldArmOrigin!.at-2.05)<1e-12);assert.equal(r.at(.1).heldArmOrigin!.history!.length,2);}finally{r.dispose();}
 const foreign={...a,rulesVersion:'foreign'},gap=reader(b,[foreign,b]);try{assert.equal(gap.at(.1).heldArmOrigin!.history!.length,0,'known empty at current cut permits entry but foreign earlier chain is absent');}finally{gap.dispose();}
 const still=take([held(0),held(1900000,2)],40),unknown=reader(still,[foreign,still]);try{assert.equal(unknown.at(.1).heldArmKnown,false);}finally{unknown.dispose();}
});

test('partner-only contact boundaries invalidate free-arm origins without changing the activity',()=>{
 const t=take([held(0),held(100000,2)]);t.changes.push([4,'person','partner','other'],[6,'person','partner',null]);t.changes.sort((a,b)=>a[0]-b[0]);
 const r=reader(t);try{assert.equal(r.at(.15).heldArmKnown,true);assert.equal(r.at(.25).partner,'other');assert.equal(r.at(.25).heldArmKnown,false);assert.equal(r.at(.325).heldArmKnown,false,'ending an owner is not a fabricated free-arm predecessor');assert.equal(r.at(.325).heldArmOrigin,undefined);}finally{r.dispose();}
});
