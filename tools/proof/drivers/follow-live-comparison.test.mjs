import test from 'node:test';import assert from 'node:assert/strict';
import {liveFollowDeclaration,landmark,commandDue,observedAction,liveRowsValid,phaseEvidence,observedStop,applicable} from './follow-live-comparison.mjs';
test('frozen live declaration and native phase schedule',()=>{
 const p={variant:'legacy',seconds:60,quietSeconds:2,wallLimitSeconds:75};assert.deepEqual(liveFollowDeclaration(p),p);assert.throws(()=>liveFollowDeclaration({...p,seconds:61}));
 assert.equal(commandDue(0,[]),'walk');assert.equal(commandDue(24.99,['walk']),null);assert.equal(commandDue(25,['walk']),'stop');assert.equal(commandDue(28.99,['walk','stop']),null);assert.equal(commandDue(29,['walk','stop']),'restart');assert.equal(commandDue(60,['walk','stop','restart']),'complete');
});
test('semantic point resolution refuses real ambiguity',()=>{
 assert.equal(landmark({found:[{name:'orchard',kind:'eden:orchard',id:'point'},{name:'orchard',kind:'eden:place',id:'place'}]},'orchard').id,'point');
 assert.throws(()=>landmark({found:[]},'plaza'));assert.throws(()=>landmark({found:[{name:'plaza',id:'a'},{name:'plaza',id:'b'}]},'plaza'));
});
const row=(tick,history=false,id='body')=>({tick,key:JSON.stringify([{epoch:JSON.stringify(['world','epoch',history])},id]),subject:{id},mode:'follow'});
test('actual live epoch and selected body remain bound',()=>{
 const rows=Array.from({length:20},(_,i)=>row(i));assert.ok(liveRowsValid(rows,['body']));assert.ok(!liveRowsValid(rows.map(r=>({...r,subject:{id:'other'}})),['body']));assert.ok(!liveRowsValid(rows.map((r,i)=>i===12?row(i,true):r),['body']));assert.ok(!liveRowsValid(rows.map((r,i)=>i===12?row(0):r),['body']));
});
function samples({stopActivity='idle',stopSpeed=0,stalled=false}={}){return Array.from({length:601},(_,i)=>{const t=i/10,x=t<25?t*1.4:t<29?35+(t-25)*stopSpeed:35+(t-29)*1.4;return {at:i*100,tick:stalled?0:t*20,activity:'idle',subject:{activity:{kind:t<25||t>=29?'walk':stopActivity},transform:{positionM:[x,0,0]}}};});}
test('depicted stop admits small drift and requires real phases',()=>{
 const s=phaseEvidence(samples({stopSpeed:.016}),0);assert.ok(applicable(s,{valid:true,...s.stop}));assert.ok(s.stop.distanceM>.05&&s.stop.distanceM<.1);
 assert.ok(!applicable(s,{valid:true,...phaseEvidence(samples({stopSpeed:1.4}),0).stop}));assert.ok(!applicable(phaseEvidence(samples({stalled:true}),0),{valid:true,...s.stop}));
});
test('observation gaps and brief jumps are retained rather than hidden',()=>{
 const rows=samples();rows[101].subject.transform.positionM[0]+=1.3;rows[102].at+=700;
 const result=phaseEvidence(rows,0);assert.ok(result.walk.maxStepM>1.3);assert.ok(result.walk.maxObservationGapMs>=800);
});
test('transport activity cannot supply a depicted stop; fragmented idle cannot bridge gaps',()=>{
 const disagree=samples({stopActivity:'walk'});assert.ok(disagree.every(r=>r.activity==='idle'));assert.equal(phaseEvidence(disagree,0).stop.idleSeconds,0);
 const fragmented=samples();fragmented[269].subject.activity.kind='walk';const s=phaseEvidence(fragmented,0);assert.ok(s.stop.idleSeconds>2.5);assert.ok(s.stop.longestIdleSeconds<2.5);
});
test('late native completion still refuses the wall bound',()=>{assert.equal(observedAction(60,['walk','stop','restart'],74999),'complete');assert.throws(()=>observedAction(60,['walk','stop','restart'],75000));assert.throws(()=>observedAction(30,['walk','stop','restart'],76000));});
const commands=[{kind:'stop',before:{tick:500}},{kind:'restart',before:{tick:580}}];
function delayed(){return samples().map((s,i)=>{const t=i/10;return {...s,subject:{id:'body',activity:{kind:t<26.5||t>=30.4?'walk':'idle'},transform:{positionM:[t<26.5?t:26.5,0,0]}}};});}
test('delayed depicted stop uses the first command-bound run without changing nominal phases',()=>{
 const rows=delayed(),stop=observedStop(rows,commands),nominal=phaseEvidence(rows,0);assert.ok(stop.valid);assert.ok(stop.nativeSeconds>=3.5);assert.ok(nominal.stop.longestIdleSeconds<2.5);assert.equal(stop.distanceM,0);
});
test('no walk-through, fragmented idle, unknown gap, later arrival, or pre-restart stop can qualify',()=>{
 const variants=[rows=>rows.forEach(s=>s.subject.activity.kind='walk'),rows=>{rows[280].subject.activity.kind='walk';},rows=>{rows[280].subject.activity.kind='unknown';},rows=>{rows[280].at+=500;},rows=>rows.forEach((s,i)=>s.subject.activity.kind=i>=470?'idle':'walk'),rows=>rows.forEach((s,i)=>s.subject.activity.kind=i>=265&&i<280?'idle':'walk')];
 for(const change of variants){const rows=delayed();change(rows);assert.equal(observedStop(rows,commands).valid,false);}
});
