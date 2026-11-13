// #2243 (account-grant/1, #2242): a world issues an account grant. An agent logs in once, then lists, moves, disconnects
// and asks to retire; the person sees and revokes every grant. Fake minds, in-memory worlds, a temporary registry file.
import test,{type TestContext} from 'node:test';
import assert from 'node:assert/strict';
import {createHash,randomBytes} from 'node:crypto';
import {mkdirSync,rmSync} from 'node:fs';
import {resolve} from 'node:path';
import {DatabaseSync} from 'node:sqlite';
import {setImmediate} from 'node:timers/promises';
import {fixture} from '../test/native-owner-fixture.ts';
import {buildApp} from './http.ts';
import type {Hub} from './hub.ts';
import type {AccountIdentity} from './accounts/store.ts';
import {AccountLogins,sharedLoginsDb} from './accounts/logins.ts';
import {AccountRegistry} from './account-registry.ts';
import {marsFactory,GREEN_FIELD_WORLD} from '@souls/engine-mars';
const factory=await marsFactory({...GREEN_FIELD_WORLD,safeCrewRemoval:true});
const secret=()=>randomBytes(32).toString('base64url'),device=()=>'dev_'+randomBytes(16).toString('hex');
let keys=0;const key=(what:string)=>`account-login-test-${what}-${++keys}`;

async function world(t:TestContext){
 const f=fixture(':memory:',factory);f.brain.quiesce();f.souls.enableLifecycle();t.after(()=>{f.host.stop();f.db.close();});
 f.souls.cfg.accountAuthRequired=true;f.souls.cfg.inviteRequired=false;
 const ids=new Map<string,AccountIdentity>();for(const name of ['alice','bob']){const id='did:privy:'+name;f.db.upsertUser({id,email:null,wallet:null,role:'user'});ids.set(name,{id,issuer:'privy.io/test-app',subject:id,verifiedAt:Date.now(),expiresAt:Date.now()+600_000});}
 f.auth.accountFromToken=async token=>{const identity=ids.get(token??'');return identity?{identity,user:f.db.user(identity.id)!}:null;};
 const original=f.auth.userFromToken.bind(f.auth);f.auth.userFromToken=async token=>ids.has(token??'')?f.db.user(ids.get(token!)!.id)!:original(token);
 const app=buildApp({cfg:f.souls.cfg,db:f.db,host:f.host,souls:f.souls,brain:f.brain,auth:f.auth,hub:{clients:new Map(),refreshMe(){}} as unknown as Hub});
 const call=async(path:string,body?:unknown,token?:string)=>{const r=await app.request(path,{method:body===undefined?'GET':'POST',headers:{host:'127.0.0.1:4956',...(token?{authorization:'Bearer '+token}:{}),...(body===undefined?{}:{'content-type':'application/json'})},...(body===undefined?{}:{body:JSON.stringify(body)})});return {status:r.status,data:await r.json().catch(()=>null) as any,cache:r.headers.get('cache-control')};};
 /** A Soul born for `who` through today's approval, and the Soul token its agent holds. */
 const born=async(who:string,name:string)=>{
  const code=(await call('/v1/account/window-code',{},who)).data.code,pollSecret=secret();
  const start=await call('/v1/agent/approval/start',{agentLabel:'eden 2.33.0',name,idempotencyKey:key('born'),pollSecret,for:code}),approvalId=start.data.approval.id;
  const approved=await call(`/v1/account/approvals/${approvalId}/approve`,{},who);assert.equal(approved.data.approval.status,'ready',JSON.stringify(approved.data));
  let token:string|undefined;for(let i=0;i<50&&!token;i++){f.host.drainInputs();await setImmediate();token=(await call('/v1/agent/approval/poll',{approvalId,pollSecret})).data.token;}
  return {soulId:approved.data.approval.soulId as string,token:token!};
 };
 /** A ready account login for `who` from one device: the request, its secret and the token. */
 const login=async(who:string,dev=device(),label='eden 2.33.0')=>{
  const code=(await call('/v1/account/window-code',{},who)).data.code,pollSecret=secret();
  const start=await call('/v1/agent/account/login',{agentLabel:label,device:{id:dev,name:'studio laptop'},idempotencyKey:key('login'),pollSecret,for:code});assert.equal(start.status,200,JSON.stringify(start.data));
  assert.equal((await call(`/v1/account/requests/${start.data.request.id}/approve`,{},who)).data.request.status,'ready');
  const polled=await call('/v1/agent/account/requests/poll',{requestId:start.data.request.id,pollSecret});
  return {requestId:start.data.request.id as string,pollSecret,token:polled.data.token as string,grantId:polled.data.grant.id as string,dev};
 };
 return {f,call,born,login};
}

