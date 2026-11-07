import test from 'node:test';
import assert from 'node:assert/strict';
import {resolvedParts} from './resolved-parts.ts';
test('discovery is bounded, ranks queried parts and never manufactures actions',()=>{
 const parts=Array.from({length:12},(_,i)=>({id:`p${i}`,title:i===11?'Reading nook':`View ${i}`}));
 const place={id:'public',ref:'public',parts};
 const L={places:{byId:new Map([['public',place]])},coreA:{binds:()=>({caps:[],plans:new Map()})},resolveOnDemand:()=>assert.fail('descriptive parts cannot be actions')} as any;
 const result=resolvedParts(L,{soulId:'s'} as any,'walk:public','reading nook') as any;
 assert.equal(result.parts.length,8);assert.equal(result.parts[0].id,'p11');assert.ok(result.parts.every((p:any)=>!p.affordances));
 assert.deepEqual(resolvedParts(L,{soulId:'s'} as any,'walk:missing'),{});
});

