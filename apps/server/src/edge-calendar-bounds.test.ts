// #2100: calendar items Souls post have a per-owner and a per-world cap, ended ones expire a day after they end, and a
// read by time window is not displaced by a flood of far-future items.
import test from 'node:test';
import assert from 'node:assert/strict';
import {Hono} from 'hono';
import {retainedCommonsShoreFactory,nativeSleepSnapshotFactoryV1} from '@souls/engine-mars';
import {fixture,invite,accept} from '../test/native-owner-fixture.ts';
import {LivingWorld} from './living.ts';
import {EdgeLedger} from './edge/ledger/ledger.ts';
import {registerEdgeComms} from './edge/comms/index.ts';
import {hashToken,RateLimit} from './auth.ts';
import {edgeSoulResolver} from './edge/routes.ts';

test('#2100 owner and world caps, expiry a day after the end, windows not displaced by far-future items',{timeout:180000},async t=>{
 const f=fixture(':memory:',nativeSleepSnapshotFactoryV1(await retainedCommonsShoreFactory()),{durableClockV1:true});f.souls.enableLifecycle();f.brain.quiesce();t.after(()=>{f.host.stop();f.db.close();});
 await accept<unknown>(f.host,new LivingWorld(f.host).install(['Owners drive their Souls.']));for(let i=0;i<4;i++)f.host.tickOnce();
 // ana and ana2 share an owner; bob and cara have their own
 for(const o of ['ana','bob','cara'])await invite(f,o);
 const tokens:Record<string,string>={};
 for(const [n,o] of [['ana','ana'],['ana2','ana'],['bob','bob'],['cara','cara']]){const row=await accept(f.host,f.souls.create('dev:'+o,{name:n[0].toUpperCase()+n.slice(1),description:'cal'}));f.db.setSoulToken(row.id,hashToken('sim_CB_'+n),'t');tokens[n]=row.id;}
 const ledger=new EdgeLedger(f.host,f.db),app=new Hono(),bearer=(c:any)=>c.req.header('authorization')?.replace(/^Bearer\s+/i,'');
 const comms=registerEdgeComms(app,{host:f.host,db:f.db,souls:f.souls,soul:edgeSoulResolver(f.host,f.souls,bearer),ledger},{sweepMs:0,calendarCaps:{perOwner:3,perWorld:6}});ledger.attachComms(comms as any);t.after(()=>comms.close());
 const j=async(path:string,init:any={})=>{const r=await app.request(path,init);return {status:r.status,body:await r.json() as any};};
 const post=(n:string,title:string,startsInMinutes:number,durationMinutes=5)=>j('/v1/edge/calendar',{method:'POST',headers:{authorization:'Bearer sim_CB_'+n,'content-type':'application/json'},body:JSON.stringify({title,placeId:places[0],startsInMinutes,durationMinutes})});
 const places=[...((ledger as any).places.byId as Map<string,{name:string}>).keys()];
 const calendarIds=()=>comms.objects.ofKind('calendar-item').map(o=>o.id);
 // 1,200 ticks a real minute at rate 1; a slow admin rate keeps a real day short in ticks (a day = 1,728 ticks here)
 f.host.baseRate=0.001;

 // A1: the owner cap counts both of ana's owner's Souls; the world cap counts every Soul's open items
 for(const [n,title] of [['ana','A1'],['ana','A2'],['ana2','A3']])assert.equal((await post(n,title,1)).status,200,title);
 for(const n of ['ana','ana2']){const r=await post(n,'over owner cap',1);assert.equal(r.status,429);assert.equal(r.body.error.code,'calendar.owner-full');assert.match(r.body.error.message,/3 calendar items/);}
 for(const title of ['B1','B2','B3'])assert.equal((await post('bob',title,1)).status,200,title);
 const full=await post('cara','over world cap',1);assert.equal(full.status,429);assert.equal(full.body.error.code,'calendar.world-full');assert.match(full.body.error.message,/6 calendar items/);
 // a steward item does not count against Souls, and is never expired
 const steward=comms.objects.create({id:'cal-steward1',kind:'calendar-item',name:'Steward',placeId:places[0],params:{title:'Steward',placeId:places[0],startsAtTick:f.host.engine.world.tick+1,durationTicks:6}});
 assert.equal((await post('cara','still over world cap',1)).status,429);

 // A2: ended items stay listed (as over) for a day after they end, then go; the steward's stays
 const souls=calendarIds().filter(id=>id!==steward.id);assert.equal(souls.length,6);
 const end=Math.max(...comms.objects.ofKind('calendar-item').map(o=>(o.state as any).endsAtTick));
 while(f.host.engine.world.tick<end+2)f.host.tickOnce();
 for(let i=0;i<3;i++)comms.sweep();
 assert.ok(comms.objects.ofKind('calendar-item').every(o=>(o.state as any).phase==='over'),'all over');
 assert.equal(calendarIds().length,7,'over but not yet a day old: kept');
 f.souls.limits=new RateLimit();
 assert.equal((await post('cara','C1',1)).status,200,'over items no longer count against the caps');
 while(f.host.engine.world.tick<end+1728)f.host.tickOnce();
 comms.sweep();
 const left=calendarIds();
 assert.ok(souls.every(id=>!left.includes(id)),'Soul items gone a day after they ended: '+left);
 assert.ok(left.includes(steward.id),'the steward item stays');

 // A3: a flood of far-future items made after a near one never pushes it out of a window or a limited read
 f.host.baseRate=1;f.souls.limits=new RateLimit();
 const near=await post('bob','Near',30,30);assert.equal(near.status,200);
 for(let i=0;i<250;i++)comms.objects.create({id:'cal-flood'+i,kind:'calendar-item',name:'Flood',placeId:places[0],params:{title:'Flood '+i,placeId:places[0],proposedBy:'Cara',proposedById:tokens.cara,startsAtTick:f.host.engine.world.tick+(6000+i)*1200,durationTicks:6000}});
 assert.deepEqual((await j('/v1/edge/calendar?withinMinutes=120')).body.items.map((x:any)=>x.title).filter((x:string)=>x!=='C1'),['Near']);
 const limited=(await j('/v1/edge/calendar?limit=200')).body.items.map((x:any)=>x.title);
 assert.equal(limited.length,200);assert.ok(limited.indexOf('Near')>=0&&limited.indexOf('Near')<2,'Near is among the first: '+limited.slice(0,3));
 assert.ok((await j('/v1/edge/calendar?withinMinutes=10080&limit=200')).body.items.some((x:any)=>x.title==='Near'));
});
