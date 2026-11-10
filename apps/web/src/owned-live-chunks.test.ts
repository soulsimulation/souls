import test from 'node:test';import assert from 'node:assert/strict';
import {hydrateTakeEntitiesV1,TakeEntitiesEncoderV1,type TakeEntitiesStateV1} from '@souls/protocol';
import {ownLiveChunk,detachedData} from './owned-live-chunks.ts';

const entity=(i:number)=>({id:'e'+i,kind:i%3?'tree':'person',pose:{p:[i,0,i/2],yaw:.25},tags:['a'],state:{hp:3,inv:[{k:'apple',n:i}]}});
const table=(n:number)=>Object.fromEntries(Array.from({length:n},(_,i)=>['e'+i,entity(i)]));
const chunk=(tick:number,entities:unknown)=>({fromTick:tick-1,toTick:tick,take:{schema:'mars-take/4',id:'t'+tick,baselineStateHash:'b',finalStateHash:'f'+tick,rulesVersion:'r',dt:.05,startTick:tick-1,ticks:1,keyframeEvery:10,tracks:{e0:[[0,0,0,0,0]]},changes:[],events:[],finalState:{tick,entities}}});
/** Chunks as the web viewer receives them over take-entities-ref/1: the decoder's shared, deeply frozen tables. */
function decoded(n:number){
 const t=table(n),moved={...t,e1:{...entity(1),pose:{p:[9,9,9],yaw:0}}},m={t:'takes',serverTick:3,chunks:[chunk(1,t),chunk(2,t),chunk(3,moved)]};
 const enc=new TakeEntitiesEncoderV1(),e=enc.encode(m,null)!,s:TakeEntitiesStateV1={last:null};
 return {raw:m,out:hydrateTakeEntitiesV1(JSON.parse(JSON.stringify(e.envelope)),s) as typeof m};
}

test('raw (unfrozen) chunks keep the old behaviour: exact, deeply frozen, never shared or cached',()=>{
 const t=table(5),a=chunk(1,t),b=chunk(2,t),before=JSON.stringify(a);
 const oa:any=ownLiveChunk(a),ob:any=ownLiveChunk(b);
 assert.deepEqual(oa,JSON.parse(before));assert.equal(JSON.stringify(a),before);assert.ok(Object.isFrozen(oa.take.finalState.entities.e0.pose.p));
 assert.notEqual(oa.take.finalState.entities.e0,ob.take.finalState.entities.e0,'mutable sources are copied each time');
 (t.e0 as any).pose.p[0]=42;assert.equal(oa.take.finalState.entities.e0.pose.p[0],0,'owned copy is detached');
 assert.equal((ownLiveChunk(chunk(3,t)) as any).take.finalState.entities.e0.pose.p[0],42,'a changed mutable source is copied afresh');
});

test('decoded shared tables: owned entities are made once and reused; output is exact and deeply frozen',()=>{
 const {raw,out}=decoded(50),owned=out.chunks.map(c=>ownLiveChunk(c) as any);
 // byte-identical to what the uncached path makes from the raw (never shared) chunk
 for(let i=0;i<3;i++)assert.equal(JSON.stringify(owned[i]),JSON.stringify(ownLiveChunk(JSON.parse(JSON.stringify(raw.chunks[i])))));
 assert.equal(owned[0].take.finalState.entities.e7,owned[1].take.finalState.entities.e7);
 assert.equal(owned[0].take.finalState.entities.e7,owned[2].take.finalState.entities.e7,'unchanged entity in a patched table is reused');
 assert.notEqual(owned[0].take.finalState.entities.e1,owned[2].take.finalState.entities.e1);
 // P2 phones (arrival): a deeply frozen, checked wire entity cannot change, so it is its own owned copy (no second copy)
 assert.equal(owned[0].take.finalState.entities.e7,(out.chunks[0] as any).take.finalState.entities.e7,'the frozen wire entity is reused, not copied');
 for(const o of owned){assert.ok(Object.isFrozen(o.take.finalState.entities));assert.ok(Object.isFrozen(o.take.finalState.entities.e2.state.inv[0]));}
});

