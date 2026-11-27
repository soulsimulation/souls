// A single legal actor and the existing rendered Follow/Time controls. No pose or clock injection.
import {writeFileSync} from 'node:fs';
import {join} from 'node:path';
import {setTimeout as delay} from 'node:timers/promises';
import {beforeNavigation as observeNavigation,depictedBodyIds} from './camera-observation.mjs';
import {openCostTime} from './camera-observation-cost.mjs';
import {publicEnd,nativeReader,receiptState} from './camera-observation-cost-source.mjs';
export const beforeNavigation=observeNavigation;
export const ROUTE=Object.freeze([{target:'lab-presentation-hall',holdSeconds:4},{target:'plaza',holdSeconds:3},{target:'bench',holdSeconds:0}]);
export function routeCoverage(rows){
 const points=rows.map(r=>r.subject?.transform?.positionM).filter(Boolean);let distance=0,turn=0,stopped=0,previous=null;
 for(let i=1;i<points.length;i++){const d=points[i].map((v,j)=>v-points[i-1][j]),length=Math.hypot(...d);distance+=length;if(length<.03)stopped++;if(length>.2){if(previous){const dot=d.reduce((n,v,j)=>n+v*previous[j],0)/(length*Math.hypot(...previous));turn=Math.max(turn,Math.acos(Math.min(1,Math.max(-1,dot)))*180/Math.PI);}previous=d;}}
 return{distanceM:distance,largestTurnDegrees:turn,stationarySamples:stopped,samples:rows.length,scope:'1Hz actual depicted translation only; obstruction and readability require original pixel review'};
}
export async function prepare({recipe,paths,signal}){
 const actor=await recipe.joinActor(),targets={};
 for(const name of new Set(ROUTE.map(s=>s.target))){signal.throwIfAborted();const answer=await actor.cli('find',name,'--limit','50');writeFileSync(join(paths.dir,`follow-find-${name}.json`),JSON.stringify(answer,null,2));const matches=(answer.found??[]).filter(r=>r.name===name&&!r.kind?.startsWith('souls:body'));if(matches.length!==1)throw Error('follow-route-target-ambiguous:'+name);targets[name]=matches[0].id;}
 return{actor,targets,source:recipe.source,native:await nativeReader(recipe.source.pkg)};
}
export async function chooseFollow(page,snapshot){
 await page.waitForFunction(()=>document.querySelector('.viewer-history')?.getAttribute('data-viewer-ready')==='true'&&!document.querySelector('.viewer-arrival'),null,{timeout:30000});
 await snapshot('explore');await page.getByRole('button',{name:/^Explore /}).click();await snapshot('subject');await page.getByRole('dialog',{name:/^Explore /}).getByRole('button',{name:/Camera Subject/}).click();
 await page.waitForFunction(()=>document.querySelector('.viewer-history')?.getAttribute('data-viewer-mode')==='follow',null,{timeout:15000});
}
export async function openCameraHelp(page,snapshot){
 const direct=page.getByRole('button',{name:'Camera modes and help',exact:true});await snapshot('camera-route');
 if(await direct.isVisible())await direct.click();else{const menu=page.getByRole('button',{name:'Menu',exact:true});if(await menu.getAttribute('aria-expanded')!=='true')await menu.click();await snapshot('camera-menu');await page.getByRole('menu',{name:'Menu',exact:true}).getByRole('menuitem',{name:/^Camera(?:\s|$)/}).click();}
}
export async function resetFollow(page,snapshot){await openCameraHelp(page,snapshot);await snapshot('reset');await page.getByRole('dialog',{name:'Camera modes and help',exact:true}).getByRole('button',{name:'Reset view',exact:true}).click();await page.keyboard.press('Escape');}
export async function readFollow(page,bodyIds){return page.evaluate(ids=>{const r=window.__cameraObservation,w=window.__soulsEntity,v=document.querySelector('.viewer-history');return{at:performance.now(),tick:r?.drawn?.tick,seconds:r?.drawn?.seconds,mode:v?.getAttribute('data-viewer-mode'),presentation:v?.getAttribute('data-viewer-presentation'),subject:r?.frame?.value?.subjects.find(s=>ids.includes(s.id)&&s.state==='present'),eye:w?.camera?.position.toArray(),target:w?.controls?.target.toArray(),cameraWorld:w?.camera?.matrixWorld.toArray(),projection:w?.camera?.projectionMatrix.toArray()};},bodyIds);}
export default async function({page,paths,fixture,signal,check}){
 let n=0;const save=(file,value)=>writeFileSync(join(paths.dir,file),JSON.stringify(value,null,2)+'\n',{flag:'wx'}),snapshot=async label=>save(`follow-ui-${String(++n).padStart(3,'0')}-${label}.json`,{accessibility:await page.locator('body').ariaSnapshot()});
 const ids=depictedBodyIds(fixture.actor.body);await chooseFollow(page,snapshot);await page.waitForTimeout(1000);await resetFollow(page,snapshot);
 const before=await readFollow(page,ids);check('follow-source-present',!!before.subject&&before.mode==='follow');
 const rows=[],commands=[],start=performance.now();let index=0,sequence=null,ready=0;
 while(performance.now()-start<60000){signal.throwIfAborted();const elapsed=(performance.now()-start)/1000;
  if(index<ROUTE.length&&elapsed>=ready){if(sequence!==null){const result=await fixture.actor.cli('receipt',String(sequence));commands.push({elapsed,kind:'receipt',result});const state=receiptState(result);if(state==='refused'){save('follow-route-commands.json',commands);throw Error('follow-route-refused');}if(state==='done'){ready=elapsed+ROUTE[index].holdSeconds;index++;sequence=null;}}
   else if(index<ROUTE.length){const result=await fixture.actor.cli('act',fixture.targets[ROUTE[index].target]);commands.push({elapsed,kind:'act',target:ROUTE[index].target,result});if(!result.ok||!Number.isSafeInteger(result.sequence)){save('follow-route-commands.json',commands);throw Error('follow-route-not-accepted');}sequence=result.sequence;}}
  rows.push(await readFollow(page,ids));await delay(1000,null,{signal});
 }
 rows.push(await readFollow(page,ids));save('follow-route-commands.json',commands);save('follow-route-rows.json',rows);const coverage=routeCoverage(rows);save('follow-route-coverage.json',coverage);
 const fromUs=Math.round(before.tick*50000),toUs=Math.round(rows.at(-1).tick*50000);save('follow-source-plan.json',{source:fixture.source,body:fixture.actor.body,ids,targets:fixture.targets,route:ROUTE,fromUs,toUs,publishedTo:publicEnd(fixture.source.root,fixture.native),start:before,scope:'Exploratory route; native sealing and visual admission pending'});
 check('follow-route-actual-translation',coverage.distanceM>10);check('follow-route-mode-retained',rows.every(r=>r.mode==='follow'&&r.subject));
 await openCostTime(page,snapshot);const panel=page.getByRole('dialog',{name:'Time',exact:true});await snapshot('pause');await panel.getByRole('button',{name:'Pause',exact:true}).click();
 await page.waitForFunction(()=>document.querySelector('.viewer-history')?.getAttribute('data-viewer-presentation')==='history');
 const slider=page.getByRole('slider',{name:'Every moment since the world began',exact:true});await snapshot('history-seek');await slider.press('ArrowLeft');await page.waitForTimeout(250);await page.keyboard.press('Escape');await resetFollow(page,snapshot);
 const retained=await readFollow(page,ids);save('follow-history-retention.json',retained);check('follow-before-history-retained',retained.mode==='follow'&&retained.presentation==='history'&&!!retained.subject);await page.screenshot({path:join(paths.dir,'follow-history-reset.png')});
}