test('A1 login: start, approve as the signed-in account, poll returns one sacct_ token; only its hash is stored',async t=>{
 const w=await world(t),code=(await w.call('/v1/account/window-code',{},'alice')).data.code,pollSecret=secret(),dev=device();
 const body={agentLabel:'eden 2.33.0',device:{id:dev,name:'studio laptop'},idempotencyKey:key('a1'),pollSecret,for:code};
 const start=await w.call('/v1/agent/account/login',body);assert.equal(start.status,200,JSON.stringify(start.data));assert.equal(start.cache,'no-store');
 const r=start.data.request;assert.match(r.id,/^aq_[a-f0-9]{32}$/);assert.equal(r.kind,'login');assert.equal(r.status,'pending');assert.deepEqual(r.device,{name:'studio laptop'});assert.equal(r.soul,null);assert.match(r.confirm,/^[A-HJ-NP-Z2-9]{4}$/);assert.equal(r.inWindow,true);
 assert.equal(start.data.delivery,'window');assert.equal(start.data.intervalSeconds,3);assert.ok(start.data.approvalURL.endsWith('/#approve/'+r.id));assert.equal(start.data.world.id,w.f.host.worldId);assert.ok(!JSON.stringify(start.data).includes(pollSecret));
 assert.equal((await w.call('/v1/agent/account/login',body)).data.request.id,r.id,'a retry with the same key and secret is the same request');
 assert.equal((await w.call('/v1/agent/account/login',{...body,pollSecret:secret()})).status,401,'the same key with another secret is refused');
 assert.equal((await w.call('/v1/agent/account/requests/poll',{requestId:r.id,pollSecret})).data.token,undefined,'no token while pending');
 assert.deepEqual((await w.call('/v1/account/approvals',undefined,'alice')).data.requests.map((q:any)=>q.id),[r.id],'the addressed window lists it');
 assert.equal((await w.call(`/v1/account/requests/${r.id}`,undefined,'bob')).status,403);
 assert.equal((await w.call(`/v1/account/requests/${r.id}/approve`,{},'bob')).status,403,"a request started with alice's window code is not bob's to approve");
 assert.equal((await w.call(`/v1/account/requests/${r.id}/approve`,{},'alice')).data.request.status,'ready');
 const first=await w.call('/v1/agent/account/requests/poll',{requestId:r.id,pollSecret});assert.equal(first.data.request.status,'ready');assert.match(first.data.token,/^sacct_[A-Za-z0-9_-]{43}$/);
 assert.equal(first.data.account.id,'did:privy:alice');assert.match(first.data.grant.id,/^ag_[a-f0-9]{32}$/);
 assert.equal((await w.call('/v1/agent/account/requests/poll',{requestId:r.id,pollSecret})).data.token,first.data.token,'the same poll returns the same token');
 const rows=w.f.db.db.prepare('SELECT * FROM account_agent_logins_v1').all() as Record<string,unknown>[];assert.equal(rows.length,1);
 assert.equal(rows[0].token_hash,createHash('sha256').update(first.data.token).digest('hex'));assert.ok(!JSON.stringify(rows).includes(first.data.token)&&!JSON.stringify(w.f.db.db.prepare('SELECT * FROM account_requests_v1').all()).includes(pollSecret),'only hashes are stored');
 // cancelled: the agent cancels, the person's approve then changes nothing and no token is ever returned
 const cs=secret(),cancelled=(await w.call('/v1/agent/account/login',{...body,idempotencyKey:key('a1c'),pollSecret:cs})).data.request;
 const byAgent=(await w.call('/v1/agent/account/requests/cancel',{requestId:cancelled.id,pollSecret:cs})).data.request;assert.equal(byAgent.status,'cancelled');assert.equal(byAgent.ended,'cancelled');
 assert.equal((await w.call(`/v1/account/requests/${cancelled.id}/approve`,{},'alice')).data.request.status,'cancelled');
 assert.equal((await w.call('/v1/agent/account/requests/poll',{requestId:cancelled.id,pollSecret:cs})).data.token,undefined);
 // #2258: no expiry. Three days with no poll, still open, listed and approvable; the DTO carries no expiresAt
 let now=1_000_000;const db=sharedLoginsDb(new DatabaseSync(':memory:')),logins=new AccountLogins(db,db,'w-open',{now:()=>now}),es=secret();
 const old=logins.startLogin({agentLabel:'eden',device:{id:dev,name:'laptop'},idempotencyKey:key('a1e'),pollSecret:es});assert.equal('expiresAt' in old,false);now+=3*24*60*60_000;
 assert.equal(logins.view(old.id).status,'pending');assert.equal(logins.poll(old.id,es).request.status,'pending');
 assert.equal(logins.approveLogin('acct_x',old.id).status,'ready');assert.match(logins.poll(old.id,es).token??'',/^sacct_/);
 assert.equal(w.f.db.paidCost(),0);
});

