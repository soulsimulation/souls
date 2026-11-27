// Resource-free budget check for an explicitly frozen, interrupted proof history. Never repairs or edits a ledger.
import {readFileSync,existsSync} from 'node:fs';
import {createHash} from 'node:crypto';
import {resolve,relative,isAbsolute} from 'node:path';
const hash=bytes=>createHash('sha256').update(bytes).digest('hex');
const need=(ok,why)=>{if(!ok)throw Error('proof.import-budget-'+why);};
const same=(a,b)=>JSON.stringify(a)===JSON.stringify(b);
function readPinned(file,expected){const bytes=readFileSync(file);need(hash(bytes)===expected,'evidence-changed');return JSON.parse(bytes);}
const key=s=>`${s.arm}:${s.repeat}`;

/** Explicit, one-prestate continuation permission; never clears a lock or a stopped cycle. */
export function assertContinuationAuthority({continuationAuthority,ledgerFile,owner,cycle,current,importedBudget,arm,repeat,source,now=Date.now()}){
 if(!continuationAuthority)return undefined;
 const pin={file:resolve(continuationAuthority.file),hash:continuationAuthority.hash},a=readPinned(pin.file,pin.hash);
 need(a.schema==='owned-proof-continuation/1'&&a.authorizer&&a.authorizer!==owner&&/^https:\/\/github\.com\/soulsimulation\/souls\/issues\/\d+#issuecomment-\d+$/.test(a.grant),'continuation-grant');
 need(Number.isFinite(Date.parse(a.at))&&Date.parse(a.at)<=now+1000,'continuation-time');
 need(a.owner===owner&&same(a.cycle,cycle)&&same(a.current,current),'continuation-source-or-plan');
 need(existsSync(ledgerFile)&&resolve(a.ledger?.file??'')===resolve(ledgerFile)&&hash(readFileSync(ledgerFile))===a.ledger.hash,'continuation-ledger');
 if(a.ledgerRelocation){
  const r=a.ledgerRelocation;
  need(r.fromFile&&resolve(r.fromFile)!==resolve(ledgerFile)&&resolve(r.toFile??'')===resolve(ledgerFile)&&r.hash===a.ledger.hash,'continuation-ledger-relocation');
  need(!existsSync(r.fromFile+'.lock')&&hash(readFileSync(r.fromFile))===r.hash,'continuation-old-ledger');
  const old=JSON.parse(readFileSync(r.fromFile,'utf8'));
  need(!old.cycles?.some(c=>c.stopped||c.inFlight),'continuation-old-ledger-ownership');
 }
 const identity=importedBudget?{historyFile:resolve(importedBudget.historyFile),historyHash:importedBudget.historyHash}:null;
 need(same(a.importedBudget,identity),'continuation-import');
 need(a.slot?.arm===arm&&a.slot?.repeat===repeat&&Number.isSafeInteger(a.slot.maxTotalAttempts)&&a.slot.maxTotalAttempts>=3,'continuation-slot');
 need(a.frozenEvidence?.length&&a.frozenEvidence.every(e=>e.file&&/^[a-f0-9]{64}$/.test(e.hash)),'continuation-evidence');
 for(const e of a.frozenEvidence)need(hash(readFileSync(e.file))===e.hash,'continuation-evidence-changed');
 need(Array.isArray(a.relocations),'continuation-relocations');
 for(const r of a.relocations){
  const kind=r.kind??'product';
  need(['product','tool'].includes(kind)&&r.from?.root&&r.from?.head&&same(r.to,current[kind])&&same(source?.(r.from.root),r.from),'continuation-old-source');
  need(r.sourceFiles?.length,'continuation-old-source-files');
  for(const e of r.sourceFiles){
   const at=resolve(r.from.root,e.path),rel=relative(resolve(r.from.root),at);
   need(rel&&rel!=='..'&&!rel.startsWith('../')&&!isAbsolute(rel)&&hash(readFileSync(at))===e.hash,'continuation-old-source-files');
  }
 }
 return {...a,pin};
}

/** Runs under runOwnedAttempt's exclusive lock before resource creation; may also be used as an advisory preflight. All attempted statuses consume budget, including aborts.
 * historyFile/historyHash pin a reviewed import with its original evidence, fixed plan and consumed per-slot counts.
 * A third total try also requires a fresh independent evidence/current-head declaration; agent identity is procedural. */
export function assertImportedAttemptBudget({historyFile,historyHash,ledgerFile,plan,arm,repeat,owner,currentHeads,thirdReview,continuationAuthority,cycle,current,source,now=Date.now()}){
 const h=readPinned(historyFile,historyHash);
 need(h.schema==='owned-proof-budget/1'&&typeof h.owner==='string'&&h.owner&&Number.isSafeInteger(h.captures)&&h.captures>=0,'history-invalid');
 need(Array.isArray(h.plan)&&h.plan.every(s=>typeof s.arm==='string'&&s.arm&&Number.isSafeInteger(s.repeat)&&s.repeat>0)&&same(plan,h.plan)&&new Set(h.plan.map(key)).size===h.plan.length,'plan-changed');
 need(Array.isArray(h.slots)&&h.slots.length===h.plan.length&&same(h.slots.map(key),h.plan.map(key)),'slots-changed');
 need(h.slots.every(s=>Number.isSafeInteger(s.consumed)&&s.consumed>=0&&s.consumed<=3&&Array.isArray(s.attemptEvidence)&&s.attemptEvidence.length===s.consumed),'counts-invalid');
 need(h.captures<=h.slots.reduce((n,s)=>n+s.consumed,0),'capture-count-invalid');
 need(h.evidence?.length&&h.evidence.every(e=>e.file&&/^[a-f0-9]{64}$/.test(e.hash)),'evidence-required');
 for(const e of h.evidence)need(hash(readFileSync(e.file))===e.hash,'evidence-changed');
 const known=new Set(h.evidence.map(e=>e.hash));need(h.slots.every(s=>s.attemptEvidence.every(e=>known.has(e.hash)&&e.hypothesis&&e.endedAt)),'attempt-provenance-missing');
 if(owner!==undefined)need(owner===h.owner,'owner-mismatch');
 const selected=h.slots.find(s=>s.arm===arm&&s.repeat===repeat);need(selected,'unknown-slot');
 let rows=[];
 if(existsSync(ledgerFile)){
  const state=JSON.parse(readFileSync(ledgerFile,'utf8'));
  need(state.owner===h.owner&&state.historicalCaptures===h.captures&&same(state.historicalEvidence,h.evidence),'ledger-history-mismatch');
  need(!state.cycles?.some(c=>c.inFlight),'in-flight');
  rows=state.attempts.map(a=>({hash:a.reportHash,file:a.report,report:readPinned(a.report,a.reportHash)}));
  need(rows.every(a=>h.plan.some(s=>key(s)===key(a.report))),'unknown-recorded-slot');
 }
 const attempts=rows.filter(a=>a.report.arm===arm&&a.report.repeat===repeat),total=selected.consumed+attempts.length;
 const continuation=assertContinuationAuthority({continuationAuthority,ledgerFile,owner,cycle,current,importedBudget:{historyFile,historyHash},arm,repeat,source,now});
 const maximum=continuation?.slot.maxTotalAttempts??3;
 need(total<maximum,'ceiling');
 const previous=[...selected.attemptEvidence.map(a=>({...a,file:h.evidence.find(e=>e.hash===a.hash).file})),...attempts.map(a=>({hash:a.hash,file:a.file,hypothesis:a.report.hypothesis,endedAt:a.report.endedAt}))].slice(-2);
 const latestSource=previous.length?readPinned(previous.at(-1).file,previous.at(-1).hash).source:undefined;
 if(continuation&&total>=2)need(latestSource&&Object.keys(current).every(k=>latestSource[k]?.root&&latestSource[k]?.head)&&same(Object.keys(latestSource).sort(),Object.keys(current).sort()),'latest-source-required');
 if(total===2||continuation&&total>=2){
  need(thirdReview?.evidenceOnly===true&&thirdReview.reviewer&&thirdReview.reviewer!==h.owner&&thirdReview.decision==='TRY','third-review-required');
  need(currentHeads&&['product','tool','driver'].every(k=>typeof currentHeads[k]==='string'&&currentHeads[k])&&same(thirdReview.evidenceHashes,previous.map(a=>a.hash))&&same(thirdReview.currentHeads,currentHeads),'third-review-binding');
  need(thirdReview.hypothesis?.trim()&&previous.every(a=>a.hypothesis!==thirdReview.hypothesis),'third-hypothesis');
  need(Date.parse(thirdReview.at)>Math.max(...previous.map(a=>Date.parse(a.endedAt)))&&Date.parse(thirdReview.at)<=now+1000,'third-review-stale');
  need(thirdReview.change?.path&&Number.isSafeInteger(thirdReview.change.line)&&thirdReview.change.line>0,'third-file-line');
 }
 return {priorAttempts:selected.consumed,newAttempts:attempts.length,nextTotalAttempt:total+1,remaining:maximum-total,previous,latestSource,continuation,
  reviewEvidence:total>=2?previous.map(a=>({file:a.file,hash:a.hash})):[],
  history:{count:h.captures,evidence:h.evidence}};
}
