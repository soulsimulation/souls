import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdirSync,mkdtempSync,writeFileSync,readFileSync,rmSync,existsSync} from 'node:fs';
import {resolve,join} from 'node:path';
import {createHash} from 'node:crypto';
import {execFileSync} from 'node:child_process';
import {createTestRunner} from './owned-attempt.mjs';
import {assertImportedAttemptBudget,assertContinuationAuthority} from './imported-attempt-budget.mjs';
const digest=b=>createHash('sha256').update(b).digest('hex');
function fixture(t){
 const parent=resolve('.e2e/670');mkdirSync(parent,{recursive:true});const root=mkdtempSync(join(parent,'budget-'));t.after(()=>rmSync(root,{recursive:true,force:true}));
 const plan=['baseline','candidate'].flatMap(arm=>[1,2].map(repeat=>({arm,repeat}))),historyFile=join(root,'history.json'),ledgerFile=join(root,'ledger.json');
 const evidence=plan.slice(0,2).map((s,i)=>{const file=join(root,`original-${i}.json`);writeFileSync(file,JSON.stringify({slot:s,unqualified:true}));return{file,hash:digest(readFileSync(file))};});
 const h={schema:'owned-proof-budget/1',owner:'test-implementer',captures:2,plan,evidence,slots:plan.map((s,i)=>({...s,consumed:i<2?1:0,attemptEvidence:i<2?[{hash:evidence[i].hash,hypothesis:'original '+i,endedAt:'2026-01-01T00:00:00Z'}]:[]}))};
 const state={owner:h.owner,historicalCaptures:h.captures,historicalEvidence:evidence,cycles:[],attempts:[]};
 const save=()=>writeFileSync(ledgerFile,JSON.stringify(state));
 const o={historyFile,historyHash:'',ledgerFile,plan,arm:'baseline',repeat:1,currentHeads:{product:'p2',tool:'t2',driver:'d2'}};
 const pin=()=>{writeFileSync(historyFile,JSON.stringify(h));o.historyHash=digest(readFileSync(historyFile));};pin();
 const attempt=(arm,repeat,status)=>{const report=join(root,`new-${state.attempts.length}.json`);writeFileSync(report,JSON.stringify({arm,repeat,status,source:Object.fromEntries(Object.entries(o.currentHeads).map(([k,head])=>[k,{root:join(root,k),head}])),hypothesis:'new '+state.attempts.length,endedAt:'2026-01-02T00:00:00Z'}));state.attempts.push({report,reportHash:digest(readFileSync(report))});save();};
 return{root,h,state,o,save,pin,attempt};
}
test('frozen baseline slots each retain one consumed try; all new statuses count and third needs evidence-bound review',t=>{
 const f=fixture(t);assert.equal(assertImportedAttemptBudget(f.o).nextTotalAttempt,2);
 f.attempt('baseline',1,'BOOT_ABORT');assert.throws(()=>assertImportedAttemptBudget(f.o),/third-review-required/);
 const previous=f.h.slots[0].attemptEvidence[0];f.o.thirdReview={evidenceOnly:true,reviewer:'fresh-reviewer',decision:'TRY',evidenceHashes:[previous.hash,f.state.attempts[0].reportHash],currentHeads:f.o.currentHeads,hypothesis:'a distinct concrete cause',at:new Date().toISOString(),change:{path:'driver.mjs',line:7}};
 assert.equal(assertImportedAttemptBudget(f.o).nextTotalAttempt,3);f.attempt('baseline',1,'INTERRUPTED');assert.throws(()=>assertImportedAttemptBudget(f.o),/ceiling/);
 f.o.repeat=2;delete f.o.thirdReview;assert.equal(assertImportedAttemptBudget(f.o).nextTotalAttempt,2,'another pinned baseline slot retains its own consumed try');
});
test('candidate has3 total attempts, not3 failures plus an extra; plan and sample ids cannot evade counts',t=>{
 const f=fixture(t);f.o.arm='candidate';assert.equal(assertImportedAttemptBudget(f.o).nextTotalAttempt,1);f.attempt('candidate',1,'PASS');assert.equal(assertImportedAttemptBudget(f.o).nextTotalAttempt,2);f.attempt('candidate',1,'FAIL');
 assert.throws(()=>assertImportedAttemptBudget(f.o),/third-review-required/);f.attempt('candidate',1,'BOOT_ABORT');assert.throws(()=>assertImportedAttemptBudget(f.o),/ceiling/);
 f.o.repeat=9;assert.throws(()=>assertImportedAttemptBudget(f.o),/unknown-slot/);f.o.repeat=1;f.o.plan=[...f.o.plan].reverse();assert.throws(()=>assertImportedAttemptBudget(f.o),/plan-changed/);
});
test('history, original evidence, new reports and in-flight ownership cannot be silently changed',t=>{
 const f=fixture(t);writeFileSync(f.o.historyFile,'{}');assert.throws(()=>assertImportedAttemptBudget(f.o),/evidence-changed/);f.pin();
 writeFileSync(f.h.evidence[0].file,'changed');assert.throws(()=>assertImportedAttemptBudget(f.o),/evidence-changed/);writeFileSync(f.h.evidence[0].file,JSON.stringify({slot:f.h.plan[0],unqualified:true}));
 f.attempt('baseline',1,'INTERRUPTED');writeFileSync(f.state.attempts[0].report,'{}');assert.throws(()=>assertImportedAttemptBudget(f.o),/evidence-changed/);
 f.state.attempts=[];f.state.cycles=[{inFlight:'owned-unfinalized'}];f.save();assert.throws(()=>assertImportedAttemptBudget(f.o),/in-flight/);
 f.state.cycles=[];f.state.historicalCaptures=0;f.save();assert.throws(()=>assertImportedAttemptBudget(f.o),/ledger-history-mismatch/);
});
test('third review binds both prior tries and all current heads and cannot repeat either hypothesis',t=>{
 const f=fixture(t);f.attempt('baseline',1,'FAIL');const prior=f.h.slots[0].attemptEvidence[0],latest=f.state.attempts[0];
 const review={evidenceOnly:true,reviewer:'fresh-reviewer',decision:'TRY',evidenceHashes:[prior.hash,latest.reportHash],currentHeads:f.o.currentHeads,hypothesis:'distinct root cause',at:new Date().toISOString(),change:{path:'driver.mjs',line:7}};f.o.thirdReview=review;
 assert.equal(assertImportedAttemptBudget(f.o).nextTotalAttempt,3);
 for(const hypothesis of [prior.hypothesis,'new 0']){review.hypothesis=hypothesis;assert.throws(()=>assertImportedAttemptBudget(f.o),/third-hypothesis/);}review.hypothesis='distinct root cause';
 review.evidenceHashes=[latest.reportHash];assert.throws(()=>assertImportedAttemptBudget(f.o),/third-review-binding/);review.evidenceHashes=[prior.hash,latest.reportHash];
 const heads=f.o.currentHeads;delete f.o.currentHeads;delete review.currentHeads;assert.throws(()=>assertImportedAttemptBudget(f.o),/third-review-binding/);f.o.currentHeads=heads;review.currentHeads=heads;
 review.at='2025-01-01T00:00:00Z';assert.throws(()=>assertImportedAttemptBudget(f.o),/third-review-stale/);
});