test('#2258 A1 a request ends only when refused, cancelled or replaced by the same agent\'s newer one',async t=>{
 const w=await world(t),code=(await w.call('/v1/account/window-code',{},'alice')).data.code,dev=device(),other=device();
 const start=async(d:string)=>{const pollSecret=secret(),r=await w.call('/v1/agent/account/login',{agentLabel:'eden 2.33.0',device:{id:d,name:'studio laptop'},idempotencyKey:key('replace'),pollSecret,for:code});assert.equal(r.status,200,JSON.stringify(r.data));return {id:r.data.request.id as string,pollSecret};};
 const first=await start(dev),elsewhere=await start(other),second=await start(dev);
 const was=(await w.call('/v1/agent/account/requests/poll',{requestId:first.id,pollSecret:first.pollSecret})).data.request;assert.equal(was.status,'cancelled');assert.equal(was.ended,'replaced','the same device asking again replaces its open login');
 assert.equal((await w.call(`/v1/account/requests/${first.id}/approve`,{},'alice')).data.request.status,'cancelled','a replaced request cannot be approved');
 assert.deepEqual((await w.call('/v1/account/approvals',undefined,'alice')).data.requests.map((q:any)=>q.id),[second.id,elsewhere.id],'another device keeps its own');
 const refused=(await w.call(`/v1/account/requests/${second.id}/cancel`,{},'alice')).data.request;assert.equal(refused.status,'cancelled');assert.equal(refused.ended,'refused');
 assert.equal((await w.call('/v1/agent/account/requests/poll',{requestId:second.id,pollSecret:second.pollSecret})).data.request.ended,'refused','the agent reads who ended it');
 assert.equal((await w.call('/v1/agent/account/requests/poll',{requestId:elsewhere.id,pollSecret:elsewhere.pollSecret})).data.request.status,'pending');
 assert.equal(w.f.db.paidCost(),0);
});

