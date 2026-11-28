import test from 'node:test';import assert from 'node:assert/strict';import {WorldBroadcast} from './WorldBroadcast.ts';
test('diagnostic seed repeats picker reset while preserving opening state; defaults retain picker',()=>{const b=new WorldBroadcast(42) as any;const picker=b.picker,first=picker.random();picker.random();b.openingShown();b.reset();assert.notEqual(b.picker,picker);assert.equal(b.picker.random(),first);assert.equal(b.picker.openingShown,true);const normal=new WorldBroadcast() as any,original=normal.picker;normal.reset();assert.equal(normal.picker,original);});
test('diagnostic seed refuses values outside uint32',()=>{for(const seed of[-1,.5,NaN,Infinity,2**32])assert.throws(()=>new WorldBroadcast(seed),/seed-invalid/);});
test('sample timing includes final lifted pose construction and its bounded sequence survives reset',t=>{
 const global=globalThis as any,prior=global.__soulsBroadcastCost,priorSequence=global.__soulsBroadcastCostSequence;let clock=0;
 t.after(()=>{global.__soulsBroadcastCost=prior;global.__soulsBroadcastCostSequence=priorSequence;});global.__soulsBroadcastCost=[];global.__soulsBroadcastCostSequence=0;t.mock.method(performance,'now',()=>clock);
 const b=new WorldBroadcast() as any;b.direct=()=>({pose:{position:[0,4,8],get target(){clock+=2;return[0,1,0];},fov:45},shot:'test'});
 for(let i=0;i<605;i++){const before=clock,shot=b.sample({}, {}, null,1,.05,390/844,1,.05);assert.ok(shot.pose.target[1]>1);assert.ok(global.__soulsBroadcastCost.at(-1)>=clock-before);}
 assert.equal(global.__soulsBroadcastCost.length,600);assert.equal(global.__soulsBroadcastCostSequence,605);b.reset();assert.equal(global.__soulsBroadcastCostSequence,605);assert.equal(global.__soulsBroadcastCost.length,600);
});
