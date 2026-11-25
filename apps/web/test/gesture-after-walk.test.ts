// A greeting's bow on the old page (#4456, #4482): the engine starts each member's 1.15 s bow the tick the members finish
// walking to their places. Drawn through the replay path (HumanViews.setFrame) with the replay's own walk weight
// (walk-ease.ts): the bow is drawn while the walk eases out, its arc goes on through a take window that begins inside
// it with no history, and when it ends, before its 2.5 s arc has come back up, the
// body rises over BOW_RETURN instead of snapping upright in one frame (0.30 m of head travel in 50 ms before).
import {test} from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {GLTFLoader} from 'three/addons/loaders/GLTFLoader.js';
import {HumanViews,type SampledHuman} from '../../../mars/viewer/app/engine-view/humans.ts';
import {templateFromGltf,type Template} from '../../../mars/viewer/app/engine-view/people.ts';
import {gaitSegments,walkWeightAt} from '../../../mars/viewer/app/engine-view/walk-ease.ts';
import {POS_Q,type PoseSample} from '../../../mars/viewer/engine/take/types.ts';

const DT=.05,BOW=23;
async function views(){
 const source=readFileSync(new URL('../../../mars/viewer/public/modular/environment/animated-casual.glb',import.meta.url));
 const jsonSize=source.readUInt32LE(12),json=JSON.parse(source.subarray(20,20+jsonSize).toString()),binHeader=20+jsonSize;
 json.materials=json.materials.map(()=>({pbrMetallicRoughness:{baseColorFactor:[.5,.5,.5,1],metallicFactor:0,roughnessFactor:.8}}));delete json.textures;delete json.images;delete json.samplers;
 let chunk=Buffer.from(JSON.stringify(json));chunk=Buffer.concat([chunk,Buffer.alloc((4-chunk.length%4)%4,32)]);const bin=source.subarray(binHeader);
 const header=Buffer.alloc(20);source.copy(header,0,0,12);header.writeUInt32LE(20+chunk.length+bin.length,8);header.writeUInt32LE(chunk.length,12);header.writeUInt32LE(0x4e4f534a,16);
 const bytes=Buffer.concat([header,chunk,bin]);const tpl:Template=templateFromGltf('m04-canonical',await new GLTFLoader().parseAsync(bytes.buffer.slice(bytes.byteOffset,bytes.byteOffset+bytes.byteLength),''));
 const v=new HumanViews();v.setTemplates([tpl]);return v;
}

/** Walks 1.2 m/s along +x, slows over 0.4 s to stop at 4 m (tick kr), bows to a partner 1.5 m ahead from `start` for
 *  1.15 s, then stands. → per tick: the head's distance ahead of the body and its activity. */
async function afterWalk(act:string,lag:number){
 const v=await views(),id='h_bow',other='h_other';
 const v0=1.2,slow=8,decel=v0/(slow*DT),t0=10,stopAt=4,cruise=stopAt-v0*v0/(2*decel),k1=t0+Math.round(cruise/v0/DT);
 const track:PoseSample[]=[[0,0,0,0,0],[t0,0,0,0,0]];
 for(let k=t0+1;k<=k1;k++)track.push([k,Math.round((k-t0)*DT*v0*POS_Q),0,0,0]);
 const x1=(k1-t0)*DT*v0;for(let j=1;j<=slow;j++){const tt=j*DT;track.push([k1+j,Math.round((x1+v0*tt-decel*tt*tt/2)*POS_Q),0,0,0]);}
 const kr=k1+slow;track.push([kr+400,track.at(-1)![1],0,0,0]);
 const seg=gaitSegments([{track,offset:0}],DT);
 const xAt=(k:number)=>{const i=track.findIndex(s=>s[0]>k);if(i<0)return track.at(-1)![1]/POS_Q;const a=track[i-1],b=track[i];return (a[1]+(b[1]-a[1])*(k-a[0])/(b[0]-a[0]))/POS_Q;};
 const start=kr+lag,rows:{k:number;act:string;w:number;ahead:number;palm:number[]}[]=[];
 for(let k=kr-10;k<=start+BOW+20;k++){
  const x=xAt(k),w=walkWeightAt(seg,k,DT),speed=Math.abs(xAt(k+3)-xAt(k-3))/(6*DT),bowing=k>=start&&k<start+BOW;
  const f={id,p:[x,0,0],yaw:0,walk:w,walkDist:x,speed,activity:bowing?act:speed>.3?'walk':'idle',
   // the page's live take windows are 10 ticks: one that begins inside the bow, or after it, carries no history
   ...(bowing?{...(k-start<10?{activityAge:(k-start)*DT}:{}),partner:other}:{})} as SampledHuman;
  const g={id:other,p:[stopAt+1.5,0,0],yaw:Math.PI,walk:0,walkDist:0,activity:'idle'} as SampledHuman;
  v.setFrame([f,g],k*DT);v.render(1);
  const b=v.bones(id)[id] as unknown as {head:number[];arms:{palm:number[]}[]};
  rows.push({k:k-start,act:f.activity!,w,ahead:b.head[0]-x,palm:b.arms.flatMap(a=>[a.palm[0]-x,a.palm[1],a.palm[2]])});
 }
 return rows;
}

const step=(a:number[],b:number[])=>Math.max(Math.hypot(b[0]-a[0],b[1]-a[1],b[2]-a[2]),Math.hypot(b[3]-a[3],b[4]-a[4],b[5]-a[5]));

test('a bow that starts as the walk into place ends is drawn, and rises back up instead of snapping when it ends', async()=>{
 for(const lag of [-2,0,2]){
  const rows=await afterWalk('bow',lag),deep=Math.max(...rows.filter(r=>r.act==='bow').map(r=>r.ahead));
  assert.ok(deep>.25,`lag ${lag}: the bow leans the head ${deep.toFixed(3)} m ahead (>0.25)`);
  let jump=0;for(let i=1;i<rows.length;i++)jump=Math.max(jump,Math.abs(rows[i].ahead-rows[i-1].ahead));
  if(process.env.BOW_DEBUG)for(const r of rows)console.log(lag,r.k,r.act,r.w.toFixed(2),r.ahead.toFixed(3));
  assert.ok(jump<.1,`lag ${lag}: the head moves at most ${jump.toFixed(3)} m in 50 ms (<0.1)`);
  const end=rows.find(r=>r.k===BOW+Math.ceil(.5/DT)+1)!;
  assert.ok(end.ahead<.06,`lag ${lag}: upright again 0.5 s after the bow (${end.ahead.toFixed(3)} m)`);
 }
});

test('a host\'s point after the walk into place is drawn, and the arm comes down instead of dropping in one frame', async()=>{
 const rows=await afterWalk('point',0),reach=Math.max(...rows.filter(r=>r.act==='point').map(r=>Math.max(r.palm[0],r.palm[3])));
 assert.ok(reach>.35,`the pointing hand reaches ${reach.toFixed(3)} m ahead (>0.35)`);
 let jump=0;for(let i=1;i<rows.length;i++)if(rows[i].k>=BOW-1)jump=Math.max(jump,step(rows[i-1].palm,rows[i].palm));
 assert.ok(jump<.25,`at and after its end a palm moves at most ${jump.toFixed(3)} m in 50 ms (<0.25)`);
});
