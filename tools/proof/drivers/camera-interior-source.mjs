// Legal existing-room route and actual rendered-clone context. No pose, source or door-state writes.
import{writeFileSync}from'node:fs';import{join}from'node:path';import{setTimeout as delay}from'node:timers/promises';
import{beforeNavigation as observeNavigation,depictedBodyIds}from'./camera-observation.mjs';
import{chooseFollow,resetFollow,readFollow,compositionConsistent,routeCoverage}from'./camera-follow-source.mjs';
import{nativeReader,publicEnd,receiptState}from'./camera-observation-cost-source.mjs';
export const ROUTE=Object.freeze([{target:'presenter-desk',holdSeconds:6},{target:'plaza',holdSeconds:4}]);
export function beforeNavigation(args){const stop=observeNavigation(args),goto=args.page.goto.bind(args.page);args.page.goto=(url,...rest)=>{const u=new URL(url);u.searchParams.set('camera-follow','experimental');u.searchParams.set('camera-follow-test','1');return goto(u.href,...rest);};return stop;}
export function exactTarget(answer,name){const found=(answer.found??[]).filter(r=>r.name===name&&!r.kind?.startsWith('souls:body'));if(found.length!==1)throw Error('interior-target-ambiguous:'+name);return found[0].id;}
export async function prepare({recipe,paths,signal}){const actor=await recipe.joinActor(),targets={};for(const {target}of ROUTE){signal.throwIfAborted();const answer=await actor.cli('find',target,'--limit','50');writeFileSync(join(paths.dir,`interior-find-${target}.json`),JSON.stringify(answer,null,2));targets[target]=exactTarget(answer,target);}return{actor,targets,source:recipe.source,native:await nativeReader(recipe.source.pkg)};}
export function contextCoverage(rows){const inside=rows.filter(r=>r.enclosure?.status==='enclosed');let exit=false;if(inside.length){const last=inside.at(-1).at;exit=rows.some(r=>r.at>last&&r.enclosure?.status==='outside');}return{insideRows:inside.length,rooms:[...new Set(inside.map(r=>r.enclosure.room))],firstInsideAt:inside[0]?.at??null,lastInsideAt:inside.at(-1)?.at??null,exit,scope:'Authored floor/polygon membership; not camera containment, visibility or legal receipt proof'};}
export default async function({page,paths,fixture,signal,check}){
 let n=0;const save=(file,value)=>writeFileSync(join(paths.dir,file),JSON.stringify(value,null,2)+'\n',{flag:'wx'}),snapshot=async label=>save(`interior-ui-${++n}-${label}.json`,{accessibility:await page.locator('body').ariaSnapshot()});
 const ids=depictedBodyIds(fixture.actor.body);await chooseFollow(page,snapshot);await page.waitForFunction(()=>typeof window.__followExperiment==='function',null,{timeout:10000});await resetFollow(page,snapshot);await delay(1000,null,{signal});
 const before=await readFollow(page,ids);check('interior-start-depicted-follow',before.mode==='follow'&&!!before.subject&&compositionConsistent(before));
 const initial=await page.evaluate(()=>window.__followExperiment().rows.at(-1));save('interior-initial-context.json',initial);check('interior-native-metadata-acquired',initial?.enclosure?.work.buildings>0);
 const rows=[],commands=[],start=performance.now();let index=0,sequence=null,ready=0;
 try{while(performance.now()-start<60000){signal.throwIfAborted();const elapsed=(performance.now()-start)/1000;
  if(index<ROUTE.length&&elapsed>=ready){if(sequence!==null){const result=await fixture.actor.cli('receipt',String(sequence));commands.push({elapsed,kind:'receipt',result});const state=receiptState(result);if(state==='refused')throw Error('interior-route-refused');if(state==='done'){ready=elapsed+ROUTE[index].holdSeconds;index++;sequence=null;}}
   else{const result=await fixture.actor.cli('act',fixture.targets[ROUTE[index].target]);commands.push({elapsed,kind:'act',target:ROUTE[index].target,result});if(!result.ok||!Number.isSafeInteger(result.sequence))throw Error('interior-route-not-accepted');sequence=result.sequence;}}
  rows.push({...await readFollow(page,ids),enclosure:await page.evaluate(()=>window.__followExperiment().rows.at(-1)?.enclosure)});await delay(1000,null,{signal});
 }}finally{save('interior-route-commands.json',commands);save('interior-route-rows.json',rows);save('phase-follow-diagnostics.json',await page.evaluate(()=>({data:window.__followExperiment()})));}
 const coverage=contextCoverage(rows);save('interior-coverage.json',{...coverage,translation:routeCoverage(rows),completedLegs:index});
 save('interior-source-plan.json',{source:fixture.source,body:fixture.actor.body,ids,targets:fixture.targets,route:ROUTE,fromUs:Math.ceil(before.tick)*50000,toUs:Math.floor(rows.at(-1).tick)*50000,publishedTo:publicEnd(fixture.source.root,fixture.native),start:before});
 check('interior-legal-entry-exit-receipts',index===ROUTE.length&&sequence===null);check('interior-authored-entry-held-exit',coverage.insideRows>=4&&coverage.exit);check('interior-depicted-follow-retained',rows.every(r=>r.mode==='follow'&&r.subject));await page.screenshot({path:join(paths.dir,'interior-final.png')});
}
