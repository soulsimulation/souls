import test from 'node:test';import assert from 'node:assert/strict';import{routeCoverage,ROUTE,compositionPresent,compositionConsistent}from'./camera-follow-source.mjs';
test('route summary uses actual positions, retaining stop and reversal',()=>{const rows=[[0,0,0],[5,0,0],[5,0,0],[0,0,0]].map(positionM=>({subject:{transform:{positionM}}}));const c=routeCoverage(rows);assert.equal(c.distanceM,10);assert.equal(c.largestTurnDegrees,180);assert.equal(c.stationarySamples,1);assert.equal(ROUTE.length,2);});

test('composition refuses absent or nonfinite camera data',()=>{assert.equal(compositionPresent({}),false);const p={eye:[0,0,0],target:[1,1,1],cameraWorld:Array(16).fill(1),projection:Array(16).fill(1)};assert.equal(compositionPresent(p),true);p.eye[0]=NaN;assert.equal(compositionPresent(p),false);});

test('starting composition rejects a previous draw matrix after reset changes eye',()=>{const r={eye:[0,0,10],target:[0,0,0],cameraWorld:[1,0,0,0,0,1,0,0,0,0,1,0,0,0,10,1],projection:Array(16).fill(1)};assert.equal(compositionConsistent(r),true);r.eye[0]=2;assert.equal(compositionConsistent(r),false);});
