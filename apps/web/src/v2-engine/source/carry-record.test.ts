import test from 'node:test';import assert from 'node:assert/strict';import {encode,decode}from'cborg';
import {carryFields,carryGrips,crewMembers,carryChanges,carryChangesInPart,historyMotion,nativeId,riderPoints}from'./carry-record.ts';
const id=(n:number)=>[new Uint8Array(16),n],m=(o:Record<number,unknown>)=>new Map(Object.entries(o).map(([k,v])=>[+k,v]));
const member=[['souls:front',id(1),id(2),id(3),id(4)]];
const grips=m({1:id(8),2:id(9),3:'souls:carry',4:100,6:[m({1:id(1),2:'point:grip',3:[0,0,0],4:[[0,-200000,0],[0,200000,0]]})]});
test('native nested grips and independent crew decode without changing plain kind-state semantics',()=>{assert.equal(carryGrips(grips)?.holds[0].body,nativeId(id(1)));assert.deepEqual(carryGrips(grips)?.holds[0].handsUm,[[0,-200000,0],[0,200000,0]]);assert.equal(crewMembers(member)?.length,1);assert.equal(crewMembers([...member,...member]),undefined);assert.equal(carryGrips(m({...Object.fromEntries(grips),6:[m({1:id(1),2:'point:g',3:[0,0,0],4:[[0,0,0]]})]})),undefined);});
test('all native membership, contact phases and mid-part transfer times survive independently',()=>{const pose=m({1:[id(7),1],2:[1,2,3],3:[2**30,0,0,0]});const e=[m({2:50,7:[m({1:4,2:id(8),3:4,4:member})]}),m({2:100,6:id(8),8:[m({1:'souls:carry-grips',2:grips})]}),m({2:125,9:m({1:1,3:id(9),6:pose})}),m({2:200,6:id(8),8:[m({1:'souls:carry-grips',2:new Map([...grips,[3,'souls:released'],[4,200]])})]})];const out=carryChanges(e);assert.deepEqual(out.map(x=>x.at),[50,100,125,200]);assert.equal(out[0].members?.[0].body,nativeId(id(1)));assert.equal(out[2].pose?.slot,1);assert.equal(out[3].grips?.phase,'souls:released');});
test('history retains full native rotation from the validated motion record rather than travel direction',()=>{const q=[0,0,2**30,0],pose=m({1:[id(7)],2:[1,2,3],3:q});const b=encode(m({6:m({8:[m({2:123,7:[m({1:7,2:m({1:id(9),2:125,5:pose})})]})]})}));assert.deepEqual(historyMotion(b),[[nativeId(id(9)),nativeId(id(7)),null,125,1,2,3,q]]);});

// Lift Leave from an observed validated public packet; all IDs/digests and the clock are neutralized.
test('sanitized canonical lift packet uses a frame array at its exact transfer boundary',()=>{
 const entry=decode(Buffer.from('pwEZAeUCGH0DogEBAoJQAAAAAAAAAAAAAAAAAAAAAAEEogEBAoJQAAAAAAAAAAAAAAAAAAAAAAIFoQEBBoJQAAAAAAAAAAAAAAAAAAAAAAMJpgEBAoJQAAAAAAAAAAAAAAAAAAAAAAQDglAAAAAAAAAAAAAAAAAAAAAAAwRQAAAAAAAAAAAAAAAAAAAAAAWCUAAAAAAAAAAAAAAAAAAAAAAFBqQBgoJQAAAAAAAAAAAAAAAAAAAAAAYBAoMAOgAIZG8AA4QaLUE8zQAaLUE8zQAEoQEC','base64'),{useMaps:true}),body=encode(m({2:[entry]})),v=(n:number)=>{const out=[];do{const b=n%128;n=Math.floor(n/128);out.push(b|(n?128:0));}while(n);return out;},packed=Uint8Array.from([...v(body.length),...v(body.length),...body,0]);
 assert.deepEqual(carryChangesInPart(encode(m({6:packed}))),[{at:125,node:nativeId(id(3)),pose:{parent:nativeId(id(6)),slot:1,pos:[0, -550000, 0],rot:[759250125, 0, 759250125, 0]}}]);
});

test('native node keys retain exact public u64 counters',()=>{assert.equal(nativeId([new Uint8Array(16),2n**64n-1n]),'00000000000000000000000000000000.18446744073709551615');assert.throws(()=>nativeId([new Uint8Array(16),2n**64n]),/native id range/);});

// Motion itself comes from the validated pose samples; carry-track labels have no page consumer.
test('unused track labels do not replace the release event when the crew is removed in that entry',()=>{
 const released=new Map([...grips,[3,'souls:released'],[4,200]]);
 const end=m({2:200,6:id(8),7:[m({1:2,2:id(8)})],8:[m({1:'souls:carry-track',2:m({1:id(8),2:id(9),3:'souls:set-down',4:100,5:200})}),m({1:'souls:carry-grips',2:released})]});
 const out=carryChanges([end]);assert.equal(out.length,1);assert.equal(out[0].at,200);assert.equal(out[0].node,nativeId(id(8)));assert.equal(out[0].grips?.phase,'souls:released');assert.deepEqual(out[0].grips?.holds,carryGrips(grips)?.holds);
});

// #5134: the generated activity's node says where it holds its slot's rider (native field 15, written when the node is
// made). Only that word gives an activity's node slot points: no kind name, no source entry and no zero is assumed.
test('an activity node reads its riders\' points from field 15; anything else leaves its slot unknown',()=>{
 const read=(fields:Record<number,unknown>,slots?:number[][])=>{const rec:Parameters<typeof carryFields>[0]={...(slots?{slots}:{})};carryFields(rec,m(fields));return rec;};
 assert.deepEqual(read({4:member,15:[[1,0,0,0]]}).slots,[[1,0,0,0]],'the points the world wrote');
 assert.deepEqual(read({4:member,15:[[1n,0n,-25n,0n]]}).slots,[[1,0,-25,0]],'whole numbers as the public record holds them');
 assert.equal('slots'in read({4:member}),false,'a crew of a world that does not say: no slot points, so its load stays unplaced');
 assert.equal('slots'in read({15:[[1,0,0,0]]}),false,'field 15 on a node that is no activity (no members) is another kind\'s own field');
 assert.equal('slots'in read({4:[...member,...member],15:[[1,0,0,0]]}),false,'nor on one whose membership does not read');
 for(const bad of [[],[[1,0,0]],[[1,0,0,0,0]],[[1,0,0,.5]],[[1,0,0,'0']],'[[1,0,0,0]]',[1,0,0,0],m({1:0})])assert.equal(riderPoints(bad),undefined,`malformed points say nothing: ${JSON.stringify(bad,(_,v)=>v instanceof Map?[...v]:v)}`);
 assert.equal('slots'in read({4:member,15:[[1,0,0]]}),false);
 assert.deepEqual(read({4:member,15:[[1,9,9,9]]},[[1,5,0,0]]).slots,[[1,5,0,0]],'a node\'s own slot points (field 13) are never replaced');
 assert.equal(read({4:member}).carryField,'absent');assert.equal(read({4:member,6:grips}).carryField,'valid');assert.equal(read({4:member,6:'x'}).carryField,'invalid');assert.equal('carryField'in read({}),false);
});
