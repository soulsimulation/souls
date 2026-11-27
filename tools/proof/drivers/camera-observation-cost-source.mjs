// Legal source preparation over the existing owned native fixture; no state/pose/time writes.
import {readFileSync,writeFileSync,readdirSync} from 'node:fs';
import {join,resolve,posix} from 'node:path';
import {pathToFileURL} from 'node:url';
import {inflateRawSync} from 'node:zlib';
import {createRequire} from 'node:module';
const require=createRequire(import.meta.url);const decode=(...args)=>require('../../../apps/web/node_modules/cborg/cborg.js').decode(...args);
import {setTimeout as delay} from 'node:timers/promises';
import {sealPublicInputs,verifySealedPublicInputs} from '../sealed-public-inputs.mjs';
const fail=name=>{throw Error('camera-cost-source-'+name);};
export function sourceDeclaration(value){if(!value||![0,16].includes(value.actors)||value.durationUs!==600000000||!Array.isArray(value.targets)||value.targets.length!==2||value.targets.some(s=>typeof s!=='string'||!s||s.length>64))fail('declaration');return{actors:value.actors,durationUs:value.durationUs,targets:[...value.targets]};}
export async function nativeReader(pkg){const native=await import(pathToFileURL(join(pkg,'replica.js')).href);native.initSync({module:readFileSync(join(pkg,'replica_bg.wasm'))});return native;}
export function publishedQuiet(pointer,partTo){const quiet=pointer.quietUntil;if(quiet===null||quiet===undefined)return partTo;if(!Number.isSafeInteger(quiet)||!Number.isSafeInteger(pointer.anchorWorld)||quiet>pointer.anchorWorld)fail('quiet-bound');return Math.max(partTo,quiet);}
export function publicEnd(root,native){const view=JSON.parse(readFileSync(join(root,'views/world.json'))),stream=view.stream;if(typeof stream!=='string'||!stream.startsWith('views/')||stream.split('/').includes('..'))fail('stream');const path=join(root,stream),p=JSON.parse(native.readPointer(readFileSync(join(path,'pointer'))));if(!Number.isSafeInteger(p.newest)||p.newest<0)fail('no-published-part');if(p.generation&&!/^[a-f0-9]{64}$/.test(p.generation))fail('generation');const prefix=p.generation?join(path,'g',p.generation):path;const part=JSON.parse(native.readPart(readFileSync(join(prefix,String(p.newest)))));if(!Number.isSafeInteger(part.to))fail('published-time');return publishedQuiet(p,part.to);}
export function receiptState(reply){const answer=reply?.receipt?.answers?.at(-1);if(reply?.ok===false)return'refused';if(!answer)return'pending';if(['refused','unread'].includes(answer.answer))return'refused';if(answer.answer==='receipt')return'done';return'pending';}
/** A named standing-spot refusal may try the other discovered destination on the next cadence; no other refusal is hidden. */
export function alternateAfterRefusal(reply,count){const last=reply?.receipt?.answers?.at(-1);return reply?.ok===true&&last?.answer==='refused'&&last.reason==='spot-none-free'&&Number.isSafeInteger(count)&&count>=0&&count<12;}
export async function prepare({recipe,paths,signal}){
 const plan=sourceDeclaration(recipe.sourceRecording),source=recipe.source;if(!source||recipe.costMeasurement)fail('recipe');const actors=[];
 for(let i=0;i<plan.actors;i++){signal.throwIfAborted();actors.push({...await recipe.joinActor('camera-motion-'+String(i).padStart(2,'0')),next:i%2,sequence:null,refusals:0});}
 const targets=[];if(actors.length)for(const words of plan.targets){const answer=await actors[0].cli('find',words,'--limit','8');writeFileSync(join(paths.dir,`cost-source-find-${targets.length}.json`),JSON.stringify(answer,null,2));const matches=(answer.found??[]).filter(r=>typeof r.id==='string'&&r.name?.toLowerCase().includes(words.toLowerCase()));if(matches.length!==1)fail('ambiguous-target');targets.push(matches[0].id);}if(targets.length&&new Set(targets).size!==2)fail('same-target');
 const native=await nativeReader(source.pkg),before=publicEnd(source.root,native);let start=before;const until=Date.now()+5000;while(start<=before&&Date.now()<until){await delay(100,null,{signal});start=publicEnd(source.root,native);}if(start<=before)fail('clock-not-advancing');
 // Reserve a real source lead inside preparation; browser's hard600s deadline includes navigation and cleanup.
 await delay(10000,null,{signal});
 const value={plan,source,actors,targets,native,start};writeFileSync(join(paths.dir,'cost-source-plan.json'),JSON.stringify({plan,source,targets,bodyIds:actors.map(a=>a.body),fromUs:start,toUs:start+plan.durationUs},null,2));return value;
}
export default async function({page,paths,signal,fixture,check}){
 const {plan,source,actors,targets,native,start}=fixture;let commands=0,lastEnd=start,nextAct=0;const startHost=performance.now();
 while(lastEnd<start+plan.durationUs){signal.throwIfAborted();if(performance.now()-startHost>599000)fail('native-duration-not-published');
  if(actors.length&&Date.now()>=nextAct){for(const a of actors){signal.throwIfAborted();if(a.sequence!==null){const receipt=await a.cli('receipt',String(a.sequence));writeFileSync(join(paths.dir,`cost-source-command-${String(commands++).padStart(4,'0')}.json`),JSON.stringify({body:a.body,receipt},null,2));const state=receiptState(receipt);if(state==='refused'){if(alternateAfterRefusal(receipt,a.refusals)){a.refusals++;a.sequence=null;continue;}fail('motion-refused');}if(state!=='done')continue;}
    const target=targets[a.next%2],sent=await a.cli('act',target);writeFileSync(join(paths.dir,`cost-source-command-${String(commands++).padStart(4,'0')}.json`),JSON.stringify({body:a.body,target,sent},null,2));if(!sent.ok||!Number.isSafeInteger(sent.sequence))fail('motion-not-sent');a.sequence=sent.sequence;a.next++;if(commands>4096)fail('command-bound');}nextAct=Date.now()+5000;}
  await delay(500,null,{signal});lastEnd=publicEnd(source.root,native);
 }
 check('camera-source-published-duration',lastEnd-start>=plan.durationUs);writeFileSync(join(paths.dir,'cost-source-end.json'),JSON.stringify({fromUs:start,toUs:lastEnd,durationUs:lastEnd-start,commands,actors:actors.length,scope:'Published part duration only; stopped native history validation still required'},null,2));await page.screenshot({path:join(paths.dir,'cost-source-final.png')});
}
export function validateRanges(ranges,from,to){if(!Number.isSafeInteger(from)||!Number.isSafeInteger(to)||to-from<600000000)fail('interval');let covered=from;for(const r of ranges.sort((a,b)=>a.from-b.from)){if(r.to<=covered)continue;if(r.from>covered)fail('history-gap');covered=r.to;if(covered>=to)return true;}fail('history-short');}
const id=value=>JSON.stringify(value,(_,v)=>v instanceof Uint8Array?Buffer.from(v).toString('hex'):v);
export async function validateSourceHistory({root,pkg,fromUs,toUs,actors}){
 const native=await nativeReader(pkg),header=readFileSync(join(root,'history/header')),ranges=[],motion=new Map();let inspected=0,minimum=Infinity,maximum=0;
 const view=JSON.parse(readFileSync(join(root,'views/world.json'))),pointer=JSON.parse(native.readPointer(readFileSync(join(root,view.stream,'pointer'))));
 const publishedTo=publicEnd(root,native);if(publishedTo<toUs)fail('published-tail-short');
 const bundles=join(root,'history/bundles'),all=[];
 for(const day of readdirSync(bundles).filter(x=>/^\d{8}$/.test(x)).sort()){
  const index=decode(readFileSync(join(bundles,day,'index')),{useMaps:true});
  for(const row of index.get(3))all.push(row);
 }
 all.sort((a,b)=>Number(a[0])-Number(b[0]));if(all.length>1024)fail('index-bound');
 let quietExtension=false;
 for(let i=0;i<all.length;i++){
  const row=all[i],begin=Number(row[0]),key=new TextDecoder().decode(row[1]);
  if(!key||posix.normalize(key)!==key||key.startsWith('/')||key.split('/').includes('..'))fail('bundle-path');
  const raw=inflateRawSync(readFileSync(join(root,'history',key)),{maxOutputLength:128*1024*1024});
  const info=decode(native.historyTimeline(header,raw,row[2],BigInt(begin),BigInt(begin)),{useMaps:true});
  const nominalEnd=begin+Number(info.get(5));let end=nominalEnd;
  // A sealed native quiet promise can extend the last bundle's still state, as the product reader does.
  if(i===all.length-1&&end<toUs&&Number.isSafeInteger(pointer.newestTo)&&pointer.newestTo<=end&&Number.isSafeInteger(pointer.quietUntil)&&pointer.quietUntil>=toUs){end=toUs;quietExtension=true;}
  if(end<=fromUs||begin>=toUs)continue;if(++inspected>128)fail('bundle-bound');
  const from=Math.max(begin,fromUs),to=Math.min(end,toUs),timeline=decode(native.historyTimeline(header,raw,row[2],BigInt(from),BigInt(to)),{useMaps:true});
  ranges.push({from:begin,to:end,nominalEnd});const bodies=new Map();
  const apply=(nodes,at)=>{
   for(const n of nodes){
    const key=id(n.get(1));if(!String(n.get(2)).startsWith('souls:body'))continue;bodies.set(key,n);
    const p=n.get(7)?.get(2);if(!p)continue;
    let m=motion.get(key);if(!m){m={positions:new Set(),phases:{warm:new Set(),sample:new Set()},firstChangeUs:null,lastChangeUs:null,last:null};motion.set(key,m);}
    const value=JSON.stringify([n.get(3),p],(_,v)=>typeof v==='bigint'?String(v):v);if(m.positions.size<4)m.positions.add(value);
    if(m.last!==null&&m.last!==value){m.firstChangeUs??=at;m.lastChangeUs=at;const elapsed=at-fromUs,phase=elapsed>=60000000&&elapsed<360000000?'warm':elapsed>=360000000&&elapsed<=540000000?'sample':null;if(phase&&m.phases[phase].size<4)m.phases[phase].add(value);}m.last=value;
   }
   minimum=Math.min(minimum,bodies.size);maximum=Math.max(maximum,bodies.size);
  };
  apply(timeline.get(2),from);for(const change of timeline.get(3)){for(const removed of change.get(3))bodies.delete(id(removed));apply(change.get(2),Number(change.get(1)));}
 }
 validateRanges(ranges,fromUs,toUs);if(minimum!==actors||maximum!==actors)fail('body-count');
 if(actors&&[...motion.values()].filter(s=>s.positions.size>=3).length!==actors)fail('actual-motion-missing');
 if(actors&&[...motion.values()].some(m=>m.phases.warm.size<3||m.phases.sample.size<3))fail('phase-motion-missing');
 return{motion:[...motion].map(([body,m])=>({body,firstChangeUs:m.firstChangeUs,lastChangeUs:m.lastChangeUs,warmDistinctChanges:m.phases.warm.size,sampleDistinctChanges:m.phases.sample.size})),fromUs,toUs,publishedTo,quietExtension,durationUs:toUs-fromUs,bundles:inspected,minimumBodies:minimum,maximumBodies:maximum,movingBodies:[...motion.values()].filter(s=>s.positions.size>=3).length,ranges,scope:'Native validated public node timelines, distinct parent/pose changes in both warm and sample phases; displacement and actual rendered distant/in-use coverage require playback review'};
}
/** Call only after the existing owned attempt has stopped every writer. */
export async function sealSourceRun(reportFile,output){const report=JSON.parse(readFileSync(reportFile));if(!report.qualified||!report.teardown?.worldStopped||!report.teardown.browserClosed||report.teardown.children.some(c=>!c.exited))fail('writers-not-stopped');const dir=resolve(reportFile,'..'),plan=JSON.parse(readFileSync(join(dir,'cost-source-plan.json'))),provenance=JSON.parse(readFileSync(join(dir,'native-page-provenance.json')));const assetBindings={sourceHead:plan.source.sourceHead,artifactHash:plan.source.artifactPin.hash,trees:['apps/web/dist','v2/web/dist','mars/viewer/dist/client'].map(path=>({root:join(report.source.product.root,path),files:provenance.trees[path]}))};const pin=await sealPublicInputs({sourceRoot:plan.source.root,world:plan.source.world,sourceHead:plan.source.sourceHead,pkg:plan.source.pkg,output,assetBindings});const sealed=verifySealedPublicInputs(pin),coverage=await validateSourceHistory({root:join(sealed.root,'w',sealed.world),pkg:plan.source.pkg,fromUs:plan.fromUs,toUs:plan.toUs,actors:plan.plan.actors});return{pin,coverage,sourceReport:reportFile};}
