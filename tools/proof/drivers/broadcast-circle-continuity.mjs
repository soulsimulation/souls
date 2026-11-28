// One native listener-circle proof. Existing public source, real UI, passive completed-draw facts only.
import {writeFileSync} from 'node:fs';
import {join} from 'node:path';
import {setTimeout as delay} from 'node:timers/promises';
import {beforeNavigation as observeNavigation} from './camera-native-page.mjs';
import {nativeCameraMode} from './camera-native-page.mjs';
import {candidates} from '../../../apps/web/src/WorldDirector.ts';
import {CostCollector} from './camera-observation-cost.mjs';
let declaration;
export function continuityDeclaration(p){
 if(!p||p.seconds!==19||!Number.isSafeInteger(p.targetTick)||!Number.isFinite(p.toTick)||!Number.isFinite(p.departureTick)||p.departureTick<=p.targetTick||p.targetTick+380>p.toTick||p.departureTick>=p.targetTick+300||!Array.isArray(p.bodyIds)||p.bodyIds.length!==3||new Set(p.bodyIds).size!==3||p.bodyIds.some(x=>typeof x!=='string'||!x||x.length>128)||p.anchor!==[...p.bodyIds].sort()[0])throw Error('broadcast-continuity-declaration');
 return structuredClone(p);
}
export function assessContinuity(plan,samples,draws){
 const ids=plan.bodyIds,remaining=ids.filter(id=>id!==plan.anchor),member=(s,id)=>s.bodies.find(b=>b.id===id),listen=b=>b?.activity==='listen';
 const valid=b=>b?.p?.length===3&&b.p.every(Number.isFinite);
 const circle=(s,members)=>{const talk=candidates({bodies:s.bodies,speaking:new Map(),landmarks:[],arrivals:new Map(),now:s.at/1000}).filter(c=>c.key.startsWith('talk:'));return talk.length===1&&talk[0].members.length===members.length&&talk[0].members.every(id=>members.includes(id));};
 const nearby=(s,members)=>members.every(a=>members.every(b=>{const x=member(s,a)?.p,y=member(s,b)?.p;return x&&y&&Math.hypot(x[0]-y[0],x[2]-y[2])<3.2;}));
 const before=samples.filter(s=>s.tick<plan.departureTick-2&&s.tick>=plan.targetTick+20&&ids.every(id=>listen(member(s,id))&&valid(member(s,id)))&&nearby(s,ids)&&circle(s,ids));
 const after=samples.filter(s=>s.tick>plan.departureTick+20&&remaining.every(id=>listen(member(s,id)))&&member(s,plan.anchor)?.activity==='walk'&&ids.every(id=>valid(member(s,id)))&&nearby(s,remaining)&&circle(s,remaining));
 const observed=draws.filter(d=>samples.length&&d.at>=samples[0].at&&d.at<=samples.at(-1).at&&d.history===(plan.live?0:1)&&d.mode===0);
 const beforeDraws=observed.filter(d=>d.tick<plan.departureTick-2&&before.some(s=>Math.abs(s.tick-d.tick)<5)&&d.key.startsWith('talk:')&&d.shot),key=beforeDraws.at(-1)?.key??null;
 const afterDraws=observed.filter(d=>after.length&&d.tick>=after[0].tick&&d.tick<=after.at(-1).tick);
 const validAfter=new Set(after);
 let runStart=null,runLast=null,longest=0,matching=0;
 for(const d of afterDraws){const nearest=samples.reduce((a,b)=>Math.abs(b.at-d.at)<Math.abs(a.at-d.at)?b:a),i=samples.indexOf(nearest),supported=validAfter.has(nearest)&&Math.abs(nearest.at-d.at)<=400&&(!i||nearest.at-samples[i-1].at<=400)&&(i===samples.length-1||samples[i+1].at-nearest.at<=400);if(supported&&d.key===key&&d.shot){if(runStart===null||d.tick-runLast>20)runStart=d.tick;runLast=d.tick;matching++;longest=Math.max(longest,d.tick-runStart);}else{runStart=null;runLast=null;}}
 const ordered=samples.every((s,i)=>Number.isFinite(s.tick)&&Number.isFinite(s.at)&&(!i||s.at>samples[i-1].at&&s.tick>=samples[i-1].tick));
 const span=a=>a.length?a.at(-1).tick-a[0].tick:0;
 return{inputBefore:before.length>=4&&span(before)>=20,inputAfter:after.length>=4&&span(after)>=40,progress:ordered&&samples.length>1&&span(samples)>=360,selectedTalkBefore:!!key,selectedTalkAfter:matching>10&&longest>=40,key,beforeRows:before.length,afterRows:after.length,matchingDraws:matching,longestMatchingTicks:longest,observedListenerMembers:remaining,scope:'Observed native input membership plus actual selected key/drawn shot. Exact private framing membership is covered by the unchanged-consumer regression, not read from a page closure.'};
}
export function liveDeclaration(p){
 if(!p||p.seconds!==19||p.preMs!==8000||p.activationMs!==8000||!Array.isArray(p.labels)||p.labels.length!==3||new Set(p.labels).size!==3||p.labels.some(x=>!/^listener-[123]$/.test(x)))throw Error('broadcast-live-declaration');
 return structuredClone(p);
}
export function actorMapping(souls,labels){
 const mapped=labels.map(label=>{const found=souls.filter(s=>s.name===label);if(found.length!==1||typeof found[0].entityId!=='string'||!found[0].entityId)throw Error('broadcast-live-actor-mapping');return{label,id:found[0].entityId};});
 if(new Set(mapped.map(m=>m.id)).size!==labels.length)throw Error('broadcast-live-actor-mapping');return mapped;
}
export function observedCircle(s,ids){
 if(!ids.every(id=>s.bodies.some(b=>b.id===id&&b.activity==='listen'&&b.p?.length===3&&b.p.every(Number.isFinite)))||s.bodies.some(b=>!b.p?.every(Number.isFinite)))return false;
 const talk=candidates({bodies:s.bodies,speaking:new Map(),landmarks:[],arrivals:new Map(),now:s.at/1000}).filter(c=>c.key.startsWith('talk:'));
 return talk.length===1&&talk[0].members.length===ids.length&&talk[0].members.every(id=>ids.includes(id));
}
export async function prepare({recipe,paths}){
 declaration=liveDeclaration(recipe.sourceRecording?.continuityLive);const actors=[];
 for(const label of declaration.labels)actors.push({label,...await recipe.joinActor(label)});
 const found=await actors[0].cli('find','orchard','--limit','8'),targets=(found.found??[]).filter(x=>x.name==='orchard');if(targets.length!==1)throw Error('broadcast-live-target');
 writeFileSync(join(paths.dir,'continuity-preparation.json'),JSON.stringify({declaration,actors:actors.map(({label,body})=>({label,body})),find:found},null,2));return{...declaration,actors,target:targets[0].id};
}
export function beforeNavigation(args){const stop=observeNavigation(args),goto=args.page.goto.bind(args.page);args.page.goto=(url,...rest)=>{const u=new URL(url);u.searchParams.set('camera-observation-cost','1');u.searchParams.set('camera-cost-seed','1');return goto(u.href,...rest);};return stop;}
export default async function({page,paths,fixture:prepared,signal,check}){
 let index=0,ui=0,error=null,plan=null;const commands=[],activation=[];const batches=[],samples=[],stop=new AbortController(),save=(name,value)=>writeFileSync(join(paths.dir,name),JSON.stringify(value,null,2)+'\n',{flag:'wx'}),snapshot=async label=>save(`continuity-ui-${++ui}-${label}.json`,{accessibility:await page.locator('body').ariaSnapshot()});
 await page.waitForFunction(()=>!!window.__cameraObservationCost,null,{timeout:30000});
 const collector=new CostCollector((after,epoch)=>page.evaluate(({after,epoch})=>window.__cameraObservationCost.read(after,epoch),{after,epoch}),batch=>{save(`continuity-cost-${++index}.json`,batch);batches.push(batch);});
 await collector.poll();const collecting=(async()=>{try{while(!stop.signal.aborted){await delay(1000,null,{signal:stop.signal});await collector.poll();}}catch(e){if(!stop.signal.aborted)error=String(e);}})();
 try{
  await page.waitForFunction(()=>document.querySelector('.viewer-history')?.getAttribute('data-viewer-ready')==='true'&&!document.querySelector('.viewer-arrival'),null,{timeout:30000});
  await nativeCameraMode(page,'broadcast',snapshot);await snapshot('dismiss-camera');await page.keyboard.press('Escape');
  const read=()=>page.evaluate(()=>{const w=window.__soulsEntity,f=w?.transportFrame();return{at:performance.now(),tick:f?.tick,mode:document.querySelector('.viewer-history')?.getAttribute('data-viewer-mode'),presentation:document.querySelector('.viewer-history')?.getAttribute('data-viewer-presentation'),souls:w?.gameFrame().souls??[],bodies:(w?.residents()??[]).map(r=>r.body).filter(id=>typeof id==='string').map(id=>({id,p:f?.entities[id]?.p,activity:f?.entities[id]?.activity})),cuts:window.__soulsBroadcastCuts??[]};});
  const initial=await read(),mapping=actorMapping(initial.souls,prepared.labels),ids=mapping.map(m=>m.id),anchor=[...ids].sort()[0],actor=prepared.actors.find(a=>a.label===mapping.find(m=>m.id===anchor).label);
  check('native-continuity-live-initial',initial.presentation==='live'&&initial.mode==='broadcast'&&ids.every(id=>initial.bodies.some(b=>b.id===id)));save('continuity-identity.json',{initial,mapping,nativeActors:prepared.actors.map(({label,body})=>({label,body})),anchor});
  for(const a of prepared.actors){const reply=await a.cli('act','listen','for=50');commands.push({label:a.label,kind:'listen',reply});save(`continuity-command-${commands.length}.json`,commands.at(-1));check('native-continuity-listen-sent',reply.ok&&Number.isSafeInteger(reply.sequence));}
  const until=performance.now()+prepared.activationMs;let ready=null;
  while(performance.now()<until){signal.throwIfAborted();if(error)throw Error(error);const s=await read();activation.push(s);const batch=batches.at(-1),r=batch?.rows.at(-1),shot=r?JSON.parse(batch.snapshot.shots[r[63]]):null;
   if(s.presentation==='live'&&s.mode==='broadcast'&&observedCircle(s,ids)&&r&&r[55]===0&&r[53]===0&&s.at-r[2]<1200&&shot[0].startsWith('talk:')&&shot[1]){ready=s;break;}await delay(250,null,{signal});}
  check('native-continuity-observed-listeners-before-dwell',!!ready);plan={live:true,seconds:19,targetTick:ready.tick,bodyIds:ids,anchor,departureTick:Infinity};
  const begin=performance.now();let departed=false;
  while(performance.now()-begin<19000){signal.throwIfAborted();if(error)throw Error(error);const s=await read();samples.push(s);
   if(!departed&&performance.now()-begin>=prepared.preMs){plan.departureTick=s.tick;const reply=await actor.cli('act',prepared.target);commands.push({label:actor.label,kind:'departure',observedTick:s.tick,reply});save(`continuity-command-${commands.length}.json`,commands.at(-1));check('native-continuity-departure-sent',reply.ok&&Number.isSafeInteger(reply.sequence));departed=true;}await delay(250,null,{signal});}

 }finally{stop.abort();await collecting;await collector.poll({final:true});save('continuity-inputs.json',{plan,samples,activation,commands,collectionError:error});}
 const draws=batches.flatMap(b=>b.rows.map(r=>{const [key,shot]=JSON.parse(b.snapshot.shots[r[63]]);return{tick:r[3],key,shot,mode:r[53],history:r[55],at:r[2]};})),result=assessContinuity(plan,samples,draws);save('continuity-draws.json',draws);save('continuity-result.json',result);
 check('native-continuity-broadcast-mode',samples.length>0&&samples.every(s=>s.mode==='broadcast'&&s.presentation==='live'));
 for(const name of ['inputBefore','inputAfter','progress','selectedTalkBefore','selectedTalkAfter'])check('native-continuity-'+name,result[name]);
 check('native-continuity-lossless-cost',!error&&collector.count>100);await page.screenshot({path:join(paths.dir,'continuity-final.png')});
}