test('the lifecycle rechecks imported counts under its exclusive lock; stale preflight cannot boot a third try',async t=>{
 const f=fixture(t);assert.equal(assertImportedAttemptBudget(f.o).nextTotalAttempt,2);
 // Another finished attempt advances the ledger after the advisory preflight.
 f.attempt('baseline',1,'INTERRUPTED');let boots=0;
 const runner=createTestRunner({source:root=>({root,head:'committed'}),boot:async()=>{boots++;throw Error('must not boot');}});
 const options={owner:f.h.owner,sourceRoot:f.root,toolRoot:f.root,ledger:f.o.ledgerFile,
  arm:'baseline',repeat:1,world:{port:19044,slug:'budget-fixture'},cycle:{id:'replacement',plan:f.h.plan},history:{count:2,evidence:f.h.evidence},
  importedBudget:{historyFile:f.o.historyFile,historyHash:f.o.historyHash}};
 await assert.rejects(runner(options),/import-budget-third-review-required/);
 assert.equal(boots,0);assert.equal(existsSync(options.ledger+'.lock'),false);
 options.owner='another-agent';await assert.rejects(runner(options),/import-budget-owner-mismatch/);assert.equal(boots,0);
 f.state.attempts=[];f.save();options.owner=f.h.owner;options.history={count:0,evidence:[]};
 await assert.rejects(runner(options),/imported-history-mismatch/);assert.equal(boots,0);
});

