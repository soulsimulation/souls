import test from 'node:test';
import assert from 'node:assert/strict';
import {humanIdsOf} from '../../../mars/viewer/app/engine-view/water-transition.ts';

const reference=(take:{finalState:{entities:Record<string,{kind:string}>};entities0?:Record<string,{kind:string}>})=>
 Object.entries({...take.finalState.entities,...take.entities0}).filter(([,e])=>e.kind==='human').map(([id])=>id);

test('P2: the human ids of the merged table, in its order, without building it', () => {
 const h={kind:'human'},t={kind:'thing'};
 const cases:{finalState:{entities:Record<string,{kind:string}>};entities0?:Record<string,{kind:string}>}[]=[
  {finalState:{entities:{a:h,b:t,c:h}},entities0:{d:h,b:h,c:t}},   // entities0 overrides kind both ways; a new id is appended
  {finalState:{entities:{'2':h,x:h,'1':t}},entities0:{'1':h,y:t}},  // integer-like keys keep the spread's order
  {finalState:{entities:{a:h,b:h}}},                                // no entities0
  {finalState:{entities:{}},entities0:{z:h}},
 ];
 for(const c of cases)assert.deepEqual(humanIdsOf(c as never),reference(c));
 const many=Object.fromEntries(Array.from({length:4900},(_,i)=>['e'+i,i%7?t:h]));
 assert.deepEqual(humanIdsOf({finalState:{entities:many},entities0:{e3:h,e7:t}} as never),reference({finalState:{entities:many},entities0:{e3:h,e7:t}}));
});
