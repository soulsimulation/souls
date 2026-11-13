import test from 'node:test';
import assert from 'node:assert/strict';
import {readingRigFixture,worldVertices} from './rig-fixture.mjs';
import {observedAnimationSample} from '../../mars/viewer/app/engine-view/observed-animation.ts';
const {HumanViews}=await import('../../mars/viewer/app/engine-view/humans.ts');
const actor='fixture-clock-actor',dt=.05;
const body=(activity='idle',p=[0,0,0])=>({id:actor,kind:'human',def:'human',pose:{p,yaw:0},human:{activity,level:0,...(activity==='walk'?{speed:1}:{})}});
const make=template=>{const v=new HumanViews(false);v.setTemplates([template]);return v;};
const skin=v=>worldVertices(v.bodyObject(actor));
const gap=(a,b)=>a.reduce((max,p,i)=>Math.max(max,p.distanceTo(b[i])),0);

test('actual rigs share the observed Idle epoch for fresh native and already sampled actors',async()=>{
  const {templates}=await readingRigFixture();
  for(const template of templates)for(const tick of [0,137]){
    const native=make(template),sampled=make(template);native.onTick({tick,entities:{[actor]:body()}});native.render(1);
    const frame={id:actor,p:[0,0,0],yaw:0,walk:0,walkDist:0,activity:'idle',animationObservation:{tick,dt}};
    sampled.setFrame([frame],tick*dt);sampled.render(1);const expected=skin(sampled);
    assert.ok(gap(skin(native),expected)<1e-9,`${template.name} native/sampled nonzero epoch`);
    native.onTick({tick,entities:{[actor]:body()}});native.render(1);
    assert.ok(gap(skin(native),expected)<1e-9,`${template.name} repeated idle observation`);
    native.onTick({tick:tick+1,entities:{}});native.onTick({tick,entities:{[actor]:body()}});native.render(1);
    assert.ok(gap(skin(native),expected)<1e-9,`${template.name} restored actor with same id`);
    native.clear();sampled.clear();
  }
});

test('actual Walk loops use continuous observed phases at equal-time native buffer boundaries',async()=>{
  const {templates}=await readingRigFixture();let wrapped=0;
  for(const template of templates){const view=make(template);let last;
    for(let tick=0;tick<70;tick++){
      view.onTick({tick,entities:{[actor]:body('walk',[tick*dt,0,0])}});
      const v=view.views.get(actor),sample=observedAnimationSample(v.prev.observed,v.cur.observed,0);
      if(tick>1){assert.equal(sample.kind,'sampled',`${template.name} tick${tick}`);
        view.render(0);assert.ok(gap(last,skin(view))<1e-8,`${template.name} equal-time tick${tick}`);
        if(sample.walkMode==='wrap')wrapped++;
      }
      view.render(1);last=skin(view);
    }view.clear();
  }assert.ok(wrapped>=3,'actual clip loop wraps were exercised on all rigs');
});

test('fresh, reverse and repeated sampled frames give identical actual skin and explicit source/gap fallback',async()=>{
  const {templates}=await readingRigFixture();
  for(const template of templates){const view=make(template),saved=new Map();
    const frame=t=>({id:actor,p:[0,0,0],yaw:0,walk:0,walkDist:0,activity:'idle',restAge:t,animationObservation:{tick:t/dt,dt}});
    for(const t of [1.99,2,2.01,3.4]){view.setFrame([frame(t)],t);view.render(1);saved.set(t,skin(view));}
    for(const t of [3.4,2.01,1.99,2,2]){view.setFrame([frame(t)],t);view.render(1);assert.ok(gap(saved.get(t),skin(view))<1e-9);
      const fresh=make(template);fresh.setFrame([frame(t)],t);fresh.render(1);assert.ok(gap(saved.get(t),skin(fresh))<1e-9);fresh.clear();}
    view.onTick({tick:100,entities:{[actor]:body()}});let v=view.views.get(actor);
    assert.equal(observedAnimationSample(v.prev.observed,v.cur.observed,.5).reason,'mixed-source');
    view.onTick({tick:103,entities:{[actor]:body()}});v=view.views.get(actor);
    assert.equal(observedAnimationSample(v.prev.observed,v.cur.observed,.5).reason,'unobserved-interval');
    view.onTick({tick:102,entities:{[actor]:body()}});v=view.views.get(actor);
    assert.equal(observedAnimationSample(v.prev.observed,v.cur.observed,.5).reason,'unobserved-interval');view.clear();
  }
});

