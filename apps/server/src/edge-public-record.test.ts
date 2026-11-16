// A Soul's public record, read with no token, keeps every field of a walk's receipt (#1234's control; #1262: no place is secret).
import test,{type TestContext} from 'node:test';
import assert from 'node:assert/strict';
import {setImmediate} from 'node:timers/promises';
import {retainedCommonsShoreFactory,nativeSleepSnapshotFactoryV1} from '@souls/engine-mars';
import {Hono} from 'hono';
import {fixture,invite,accept} from '../test/native-owner-fixture.ts';
import {LivingWorld} from './living.ts';
import {hashToken} from './auth.ts';
import {EdgeLedger} from './edge/ledger/ledger.ts';
import {mountEdgeRoutes,edgeSoulResolver} from './edge/routes.ts';

const factory=nativeSleepSnapshotFactoryV1(await retainedCommonsShoreFactory());
async function world(t:TestContext){
 const f=fixture(':memory:',factory,{durableClockV1:true});f.souls.enableLifecycle();f.brain.quiesce();
 await accept<unknown>(f.host,new LivingWorld(f.host).install(['Owners drive their Souls.']));for(let i=0;i<4;i++)f.host.tickOnce();
 await accept(f.host,f.host.installCommonsProvisionsV1());await accept(f.host,f.host.installRetainedCommonsShoreV1());await accept(f.host,f.host.installNativeSleepSnapshotV1());
 await invite(f,'alice');const row=await accept<{id:string}>(f.host,f.souls.create('dev:alice',{name:'Alice',description:'Synthetic'}) as never);f.db.setSoulToken(row.id,hashToken('sim_T'),'synthetic');
 const ledger=new EdgeLedger(f.host,f.db),app=new Hono(),bearer=(c:any)=>c.req.header('authorization')?.replace(/^Bearer\s+/i,'');
 mountEdgeRoutes(app,{host:f.host,db:f.db,souls:f.souls,soul:edgeSoulResolver(f.host,f.souls,bearer),ledger});t.after(()=>{f.host.stop();f.db.close();});
 const owner=async(m:string,p:string,b?:unknown)=>await (await accept<Response>(f.host,app.request(p,{method:m,headers:{authorization:'Bearer sim_T','content-type':'application/json'},...(b?{body:JSON.stringify(b)}:{})}) as never)).json() as any;
 const pub=async()=>{const r=await accept<Response>(f.host,app.request('/v1/edge/public/souls/'+row.id) as never),text=await r.text();return {status:r.status,text,j:JSON.parse(text)};};
 // a walk that ends somewhere: a real receipt with a capability, an endedAt and a path
 const caps=(await owner('GET','/v1/edge/capabilities')).capabilities as any[],walk=caps.find((c)=>c.verb==='walk'&&c.available),acted=await owner('POST','/v1/edge/act',{capability:walk.id});
 for(let i=0;i<4000;i++){f.host.tickOnce();if(i%20===0)await setImmediate();if((await owner('GET','/v1/edge/receipts/'+acted.receipt.id)).receipt?.phase==='completed')break;}
 return {...f,row,ledger,pub,owner,receiptId:acted.receipt.id as string,walk:walk.id as string};
}
/** Every place the record names, inner first, leaving the world itself. */
const places=(j:any)=>(j.self.placePath as {id:string;name:string}[]).filter((p)=>p.id!=='world');

test('a walk on the public record keeps its capability, its end place and position', async t => {
 const f=await world(t),{status,j}=await f.pub();
 assert.equal(status,200);assert.ok(places(j).length>0,'a path');
 const r=j.receipts.find((x:any)=>x.id===f.receiptId);
 assert.equal(r.capability,f.walk);assert.ok(r.endedAt?.place);assert.ok(Array.isArray(r.endedAt.pos));
});
