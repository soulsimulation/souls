import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import * as THREE from 'three';
import {GLTFLoader} from 'three/addons/loaders/GLTFLoader.js';
import {templateFromGltf} from './people.ts';
import {HumanViews, setHumanGround, type SampledHuman} from './humans.ts';
import {formPresses, pressWeight, type FormPress} from './activity-poses.ts';

const press:FormPress={hand:'left',start:100_000_000,contact:100_250_000,end:100_550_000};
test('a press reaches at its recorded contact and returns inside its recorded recovery',()=>{
  assert.equal(pressWeight(press,100),0);assert.equal(pressWeight(press,100.25),1);assert.equal(pressWeight(press,100.55),0);
  assert.equal(pressWeight({...press,cut:100_100_000},100.1),pressWeight(press,100.1));
  assert.equal(pressWeight({...press,cut:100_100_000},100.4),0);
  assert.equal(pressWeight({...press,contact:press.start},100.1),0);
  assert.equal(formPresses([null,{}, {...press,hand:'unknown'}]),undefined);
});

test('production rig press is continuous, uses its recorded free hand and retains seats and authoritative owners',async()=>{
  const loader=new GLTFLoader();loader.register(()=>({name:'press-test-material',loadMaterial:async()=>new THREE.MeshStandardMaterial()}));
  const root=process.env.HUMAN_RIG_DIR??new URL('../../public/modular/environment/',import.meta.url).pathname;
  const read=async(name:string)=>{const b=await readFile(root+'/'+name);return loader.parseAsync(b.buffer.slice(b.byteOffset,b.byteOffset+b.byteLength),'');};
  const model=await read('animated-casual.mesh.glb'),clips=await read('clips-ual.glb');model.animations=clips.animations;
  const views=new HumanViews();views.setTemplates([templateFromGltf('casual',model)]);setHumanGround(()=>0);
  const draw=(age:number,extra:Partial<SampledHuman>={},withPress=true)=>{
    views.setFrame([{id:'press-rig',p:[2,0,1],yaw:0,walk:0,walkDist:0,activity:age<0||age>=.55?'idle':'operate',activityAge:Math.max(0,age),restAge:20,formPress:withPress?[press]:undefined,...extra}],100+age);views.render(1);
    return {points:views.meshPoints('press-rig',1),bones:views.bones('press-rig')['press-rig'],root:views.bodyObject('press-rig')!.position.clone()};
  };
  const delta=(a:ReturnType<typeof draw>,b:ReturnType<typeof draw>)=>Math.max(...a.points.map((p,i)=>Math.hypot(...p.p.map((x,j)=>x-b.points[i].p[j]) as [number,number,number])));
  const hand=(r:ReturnType<typeof draw>,side:string)=>r.bones.arms.find(a=>a.side===side)!.palm;
  const distance=(a:number[],b:number[])=>Math.hypot(...a.map((x,i)=>x-b[i]));
  for(const boundary of [0,.25,.55])assert.ok(delta(draw(boundary-1e-6),draw(boundary+1e-6))<.015,'skin continuity at phase '+boundary+' delta '+delta(draw(boundary-1e-6),draw(boundary+1e-6)));
  const base=draw(.25,{activity:'idle'},false),peak=draw(.25);assert.ok(distance(hand(base,'left'),hand(peak,'left'))>.2,'recorded left hand visibly moves');assert.ok(distance(hand(base,'right'),hand(peak,'right'))<.015,'unclaimed right hand stays in its actual base pose');
  let previous=draw(-1/60);for(let age=0;age<=.6;age+=1/60){const now=draw(age);assert.ok(delta(previous,now)<.15,'bounded real-frame skin displacement at '+age+' delta '+delta(previous,now));assert.deepEqual(now.root.toArray(),[2,0,1]);for(const side of ['leg','foot'])assert.ok(Math.min(...now.points.filter(p=>p.part===side).map(p=>p.p[1]))>=.001,'standing skin stays at least 1 mm above the ground '+side);previous=now;}
  for(const cut of [.075,.2,.4]){const p={...press,cut:press.start+cut*1e6};const a=draw(cut-1e-6),b=draw(cut+1e-6,{activity:'idle',formPress:[p]});assert.ok(delta(a,b)<.015,'cancel from attained pose '+cut);assert.ok(delta(draw(cut+.3,{activity:'idle',formPress:[p]}),draw(cut+.3,{activity:'idle'},false))<.015,'cancel returns completely');}
  const interrupted={...press,cut:100_200_000};
  const beforeWalk=draw(.2-1e-6),afterWalk=draw(.2+1e-6,{activity:'walk',activityAge:1e-6,walkAge:1e-6,walk:0,formPress:[interrupted]});
  assert.ok(delta(beforeWalk,afterWalk)<.015,'immediate locomotion returns from the attained press without moving the native root');
  for(const activity of ['sit','nod']){const extra={baseActivity:activity==='sit'?'sit':undefined,activity,seatHeight:.45};assert.ok(delta(draw(.55-1e-6,extra),draw(.55+1e-6,extra))<.015,'return to '+activity);}
  const fixed={hands:{left:[2.3,1,1] as [number,number,number]}};assert.ok(delta(draw(.25,fixed),draw(.25,{...fixed,activity:'idle'},false))<1e-5,'explicit native hand wins');
  for(const extra of [{prop:'cup'},{handHold:{with:'other',hand:'left',since:2000} as SampledHuman['handHold']},{partner:'other'}])assert.ok(delta(draw(.25,extra),draw(.25,{...extra,activity:'idle'},false))<.015,'held/paired hand ownership wins');
  views.clear();setHumanGround(null);
});