test('actual native Walk start, stop, and rest reset intervals retain observed weights and repeatable whole skin',async()=>{
  const {Runtime}=await import('../../mars/viewer/engine/runtime/runtime.ts');
  const {Spatial}=await import('../../mars/viewer/engine/spatial/service.ts');
  const {provingGround}=await import('../../mars/viewer/engine/scenes/proving-ground.ts');
  const {emptyWorld,human,addAll}=await import('../../mars/viewer/engine/world/factory.ts');
  const {walkTo}=await import('../../mars/viewer/engine/locomotion/walk.ts');
  const {templates}=await readingRigFixture();
  const scene=provingGround(),world=addAll(emptyWorld('fixture-native-walk',scene),human(actor,-6,-6));
  const runtime=new Runtime(world,new Map([[walkTo.verb,walkTo]]),{spatial:new Spatial(scene)},[]),observations=[];
  const capture=()=>observations.push({tick:runtime.tick,entity:structuredClone(runtime.world.entities[actor])});capture();
  for(let i=0;i<48;i++){runtime.step();capture();}
  const action=runtime.submit(walkTo.verb,{actor,x:-4,z:-6,speed:1});assert.equal(action.status,'executing');
  for(let i=0;i<160;i++){runtime.step();capture();}
  assert.equal(action.status,'completed');assert.deepEqual(runtime.violations,[]);
  const seen=new Set();
  for(const template of templates){const view=make(template);let previousEnd;
    for(const record of observations){
      view.onTick({tick:record.tick,entities:{[actor]:record.entity}});const v=view.views.get(actor),a=v.prev.observed,b=v.cur.observed;
      const sample=observedAnimationSample(a,b,.5);
      const event=sample.kind==='sampled'&&(sample.walkMode==='start'||sample.walkMode==='stop'||sample.restMode==='reset'&&a.restAge!==0);
      if(event){
        assert.equal(sample.kind,'sampled');seen.add(`${template.name}:${sample.walkMode==='start'||sample.walkMode==='stop'?sample.walkMode:'rest-reset'}`);
        assert.equal(b.walkWeight,v.cur.walkW,'sampler observes existing native driver weight');
        const copy=o=>({...o,idle:{...o.idle},walk:{...o.walk}});
        const original={a:copy(a),b:copy(b)},saved=new Map();
        for(const alpha of [0,.25,.5,.75,1]){view.render(alpha);saved.set(alpha,skin(view));}
        if(previousEnd)assert.ok(gap(previousEnd,saved.get(0))<1e-8,`${template.name} ${sample.walkMode}/${sample.restMode} equal-time incoming boundary`);
        // Existing Float64 sequential quaternion blending is activation-order dependent for slightly nonunit tracks.
        // Repeat/reverse presentation uses the existing 5 µm bound; incoming boundaries keep the tighter check above.
        for(const alpha of [1,.75,.5,.25,0,.5]){view.render(alpha);assert.ok(gap(saved.get(alpha),skin(view))<5e-6,`${template.name} ${sample.walkMode}/${sample.restMode} repeated/reverse alpha${alpha}`);}
        assert.deepEqual({a:copy(a),b:copy(b)},original,'rendering never advances observed clip/rest inputs');
      }
      view.render(1);previousEnd=skin(view);
    }view.clear();
  }
  for(const template of templates)for(const mode of ['start','stop','rest-reset'])assert.ok(seen.has(`${template.name}:${mode}`),`${template.name} actual ${mode} interval observed`);
});
