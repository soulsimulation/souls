import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mkdirSync, mkdtempSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { silentPartyTemplate } from '../../playtest/party/rehearse.mjs';
import { partyPage, partyBoot, partyStage, partyBrowserStop, partyFinalization, partyCaptureMs, partyStageWaitMs } from './party-native-page.mjs';

const souls = ['s0','s1','s2','s3','s4'];
const sample = (n, activities) => ({ at:n*250, tick:n*5, frame:n, currentCanvas:true,
  bodies:souls.map((soul,i)=>({soul,activity:activities[i]})) });
const idle = Array(5).fill('idle'), dance = Array(5).fill('dance');
const event = (stage, details={}) => ({stage,sampleIndex:0,...details});

test('party template uses a named open park area, without furniture or a new model', () => {
  const t=JSON.parse(readFileSync(new URL('../../../worlds/templates/party-rehearsal.json',import.meta.url)));
  assert.deepEqual(t,silentPartyTemplate());
  assert.equal(t.batches[0].ops.length,1);
  const area=t.batches[0].ops[0];assert.equal(area.def,'core/zone@1');assert.equal(area.params.use,'park');
  assert.deepEqual(area.shape.area,[[-8,-8],[8,-8],[8,8],[-8,8]]);
  assert.equal(partyCaptureMs,90000);
});

test('public party discovery cannot select an ambiguous or foreign page',()=>{
  const row={name:'Silent party rehearsal',template:'party-rehearsal',url:'/w/party/'};
  assert.equal(partyPage({worlds:[row]},'https://example.test'),'https://example.test/w/party/');
  assert.throws(()=>partyPage({worlds:[row,row]},'https://example.test'),/ambiguous/);
  assert.throws(()=>partyPage({worlds:[{...row,url:'https://elsewhere.test/w/party/'}]},'https://example.test'),/owned origin/);
});

test('object-free creator evidence requires the exact activity pin in actual boot registrations',()=>{
  const a={format:'souls-activities/1',activities:[{kind:'eden:dance_together',word:'dance-together',name:'dance-pin@1'}]};
  const bytes=Buffer.from(JSON.stringify(a)),line='# souls-boot-activity full-body@1 dance-pin@1';
  const result=partyBoot(Buffer.from(line+'\n'),bytes);assert.equal(result.bootLine,line);assert.equal(result.activitiesSHA256.length,64);
  assert.throws(()=>partyBoot(Buffer.from('# souls-boot-activity body another-pin\n'),bytes),/matching boot/);
  assert.throws(()=>partyBoot(Buffer.from(line),Buffer.from(JSON.stringify({...a,activities:[{...a.activities[0],at:'thing'}]}))),/object-free/);
});

test('receipts cannot substitute for advancing five-person final draws',()=>{
  const e=event('dance-ready',{souls});
  assert.throws(()=>partyStage([], [e],e),/clock/);
  assert.throws(()=>partyStage([sample(1,dance),sample(1,dance)],[e],e),/clock/);
  const missing=sample(2,dance);missing.bodies.pop();
  assert.throws(()=>partyStage([sample(1,dance),missing],[e],e),/whole-group/);
  assert.throws(()=>partyStage([sample(1,dance),sample(2,[...dance.slice(0,4),'walk'])],[e],e),/all five/);
  assert.equal(partyStage([sample(1,dance),sample(2,dance)],[e],e).lastTick,10);
});

test('dance readiness waits for the delayed fifth approach and two actual all-dance tails',()=>{
  const e=event('dance-ready',{souls});
  assert.equal(partyStageWaitMs(e.stage),12000);
  for(const stage of ['greeting-done','reply-done','dance-sustained','departure-done','party-clean'])
    assert.equal(partyStageWaitMs(stage),2500);
  const rows=[sample(1,dance.map((a,i)=>i===4?'walk':a)),sample(36,[...dance.slice(0,4),'walk'])];
  assert.throws(()=>partyStage(rows,[e],e),/all five/);
  rows.push(sample(37,dance));
  assert.throws(()=>partyStage(rows,[e],e),/all five/);
  rows.push(sample(38,dance));
  assert.equal(partyStage(rows,[e],e).lastTick,190);
});

