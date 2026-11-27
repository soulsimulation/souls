import test from 'node:test';import assert from 'node:assert/strict';import {alignmentValid,depictedBodyIds,recordAlignment} from './camera-observation.mjs';
test('alignment requires actual present subject, finite depicted tick and matching rendered matrix',()=>{
 const r={frame:{status:'observed',value:{depicted:{tick:1.25,seconds:.0625},subjects:[{id:'subject',state:'present',transform:{positionM:[1,2,3]}}]}},drawn:{tick:1.25,seconds:.0625},alignment:[{id:'subject',matrixPosition:[1,2,3]}]};assert.equal(alignmentValid(r,'subject'),true);r.drawn.tick=2;assert.equal(alignmentValid(r,'subject'),false);r.drawn.tick=1.25;r.alignment[0].matrixPosition[0]=2;assert.equal(alignmentValid(r,'subject'),false);assert.equal(alignmentValid(r,'missing'),false);
});

test('native node identifiers are mapped through the actual bridge/default-look entity convention',()=>{
 const scope='0'.repeat(32),ids=depictedBodyIds(scope+'-0');assert.equal(ids[0],'v2_'+scope+'_0');assert.ok(ids[1].startsWith('v2_'+scope+'_0'));assert.equal(ids.includes(scope+'-0'),false);
});

test('failed phase evidence is written before the throwing alignment assertion',async()=>{
 const {mkdirSync,mkdtempSync,readFileSync,rmSync}=await import('node:fs');mkdirSync('.local/camera-observation-driver-tests',{recursive:true});const dir=mkdtempSync('.local/camera-observation-driver-tests/phase-');const value={frame:{status:'rejected',reason:'fixture'}};
 try {assert.throws(()=>recordAlignment(value,'history','subject',dir+'/phase.json',(_key,ok)=>assert.ok(ok)),assert.AssertionError);assert.deepEqual(JSON.parse(readFileSync(dir+'/phase.json','utf8')),value);}finally{rmSync(dir,{recursive:true,force:true});}
});

import {pausedReady,stablePaused,collectResponses,completeResponses} from './camera-observation.mjs';
import {EventEmitter} from 'node:events';
import {mkdirSync,mkdtempSync,readFileSync,existsSync,rmSync} from 'node:fs';
test('history epoch alone and loading UI are rejected; paused ready target must match exactly',()=>{
 const good={ready:true,recorded:true,playEnabled:true,loading:false,epoch:'history',tick:123};
 assert.equal(pausedReady({epoch:'history',tick:123},123),false);assert.equal(pausedReady({...good,loading:true},123),false);
 assert.equal(pausedReady({...good,playEnabled:false},123),false);assert.equal(pausedReady(good,124),false);assert.equal(pausedReady(good,123),true);
});
test('paused stability requires same depicted time and transform on two distinct readouts',()=>{
 const r={frame:{value:{depicted:{tick:10,seconds:.5},subjects:[{id:'s',state:'present',transform:{positionM:[1,0,0]}}]}}};const later=structuredClone(r);
 assert.equal(stablePaused(r,later,'s'),true);later.frame.value.subjects[0].transform.positionM[0]=2;assert.equal(stablePaused(r,later,'s'),false);
});
const response=(page,body,url='https://example.test/world/history/header',status=200,headers={})=>({url:()=>url,status:()=>status,headers:()=>headers,body,request:()=>({isNavigationRequest:()=>false}),frame:()=>page.mainFrame()});
test('response cleanup drains in-flight bytes, unregisters listener and binds exact hashes plus phases',async()=>{
 mkdirSync('.local/camera-observation-driver-tests',{recursive:true});const dir=mkdtempSync('.local/camera-observation-driver-tests/responses-');const page=new EventEmitter();page.mainFrame=()=>null;
 let finish;const wait=new Promise(resolve=>finish=resolve);const c=collectResponses(page,dir,'https://example.test');page.emit('response',response(page,()=>wait));
 let done=false;const close=c.stop().then(()=>{done=true});await Promise.resolve();assert.equal(done,false);assert.equal(page.listenerCount('response'),0);finish(Buffer.from('public'));await close;
 const m=JSON.parse(readFileSync(dir+'/public-responses.json'));assert.equal(m.pendingAtClose,0);assert.equal(m.responses[0].sha256,'efa1f375d76194fa51a3556a97e641e61685f914d446979da50a551a4333ffd7');assert.equal(readFileSync(dir+'/public-response-0.bin','utf8'),'public');assert.ok(existsSync(dir+'/phase-manifest.json'));rmSync(dir,{recursive:true,force:true});
});
test('body failure is retained; bounded cleanup rejects and forbids late artifact writes',async()=>{
 mkdirSync('.local/camera-observation-driver-tests',{recursive:true});const dir=mkdtempSync('.local/camera-observation-driver-tests/late-');const page=new EventEmitter();page.mainFrame=()=>null;let finish;
 const c=collectResponses(page,dir,'https://example.test',{cleanupMs:10});page.emit('response',response(page,()=>Promise.reject(Error('read-failed'))));page.emit('response',response(page,()=>new Promise(resolve=>finish=resolve)));
 await assert.rejects(c.stop(),/history-response-cleanup-timeout/);const before=readFileSync(dir+'/public-responses.json','utf8');assert.match(before,/read-failed/);finish(Buffer.from('late'));await assert.rejects(c.flush(),/collection-closed/);assert.equal(existsSync(dir+'/public-response-1.bin'),false);assert.equal(readFileSync(dir+'/public-responses.json','utf8'),before);rmSync(dir,{recursive:true,force:true});
});
test('partial actual response ranges are not treated as a complete public bundle',()=>{
 const url='https://example.test/history/bundles/a';const part=(start,end,text)=>({url,status:206,headers:{'content-range':`bytes ${start}-${end}/6`},bytes:Buffer.from(text)});
 assert.equal(completeResponses([part(0,2,'abc')]).size,0);assert.equal(completeResponses([part(3,5,'def'),part(0,2,'abc')]).get(url).toString(),'abcdef');
});
import {agreeRecordedPoses} from './camera-observation.mjs';
test('every eligible captured revision must agree with independent pre-walk stationary pose',()=>{
 assert.equal(agreeRecordedPoses([{positionM:[1,0,0]},{positionM:[1.0001,0,0]}],[1,0,0]),true);
 assert.equal(agreeRecordedPoses([{positionM:[1,0,0]},{positionM:[2,0,0]}],[1,0,0]),false);
 assert.equal(agreeRecordedPoses([{positionM:[2,0,0]}],[1,0,0]),false);assert.equal(agreeRecordedPoses([],[1,0,0]),false);
});

