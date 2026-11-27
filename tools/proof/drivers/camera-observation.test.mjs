import test from 'node:test';import assert from 'node:assert/strict';import {alignmentValid,depictedBodyIds,recordAlignment} from './camera-observation.mjs';
test('alignment requires actual present subject, finite depicted tick and matching rendered matrix',()=>{
 const r={frame:{status:'observed',value:{depicted:{tick:1.25,seconds:.0625},subjects:[{id:'subject',state:'present',transform:{positionM:[1,2,3]}}]}},drawn:{tick:1.25,seconds:.0625},alignment:[{id:'subject',matrixPosition:[1,2,3]}]};assert.equal(alignmentValid(r,'subject'),true);r.drawn.tick=2;assert.equal(alignmentValid(r,'subject'),false);r.drawn.tick=1.25;r.alignment[0].matrixPosition[0]=2;assert.equal(alignmentValid(r,'subject'),false);assert.equal(alignmentValid(r,'missing'),false);
});

test('native node identifiers are mapped through the actual bridge/default-look entity convention',()=>{
 const ids=depictedBodyIds('abc-0');assert.equal(ids[0],'v2_abc_0');assert.ok(ids[1].startsWith('v2_abc_0'));assert.equal(ids.includes('abc-0'),false);
});

test('failed phase evidence is written before the throwing alignment assertion',async()=>{
 const {mkdirSync,mkdtempSync,readFileSync,rmSync}=await import('node:fs');mkdirSync('.local/camera-observation-driver-tests',{recursive:true});const dir=mkdtempSync('.local/camera-observation-driver-tests/phase-');const value={frame:{status:'rejected',reason:'fixture'}};
 try {assert.throws(()=>recordAlignment(value,'history','subject',dir+'/phase.json',(_key,ok)=>assert.ok(ok)),assert.AssertionError);assert.deepEqual(JSON.parse(readFileSync(dir+'/phase.json','utf8')),value);}finally{rmSync(dir,{recursive:true,force:true});}
});
