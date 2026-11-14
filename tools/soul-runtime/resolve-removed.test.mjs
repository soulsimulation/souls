// The world closed /v1/edge/resolve (410, #2138), so the managed runtime no longer offers the model a resolve read. A resolve
// read an older runtime retained is answered locally as a refusal, so the Soul replans instead of failing closed.
import {test} from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,rmSync} from 'node:fs';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {openJournal} from './journal.mjs';
import {parseDecision,retainDecision,applyPendingDecision} from './decision.mjs';
import {createWorldClient} from './world-client.mjs';
import {INSTRUCTIONS} from './supervisor.mjs';

test('the model is offered no resolve read: the decision is refused, the client sends nothing and the instructions omit it',async()=>{
 assert.throws(()=>parseDecision(JSON.stringify({plan:'Find the bench',call:{type:'read',command:'resolve',arguments:'{"capability":"sit:bench"}'},wakeAt:null})),/Unsupported decision command/);
 let requests=0;const client=createWorldClient({world:'http://127.0.0.1:1234/world',token:'synthetic-fixture-only',fetchImpl:async()=>{requests++;return Response.json({ok:true});}});
 await assert.rejects(client.read('resolve',{capability:'sit:bench'}),/Unsupported world read/);assert.equal(requests,0);
 assert.doesNotMatch(INSTRUCTIONS,/resolve\(/);assert.match(INSTRUCTIONS,/explore\(query\), receipt\(id\)/);
});

test('a resolve read retained by an older runtime is answered locally and the Soul moves on',async t=>{
 const dir=mkdtempSync(join(tmpdir(),'souls-resolve-removed-'));const j=openJournal(dir,{worldId:'w',soulId:'s'});t.after(()=>{j.close();rmSync(dir,{recursive:true,force:true});});
 const fence=j.control.claim('test');
 retainDecision(j,fence,{plan:'Check the bench offer, then sit',call:{type:'read',command:'resolve',args:{capability:'sit:bench'}},wakeAt:null});
 let calls=0;const r=await applyPendingDecision(j,fence,{read:async()=>calls++,write:async()=>calls++});
 assert.equal(calls,0,'nothing reaches the world');assert.equal(r.applied,true);assert.equal(r.response.error.code,'read.removed');
 assert.equal(j.control.checkpoint().value.pendingDecision,null);
});
