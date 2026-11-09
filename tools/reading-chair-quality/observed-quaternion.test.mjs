import test from 'node:test';
import assert from 'node:assert/strict';
import {observedQuaternionBlend} from '../../mars/viewer/app/engine-view/observed-quaternion.ts';
const q=(x=0,y=0,z=0,w=1)=>({x,y,z,w}),values=a=>[a.x,a.y,a.z,a.w];
const sample=(a,b,w)=>{const result=observedQuaternionBlend(a,b,w);assert.equal(result.kind,'sampled');return result.q;};
const near=(a,b,eps=1e-12)=>assert.ok(Math.abs(a-b)<eps,`${a} versus ${b}`);

test('local quaternion interpolation preserves raw endpoints and magnitude without changing shortest arc rotation',()=>{
  const base=q(0,0,0,2),solved=q(0,0,3*Math.SQRT1_2,3*Math.SQRT1_2);
  assert.deepEqual(sample(base,solved,0),values(base));assert.deepEqual(sample(base,solved,1),values(solved));
  for(const w of [1e-12,.25,.5,.75,1-1e-12]){
    const s=sample(base,solved,w),n=Math.hypot(...s);near(n,2+w);near(s[2]/n,Math.sin(Math.PI/4*w));near(s[3]/n,Math.cos(Math.PI/4*w));
  }
});

test('the captured nonunit native pose remains component-continuous at zero instead of normalizing on first blend',()=>{
  const base=q(.0003,-.002,.001,.9999927498),solved=q(.1,.2,.3,.9273618495);
  const raw=values(base),n=Math.hypot(...raw),s=sample(base,solved,1e-12);
  assert.ok(Math.max(...s.map((v,i)=>Math.abs(v-raw[i])))<1e-12);
  assert.ok(Math.max(...raw.map(v=>Math.abs(v/n-v)))>1e-6,'negative control: normalizing the raw baseline introduces a finite component jump');
});

test('opposite quaternion signs retain the same physical orientation and raw endpoint sign',()=>{
  const base=q(.2,0,0,.9797958971132712),solved=q(-.4,0,0,-1.9595917942265424);
  for(const w of [.0001,.5,.9999]){const s=sample(base,solved,w),n=Math.hypot(...s);near(s[0]/n,.2);near(s[3]/n,.9797958971132712);}
  assert.deepEqual(sample(base,solved,1),values(solved));assert.deepEqual(sample(base,solved,0),values(base));
});

test('nonfinite, zero or invalid blends explicitly fall back and never mutate input or another driver',()=>{
  const base=q(.1,0,0,.995),solved=q(0,.2,0,.98),saved=structuredClone({base,solved});
  for(const w of [-1,2,NaN,Infinity])assert.equal(observedQuaternionBlend(base,solved,w).kind,'fallback');
  assert.equal(observedQuaternionBlend(q(0,0,0,0),solved,.5).reason,'zero-quaternion');
  assert.equal(observedQuaternionBlend(q(NaN),solved,.5).reason,'invalid-quaternion-blend');
  assert.equal(observedQuaternionBlend(q(1e308,1e308,1e308,1e308),solved,.5).reason,'invalid-quaternion-norm');
  sample(base,solved,.3);assert.deepEqual({base,solved},saved);
});
