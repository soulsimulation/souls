// #2050: a dev-identity pair (POST /v1/souls/:id/pair) follows the #2401 move rule a login's grant pair follows.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { marsFactory,GREEN_FIELD_WORLD } from '@souls/engine-mars';
import { fixture,invite } from '../test/native-owner-fixture.ts';
const factory=await marsFactory({...GREEN_FIELD_WORLD,safeCrewRemoval:true});

test('#2050: a dev pair is free with no agent connected, refused naming the device while one is, and move forces it',async t=>{
  const f=fixture(':memory:',factory);t.after(()=>f.db.close());await invite(f,'alice');
  const creation=f.souls.create('dev:alice',{name:'Wren',description:'pair-move fixture'});f.host.drainInputs();const soul=await creation;
  const as=(token:string)=>({headers:{host:'127.0.0.1:4956',authorization:`Bearer ${token}`}});
  const take=async(body:object)=>{const r=await f.request(`/v1/souls/${soul.id}/pair`,body);if(r.status!==200)return r;const {code}=await r.json() as {code:string};return f.request('/v1/agent/pair',{code,agent:'eden 2.35.0'});};
  const first=await take({});assert.equal(first.status,200,'never paired: free');const old=(await first.json() as {token:string}).token;
  const second=await take({});assert.equal(second.status,200,'paired but not listening: free');const held=(await second.json() as {token:string}).token;
  assert.equal(f.souls.soulFromToken(old),null,'the free take replaced the idle holder');
  assert.equal((await f.app.request('/v1/edge/inbox/listen?timeoutMs=0',as(held))).status,200,'the holder listens: connected');
  const refused=await take({});assert.equal(refused.status,409);const why=await refused.json() as {code:string;message:string;heldBy:string};
  assert.equal(why.code,'soul.held-elsewhere');assert.equal(why.heldBy,'eden 2.35.0');assert.match(why.message,/connected now from eden 2\.35\.0\. .*move/);
  assert.equal(f.souls.soulFromToken(held)!.id,soul.id,'refused: the connected agent keeps the Soul');
  const moved=await take({move:true});assert.equal(moved.status,200,'move forces it');
  assert.equal(f.souls.soulFromToken(held),null);assert.equal(f.souls.soulFromToken((await moved.json() as {token:string}).token)!.id,soul.id);
});
