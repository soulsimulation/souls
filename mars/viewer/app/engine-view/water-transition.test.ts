import test from 'node:test';
import assert from 'node:assert/strict';
import {humanIds} from './water-transition.ts';
type T=Record<string,{kind?:unknown}|undefined>;
// #1569: the expression humanIds replaced (it built the whole merged table for every take)
const old=(a:T,b?:T)=>Object.entries({...a,...b}).filter(([,e])=>e!.kind==='human').map(([id])=>id);
const H={kind:'human'},F={kind:'fixture'};
test('humanIds: same ids, same order as the merged table, overrides by the second table',()=>{
 const cases:[T,T|undefined][]=[
  [{a:H,b:F,c:H},{b:H,c:F,d:H}],            // override both ways, a key only in the second
  [{z:H,'10':H,y:F,'2':H},{'1':H,x:H,'10':F}],  // integer-like keys come first, ascending, from either table
  [{a:H,'4294967295':H,'4294967294':H,'01':H},{'3':H}],   // not array indexes: 2^32-1 and a leading zero keep insertion order
  [{a:H,b:H},undefined],                     // no entities0
  [{},{a:H}],
 ];
 for(const [a,b] of cases)assert.deepEqual(humanIds(a,b),old(a,b),JSON.stringify([a,b]));
});
test('humanIds: a 4,900-entity table',()=>{
 const a:T={},b:T={};
 for(let i=0;i<4900;i++){const id=i%7===0?String(i):`e-${(i*7919)%4900}`;a[id]=i%5===0?H:F;if(i%3===0)b[id]=i%2?H:F;}
 for(let i=0;i<40;i++)b[`late-${i}`]=H;
 const got=humanIds(a,b);assert.deepEqual(got,old(a,b));assert.ok(got.length>500);
});
