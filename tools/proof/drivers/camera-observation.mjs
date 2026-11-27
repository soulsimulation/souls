// Native displayed-observation journey. Legal actor commands and rendered controls only; no pose/camera injection.
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { suppliedNativeStream } from './camera-native-page.mjs';
const documents=new WeakMap();
export async function prepare({recipe}) {
 const actor=await recipe.joinActor();const found=await actor.cli('find','bench');const target=(found.found??[]).find(r=>!r.kind?.startsWith('souls:body'));
 if(!target)throw Error('camera-observation-legal-walk-target-missing');return {actor,target:target.id};
}
export function beforeNavigation({page}) {
 const responses=[];documents.set(page,responses);const response=r=>{if(r.request().isNavigationRequest()&&r.frame()===page.mainFrame())responses.push(r.text());};page.on('response',response);
 const goto=page.goto.bind(page);page.goto=(url,...args)=>{const u=new URL(url);u.searchParams.set('camera-observe','1');return goto(u.href,...args)};
 return ()=>page.off('response',response);
}
export function alignmentValid(readout,body) {
 if(readout?.frame?.status!=='observed')return false;
 const s=readout.frame.value.subjects.find(s=>s.id===body&&s.state==='present'),a=readout.alignment?.find(a=>a.id===body);
 return !!s&&!!a?.matrixPosition&&s.transform.positionM.every((v,i)=>Math.abs(v-a.matrixPosition[i])<1e-9)&&Number.isFinite(readout.frame.value.depicted.tick);
}
export default async function({page,paths,check,fixture,signal}) {
 const html=await documents.get(page)?.[0];check('actual-native-document',typeof html==='string'&&!!suppliedNativeStream(html));writeFileSync(join(paths.dir,'native-document.html'),html,{flag:'wx'});
 await page.waitForFunction(body=>{const r=window.__cameraObservation;return r?.frame?.status==='observed'&&r.frame.value.subjects.some(s=>s.id===body&&s.state==='present')&&!document.querySelector('.viewer-arrival')},fixture.actor.body,{timeout:30000});
 const read=()=>page.evaluate(()=>window.__cameraObservation),samples=[];
 const sample=async phase=>{const value=await read();check(`${phase}-draw-matrix-alignment`,alignmentValid(value,fixture.actor.body));samples.push({phase,...value});return value;};
 let input=0;const snapshot=async name=>writeFileSync(join(paths.dir,`accessibility-before-${++input}-${name}.yml`),await page.locator('body').ariaSnapshot(),{flag:'wx'});
 await snapshot('explore');await page.getByRole('button',{name:/^Explore /}).click();await snapshot('select-subject');await page.getByRole('dialog',{name:/^Explore /}).getByRole('button',{name:/Camera Subject/}).click();
 await page.waitForFunction(()=>document.querySelector('.viewer-history')?.getAttribute('data-viewer-mode')==='follow',null,{timeout:20000});
 await page.waitForTimeout(1500);check('selected-subject-visible',await page.locator('.world-name-tag').filter({hasText:'Camera Subject'}).isVisible());
 await sample('live-before');const command=await fixture.actor.cli('act',fixture.target);check('legal-walk-accepted',command.ok!==false&&command.phase!=='refused');
 let moved=false;const until=Date.now()+15000;
 while(Date.now()<until){signal.throwIfAborted();const r=await read();if(r?.movement?.some(([id,m])=>id===fixture.actor.body&&m.state==='travel')){moved=true;break}await page.waitForTimeout(50);}
 check('drawn-subject-travels',moved);await sample('live-moving');await page.waitForTimeout(1000);await page.screenshot({path:join(paths.dir,'live-moving.png')});
 await snapshot('time-route');const direct=page.getByRole('button',{name:/time controls$/});if(await direct.isVisible())await direct.click();else{await page.getByRole('button',{name:'Menu',exact:true}).click();await snapshot('time-menu');await page.getByRole('menuitem',{name:/^Time(?:\s|$)/}).click();}
 await snapshot('pause');await page.getByRole('dialog',{name:'Time',exact:true}).getByRole('button',{name:'Pause',exact:true}).click();
 await page.waitForFunction(()=>window.__cameraObservation?.frame?.value?.version.epoch.includes('history'),null,{timeout:20000});
 await sample('history-paused');await page.screenshot({path:join(paths.dir,'history-paused.png')});
 await snapshot('return-live');await page.getByRole('button',{name:'Return to live',exact:true}).click();
 await page.waitForFunction(()=>window.__cameraObservation?.frame?.value?.version.epoch.includes('live'),null,{timeout:20000});await sample('returned-live');
 await snapshot('escape');await page.keyboard.press('Escape');await page.waitForTimeout(1200);
 writeFileSync(join(paths.dir,'observation-facts.json'),JSON.stringify({qualification:'displayed observation alignment only',samples},null,2),{flag:'wx'});
}
