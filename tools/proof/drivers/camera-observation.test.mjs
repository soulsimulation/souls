import test from 'node:test';import assert from 'node:assert/strict';import {alignmentValid} from './camera-observation.mjs';
test('alignment requires actual present subject, finite depicted tick and matching rendered matrix',()=>{
 const r={frame:{status:'observed',value:{depicted:{tick:1.25},subjects:[{id:'subject',state:'present',transform:{positionM:[1,2,3]}}]}},alignment:[{id:'subject',matrixPosition:[1,2,3]}]};assert.equal(alignmentValid(r,'subject'),true);r.alignment[0].matrixPosition[0]=2;assert.equal(alignmentValid(r,'subject'),false);assert.equal(alignmentValid(r,'missing'),false);
});
