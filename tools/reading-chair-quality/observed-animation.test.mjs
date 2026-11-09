import test from 'node:test';
import assert from 'node:assert/strict';
import {observedAnimationSample} from '../../mars/viewer/app/engine-view/observed-animation.ts';

const idle = {}, walk = {};
const before = () => ({actor:'fixture-actor',source:'native',tick:40,dt:.05,time:2,
  idle:{identity:idle,duration:2,phase:1.98},walk:{identity:walk,duration:1,phase:.98},
  walkWeight:.5,restAge:.4});
const after = a => ({...a,tick:41,time:2.05,idle:{...a.idle,phase:.03},walk:{...a.walk,phase:.03},walkAdvance:.05,restAge:.45});

test('observed phases unwrap together and rest age uses the same bounded sample',()=>{
  const a=before(),b=after(a),s=observedAnimationSample(a,b,.5);
  assert.equal(s.kind,'sampled');assert.ok(Math.abs(s.idle-.005)<1e-12);
  assert.ok(Math.abs(s.walk-.005)<1e-12);assert.equal(s.walkMode,'wrap');
  assert.equal(s.restAge,.42500000000000004);assert.equal(s.nativeTime,2.025);
  assert.equal(observedAnimationSample(a,b,0).idle,a.idle.phase);
  assert.equal(observedAnimationSample(a,b,1).idle,b.idle.phase);
});

test('Walk stop/reset keeps the outgoing observed phase while its weight fades',()=>{
  const a=before(),b={...after(a),walkWeight:0,walk:{...a.walk,phase:0}};
  assert.equal(observedAnimationSample(a,b,.5).walk,.98);
  assert.equal(observedAnimationSample(a,b,.5).walkMode,'stop');
  const start={...a,walkWeight:0,walk:{...a.walk,phase:0}};
  const moving={...after(start),walkWeight:.25};
  assert.equal(observedAnimationSample(start,moving,.5).walk,.03);
  assert.equal(observedAnimationSample(start,moving,.5).walkMode,'start');
});

test('fresh and backward requests agree and never mutate observations',()=>{
  const a=before(),b=after(a),saved=structuredClone({a,b}),forward=new Map();
  for(const alpha of [0,.25,.5,.75,1])forward.set(alpha,observedAnimationSample(a,b,alpha));
  for(const alpha of [1,.75,.25,0,.5,.5])assert.deepEqual(observedAnimationSample(a,b,alpha),forward.get(alpha));
  assert.deepEqual(structuredClone({a,b}),saved);
});

test('already sampled fractional observations keep their canonical timestamp',()=>{
  const a={...before(),source:'sampled',tick:40.5,time:17.25};
  for(const alpha of [0,.5,1]){const s=observedAnimationSample(a,a,alpha);assert.equal(s.kind,'sampled');assert.equal(s.time,17.25);assert.equal(s.nativeTime,2.025);assert.equal(s.walk,.98);}
});

test('missing, mixed, changed, gapped and reset observations have explicit fallbacks',()=>{
  const a=before(),b=after(a),reason=(x,y,u=.5)=>observedAnimationSample(x,y,u).reason;
  assert.equal(reason(undefined,b),'missing-observation');
  assert.equal(reason(a,b,NaN),'invalid-alpha');assert.equal(reason(a,b,1.1),'invalid-alpha');
  assert.equal(reason(a,{...b,actor:'other-actor'}),'mixed-source');
  assert.equal(reason(a,{...b,source:'sampled'}),'mixed-source');
  assert.equal(reason(a,{...b,idle:{...b.idle,identity:{}}}),'changed-clip');
  assert.equal(reason(a,{...b,walk:{...b.walk,duration:1.1}}),'changed-clip');
  assert.equal(reason(a,{...b,tick:42,time:2.1}),'unobserved-interval');
  assert.equal(reason(a,{...b,idle:{...b.idle,phase:0}}),'idle-reset');
  assert.equal(reason(a,{...b,walkAdvance:undefined}),'ambiguous-walk-advance');
  assert.equal(reason(a,{...b,restAge:.1}),'ambiguous-rest-envelope');
  assert.equal(reason(a,{...b,restAge:NaN}),'invalid-observation');
});

test('explicit rest reset and unrelated actors use the observed policy without an episode flag',()=>{
  const a=before(),b={...after(a),restAge:0,restReset:true};
  assert.equal(observedAnimationSample(a,b,.5).restMode,'reset');
  assert.equal(observedAnimationSample(a,b,.5).restAge,0);
  const ordinary={...a,actor:'ordinary-fixture'},next={...after(ordinary)};
  assert.equal(observedAnimationSample(ordinary,next,.5).kind,'sampled');
  assert.equal(observedAnimationSample(ordinary,next,.5).idle,observedAnimationSample(a,after(a),.5).idle);
});

test('unknown and known rest resets interpolate existing normalized endpoint envelopes without inventing ages',()=>{
  const duration=1.2,unknown={...before(),restAge:undefined},reset={...after(unknown),restAge:0,restReset:true};
  const known={...before(),restAge:.6},knownReset={...after(known),restAge:0,restReset:true};
  for(const alpha of [0,.25,.5,.75,1]){
    const u=observedAnimationSample(unknown,reset,alpha,duration),k=observedAnimationSample(known,knownReset,alpha,duration);
    assert.equal(u.kind,'sampled');assert.equal(k.kind,'sampled');assert.equal(u.restMode,'reset');
    assert.equal(u.restOnset,1-alpha);assert.equal(k.restOnset,.5*(1-alpha));
    assert.equal(u.restAge,0,'native reset observation is unchanged, not a synthetic age');
    assert.equal(observedAnimationSample(unknown,after(unknown),alpha,duration).reason,'ambiguous-rest-envelope','unknown to known without reset is conservative fallback');
    assert.equal(observedAnimationSample(unknown,{...after(unknown),restAge:undefined},alpha,duration).restOnset,1,'valid unknown is explicit full onset');
  }
});

test('ordinary rest advance and already sampled frames retain the existing smooth age envelope',()=>{
  const duration=1.2,a=before(),b=after(a),smooth=age=>{const k=Math.max(0,Math.min(1,age/duration));return k*k*(3-2*k);};
  for(const alpha of [0,.25,.5,.75,1]){
    const sampled=observedAnimationSample(a,b,alpha,duration),legacy=observedAnimationSample(a,b,alpha);
    assert.ok(Math.abs(sampled.restOnset-smooth(sampled.restAge))<1e-15);
    for(const key of ['idle','walk','time','nativeTime','restAge','walkMode','restMode'])assert.equal(sampled[key],legacy[key],key);
  }
  const single={...a,source:'sampled',tick:40.5,time:17.25,restAge:undefined};
  assert.equal(observedAnimationSample(single,single,.5,duration).restOnset,1);
  for(const duration of [0,-1,NaN,Infinity])assert.equal(observedAnimationSample(a,b,.5,duration).reason,'invalid-rest-envelope');
});