test('A2 the grant lists Souls, ends on logout, revoke and a newer login of the same device; a registry shares it',async t=>{
 const w=await world(t);
 const {soulId}=await w.born('alice','Averil');
 const a=await w.login('alice');
 const me=await w.call('/v1/agent/account',undefined,a.token);assert.equal(me.status,200,JSON.stringify(me.data));assert.equal(me.cache,'no-store');
 assert.equal(me.data.account.id,'did:privy:alice');assert.equal(me.data.grant.id,a.grantId);assert.deepEqual(me.data.grant.device,{id:a.dev,name:'studio laptop'});assert.equal(me.data.maxSouls,w.f.souls.cfg.maxSoulsPerUser);
 assert.deepEqual(me.data.souls.map((s:any)=>s.id),[soulId]);const s=me.data.souls[0];assert.equal(s.name,'Averil');assert.equal(typeof s.control.held,'boolean');assert.ok('state' in s.control&&'since' in s.control);assert.equal(s.agent.label,'eden 2.33.0');
 const agents=(await w.call('/v1/account/agents',undefined,'alice')).data.agents;assert.deepEqual(agents.map((g:any)=>g.id),[a.grantId]);assert.equal(typeof agents[0].lastUsedAt,'number');assert.deepEqual(agents[0].device,{name:'studio laptop'});
 assert.deepEqual((await w.call('/v1/account/agents',undefined,'bob')).data.agents,[]);
 assert.equal((await w.call('/v1/agent/account/logout',{},a.token)).data.ok,true);
 const out=await w.call('/v1/agent/account',undefined,a.token);assert.equal(out.status,401);assert.equal(out.data.code,'account.revoked');
 assert.equal((await w.call('/v1/agent/account/requests/poll',{requestId:a.requestId,pollSecret:a.pollSecret})).data.token,undefined,'an ended grant gives no token again');
 const b=await w.login('alice');assert.equal((await w.call(`/v1/account/agents/${b.grantId}/revoke`,{},'bob')).status,404);
 assert.equal((await w.call(`/v1/account/agents/${b.grantId}/revoke`,{},'alice')).data.ok,true);assert.equal((await w.call('/v1/agent/account',undefined,b.token)).data.code,'account.revoked');
 const c=await w.login('alice'),d=await w.login('alice',c.dev);
 const replaced=await w.call('/v1/agent/account',undefined,c.token);assert.equal(replaced.status,401);assert.equal(replaced.data.code,'account.revoked');assert.equal(replaced.data.reason,'replaced');
 assert.equal((await w.call('/v1/agent/account',undefined,d.token)).status,200);assert.deepEqual((await w.call('/v1/account/agents',undefined,'alice')).data.agents.map((g:any)=>g.id),[d.grantId]);
 const unknown=await w.call('/v1/agent/account',undefined,'sacct_'+secret());assert.equal(unknown.status,401);assert.equal(unknown.data.code,'account.unknown');
 // two worlds' grant stores on one registry file; and two worlds without one
 const dir=resolve('.local/test-account-login-'+randomBytes(6).toString('hex'));mkdirSync(dir,{recursive:true});t.after(()=>rmSync(dir,{recursive:true,force:true}));
 const registry=new AccountRegistry(resolve(dir,'registry.db'));t.after(()=>registry.close());
 const issue=(logins:AccountLogins)=>{const ps=secret(),r=logins.startLogin({agentLabel:'eden',device:{id:device(),name:'laptop'},idempotencyKey:key('reg'),pollSecret:ps});logins.approveLogin('acct_shared',r.id);return logins.poll(r.id,ps).token!;};
 const own=()=>sharedLoginsDb(new DatabaseSync(':memory:')),shared=sharedLoginsDb(registry.db);
 const first=new AccountLogins(own(),shared,'world-one'),second=new AccountLogins(own(),sharedLoginsDb(new AccountRegistry(resolve(dir,'registry.db')).db),'world-two'),token=issue(first);
 assert.equal((second.resolve(token) as any)?.grant.accountId,'acct_shared','a token issued by the first world is accepted by the second');
 const wa=own(),wb=own(),lone=new AccountLogins(wa,wa,'world-a'),other=new AccountLogins(wb,wb,'world-b'),local=issue(lone);
 assert.equal((lone.resolve(local) as any)?.grant.accountId,'acct_shared');assert.equal(other.resolve(local),null,'without a registry it is accepted only where it was issued');
});

test('A3 move: pair through the grant hands a Soul token with no person; the old token is replaced; others refused',async t=>{
 const w=await world(t),{soulId,token:old}=await w.born('alice','Brisa'),bobs=await w.born('bob','Corvin'),a=await w.login('alice');
 assert.equal((await w.call('/v1/agent/soul',undefined,old)).status,200);
 assert.equal((await w.call('/v1/agent/account',undefined,a.token)).data.souls[0].control.held,true,'the Soul is held elsewhere');
 const pairBody={agentLabel:'eden 2.33.0',idempotencyKey:key('pair'),pollSecret:secret()};
 const pair=await w.call(`/v1/agent/account/souls/${soulId}/pair`,pairBody,a.token);assert.equal(pair.status,200,JSON.stringify(pair.data));
 assert.equal(pair.data.delivery,'account');assert.equal(pair.data.intervalSeconds,3);assert.equal(pair.data.approval.mode,'repair');assert.equal(pair.data.approval.status,'ready');assert.equal(pair.data.approval.agentLabel,'eden 2.33.0 on studio laptop');
 const polled=await w.call('/v1/agent/approval/poll',{approvalId:pair.data.approval.id,pollSecret:pairBody.pollSecret});assert.match(polled.data.token,/^sim_s_/);assert.notEqual(polled.data.token,old);
 assert.equal((await w.call('/v1/agent/soul',undefined,polled.data.token)).status,200,'the new token works');
 const gone=await w.call('/v1/agent/soul',undefined,old);assert.equal(gone.status,401);assert.equal(gone.data.code,'control.revoked');assert.equal(gone.data.reason,'replaced');
 const again=await w.call(`/v1/agent/account/souls/${soulId}/pair`,pairBody,a.token);assert.equal(again.data.approval.id,pair.data.approval.id);
 assert.equal((await w.call('/v1/agent/approval/poll',{approvalId:again.data.approval.id,pollSecret:pairBody.pollSecret})).data.token,polled.data.token,'a repeat returns the same token');
 const foreign=await w.call(`/v1/agent/account/souls/${bobs.soulId}/pair`,{...pairBody,idempotencyKey:key('pair')},a.token);assert.equal(foreign.status,403);assert.equal(foreign.data.code,'forbidden');
 assert.equal((await w.call('/v1/agent/soul',undefined,bobs.token)).status,200,"bob's Soul is untouched");
 assert.equal((await w.call('/v1/agent/account/souls/s_nowhere/pair',{...pairBody,idempotencyKey:key('pair')},a.token)).data.code,'soul-not-found');
 assert.equal((await w.call(`/v1/agent/account/souls/${bobs.soulId}/revoke`,{},a.token)).status,403);
 const revoked=await w.call(`/v1/agent/account/souls/${soulId}/revoke`,{},a.token);assert.deepEqual(revoked.data,{ok:true,soulId});
 const off=await w.call('/v1/agent/soul',undefined,polled.data.token);assert.equal(off.status,401);assert.equal(off.data.code,'control.revoked');
 assert.deepEqual(w.f.host.engine.runtime.violations,[]);
});

