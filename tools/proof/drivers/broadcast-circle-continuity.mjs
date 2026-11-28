// One native listener-circle proof. Existing public source, real UI, passive completed-draw facts only.
import {writeFileSync} from 'node:fs';
import {join} from 'node:path';
import {setTimeout as delay} from 'node:timers/promises';
import {beforeNavigation as observeNavigation} from './camera-native-page.mjs';
import {nativeCameraMode} from './camera-native-page.mjs';
import {CostCollector,openCostTime,seekCostTarget} from './camera-observation-cost.mjs';
let declaration;
export function continuityDeclaration(p){
 if(!p||p.seconds!==19||!Number.isSafeInteger(p.targetTick)||!Number.isFinite(p.toTick)||!Number.isFinite(p.departureTick)||p.departureTick<=p.targetTick||p.targetTick+380>p.toTick||p.departureTick>=p.targetTick+300||!Array.isArray(p.bodyIds)||p.bodyIds.length!==3||new Set(p.bodyIds).size!==3||p.bodyIds.some(x=>typeof x!=='string'||!x||x.length>128)||p.anchor!==[...p.bodyIds].sort()[0])throw Error('broadcast-continuity-declaration');
 return structuredClone(p);
}
export function assessContinuity(plan,samples,draws){
 const ids=plan.bodyIds,remaining=ids.filter(id=>id!==plan.anchor),member=(s,id)=>s.bodies.find(b=>b.id===id),listen=b=>b?.activity==='listen';
 const valid=b=>b?.p?.length===3&&b.p.every(Number.isFinite);
 const before=samples.filter(s=>s.tick<plan.departureTick-2&&s.tick>=plan.targetTick+20&&ids.every(id=>listen(member(s,id))&&valid(member(s,id))));
 const after=samples.filter(s=>s.tick>plan.departureTick+20&&remaining.every(id=>listen(member(s,id)))&&member(s,plan.anchor)?.activity==='walk'&&ids.every(id=>valid(member(s,id))));
 const beforeDraws=draws.filter(d=>d.tick<plan.departureTick-2&&before.some(s=>Math.abs(s.tick-d.tick)<5)&&d.key.startsWith('talk:')&&d.shot),key=beforeDraws.at(-1)?.key??null;
 const afterDraws=draws.filter(d=>after.length&&d.tick>=after[0].tick&&d.tick<=after.at(-1).tick);
 let runStart=null,runLast=null,longest=0,matching=0;
 for(const d of afterDraws){if(d.key===key&&d.shot){if(runStart===null||d.tick-runLast>20)runStart=d.tick;runLast=d.tick;matching++;longest=Math.max(longest,d.tick-runStart);}else{runStart=null;runLast=null;}}
 const span=a=>a.length?a.at(-1).tick-a[0].tick:0;
 return{inputBefore:before.length>=4&&span(before)>=20,inputAfter:after.length>=4&&span(after)>=40,progress:samples.length>1&&span(samples)>=360,selectedTalkBefore:!!key,selectedTalkAfter:matching>10&&longest>=40,key,beforeRows:before.length,afterRows:after.length,matchingDraws:matching,longestMatchingTicks:longest,observedListenerMembers:remaining,scope:'Observed native input membership plus actual selected key/drawn shot. Exact private framing membership is covered by the unchanged-consumer regression, not read from a page closure.'};
}
export function prepare({recipe}){declaration=continuityDeclaration(recipe.sourceRecording?.continuity);return declaration;}
export function beforeNavigation(args){return observeNavigation(args);}
export default async function({page,paths,fixture:plan,signal,check}){
 let index=0,ui=0,error=null;const batches=[],samples=[],stop=new AbortController(),save=(name,value)=>writeFileSync(join(paths.dir,name),JSON.stringify(value,null,2)+'\n',{flag:'wx'}),snapshot=async label=>save(`continuity-ui-${++ui}-${label}.json`,{accessibility:await page.locator('body').ariaSnapshot()});
 await page.waitForFunction(()=>!!window.__cameraObservationCost,null,{timeout:30000});
 const collector=new CostCollector((after,epoch)=>page.evaluate(({after,epoch})=>window.__cameraObservationCost.read(after,epoch),{after,epoch}),batch=>{save(`continuity-cost-${++index}.json`,batch);batches.push(batch);});
 await collector.poll();const collecting=(async()=>{try{while(!stop.signal.aborted){await delay(1000,null,{signal:stop.signal});await collector.poll();}}catch(e){if(!stop.signal.aborted)error=String(e);}})();
 try{
  await page.waitForFunction(()=>document.querySelector('.viewer-history')?.getAttribute('data-viewer-ready')==='true'&&!document.querySelector('.viewer-arrival'),null,{timeout:30000});
  await nativeCameraMode(page,'broadcast',snapshot);await snapshot('dismiss-camera');await page.keyboard.press('Escape');await openCostTime(page,snapshot);
  const panel=page.getByRole('dialog',{name:'Time',exact:true});if(await panel.getByRole('button',{name:'Pause',exact:true}).isVisible()){await snapshot('pause');await panel.getByRole('button',{name:'Pause',exact:true}).click();}
  const slider=page.getByRole('slider',{name:'Every moment since the world began',exact:true});await snapshot('seek');await seekCostTarget(slider,plan.targetTick,signal);
  await page.waitForFunction(t=>Number(document.querySelector('.viewer-history')?.getAttribute('data-viewer-tick'))===t&&!document.querySelector('[data-time-panel]')?.textContent.toLowerCase().includes('loading that moment'),plan.targetTick,{timeout:10000});
  await snapshot('play');await panel.getByRole('button',{name:'Play',exact:true}).click();await page.keyboard.press('Escape');
  const begin=performance.now();while(performance.now()-begin<19000){signal.throwIfAborted();if(error)throw Error(error);samples.push(await page.evaluate(ids=>{const f=window.__soulsEntity?.transportFrame();return{at:performance.now(),tick:f?.tick,mode:document.querySelector('.viewer-history')?.getAttribute('data-viewer-mode'),bodies:ids.map(id=>({id,p:f?.entities[id]?.p,activity:f?.entities[id]?.activity})),cuts:window.__soulsBroadcastCuts??[]};},plan.bodyIds));await delay(250,null,{signal});}
 }finally{stop.abort();await collecting;await collector.poll({final:true});save('continuity-inputs.json',{plan,samples,collectionError:error});}
 const draws=batches.flatMap(b=>b.rows.map(r=>{const [key,shot]=JSON.parse(b.snapshot.shots[r[63]]);return{tick:r[3],key,shot,mode:r[53],at:r[2]};})),result=assessContinuity(plan,samples,draws);save('continuity-draws.json',draws);save('continuity-result.json',result);
 check('native-continuity-broadcast-mode',samples.length>0&&samples.every(s=>s.mode==='broadcast'));
 for(const name of ['inputBefore','inputAfter','progress','selectedTalkBefore','selectedTalkAfter'])check('native-continuity-'+name,result[name]);
 check('native-continuity-lossless-cost',!error&&collector.count>100);await page.screenshot({path:join(paths.dir,'continuity-final.png')});
}
