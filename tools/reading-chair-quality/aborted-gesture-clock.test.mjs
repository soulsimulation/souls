// Exercise the viewer's scalar clock without loading a renderer or a body asset.
import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import vm from 'node:vm';
import {transformSync} from '../../apps/web/node_modules/esbuild/lib/main.js';
import {DT} from '../../mars/viewer/engine/runtime/runtime.ts';
import {handActuatorFrame,HAND_REACH_SECONDS,HAND_RELEASE_SECONDS} from '../../mars/viewer/engine/social/hand-actuator.ts';
const source=readFileSync(new URL('../../mars/viewer/app/engine-view/humans.ts',import.meta.url),'utf8');
const held=source.match(/^const heldClip = .*$/m)?.[0],fade=source.match(/^export const GESTURE_FADE = .*$/m)?.[0];
const begin=source.indexOf('type CurrentAbortClockInput ='),end=source.indexOf('/** PERF-EDEN',begin);
assert.ok(held&&fade&&begin>0&&end>begin);
const box={DT,HAND_REACH_SECONDS,HAND_RELEASE_SECONDS};
vm.runInNewContext(transformSync(`${held}\n${fade.replace('export ','')}\n${source.slice(begin,end)}\nglobalThis.offset=currentDefaultAbortOffset;`,{loader:'ts',format:'cjs'}).code,box);
const input=(age,abortedAt=.2)=>{const motion={startTick:0,actionId:'light',target:'censer',at:[0,1.093,0],abortedAt,abortWeight:.25};return {motion,actor:'actor',observation:{actor:'actor',source:'sampled',tick:age/DT,dt:DT,time:age},sample:{kind:'sampled',time:age,nativeTime:age},observed:true,time:age,reach:age,handoff:handActuatorFrame(motion,age)};};
test('default aborted gesture offset stays continuous across fade and releases to the native idle clock',()=>{
 for(const abort of [0,.2,.6]){
  const end=abort+HAND_RELEASE_SECONDS+1.2;
  for(const boundary of [abort+HAND_RELEASE_SECONDS,1.4,end]){
   const before=input(boundary-1e-8,abort),after=input(boundary+1e-8,abort);
   assert.ok(Math.abs((after.time+box.offset(after))-(before.time+box.offset(before)))<1e-6,'no clip-time reset at existing boundaries');
  }
  assert.ok(box.offset(input(end,abort))===0);
 }
});
test('invalid scalar observations and custom motion families retain the existing fallback',()=>{
 const invalid=[x=>x.motion.startTick=-Infinity,x=>x.motion.startTick='0',x=>x.observed=1,x=>x.motion.at=new Array(3),x=>delete x.motion.at[1],x=>x.handoff.idleBlend=NaN,x=>x.motion.stroke={handoff:.1},x=>x.motion.abortedAt=undefined,x=>x.observation.actor='other',x=>x.time=Infinity,x=>x.motion=undefined];
 for(const change of invalid){const x=input(.3);change(x);assert.equal(box.offset(x),undefined);}
});