test('A4 retire: an agent only asks; the addressed person approves it by the DELETE path, a cancel changes nothing',async t=>{
 const w=await world(t),{soulId}=await w.born('alice','Dalia'),a=await w.login('alice'),live=()=>w.f.db.soul(soulId)!.retired_at===null;
 const ask=async()=>{const pollSecret=secret(),r=await w.call(`/v1/agent/account/souls/${soulId}/retire`,{idempotencyKey:key('retire'),pollSecret},a.token);assert.equal(r.status,200,JSON.stringify(r.data));return {...r.data,pollSecret};};
 const two=await ask();
 assert.equal((await w.call(`/v1/account/requests/${two.request.id}/cancel`,{},'alice')).data.request.status,'cancelled');
 assert.equal((await w.call(`/v1/account/requests/${two.request.id}/approve`,{},'alice')).data.request.status,'cancelled');assert.ok(live(),'cancelling changes nothing');
 const old=await ask(),one=await ask();
 assert.equal(one.request.kind,'retire');assert.equal(one.request.status,'pending');assert.deepEqual(one.request.soul,{id:soulId,name:'Dalia'});assert.equal(one.delivery,'window');assert.ok(one.approvalURL.endsWith('/#approve/'+one.request.id));
 assert.equal((await w.call('/v1/agent/account/requests/poll',{requestId:old.request.id,pollSecret:old.pollSecret})).data.request.ended,'replaced','asking again to retire the same Soul replaces the open ask');
 const listed=(await w.call('/v1/account/approvals',undefined,'alice')).data;assert.ok(Array.isArray(listed.approvals));assert.deepEqual(listed.requests.filter((q:any)=>q.kind==='retire').map((q:any)=>q.id),[one.request.id]);
 assert.deepEqual((await w.call('/v1/account/approvals',undefined,'bob')).data.requests,[],"bob's window never sees it");
 assert.equal((await w.call(`/v1/account/requests/${one.request.id}/approve`,{},'bob')).status,403);
 assert.equal((await w.call(`/v1/account/requests/${one.request.id}/approve`,{},a.token)).status,401,'the account token cannot approve');
 assert.equal((await w.call('/v1/agent/account/requests/poll',{requestId:one.request.id,pollSecret:one.pollSecret})).data.request.status,'pending');assert.ok(live());
 const approved=await w.call(`/v1/account/requests/${one.request.id}/approve`,{},'alice');assert.equal(approved.status,200,JSON.stringify(approved.data));assert.equal(approved.data.request.status,'ready');
 for(let i=0;i<100&&live();i++){w.f.host.drainInputs();w.f.souls.lifecycle?.pump();await setImmediate();}
 assert.ok(!live(),'the Soul is retired');
 assert.equal((await w.call('/v1/agent/account/requests/poll',{requestId:one.request.id,pollSecret:one.pollSecret})).data.request.status,'ready');
 assert.deepEqual(w.f.host.engine.runtime.violations,[]);
});

test('A5 config announces accountLogin',async t=>{
 const w=await world(t);assert.equal((await w.call('/v1/config')).data.accountLogin,true);
});
