import test from 'node:test';
import assert from 'node:assert/strict';
import {marsFactory,GREEN_FIELD_WORLD} from './engine.ts';
import {groundFact,groundField} from './ground-bridge.ts';
import {emptyGround,type Ground} from '../../ground/src/index.ts';
import {nextEntityPhysics} from './entity-physics.ts';
const factory=await marsFactory(GREEN_FIELD_WORLD);
const area:[number,number][]=[[10,-20],[50,-20],[50,20],[10,20]];
function lake(points=area,depth=3){const g=emptyGround(200);g.landforms.push({id:'lake',kind:'carve',area:points,bed:-depth,edge:2});g.waters.push({id:'lake',area:points,level:0});return g;}
function setup(g:Ground){const e=factory.create(factory.genesis('nearby-swim')) as any;e.installGroundV1(groundFact(g,1,{paged:true}));e.spawnHuman({id:'h_swimmer',label:'Swimmer',soul:'s_swimmer'});return e;}
const step={verb:'mars:swim_in',params:{water:'lake'}};
function run(e:any,steps=[step],max=2500){const adm=e.perform({actor:'h_swimmer',label:'take a swim',steps});if(!adm.ok)return {end:{kind:'failed',...adm.diagnostic},acts:new Set<string>()};let end:any;const acts=new Set<string>();for(let i=0;i<max&&!end;i++){const out=e.step();acts.add(e.world.entities.h_swimmer.human.activity);end=out.programs.find((p:any)=>p.id===adm.id&&['failed','completed','cancelled'].includes(p.kind));}return {end,acts};}
function overlay(e:any,deck:boolean){const box={c:[30,0],half:[22,22],yaw:0};const set={e_cover:deck?{surfaces:[{id:'cover',level:0,y:.5,obb:box}]}:{solids:[{id:'wall',kind:'fixture',label:'solid wall',y0:-5,y1:4,obb:box}]}};const ev:any={contract:'world-edit/1',seq:1,hash:'',levels:[],set,assets:{}};ev.hash=nextEntityPhysics(undefined,ev).hash;e.applyWorldEditV1(ev);}
test('nearby named swim finishes in real selected water and restores deterministically; old explicit points remain exact',()=>{
 const g=lake(),a=setup(g),field=groundField(groundFact(g,1).recipeHash);
 const adm=a.perform({actor:'h_swimmer',label:'take a swim',steps:[step]});assert.equal(adm.ok,true,JSON.stringify(adm));
 for(let i=0;i<150;i++)a.step();const b=factory.restore(a.snapshot()) as any;
 for(let i=0;i<1800;i++){a.step();b.step();}
 assert.equal(a.stateHash(),b.stateHash());const body=a.world.entities.h_swimmer;
 assert.equal(body.human.activity,'tread');assert.equal(field.waterId!(body.pose.p[0],body.pose.p[2]),'lake');assert.equal(field.medium(body.pose.p[0],body.pose.p[2]),2);
 const exact=run(a,[{verb:'mars:ground_travel',params:{x:30,z:0,level:0}}] as any);assert.equal(exact.end?.kind,'completed',JSON.stringify(exact));assert.deepEqual(a.world.entities.h_swimmer.pose.p,[30,-1.2,0]);assert.deepEqual(a.runtime.violations,[]);
});
test('concave lake with a dry centroid uses genuine deep water in its reachable arm',()=>{
 const points:[number,number][]=[[10,-20],[50,-20],[50,20],[36,20],[36,-6],[24,-6],[24,20],[10,20]],g=lake(points),e=setup(g),f=groundField(groundFact(g,1).recipeHash);
 assert.notEqual(f.medium(30,3.5),2,'arithmetic centre is dry');const r=run(e);assert.equal(r.end?.kind,'completed',JSON.stringify(r.end));assert.ok(r.acts.has('swim'));
 const p=e.world.entities.h_swimmer.pose.p;assert.equal(f.waterId!(p[0],p[2]),'lake');assert.equal(f.medium(p[0],p[2]),2);assert.deepEqual(e.runtime.violations,[]);
});
test('shallow, overlapped, fully covered and solid-blocked waters cannot falsely finish a named swim',()=>{
 for(const kind of ['shallow','overlap','deck','solid']){
  const g=lake(area,kind==='shallow'?.3:3);if(kind==='overlap')g.waters.push({id:'other-water',area,level:0});const e=setup(g);
  if(kind==='deck'||kind==='solid')overlay(e,kind==='deck');
  const r=run(e);assert.equal(r.end?.kind,'failed',kind);assert.match(r.end?.code??'',/^swim\.(no-deep-water|no-reachable-entry)$/,JSON.stringify({kind,r:r.end}));assert.ok(!r.acts.has('swim'),kind);
 }
});
test('removed or replaced named water refuses precisely rather than using an overlapping body',()=>{
 const g=lake(),e=setup(g);g.waters[0].id='replacement';e.installGroundV1(groundFact(g,2,{paged:true}));
 const r=run(e);assert.equal(r.end?.code,'swim.water-missing');
});

test('an explicit middle must remain deep uncovered water, including a deck added over the centre',()=>{
 const e=setup(lake());overlay(e,true);
 const r=run(e,[{verb:'mars:swim_in',params:{water:'lake',x:30,z:0}}] as any);
 assert.equal(r.end?.code,'swim.not-deep-target');assert.ok(!r.acts.has('swim'));
});
test('very long narrow water is clipped to world bounds and cannot expand the search beyond its finite grid',()=>{
 const g=lake([[0,0],[.2,0],[.2,1e6],[0,1e6]]),e=setup(g);
 assert.equal(run(e).end?.code,'swim.no-deep-water');
});