test('an imported ledger pins required budget enforcement across later calls',async t=>{
 const f=fixture(t);let boots=0;
 const runner=createTestRunner({source:root=>({root,head:'p1'}),changed:()=>['fix.ts'],portFree:async()=>true,
  boot:async()=>{boots++;throw Error('controlled boot abort');}});
 const options={owner:f.h.owner,sourceRoot:f.root,toolRoot:f.root,ledger:f.o.ledgerFile,
  arm:'baseline',repeat:1,history:{count:2,evidence:f.h.evidence},world:{port:19044,slug:'budget-fixture'},journey:async()=>{},
  cycle:{id:'replacement',plan:f.h.plan,fix:{root:f.root,from:'p0',to:'p1',paths:['fix.ts'],scope:'relevant lifecycle correction'},
   arms:{baseline:{root:f.root,head:'p1'},candidate:{root:f.root,head:'p1'}}},
  importedBudget:{historyFile:f.o.historyFile,historyHash:f.o.historyHash}};
 const report=await runner(options);assert.equal(report.status,'BOOT_ABORT');assert.equal(boots,1);
 assert.deepEqual(JSON.parse(readFileSync(options.ledger)).importedBudget,options.importedBudget);
 const pinned=options.importedBudget;delete options.importedBudget;
 await assert.rejects(runner(options),/imported-budget-required-and-pinned/);assert.equal(boots,1);
 options.importedBudget={...pinned,historyHash:'changed'};
 await assert.rejects(runner(options),/imported-budget-required-and-pinned/);assert.equal(boots,1);
 options.importedBudget=pinned;await assert.rejects(runner(options),/import-budget-third-review-required/);assert.equal(boots,1);
});

test('a pinned continuation counts all earlier failures and requires the latest two reviews for a fourth try',t=>{
 const f=fixture(t);f.o.owner=f.h.owner;f.attempt('baseline',1,'FAIL');f.attempt('baseline',1,'BOOT_ABORT');
 assert.throws(()=>assertImportedAttemptBudget(f.o),/ceiling/);
 f.o.cycle={id:'same-concern',plan:f.h.plan};
 f.o.current=Object.fromEntries(Object.entries(f.o.currentHeads).map(([k,head])=>[k,{root:join(f.root,k),head}]));
 const file=join(f.root,'continuation.json'),a={schema:'owned-proof-continuation/1',authorizer:'coordinator',grant:'https://github.com/soulsimulation/souls/issues/4379#issuecomment-1',at:new Date().toISOString(),owner:f.h.owner,cycle:f.o.cycle,current:structuredClone(f.o.current),
  ledger:{file:f.o.ledgerFile,hash:digest(readFileSync(f.o.ledgerFile))},importedBudget:{historyFile:f.o.historyFile,historyHash:f.o.historyHash},slot:{arm:'baseline',repeat:1,maxTotalAttempts:4},frozenEvidence:f.h.evidence,relocations:[]};
 const pin=()=>{writeFileSync(file,JSON.stringify(a));f.o.continuationAuthority={file,hash:digest(readFileSync(file))};};pin();
 const hashes=f.state.attempts.map(x=>x.reportHash);
 f.o.thirdReview={evidenceOnly:true,reviewer:'independent-reviewer',decision:'TRY',at:new Date().toISOString(),currentHeads:f.o.currentHeads,evidenceHashes:[f.h.slots[0].attemptEvidence[0].hash,...hashes],hypothesis:'new observed correction',change:{path:'driver.mjs',line:7}};
 assert.throws(()=>assertImportedAttemptBudget(f.o),/third-review-binding/);
 f.o.thirdReview.evidenceHashes=hashes;
 const before=readFileSync(f.o.ledgerFile),result=assertImportedAttemptBudget(f.o);
 assert.equal(result.nextTotalAttempt,4);assert.equal(result.remaining,1);assert.equal(result.priorAttempts,1);assert.equal(result.newAttempts,2);
 assert.deepEqual(readFileSync(f.o.ledgerFile),before,'advisory authority never rewrites history');
 a.current.product.head='wrong';pin();assert.throws(()=>assertImportedAttemptBudget(f.o),/continuation-source-or-plan/);a.current=f.o.current=Object.fromEntries(Object.entries(f.o.currentHeads).map(([k,head])=>[k,{root:join(f.root,k),head}]));pin();
 a.ledger.hash='changed';pin();assert.throws(()=>assertImportedAttemptBudget(f.o),/continuation-ledger/);a.ledger.hash=digest(before);pin();
 f.state.cycles=[{inFlight:'unfinished'}];f.save();assert.throws(()=>assertImportedAttemptBudget(f.o),/in-flight/);
});

