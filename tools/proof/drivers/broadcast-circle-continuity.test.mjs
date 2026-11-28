import{test}from'node:test';import assert from'node:assert/strict';import{continuityDeclaration,assessContinuity}from'./broadcast-circle-continuity.mjs';
const p={seconds:19,targetTick:0,toTick:400,departureTick:160,bodyIds:['a','b','c'],anchor:'a'};
const data=()=>{const samples=[],draws=[];for(let tick=0;tick<=380;tick+=4){samples.push({tick,at:1000+tick*50,bodies:p.bodyIds.map(id=>({id,p:[0,0,0],activity:id==='a'&&tick>=160?'walk':'listen'}))});for(let j=0;j<4;j++)draws.push({tick:tick+j,at:1000+(tick+j)*50,mode:0,history:1,key:'talk:scene:1',shot:'conversation:track'});}return{samples,draws};};
test('continuity declaration binds exact source interval, unique actual bodies and lexical anchor',()=>{assert.deepEqual(continuityDeclaration(p),p);for(const patch of [{bodyIds:['a','a','b']},{anchor:'b'},{toTick:379},{departureTick:400},{seconds:20}])assert.throws(()=>continuityDeclaration({...p,...patch}));});
test('continuity requires actual activity transition, advancing source and selected drawn talk on both sides',()=>{const{samples,draws}=data();const r=assessContinuity(p,samples,draws);assert.ok(r.inputBefore&&r.inputAfter&&r.progress&&r.selectedTalkBefore&&r.selectedTalkAfter);
 assert.equal(assessContinuity(p,samples.map(s=>({...s,bodies:s.bodies.filter(b=>b.id!=='c')})),draws).inputBefore,false);
 assert.equal(assessContinuity(p,samples.map(s=>({...s,bodies:s.bodies.map(b=>({...b,activity:'idle'}))})),draws).inputAfter,false);
 assert.equal(assessContinuity(p,samples.map(s=>({...s,tick:0})),draws).progress,false);
 assert.equal(assessContinuity(p,samples,[]).selectedTalkBefore,false);
 assert.equal(assessContinuity(p,samples,draws.map(d=>({...d,key:d.tick>160?'talk:scene:2':d.key}))).selectedTalkAfter,false);
 assert.equal(assessContinuity(p,samples,draws.map(d=>({...d,shot:''}))).selectedTalkBefore,false);
 // A later legitimate selection does not falsify the earlier observed continuity interval.
 assert.ok(assessContinuity(p,samples,draws.map(d=>({...d,key:d.tick>300?'soul:a':d.key}))).selectedTalkAfter);
});

test('continuity excludes preroll/other modes and refuses unrelated or disconnected circles',()=>{
 const{samples,draws}=data(),wrong=draws.map(d=>({...d,key:d.tick>160?'talk:new':d.key}));
 const preroll=draws.map(d=>({...d,at:d.at-30000}));assert.equal(assessContinuity(p,samples,[...preroll,...wrong]).selectedTalkAfter,false);
 for(const patch of [{history:0},{mode:1}])assert.equal(assessContinuity(p,samples,draws.map(d=>({...d,...patch}))).selectedTalkBefore,false);
 const extra=samples.map(s=>({...s,bodies:[...s.bodies,{id:'x',p:[30,0,0],activity:'listen'},{id:'y',p:[31,0,0],activity:'listen'}]}));assert.equal(assessContinuity(p,extra,draws).inputBefore,false);assert.equal(assessContinuity(p,extra,draws).inputAfter,false);
 const distant=samples.map(s=>({...s,bodies:s.bodies.map(b=>({...b,p:b.id==='c'?[10,0,0]:b.p}))}));assert.equal(assessContinuity(p,distant,draws).inputAfter,false);
});

test('post-event continuity cannot bridge an invalid middle input window or unordered source',()=>{
 const{samples,draws}=data(),limited=draws.map(d=>({...d,key:d.tick>180&&d.tick<250?'talk:scene:1':d.tick>160?'soul:a':d.key}));
 const broken=samples.map(s=>({...s,bodies:s.bodies.map(b=>({...b,activity:s.tick>=208&&s.tick<=224?'idle':b.activity}))}));
 assert.equal(assessContinuity(p,broken,limited).selectedTalkAfter,false);
 const unordered=[...samples].reverse();assert.equal(assessContinuity(p,unordered,draws).progress,false);
});
