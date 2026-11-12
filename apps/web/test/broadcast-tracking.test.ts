import assert from 'node:assert/strict';
import {test} from 'node:test';
import {Tracker,tracked,hotspotView,pathClear,TRACK_TYPES,GLIDE,type Scenery} from '../src/broadcast-tracking.ts';
import {makeMove} from '../src/WorldTour.ts';

type Box=[number,number,number,number,number,number];// minx,miny,minz,maxx,maxy,maxz
/** Scenery made of boxes: clear = 0.8 m from every box; reach = distance along a→b to the first box (slab test). */
const scenery=(boxes:Box[]):Scenery=>({
  clear:p=>boxes.every(b=>Math.hypot(Math.max(b[0]-p[0],0,p[0]-b[3]),Math.max(b[1]-p[1],0,p[1]-b[4]),Math.max(b[2]-p[2],0,p[2]-b[5]))>.8),
  reach:(a,c)=>{const d=[c[0]-a[0],c[1]-a[1],c[2]-a[2]],len=Math.hypot(...d);let best=Infinity;
    for(const b of boxes){let t0=0,t1=1;for(let i=0;i<3;i++){if(Math.abs(d[i])<1e-9){if(a[i]<b[i]||a[i]>b[i+3]){t0=2;break;}continue;}let u=(b[i]-a[i])/d[i],v=(b[i+3]-a[i])/d[i];if(u>v)[u,v]=[v,u];t0=Math.max(t0,u);t1=Math.min(t1,v);}
      if(t0<=t1&&t0<=1)best=Math.min(best,t0*len);}return best;}});
const inside=(p:readonly number[],b:Box)=>p[0]>b[0]&&p[0]<b[3]&&p[1]>b[1]&&p[1]<b[4]&&p[2]>b[2]&&p[2]<b[5];
const run=(t:Tracker,s:Scenery,centre:(now:number)=>number[],from:number,to:number,dt=1/60)=>{const out:{now:number;pose:{position:number[];target:number[]}|null;type:string|null;cut:boolean}[]=[];
  for(let now=from;now<to;now+=dt){const r=t.pose('group:a',centre(now),3,now,s);out.push({now,pose:r?.pose??null,type:r?.type??null,cut:!!r?.cut});}return out;};

test('#2202 B2: gatherings and activity are tracked; two-shots, gestures, riders and walkers keep the solver', () => {
  assert.ok(tracked({key:'group:a',label:'group',members:['a','b','c']}));
  assert.ok(tracked({key:'game:play-frisbee:a',label:'game',members:['a','b']}));
  assert.ok(tracked({key:'talk:a',label:'conversation',members:['a','b']}));
  assert.ok(tracked({key:'soul:a',label:'busy',members:['a']}));
  assert.ok(tracked({key:'conversation:t',label:'conversation',members:['a','b','c']}));
  for(const c of [{key:'conversation:t',label:'conversation',members:['a','b']},{key:'pair:hug:a:b',label:'hug',members:['a','b']},{key:'ride:a',label:'riding',members:['a']},{key:'soul:a',label:'walking',members:['a']},{key:'soul:a',label:'presenting',members:['a']}])
    assert.ok(!tracked(c),c.key);
});

test('#2202 B2: moves ease in and out, each type in turn, and the next one glides in with no jump', () => {
  const t=new Tracker(4),open=scenery([]),frames=run(t,open,()=>[0,0,0],0,90);
  assert.ok(frames.every(f=>f.pose),'open ground: always a moving shot');
  const types=frames.map(f=>f.type).filter((x,i,a)=>x!==a[i-1]);
  assert.deepEqual(new Set(types.slice(0,4)),new Set(TRACK_TYPES),'the four types before any repeats: '+types.join());
  // eased: the eye's speed is near zero where a move starts and ends, and no frame jumps
  const speed=frames.map((f,i)=>i?Math.hypot(...f.pose!.position.map((x,j)=>x-frames[i-1].pose!.position[j]))*60:0);
  assert.ok(Math.max(...speed)<6,'never faster than 6 m/s: '+Math.max(...speed).toFixed(2));
  const starts=frames.map((f,i)=>i&&f.type!==frames[i-1].type?i:-1).filter(i=>i>0);
  for(const i of starts){assert.ok(speed[i]<.3,`move change at ${frames[i].now.toFixed(2)} s: ${speed[i].toFixed(3)} m/s`);}
  assert.ok(speed[1]<.3,'the first move starts at rest');
  const mid=frames.findIndex(f=>f.now>=5);assert.ok(speed[mid]>.05,'and moves between');
  assert.ok(GLIDE>1);
});

test('#2202 B2: the shot follows a smoothed centre: a member stepping away moves the camera gradually', () => {
  const t=new Tracker(2),open=scenery([]);
  const frames=run(t,open,now=>now<3?[0,0,0]:[4,0,0],0,6);
  const at=(s:number)=>frames.find(f=>f.now>=s)!.pose!.target;
  const jump=at(3.05)[0]-at(2.95)[0];
  assert.ok(jump<.2,'no jump when the centre moves: '+jump.toFixed(3));
  assert.ok(at(5.9)[0]-at(2.95)[0]>2,'it does follow: '+(at(5.9)[0]-at(2.95)[0]).toFixed(2));
});

test('#2202 B2: never through scenery: every eye is clear and no frame-to-frame step crosses a wall; blocked moves re-solve', () => {
  // A walled yard: three tall walls round the hotspot leave one side open; a pillar stands in the open side.
  const walls:Box[]=[[-12,0,-12,12,8,-11],[-12,0,11,12,8,12],[-12,0,-12,-11,8,12],[7,0,-1,8,9,1]];
  const s=scenery(walls);
  for(const seed of [1,2,3,4,5,6]){
    const t=new Tracker(seed),frames=run(t,s,now=>[Math.sin(now/7)*2,0,0],0,80);
    let shots=0;
    for(let i=0;i<frames.length;i++){const p=frames[i].pose;if(!p)continue;shots++;
      assert.ok(s.clear(p.position),`seed ${seed}: eye in a wall at ${frames[i].now.toFixed(2)} s`);
      for(const w of walls)assert.ok(!inside(p.position,w));
      const q=frames[i-1]?.pose;if(q&&!frames[i].cut){const step=Math.hypot(...p.position.map((x,j)=>x-q.position[j]));assert.ok(s.reach(q.position,p.position)>=step-1e-6,`seed ${seed}: a step through a wall at ${frames[i].now.toFixed(2)} s`);}}
    assert.ok(shots>frames.length*.8,`seed ${seed}: the open side is used (${shots}/${frames.length})`);
  }
  // A closed room: no move is clear, so Broadcast keeps its solver (null), and asks again only after a pause.
  const room=scenery([[-5,-1,-5,5,0,5],[-5,4,-5,5,5,5],[-6,0,-6,-5,4,6],[5,0,-6,6,4,6],[-6,0,-6,6,4,-5],[-6,0,5,6,4,6]]);
  assert.equal(new Tracker(1).pose('group:a',[0,0,0],2,0,room),null);
  // pathClear sees a wall between two samples
  const m=makeMove(hotspotView([0,0,0],2,0),'orbit',12,1),thin=scenery([[9.5,0,-.05,12,6,.05]]);
  assert.ok(pathClear(m,[0,0,0],0,1,scenery([])));
  assert.ok(!pathClear(m,[0,0,0],0,1,thin),'a thin wall across the arc');
});
