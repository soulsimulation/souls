import test from 'node:test';
import assert from 'node:assert/strict';
import {rankCapabilities,refusalList,shortLabel,searchOrder} from './eden.mjs';
test('phrase and all terms beat unrelated west noise before truncation, retaining partial fallback',()=>{
 const noise=Array.from({length:90},(_,i)=>({id:`sit:west-library-${i}`,verb:'sit',label:'West library chair'}));
 const bound={id:'sit:land-harbour-west-pier/part-sea-view-seat',verb:'sit',label:'Sit at Sea-View Bench'};
 const allTerms={id:'walk:other',verb:'walk',label:'Pier on the west waterfront'};
 const ranked=rankCapabilities([...noise,allTerms,bound],'west pier');
 assert.equal(ranked[0],bound);assert.equal(ranked[1],allTerms);assert.equal(ranked.length,92);
 assert.equal(rankCapabilities([...noise,bound],'west.pier|pier.bench').length,0,'literal matching does not pretend to support regex');
 assert.equal(rankCapabilities([bound],'sea view')[0],bound);
});
test('#1268: a word in an id or name ranks above the same word in a description',()=>{
 const scenery={id:'walk:green',verb:'walk',label:'Walk to Village Green [green], between the hall and the audience bench, by hall/bench (9 m)'};
 const seat={id:'sit:hall/part-a',verb:'sit',label:'Sit at Audience Bench [hall/part-a]'};
 const byId={id:'walk:cottage/bench',verb:'walk',label:'Walk to the Rest [cottage/bench], a place to pause (39 m)'};
 assert.deepEqual(rankCapabilities([scenery,seat,byId],'bench').map(c=>c.id),['sit:hall/part-a','walk:cottage/bench','walk:green']);
 assert.deepEqual(rankCapabilities([scenery,seat],'audience bench').map(c=>c.id),['sit:hall/part-a','walk:green']);
 assert.equal(rankCapabilities([{id:'walk:far',verb:'walk',label:'Walk to Far (a name, then a bench)'}],'bench').length,1,'a description alone still matches');
 const named={id:'walk:bench',verb:'walk',label:'Walk to the Bench'},scene={id:'walk:z',verb:'walk',label:'Walk to Z, a bench under a tree'};
 assert.deepEqual(rankCapabilities([scene,named],'bench oak').map(c=>c.id),['walk:bench','walk:z'],'a partial match too');
});
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

test('#1412: the places the world names lead in its order, over a better local match, each once; no places: the local ranking',()=>{
 const a={id:'walk:library-annex',verb:'walk',label:'Walk to the Library Annex'},b={id:'walk:eden-stacks',verb:'walk',label:'Walk to the Stacks, a quiet library room'};
 const far={id:'walk:region-reading-hall',verb:'walk',label:'Walk to Reading Hall (300 m)',aliases:['Reading Hall']},other={id:'sit:library-annex/part-chair',verb:'sit',label:'Sit at Library Annex Chair'};
 const list=[other,a,b,far];
 const local=rankCapabilities(list,'library').map(c=>c.id);
 assert.ok(local.indexOf('walk:library-annex')<local.indexOf('walk:eden-stacks')&&!local.includes('walk:region-reading-hall'),'locally the annex outranks the stacks, and the hall does not match');
 assert.deepEqual(searchOrder(list,'library',{places:['walk:region-reading-hall','walk:eden-stacks','walk:library-annex']}).map(c=>c.id),
  ['walk:region-reading-hall','walk:eden-stacks','walk:library-annex','sit:library-annex/part-chair'],'the world\'s order first, a place with no local match included, then the rest once');
 assert.deepEqual(searchOrder(list,'library',{places:['walk:gone',...['walk:eden-stacks']]}).map(c=>c.id)[0],'walk:eden-stacks','an id not in the list is skipped');
 assert.deepEqual(searchOrder(list,'library',undefined),rankCapabilities(list,'library'),'an old world: the local ranking');
 assert.deepEqual(searchOrder(list,'library',{places:[]}),rankCapabilities(list,'library'));
});