import {publicTarget} from './camera-observation.mjs';
test('pending oracle cannot resume after cleanup closes collection',async()=>{
 mkdirSync('.local/camera-observation-driver-tests',{recursive:true});const dir=mkdtempSync('.local/camera-observation-driver-tests/oracle-');const page=new EventEmitter();page.mainFrame=()=>null;let finish;
 const c=collectResponses(page,dir,'https://example.test',{cleanupMs:10});page.emit('response',response(page,()=>new Promise(resolve=>finish=resolve)));
 const query=assert.rejects(publicTarget(c,1,'body',[0,0,0]),/collection-closed/);await assert.rejects(c.stop(),/cleanup-timeout/);const frozen=readFileSync(dir+'/phase-manifest.json','utf8');finish(Buffer.from('late'));await query;assert.equal(readFileSync(dir+'/phase-manifest.json','utf8'),frozen);assert.equal(existsSync(dir+'/public-response-0.bin'),false);rmSync(dir,{recursive:true,force:true});
});

import {completeRecordedResponses,decodeRecordedBundle} from './camera-observation.mjs';
import {createHash} from 'node:crypto';import {deflateRawSync} from 'node:zlib';
test('complete old revision cannot hide failed or incomplete potentially eligible revision',()=>{
 const url='https://example.test/history/bundles/old',old={url,status:200,headers:{},bytes:Buffer.from('complete')};
 const fresh={url:'https://example.test/history/bundles/new',status:206,headers:{'content-range':'bytes 0-2/6'},bytes:Buffer.from('abc')};
 assert.throws(()=>completeRecordedResponses([old,fresh]),/incomplete-or-failed/);
 assert.throws(()=>completeRecordedResponses([old,{...fresh,status:503,bytes:undefined,error:'failed'}]),/incomplete-or-failed/);
 assert.throws(()=>completeRecordedResponses([old,{...fresh,headers:{}}]),/incomplete-or-failed/);
 assert.equal(completeRecordedResponses([old]).get(url).toString(),'complete');
});
test('undecodable actual bundle revision propagates refusal instead of leaving only old candidate',()=>{
 const raw=Buffer.from('validated-shape-counterexample'),sha=createHash('sha256').update(raw).digest('hex'),url='https://example.test/history/bundles/0-'+sha;
 assert.throws(()=>decodeRecordedBundle(deflateRawSync(raw),Buffer.from(sha,'hex'),()=>{throw Error('native-history-integrity-refusal');}),/native-history-integrity-refusal/);
 assert.throws(()=>decodeRecordedBundle(Buffer.from('not-deflate'),Buffer.from(sha,'hex'),()=>assert.fail('cannot decode corrupt bytes')));
 assert.equal(decodeRecordedBundle(deflateRawSync(raw),Buffer.from(sha,'hex'),bytes=>bytes.toString()),raw.toString());
});
test('direct native/display comparison rejects opposite sides of prewalk within1mm each',()=>{
 const native=[{positionM:[1.0009,0,0]}],initial=[1,0,0],paused=[.9991,0,0];
 assert.equal(agreeRecordedPoses(native,initial),true);assert.equal(agreeRecordedPoses([{positionM:paused}],initial),true);
 assert.equal(agreeRecordedPoses(native,paused),false);
 assert.equal(agreeRecordedPoses([{positionM:[1,0,0]},{positionM:[1.0001,0,0]}],[1.0005,0,0]),true);
});