test('relocation permission verifies the frozen old root and source bytes instead of dropping their identity',t=>{
 const f=fixture(t);f.save();const from={root:f.root,head:'old'},current={product:{root:join(f.root,'relocated'),head:'new'}};
 const oldFile=join(f.root,'source.ts');writeFileSync(oldFile,'frozen source');const cycle={id:'retained',plan:f.h.plan};
 const file=join(f.root,'authority.json'),a={schema:'owned-proof-continuation/1',authorizer:'coordinator',grant:'https://github.com/soulsimulation/souls/issues/4379#issuecomment-1',at:new Date().toISOString(),owner:f.h.owner,cycle,current,
  ledger:{file:f.o.ledgerFile,hash:digest(readFileSync(f.o.ledgerFile))},importedBudget:null,slot:{arm:'baseline',repeat:1,maxTotalAttempts:4},frozenEvidence:f.h.evidence,
  relocations:[{from,to:current.product,sourceFiles:[{path:'source.ts',hash:digest(readFileSync(oldFile))}]}]};
 const pin=()=>{writeFileSync(file,JSON.stringify(a));return{file,hash:digest(readFileSync(file))};};
 const o={continuationAuthority:pin(),ledgerFile:f.o.ledgerFile,owner:f.h.owner,cycle,current,arm:'baseline',repeat:1,source:()=>from};
 assert.equal(assertContinuationAuthority(o).slot.maxTotalAttempts,4);
 o.source=()=>({...from,head:'changed'});assert.throws(()=>assertContinuationAuthority(o),/continuation-old-source/);o.source=()=>from;
 writeFileSync(oldFile,'tampered');assert.throws(()=>assertContinuationAuthority(o),/continuation-old-source-files/);
});

