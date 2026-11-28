// One daylight native Broadcast baseline; commands affect actors, never selection or camera poses.
import {writeFileSync} from 'node:fs';
import {join} from 'node:path';
import {setTimeout as delay} from 'node:timers/promises';
import {beforeNavigation as observeNavigation,nativeCameraMode} from './camera-native-page.mjs';
import {actorMapping,observedCircle} from './broadcast-circle-continuity.mjs';
import {CostCollector} from './camera-observation-cost.mjs';
import {candidates} from '../../../apps/web/src/WorldDirector.ts';
export const PHASES=[{name:'quiet-before',from:0,to:30,min:15},{name:'walk',from:30,to:75,min:10},{name:'listen',from:75,to:120,min:10},{name:'quiet-after',from:120,to:180,min:20}];
export function baselineDeclaration(p){
 if(!p||p.seconds!==180||p.destination!=='orchard'||p.holdoutDestination!=='knoll'||p.seed!==1||p.hour!=='12:00'||!Array.isArray(p.labels)||p.labels.length!==3||new Set(p.labels).size!==3||p.labels.some(x=>!/^baseline-[123]$/.test(x)))throw Error('broadcast-baseline-declaration');
 return structuredClone(p);
}
const valid=b=>b?.p?.length===3&&b.p.every(Number.isFinite);
export function assessBaseline(ids,samples,draws){
 const ordered=samples.length>1&&samples.every((s,i)=>Number.isFinite(s.at)&&Number.isFinite(s.tick)&&Number.isFinite(s.elapsed)&&(!i||s.at>samples[i-1].at&&s.tick>=samples[i-1].tick&&s.elapsed>samples[i-1].elapsed));
 const phases=PHASES.map(p=>{let start=null,startTick=null,last=null,longest=0,longestWall=0,validRows=0;const rows=samples.filter(s=>s.elapsed>=p.from&&s.elapsed<p.to);
  for(let i=0;i<rows.length;i++){const s=rows[i],b=ids.map(id=>s.bodies.find(b=>b.id===id)),prev=rows[i-1];let ok=b.every(valid)&&s.mode==='broadcast'&&s.presentation==='live';
   if(p.name==='walk')ok=ok&&b.every(b=>b.activity==='walk');
   else if(p.name==='listen')ok=ok&&observedCircle(s,ids)&&b.every(a=>b.every(c=>Math.hypot(a.p[0]-c.p[0],a.p[2]-c.p[2])<3.2));
   else ok=ok&&b.every(b=>b.activity==='idle')&&!!prev&&b.every(a=>{const old=prev.bodies.find(b=>b.id===a.id),dt=(s.at-prev.at)/1000;return valid(old)&&dt>0&&Math.hypot(a.p[0]-old.p[0],a.p[2]-old.p[2])/dt<=.1;});
   if(ok){validRows++;if(start===null||s.at-last>750){start=s.at;startTick=s.tick;}last=s.at;longest=Math.max(longest,(s.tick-startTick)*.05);longestWall=Math.max(longestWall,(last-start)/1000);}else{start=null;last=null;}
  }return{...p,rows:rows.length,validRows,longestValidNativeSeconds:longest,longestValidWallSeconds:longestWall,exercised:longest>=p.min};});
 const observed=draws.filter(d=>samples.length&&d.at>=samples[0].at&&d.at<=samples.at(-1).at&&d.mode===0&&d.history===0),keys=[...new Set(observed.map(d=>d.key).filter(Boolean))];
 return{ordered,progress:ordered&&samples.at(-1).elapsed>=179&&(samples.at(-1).tick-samples[0].tick)*.05>=170,live:samples.length>0&&samples.every(s=>s.mode==='broadcast'&&s.presentation==='live'),wallSpanSeconds:samples.length?(samples.at(-1).at-samples[0].at)/1000:0,nativeSpanSeconds:samples.length?(samples.at(-1).tick-samples[0].tick)*.05:0,phases,drawn:observed.filter(d=>d.key&&d.shot).length,keys,scope:'Phase applicability and selected/drawn trace only. No required selection or phase-boundary cut; public candidate recomputation is approximate, not complete private ranking state.'};
}
export async function prepare({recipe,paths}){
 const p=baselineDeclaration(recipe.sourceRecording?.baselineLive),actors=[];
 for(const label of p.labels)actors.push({label,...await recipe.joinActor(label)});
 const found=await actors[0].cli('find',p.destination,'--limit','8'),matches=(found.found??[]).filter(x=>x.name===p.destination);if(matches.length!==1)throw Error('broadcast-baseline-destination');
 writeFileSync(join(paths.dir,'baseline-preparation.json'),JSON.stringify({declaration:p,actors:actors.map(({label,body})=>({label,body})),find:found},null,2));return{...p,actors,target:matches[0].id};
}
export function beforeNavigation(args){const stop=observeNavigation(args),goto=args.page.goto.bind(args.page);args.page.goto=(url,...rest)=>{const u=new URL(url);u.searchParams.set('hour','12:00');u.searchParams.set('camera-observation-cost','1');u.searchParams.set('camera-cost-seed','1');return goto(u.href,...rest);};return stop;}
export default async function({page,paths,fixture:prepared,signal,check}){
 let index=0,ui=0,error=null;const batches=[],samples=[],commands=[],stop=new AbortController(),save=(name,value)=>writeFileSync(join(paths.dir,name),JSON.stringify(value,null,2)+'\n',{flag:'wx'}),snapshot=async label=>save(`baseline-ui-${++ui}-${label}.json`,{accessibility:await page.locator('body').ariaSnapshot()});
 await page.waitForFunction(()=>!!window.__cameraObservationCost,null,{timeout:30000});
 const collector=new CostCollector((after,epoch)=>page.evaluate(({after,epoch})=>window.__cameraObservationCost.read(after,epoch),{after,epoch}),b=>{save(`baseline-cost-${++index}.json`,b);batches.push(b);});await collector.poll();
 const collecting=(async()=>{try{while(!stop.signal.aborted){await delay(1000,null,{signal:stop.signal});await collector.poll();}}catch(e){if(!stop.signal.aborted)error=String(e);}})();
 try{
  await page.waitForFunction(()=>document.querySelector('.viewer-history')?.getAttribute('data-viewer-ready')==='true'&&!document.querySelector('.viewer-arrival'),null,{timeout:30000});await nativeCameraMode(page,'broadcast',snapshot);await page.keyboard.press('Escape');
  const read=()=>page.evaluate(()=>{const w=window.__soulsEntity,f=w?.transportFrame();return{at:performance.now(),tick:f?.tick,mode:document.querySelector('.viewer-history')?.getAttribute('data-viewer-mode'),presentation:document.querySelector('.viewer-history')?.getAttribute('data-viewer-presentation'),souls:w?.gameFrame().souls??[],bodies:(w?.residents()??[]).map(r=>r.body).filter(id=>typeof id==='string').map(id=>({id,p:f?.entities[id]?.p,activity:f?.entities[id]?.activity}))};});
  const initial=await read(),mapping=actorMapping(initial.souls,prepared.labels),ids=mapping.map(m=>m.id);check('baseline-actual-bodies',ids.every(id=>initial.bodies.some(b=>b.id===id)));save('baseline-identity.json',{initial,mapping});
  const begin=performance.now();let stage=0;
  while(performance.now()-begin<180000){signal.throwIfAborted();if(error)throw Error(error);const elapsed=(performance.now()-begin)/1000;
   if(stage===0&&elapsed>=30||stage===1&&elapsed>=75||stage===2&&elapsed>=120){const kind=['walk','listen','stop'][stage++];for(const a of prepared.actors){const reply=kind==='walk'?await a.cli('act',prepared.target):kind==='listen'?await a.cli('act','listen','for=50'):await a.cli('stop');commands.push({kind,label:a.label,elapsed:(performance.now()-begin)/1000,reply});save(`baseline-command-${commands.length}.json`,commands.at(-1));check('baseline-command-'+kind,reply.ok===true);}}
   const s=await read();s.elapsed=(performance.now()-begin)/1000;s.candidates=candidates({bodies:s.bodies,speaking:new Map(),landmarks:[],arrivals:new Map(),now:s.at/1000}).map(c=>({key:c.key,members:c.members,kind:c.kind,label:c.label,phase:c.phase,score:c.score}));samples.push(s);await delay(250,null,{signal});
  }
  stop.abort();await collecting;await collector.poll({final:true});
  // Include final export rows only after they have been collected.
  const allDraws=batches.flatMap(b=>b.rows.map(r=>{const[key,shot]=JSON.parse(b.snapshot.shots[r[63]]);return{at:r[2],tick:r[3],mode:r[53],history:r[55],key,shot};})),result=assessBaseline(ids,samples,allDraws);save('baseline-draws.json',allDraws);save('baseline-result.json',result);
  check('baseline-progress',result.progress);check('baseline-live',result.live);for(const p of result.phases)check('baseline-phase-'+p.name,p.exercised);check('baseline-drawn-observation',result.drawn>100);check('baseline-lossless-cost',!error&&collector.count>100);await page.screenshot({path:join(paths.dir,'baseline-final.png')});
 }finally{stop.abort();await collecting;if(!collector.closed)await collector.poll({final:true});save('baseline-collection-close.json',{error,samples:samples.length,commands});save('baseline-inputs.json',{samples,commands});}
}