import {capturedIndexBindings} from './camera-observation.mjs';
import {encode,decode} from '../../../apps/web/node_modules/cborg/cborg.js';
const indexResponse=rows=>({url:'https://example.test/world/history/bundles/00000000/index',status:200,headers:{},bytes:Buffer.from(encode(new Map([[1,1],[2,0],[3,rows]])))});
const indexKey=new TextEncoder().encode('bundles/00000000/opaque-public-key');
test('opaque non-hash public key uses actual captured index SHA and exact history-root resolution',()=>{
 const raw=Buffer.from('public payload'),digest=createHash('sha256').update(raw).digest(),r=indexResponse([[0,indexKey,digest]]),bindings=capturedIndexBindings([r],decode),url='https://example.test/world/history/bundles/00000000/opaque-public-key';
 assert.deepEqual(bindings.get(url).digest,digest);assert.equal(decodeRecordedBundle(deflateRawSync(raw),bindings.get(url).digest,bytes=>bytes.toString()),'public payload');
 assert.throws(()=>decodeRecordedBundle(deflateRawSync(Buffer.from('tampered')),digest,()=>assert.fail('must reject before native decode')),/index-hash-mismatch/);
});
test('missing, conflicting, malformed and incomplete actual index bindings fail closed',()=>{
 const digest=Buffer.alloc(32,1),other=Buffer.alloc(32,2),row=[0,indexKey,digest];
 assert.equal(capturedIndexBindings([],decode).size,0);assert.throws(()=>decodeRecordedBundle(Buffer.from('x'),undefined,()=>{}),/digest-missing/);
 assert.throws(()=>capturedIndexBindings([indexResponse([row]),indexResponse([[0,indexKey,other]])],decode),/conflicting-binding/);
 assert.throws(()=>capturedIndexBindings([indexResponse([[0,indexKey,Buffer.alloc(31)]])],decode),/malformed/);
 assert.throws(()=>capturedIndexBindings([{...indexResponse([row]),status:503}],decode),/incomplete-or-failed/);
 assert.throws(()=>capturedIndexBindings([{...indexResponse([row]),status:206,headers:{'content-range':'bytes 0-2/100'}}],decode),/incomplete-or-failed/);
 assert.throws(()=>capturedIndexBindings([indexResponse([[0,new TextEncoder().encode('https://elsewhere.test/bundle'),digest]])],decode),/key-invalid/);
});

test('day-index envelope requires native format1 and integer day matching index URL',()=>{
 const row=[0,indexKey,Buffer.alloc(32,1)],base=indexResponse([row]),responseWith=entries=>({...base,bytes:Buffer.from(encode(new Map(entries)))});
 assert.equal(capturedIndexBindings([base],decode).size,1);
 for(const entries of [[[2,0],[3,[row]]],[[1,1],[3,[row]]],[[1,2],[2,0],[3,[row]]],[[1,1],[2,0.5],[3,[row]]],[[1,1],[2,'0'],[3,[row]]],[[1,1],[2,1],[3,[row]]],[[1,1],[2,0]]])assert.throws(()=>capturedIndexBindings([responseWith(entries)],decode),/recorded-index-malformed/);
});

import {nativeActorId} from './camera-observation.mjs';
import {entityOf} from '../../../apps/web/src/v2-engine/bridge.ts';
import {defaultLookOf,entityWithLook} from '../../../apps/web/src/v2-engine/take-bodies.ts';
test('zero/nonzero CLI counters normalize only at actor boundary and default look matches native product mapping',()=>{
 const scope='0'.repeat(32);
 for(const counter of [0,1]){const cli=scope+'-'+counter,native=scope+'.'+counter,base=entityOf(native);assert.equal(nativeActorId(cli),native);assert.deepEqual(depictedBodyIds(cli),[base,entityWithLook(base,defaultLookOf(native))]);}
 assert.notEqual(defaultLookOf(scope+'-1'),defaultLookOf(scope+'.1'),'nonzero fixture discriminates raw CLI look from native look');
});
test('malformed and arbitrary rendered/native identifiers cannot enter CLI actor normalization',()=>{
 const scope='0'.repeat(32);for(const value of [null,1,'abc-0',scope+'.0','v2_'+scope+'_0',scope+'-01',scope+'--1',scope+'-1.5',scope+'-9007199254740992',scope.toUpperCase().replace('0','A')+'-0'])assert.throws(()=>nativeActorId(value),/actor-cli-id-invalid/);
});