test('driver relocation retains its frozen origin and rejects a different target, old head or old source bytes',t=>{
 const f=fixture(t);f.save();const from={root:f.root,head:'driver-before'},current={driver:{root:join(f.root,'driver-after'),head:'driver-fixed'}};
 const oldFile=join(f.root,'driver.mjs');writeFileSync(oldFile,'frozen driver');const cycle={id:'same-concern',plan:f.h.plan};
 const file=join(f.root,'authority.json'),a={schema:'owned-proof-continuation/1',authorizer:'coordinator',grant:'https://github.com/soulsimulation/souls/issues/4379#issuecomment-1',at:new Date().toISOString(),owner:f.h.owner,cycle,current,
  ledger:{file:f.o.ledgerFile,hash:digest(readFileSync(f.o.ledgerFile))},importedBudget:null,slot:{arm:'baseline',repeat:1,maxTotalAttempts:5},frozenEvidence:f.h.evidence,
  relocations:[{kind:'driver',from,to:{...current.driver},sourceFiles:[{path:'driver.mjs',hash:digest(readFileSync(oldFile))}]}]};
 const pin=()=>{writeFileSync(file,JSON.stringify(a));return{file,hash:digest(readFileSync(file))};};
 const o={continuationAuthority:pin(),ledgerFile:f.o.ledgerFile,owner:f.h.owner,cycle,current,arm:'baseline',repeat:1,source:()=>from};
 assert.equal(assertContinuationAuthority(o).relocations[0].kind,'driver');
 a.relocations[0].to.head='another-revision';o.continuationAuthority=pin();assert.throws(()=>assertContinuationAuthority(o),/continuation-old-source/);
 a.relocations[0].to={...current.driver};o.continuationAuthority=pin();o.source=()=>({...from,head:'changed'});assert.throws(()=>assertContinuationAuthority(o),/continuation-old-source/);
 o.source=()=>from;writeFileSync(oldFile,'changed driver');assert.throws(()=>assertContinuationAuthority(o),/continuation-old-source-files/);
});

test('ledger relocation requires identical frozen bytes and refuses old stopped, in-flight or locked ownership',t=>{
 const f=fixture(t);f.save();const fromFile=join(f.root,'frozen-ledger.json'),file=join(f.root,'authority.json');
 const a={schema:'owned-proof-continuation/1',authorizer:'coordinator',grant:'https://github.com/soulsimulation/souls/issues/4379#issuecomment-1',at:new Date().toISOString(),owner:f.h.owner,
  cycle:{id:'retained',plan:f.h.plan},current:{},importedBudget:null,slot:{arm:'baseline',repeat:1,maxTotalAttempts:4},frozenEvidence:f.h.evidence,relocations:[]};
 const pin=()=>{const bytes=readFileSync(f.o.ledgerFile),hash=digest(bytes);writeFileSync(fromFile,bytes);a.ledger={file:f.o.ledgerFile,hash};a.ledgerRelocation={fromFile,hash,toFile:f.o.ledgerFile};writeFileSync(file,JSON.stringify(a));return{file,hash:digest(readFileSync(file))};};
 const o={ledgerFile:f.o.ledgerFile,owner:f.h.owner,cycle:a.cycle,current:a.current,arm:'baseline',repeat:1};
 o.continuationAuthority=pin();assert.equal(assertContinuationAuthority(o).ledgerRelocation.hash,a.ledger.hash);
 writeFileSync(fromFile,'{}');assert.throws(()=>assertContinuationAuthority(o),/continuation-old-ledger/);
 for(const ownership of [{stopped:'cleanup failed'},{inFlight:'unfinalized'}]){f.state.cycles=[ownership];f.save();o.continuationAuthority=pin();assert.throws(()=>assertContinuationAuthority(o),/continuation-old-ledger-ownership/);}
 f.state.cycles=[];f.save();o.continuationAuthority=pin();mkdirSync(fromFile+'.lock');assert.throws(()=>assertContinuationAuthority(o),/continuation-old-ledger/);
});

