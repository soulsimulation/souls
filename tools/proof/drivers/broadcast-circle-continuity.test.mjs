import{test}from'node:test';import assert from'node:assert/strict';import{continuityDeclaration,assessContinuity}from'./broadcast-circle-continuity.mjs';
const p={seconds:19,targetTick:0,toTick:400,departureTick:160,bodyIds:['a','b','c'],anchor:'a'};
const data=()=>{const samples=[],draws=[];for(let tick=0;tick<=380;tick+=4){samples.push({tick,bodies:p.bodyIds.map(id=>({id,p:[0,0,0],activity:id==='a'&&tick>=160?'walk':'listen'}))});for(let j=0;j<4;j++)draws.push({tick:tick+j,key:'talk:scene:1',shot:'conversation:track'});}return{samples,draws};};
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