test('sustained dance, independent departure/next wave and all-left rest must actually appear',()=>{
  const ready=event('dance-ready',{souls}), sustained=event('dance-sustained',{souls});
  assert.throws(()=>partyStage([sample(1,dance),sample(2,dance)],[ready,sustained],sustained),/sustained/);
  assert(partyStage([sample(1,dance),sample(49,dance)],[ready,sustained],sustained));
  assert.throws(()=>partyStage([sample(1,dance),sample(20,['idle',...dance.slice(1)]),sample(48,dance),sample(49,dance)],[ready,sustained],sustained),/sustained dance interrupted/);
  const start=event('departure-start'), done=event('departure-done',{soul:'s4',souls:souls.slice(0,4)});
  const rows=[sample(1,dance),sample(2,[...dance.slice(0,4),'wave']),sample(3,[...dance.slice(0,4),'idle']),sample(4,[...dance.slice(0,4),'idle'])];
  assert(partyStage(rows,[start,done],done));
  assert.throws(()=>partyStage(rows.map(r=>({...r,bodies:r.bodies.map(b=>({...b,activity:b.soul==='s0'?'idle':b.activity}))})),[start,done],done),/four continuing/);
  const cleanStart=event('cleanup-start'), clean=event('party-clean',{soul:'s0',souls});
  assert.throws(()=>partyStage([sample(1,idle),sample(2,idle)],[cleanStart,clean],clean),/host nod/);
  assert(partyStage([sample(1,['nod',...idle.slice(1)]),sample(2,idle),sample(3,idle)],[cleanStart,clean],clean));
});

test('browser draw stop caches both result and failure and never restores another writer',()=>{
  const old=globalThis.window;
  try {
    let stops=0;const original=()=>{},show=()=>{},prototype={show};
    globalThis.window={__partyDrawObserver:{samples:[{measurementMs:3}],failures:[],sampleLimit:361,prototype,show,original,stopRender:()=>stops++}};
    const first=partyBrowserStop();assert.equal(partyBrowserStop(),first);assert.equal(stops,1);assert.equal(prototype.show,original);assert.equal(first.measurementSummary.maxMs,3);
    const other=()=>{};window.__partyDrawObserver={samples:[],prototype:{show:other},show,original,stopRender:()=>stops++};
    assert.throws(()=>partyBrowserStop(),/ownership/);assert.throws(()=>partyBrowserStop(),/ownership/);assert.equal(stops,2);assert.equal(window.__partyDrawObserver.prototype.show,other);
  } finally {globalThis.window=old;}
});

test('finalization preserves ordinary receipts before collection and rejects a missing installed observer once',async()=>{
  mkdirSync(new URL('../../../.local',import.meta.url),{recursive:true});
  const dir=mkdtempSync(new URL('../../../.local/party-source-test-',import.meta.url).pathname),state={rows:[{answer:'retained'}],stages:[],observerInstalled:true};
  let calls=0;
  const page={evaluate:async()=>{calls++;assert.equal(JSON.parse(readFileSync(join(dir,'command-party-sequence.json'))).rows[0].answer,'retained');return undefined;}};
  partyFinalization(page,{dir},state);
  await assert.rejects(state.finalize(),/collector missing/);await assert.rejects(state.finalize(),/collector missing/);assert.equal(calls,1);
  assert.equal(JSON.parse(readFileSync(join(dir,'command-party-finalization.json'))).ok,false);
});


test('a greeting requires the actual aimed gesture and its idle return',()=>{
  const start=event('greeting-start'),done=event('greeting-done',{soul:'s0'});
  assert.throws(()=>partyStage([sample(1,idle),sample(2,idle)],[start,done],done),/greeting\/return/);
  assert.throws(()=>partyStage([sample(1,['wave',...idle.slice(1)]),sample(2,['wave',...idle.slice(1)])],[start,done],done),/greeting\/return/);
  assert(partyStage([sample(1,['wave',...idle.slice(1)]),sample(2,idle),sample(3,idle)],[start,done],done));
});