test('large and long-thin named-water plans report finite cold/warm work without per-bind routing',()=>{
 for(const [name,points]of [['large',[[-90,-90],[90,-90],[90,90],[-90,90]]],['long-thin',[[0,0],[.2,0],[.2,1e6],[0,1e6]]]] as [string,[number,number][]][]){
  const g=lake(points),e=setup(g),field=groundField(groundFact(g,1).recipeHash),original=field.waterId!;let probes=0;field.waterId=(x,z)=>{probes++;return original(x,z);};
  try{const results=[];for(const mode of ['cold','warm']){probes=0;const t=performance.now();e.canPerform({actor:'h_swimmer',label:'take a swim',steps:[step]});results.push({mode,ms:performance.now()-t,waterIdentityProbes:probes});assert.ok(probes<=9*65536+1,`${name}: bounded candidate and margin probes: ${probes}`);}console.log(JSON.stringify({fixture:name,results}));}finally{field.waterId=original;}
 }
});

test('replacing the selected water before terminal publication cannot produce a successful named swim',()=>{
 const g=lake(),e=setup(g),adm=e.perform({actor:'h_swimmer',label:'take a swim',steps:[step]});assert.equal(adm.ok,true);
 let arrived=false;for(let i=0;i<2500;i++){e.step();if(e.world.entities.h_swimmer.human.activity==='tread'&&e.programOf('h_swimmer')){arrived=true;break;}}
 assert.ok(arrived,'swim child reached water while parent is still open');g.waters[0].id='replacement';e.installGroundV1(groundFact(g,2,{paged:true}));
 let end:any;for(let i=0;i<2500&&!end;i++)end=e.step().programs.find((p:any)=>p.id===adm.id&&['completed','failed'].includes(p.kind));
 assert.equal(end?.kind,'failed');assert.equal(end?.code,'swim.destination-changed');
});

test('a lake below a cliff has no safe walk-in entry despite deep water beyond it',()=>{
 const g=lake();g.landforms[0]={id:'lake',kind:'carve',area,bed:-12,edge:6};g.waters[0].level=-8;
 const r=run(setup(g));assert.equal(r.end?.kind,'failed');assert.equal(r.end?.code,'swim.no-reachable-entry');
});

// #1288: a swim held up by a body that never moves ends honestly, as a walk with no headway does
function heldUp(){const e=setup(lake());e.spawnHuman({id:'h_block',label:'Blocker',soul:'s_block'});const b=e.world.entities.h_block,h=e.world.entities.h_swimmer;
 h.pose.p=[22,h.pose.p[1],0];b.pose.p=[26,b.pose.p[1],0];return {e,b,h};}
const run2=(e:any,id:string,max:number)=>{let end:any,n=0;for(;n<max&&!end;n++)end=e.step().programs.find((p:any)=>p.id===id&&['failed','completed','cancelled'].includes(p.kind));return {end,n};};
test('#1288 W3: a swim held up for 30 s ends swim.stuck and leaves the swimmer free',()=>{
 const {e,h}=heldUp(),adm=e.perform({actor:'h_swimmer',label:'swim',steps:[{verb:'mars:swim_to',params:{x:32,z:0}}]});assert.equal(adm.ok,true,JSON.stringify(adm));
 const r=run2(e,adm.id,800);assert.equal(r.end?.kind,'failed',JSON.stringify(r));assert.equal(r.end?.code,'swim.stuck',JSON.stringify(r));
 assert.ok(r.n>=590&&r.n<=720,`near 30 s (tick ${r.n})`);assert.equal(h.human.task,undefined);assert.ok(['tread','idle'].includes(h.human.activity),h.human.activity);
});
test('#1288 W4: a swim that waits and then gets past completes, and the count starts again',()=>{
 const {e,b}=heldUp(),adm=e.perform({actor:'h_swimmer',label:'swim',steps:[{verb:'mars:swim_to',params:{x:32,z:0}}]});assert.equal(adm.ok,true,JSON.stringify(adm));
 for(let i=0;i<300;i++)e.step();b.pose.p=[26,b.pose.p[1],8];
 const r=run2(e,adm.id,1500);assert.equal(r.end?.kind,'completed',JSON.stringify(r));
});
test('#1288 W5: an unhindered swim holds no wait state, and a held one keeps its count across a restore',()=>{
 const free=setup(lake());free.world.entities.h_swimmer.pose.p=[22,free.world.entities.h_swimmer.pose.p[1],0];
 const a=free.perform({actor:'h_swimmer',label:'swim',steps:[{verb:'mars:swim_to',params:{x:32,z:0}}]});for(let i=0;i<40;i++)free.step();assert.equal(a.ok,true);
 assert.ok(!JSON.stringify(free.snapshot()).includes('"waited"'),'no new state');
 const {e}=heldUp(),adm=e.perform({actor:'h_swimmer',label:'swim',steps:[{verb:'mars:swim_to',params:{x:32,z:0}}]});for(let i=0;i<300;i++)e.step();
 const b=factory.restore(e.snapshot()) as any;for(let i=0;i<200;i++){e.step();b.step();}assert.equal(e.stateHash(),b.stateHash());
 assert.equal(run2(b,adm.id,300).end?.code,'swim.stuck');
});
