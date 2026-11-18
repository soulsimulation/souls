import test from 'node:test';
import assert from 'node:assert/strict';
import {findNext,refusalList,shortLabel} from './eden.mjs';
test('#1268: a short label drops the bracketed id, stays under the bound and keeps the distance',()=>{
 const long=`Walk to Cottage Bench [cottage/bench], ${'A two-seat wooden bench outside Knoll Cottage, '.repeat(4)}by knoll (39 m)`;
 const short=shortLabel('walk:cottage/bench',long);
 assert.ok(short.length<=80,short); assert.ok(short.startsWith('Walk to Cottage Bench, A two-seat'),short); assert.ok(short.endsWith('… (39 m)'),short); assert.ok(!short.includes('['));
 assert.ok(shortLabel('hang-out:knoll',`Hang out at knoll (${'grass '.repeat(30)}; 39 m)`).endsWith('… (39 m)'));
 assert.equal(shortLabel('sit:hall/part-a','Sit at Audience Bench [hall/part-a]'),'Sit at Audience Bench');
 assert.equal(shortLabel('cheer:here','Cheer (params.to: someone)'),'Cheer (params.to: someone)');
 assert.ok(shortLabel('make:mark','Leave a note '.repeat(20)).endsWith('…'));
 for(const long of ['Walk to '+'名'.repeat(120),'x'.repeat(200),`Walk to ${'名'.repeat(120)} (39 m)`,'😀'.repeat(60)]){const s=shortLabel('walk:x',long);assert.ok(s.length>40&&s.length<=80,s);}
 assert.ok(shortLabel('walk:x',`Walk to a place ${'very far off '.repeat(9)}(1,200 m)`).endsWith('… (1,200 m)'));
 assert.doesNotMatch(shortLabel('walk:x','a '+'😀'.repeat(60)),/[\ud800-\udbff]…$/);
});
test('#1268: a refusal is one list: the ids once, the world\'s label, parameter names, unavailability only when so',()=>{
 const candidates=[{id:'walk:a',verb:'walk',label:'Walk to A',available:true,params:{with:{type:'array'}}},{id:'walk:b',verb:'walk',label:'Walk to B',available:false,blocked:{code:'route.unreachable',reason:'closed'}},{id:'walk:c',verb:'walk',label:'C',available:true},{id:'walk:d',verb:'walk',label:'D',available:true}];
 const did_you_mean=[{id:'walk:a',label:'A — the place',what:'more',target:{}},{id:'walk:b',label:'Walk to B'}];
 assert.deepEqual(refusalList({code:'capability.unknown',did_you_mean,candidates}),{did_you_mean:[{id:'walk:a',label:'A — the place',params:['with']},{id:'walk:b',label:'Walk to B',available:false,blocked:{code:'route.unreachable',reason:'closed'}},{id:'walk:c',label:'C'}]});
 const choice=refusalList({code:'capability.choose',did_you_mean,candidates}); assert.equal(choice.did_you_mean.length,4,'a choice keeps its list'); assert.equal(choice.more,undefined);
 const eight=Array.from({length:8},(_,i)=>({id:`sit:s${i}`,label:`Seat ${i}`})); const cut=refusalList({code:'capability.choose',did_you_mean:eight}); assert.equal(cut.did_you_mean.length,5); assert.equal(cut.more,'--json shows all 8','a cut choice says so; cut guesses need not');
 assert.equal(refusalList({code:'place.ambiguous',did_you_mean,candidates}).did_you_mean.length,4);
 assert.deepEqual(refusalList({code:'ride.unavailable'}),{});
 // a choice carries availability on its own entry, and the candidate beside it can say otherwise
 assert.deepEqual(refusalList({code:'capability.choose',did_you_mean:[{id:'walk:far',label:'Far',available:false,reason:'Too far.'}],candidates:[{id:'walk:far',available:true}]}).did_you_mean,[{id:'walk:far',label:'Far',available:false,blocked:{reason:'Too far.'}}]);
 assert.deepEqual(refusalList({code:'capability.choose',did_you_mean:[{id:'walk:far',label:'Far',available:false,reason:'Too far.'}]}).did_you_mean[0].blocked,{reason:'Too far.'},'an act\'s choice has no candidates');
});

test('#1948: an id the world refuses with no list is searched for on this machine by its words',()=>{
 const reason='"walk:eden-pond-north" is not an offer on this Soul right now, so nothing was done. Send an offered id, or find one by its words.';
 assert.deepEqual(findNext('walk:eden-pond-north',{code:'capability.unknown',reason}),{next:'node eden.mjs find "walk eden pond north"'});
 assert.deepEqual(findNext('fly:here',{code:'capability.unknown'}),{next:'node eden.mjs find "fly"'});
 assert.deepEqual(findNext('walk:x',{code:'capability.unknown',did_you_mean:[{id:'walk:y',label:'Y'}]}),{},'a world that still names others: its list');
 assert.deepEqual(findNext('sit:e_1',{code:'seat.taken'}),{},'a refusal of its own keeps its own words');
});