test('an empty local chain cannot replay the latest imported source, and the validated review becomes immutable history',async t=>{
 const f=fixture(t),snapshot=head=>({product:{root:f.root,head},tool:{root:f.root,head},driver:{root:f.root,head}}),reports=[];
 for(let i=0;i<3;i++){
  const file=join(f.root,`imported-${i}.json`),report={arm:'baseline',repeat:1,source:snapshot('p1'),hypothesis:'old diagnosis '+i,endedAt:`2026-01-0${i+1}T00:00:00Z`};
  writeFileSync(file,JSON.stringify(report));reports.push({file,hash:digest(readFileSync(file)),report});
 }
 f.h.evidence=[...reports.map(({file,hash})=>({file,hash})),f.h.evidence[1]];
 f.h.slots[0]={arm:'baseline',repeat:1,consumed:3,attemptEvidence:reports.map(({hash,report})=>({hash,hypothesis:report.hypothesis,endedAt:report.endedAt}))};
 f.state.historicalEvidence=f.h.evidence;f.pin();writeFileSync(join(f.root,'driver.mjs'),'export default async () => {};\n');
 for(const args of [['init','-q'],['add','driver.mjs'],['-c','user.name=Fixture','-c','user.email=fixture@example.com','commit','-qm','fixture']])execFileSync('git',['-c','gc.auto=0','-C',f.root,...args]);
 const arms=Object.fromEntries(['baseline','candidate'].map(arm=>[arm,{root:f.root,head:'p0'}]));
 const cycle={id:'same-original-cycle',plan:f.h.plan,arms,fix:{root:f.root,from:'before',to:'p0',paths:['driver.mjs'],scope:'original fix'}};
 f.state.cycles=[{...cycle,cursor:0,chain:0,armSources:arms,toolSource:{root:f.root,head:'p0'},driverSource:{root:f.root,head:'p0'},driverPath:'driver.mjs'}];f.save();
 let head='p1',boots=0;
 const runner=createTestRunner({source:root=>({root,head}),changed:()=>['driver.mjs'],portFree:async()=>true,boot:async()=>{boots++;throw Error('controlled boot abort');}});
 const options={owner:f.h.owner,sourceRoot:f.root,toolRoot:f.root,ledger:f.o.ledgerFile,arm:'baseline',repeat:1,cycle,
  world:{port:19044,slug:'fixture'},history:{count:f.h.captures,evidence:f.h.evidence},driver:{root:f.root,path:'driver.mjs'},
  repair:{root:f.root,from:'p0',to:head,paths:['driver.mjs'],scope:'actual repair',hypothesis:'unvalidated repair description'},
  importedBudget:{historyFile:f.o.historyFile,historyHash:f.o.historyHash}};
 const file=join(f.root,'authority.json'),review={reviewer:'independent-reviewer',evidenceOnly:true,decision:'TRY',at:new Date().toISOString(),
  evidenceHashes:reports.slice(-2).map(a=>a.hash),currentHeads:{product:head,tool:head,driver:head},hypothesis:'validated distinct diagnosis',change:{path:'driver.mjs',line:1}};
 options.importedBudget.thirdReview=review;
 const pin=maximum=>{const a={schema:'owned-proof-continuation/1',authorizer:'coordinator',grant:'https://github.com/soulsimulation/souls/issues/4379#issuecomment-1',at:new Date().toISOString(),owner:f.h.owner,
  ledger:{file:options.ledger,hash:digest(readFileSync(options.ledger))},cycle,current:snapshot(head),importedBudget:{historyFile:f.o.historyFile,historyHash:f.o.historyHash},slot:{arm:'baseline',repeat:1,maxTotalAttempts:maximum},frozenEvidence:f.h.evidence,relocations:[]};
  writeFileSync(file,JSON.stringify(a));options.continuationAuthority={file,hash:digest(readFileSync(file))};};
 pin(4);await assert.rejects(runner(options),/unchanged-retry/);assert.equal(boots,0);
 head='p2';options.repair.to=head;review.currentHeads={product:head,tool:head,driver:head};pin(4);
 const report=await runner(options);assert.equal(report.status,'BOOT_ABORT');assert.equal(boots,1);
 assert.equal(report.hypothesis,review.hypothesis);assert.deepEqual(report.review.evidence,review.evidenceHashes);
 assert.deepEqual(report.review.source,snapshot(head));assert.deepEqual(report.evidence.filter(e=>review.evidenceHashes.includes(e.hash)),reports.slice(-2).map(({file,hash})=>({file,hash})));
 review.hypothesis='later mutation';assert.equal(report.review.hypothesis,'validated distinct diagnosis');
 const state=JSON.parse(readFileSync(options.ledger));head='p3';options.repair.to=head;review.currentHeads={product:head,tool:head,driver:head};
 review.evidenceHashes=[reports.at(-1).hash,state.attempts.at(-1).reportHash];review.at=new Date(Date.now()+1).toISOString();review.hypothesis=report.hypothesis;pin(5);
 await assert.rejects(runner(options),/third-hypothesis/);assert.equal(boots,1);
});