test('cached entities still count toward the node budget, and partly frozen values are not cached',()=>{
 const {out}=decoded(20),c:any=out.chunks[0],t=c.take.finalState.entities;
 const first={nodes:0},second={nodes:0};detachedData(c,undefined,first,0,t);detachedData(c,undefined,second,0,t);
 assert.equal(second.nodes,first.nodes);assert.ok(first.nodes>20*10);
 const shallow=Object.freeze({id:'x',pose:{p:[1,2,3]}}),pt={x:shallow},a:any=ownLiveChunk(chunk(1,pt));
 shallow.pose.p[0]=7;const b:any=ownLiveChunk(chunk(2,pt));
 assert.equal(a.take.finalState.entities.x.pose.p[0],1);assert.equal(b.take.finalState.entities.x.pose.p[0],7);
});

test('a 4,900-entity shared table costs far less on the second chunk',t=>{
 const {out}=decoded(4900);const time=(c:unknown)=>{const at=performance.now();assert.ok(ownLiveChunk(c));return performance.now()-at;};
 const cold=time(out.chunks[0]),warm=time(out.chunks[1]),patched=time(out.chunks[2]);
 t.diagnostic(`cold ${cold.toFixed(1)} ms, shared ${warm.toFixed(1)} ms, patched ${patched.toFixed(1)} ms`);
 assert.ok(warm<cold/3,`shared ${warm} vs cold ${cold}`);
});

test('P2 arrival: a frozen wire entity is checked like a copy would be; anything not wholly frozen and plain is still copied or refused',()=>{
 const {out}=decoded(3),c:any=out.chunks[0];
 const swap=(e:unknown)=>({...c,take:{...c.take,finalState:{...c.take.finalState,entities:Object.freeze({...c.take.finalState.entities,e0:e})}}});
 // a frozen entity with an unfrozen part: copied (not the wire object), and that copy is frozen and detached
 const inner={p:[1,2,3]},partly=Object.freeze({id:'e0',pose:inner}),a:any=ownLiveChunk(swap(partly));
 assert.notEqual(a.take.finalState.entities.e0,partly);assert.ok(Object.isFrozen(a.take.finalState.entities.e0.pose.p));inner.p[0]=9;assert.equal(a.take.finalState.entities.e0.pose.p[0],1);
 // frozen but not plain data: refused exactly as the copying path refuses it
 assert.equal(ownLiveChunk(swap(Object.freeze({id:'e0',hp:Number.NaN}))),null,'non-finite');
 assert.equal(ownLiveChunk(swap(Object.freeze(Object.defineProperty({id:'e0'},'hp',{get:()=>1,enumerable:true})))),null,'accessor');
 assert.equal(ownLiveChunk(swap(Object.freeze(Object.assign(Object.create({inherited:1}),{id:'e0'})))),null,'non-plain prototype');
 // the wire table itself is reused (no rebuilt 4,900-key object per chunk, no schema copy), and shared by chunks that share it
 const {raw,out:o2}=decoded(30),w:any=o2.chunks,own0:any=ownLiveChunk(w[0]),own1:any=ownLiveChunk(w[1]);
 assert.equal(own0.take.finalState.entities,w[0].take.finalState.entities);assert.equal(own1.take.finalState.entities,own0.take.finalState.entities);
 assert.equal(JSON.stringify(own0),JSON.stringify(ownLiveChunk(JSON.parse(JSON.stringify(raw.chunks[0])))),'exactly what the copying path makes');
 assert.ok(Object.isFrozen(own0)&&Object.isFrozen(own0.take.finalState));
 // the node budget counts a reused entity exactly as a copied one
 const frozenBudget={nodes:0},copiedBudget={nodes:0},e=c.take.finalState.entities;
 detachedData(c,undefined,frozenBudget,0,e);detachedData(JSON.parse(JSON.stringify(c)),undefined,copiedBudget,0);
 assert.equal(frozenBudget.nodes,copiedBudget.nodes);
});
