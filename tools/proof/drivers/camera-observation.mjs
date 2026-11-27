// Native displayed-observation journey. Legal actor commands and rendered controls only; no pose/camera injection.
import { writeFileSync, readFileSync, readdirSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { inflateRawSync } from 'node:zlib';
import { join } from 'node:path';
import { entityOf } from '../../../apps/web/src/v2-engine/bridge.ts';
import { defaultLookOf, entityWithLook } from '../../../apps/web/src/v2-engine/take-bodies.ts';
import { suppliedNativeStream } from './camera-native-page.mjs';
const documents=new WeakMap();
export async function prepare({recipe}) {
 const actor=await recipe.joinActor();const found=await actor.cli('find','bench');const target=(found.found??[]).find(r=>!r.kind?.startsWith('souls:body'));
 if(!target)throw Error('camera-observation-legal-walk-target-missing');return {actor,target:target.id};
}
const hash=bytes=>createHash('sha256').update(bytes).digest('hex');
/** Stop accepting before draining: no body promise can escape the owned cleanup. */
export function collectResponses(page,dir,base,{cleanupMs=6000}={}) {
 const state={documents:[],responses:[],pending:new Set(),stopped:false,closed:false};
 const response=r=>{
  if(state.stopped||new URL(r.url()).origin!==new URL(base).origin)return;
  const navigation=r.request().isNavigationRequest()&&r.frame()===page.mainFrame();
  if(!navigation&&!new URL(r.url()).pathname.includes('/history/'))return;
  const entry={url:r.url(),status:r.status(),headers:r.headers(),file:`public-response-${state.responses.length}.bin`};state.responses.push(entry);
  const task=Promise.resolve().then(()=>r.body()).then(bytes=>{if(state.closed)return;entry.bytes=bytes;entry.sha256=hash(bytes);writeFileSync(join(dir,entry.file),bytes,{flag:'wx'});return bytes;}).catch(error=>{if(!state.closed)entry.error=String(error);});
  state.pending.add(task);task.finally(()=>state.pending.delete(task));if(navigation)state.documents.push(task.then(bytes=>bytes?.toString('utf8')));
 };
 page.on('response',response);
 state.flush=async({cleanup=false}={})=>{while(state.pending.size)await Promise.all([...state.pending]);if(!cleanup&&(state.stopped||state.closed))throw Error('history-response-collection-closed');};
 state.stop=async()=>{state.stopped=true;page.off('response',response);let timer,timedOut=false;await Promise.race([state.flush({cleanup:true}),new Promise(resolve=>{timer=setTimeout(()=>{timedOut=true;resolve();},cleanupMs);})]);clearTimeout(timer);state.closed=true;
  const responses=state.responses.map(({bytes,...r})=>r);writeFileSync(join(dir,'public-responses.json'),JSON.stringify({responses,pendingAtClose:state.pending.size,timedOut},null,2),{flag:'wx'});
  const files=readdirSync(dir).filter(f=>/^(phase-.*\.json|.*\.png|public-response-.*\.bin|public-responses\.json|observation-facts\.json|recorded-(?:target|public-oracle)\.json|accessibility-before-.*\.yml)$/.test(f)).sort().map(file=>({file,sha256:hash(readFileSync(join(dir,file)))}));
  writeFileSync(join(dir,'phase-manifest.json'),JSON.stringify({files},null,2),{flag:'wx'});if(timedOut)throw Error('history-response-cleanup-timeout');
 };
 return state;
}
export function beforeNavigation({page,paths,base}) {
 const state=collectResponses(page,paths.dir,base);documents.set(page,state);
 const goto=page.goto.bind(page);page.goto=(url,...args)=>{const u=new URL(url);u.searchParams.set('camera-observe','1');return goto(u.href,...args)};
 return state.stop;
}
/** UI readiness is independent of the epoch marker; one loading frame must fail. */
export function pausedReady(value,target) {
 return !!value?.ready&&value.recorded&&value.playEnabled&&!value.loading&&value.epoch?.includes('history')&&value.tick===target;
}
export function stablePaused(a,b,body) {
 const find=r=>r?.frame?.value?.subjects.find(s=>s.id===body&&s.state==='present');
 const x=find(a),y=find(b);return !!x&&!!y&&a.frame.value.depicted.tick===b.frame.value.depicted.tick&&a.frame.value.depicted.seconds===b.frame.value.depicted.seconds&&JSON.stringify(x.transform)===JSON.stringify(y.transform);
}
/** Reassemble only complete actual response bytes, retaining every original range independently. */
export function completeResponses(responses) {
 const out=new Map();
 for(const r of responses){if(!r.bytes||r.status<200||r.status>=300)continue;const range=/^bytes (\d+)-(\d+)\/(\d+)$/.exec(r.headers['content-range']??'');
  if(!range){out.set(r.url,r.bytes);continue;}
  const total=Number(range[3]);let v=out.get(r.url);if(!v||Buffer.isBuffer(v))v={total,parts:[]};if(v.total!==total)throw Error('history-response-range-size-changed');v.parts.push([Number(range[1]),Number(range[2]),r.bytes]);out.set(r.url,v);
 }
 for(const [url,v]of out){if(Buffer.isBuffer(v))continue;v.parts.sort((a,b)=>a[0]-b[0]);let end=0;const parts=[];for(const [start,last,bytes]of v.parts){if(start!==end||bytes.length!==last-start+1)break;parts.push(bytes);end=last+1;}if(end===v.total)out.set(url,Buffer.concat(parts));else out.delete(url);}
 return out;
}
const bundleResponse=url=>{const p=new URL(url).pathname;return p.includes('/bundles/')&&!p.endsWith('/index');};
/** A failed/partial revision has unknown eligibility; it cannot vanish from agreement proof. */
export function completeRecordedResponses(responses) {
 const complete=completeResponses(responses);
 for(const r of responses){if(!bundleResponse(r.url))continue;
  if(r.error||!r.bytes||r.status<200||r.status>=300||!complete.has(r.url)||(r.status===206&&!/^bytes \d+-\d+\/\d+$/.test(r.headers['content-range']??'')))throw Error('recorded-bundle-incomplete-or-failed');
 }
 return complete;
}
/** Integrity/decoder refusal propagates: an undecodable revision is never silently skipped. */
export function decodeRecordedBundle(url,bytes,read) {
 const raw=inflateRawSync(bytes),digest=createHash('sha256').update(raw).digest();
 if(!new URL(url).pathname.endsWith('-'+digest.toString('hex')))throw Error('recorded-bundle-content-address-mismatch');
 return read(raw,digest);
}
export function agreeRecordedPoses(candidates,initial,toleranceM=0.001) {
 if(!candidates.length||!Array.isArray(initial)||initial.length!==3||!initial.every(Number.isFinite))return false;
 return candidates.every(c=>Array.isArray(c.positionM)&&c.positionM.length===3&&c.positionM.every((v,i)=>Number.isFinite(v)&&Math.abs(v-initial[i])<=toleranceM));
}
export async function publicTarget(state,target,body,initial) {
 await state.flush();if(state.stopped||state.closed)throw Error('history-response-collection-closed');const responses=completeRecordedResponses(state.responses),header=[...responses].find(([url])=>new URL(url).pathname.endsWith('/header'))?.[1];
 if(!header)throw Error('recorded-public-header-not-retained');
 const {decode}=await import(new URL('../../../apps/web/node_modules/cborg/cborg.js',import.meta.url));
 const replica=await import(new URL('../../../v2/target/wasm-load/pkg/replica.js',import.meta.url));replica.initSync({module:readFileSync(new URL('../../../v2/target/wasm-load/pkg/replica_bg.wasm',import.meta.url))});
 const key=id=>id?Buffer.from(id[0]).toString('hex')+'.'+id[1]:null,candidates=[];
 for(const [url,bytes]of responses){if(!new URL(url).pathname.includes('/bundles/')||new URL(url).pathname.endsWith('/index'))continue;
  let rawSha256;const result=decodeRecordedBundle(url,bytes,(raw,digest)=>{rawSha256=digest.toString('hex');return decode(replica.historyAt(header,raw,digest,BigInt(Math.round(target*50000)),false),{useMaps:true});});
  const at=target*50000;if(at<Number(result.get(4))||at>Number(result.get(4))+Number(result.get(5)))continue;
  const nodes=new Map(result.get(2).map(n=>[key(n.get(1)),n])),node=nodes.get(body);if(!node)throw Error('recorded-target-body-absent-in-eligible-revision');
  // The owned fixture's root body has a world parent. Decline nested oracle rather than invent a transform.
  let parentId=key(node.get(3));const seen=new Set();while(parentId){if(seen.has(parentId))throw Error('recorded-target-parent-cycle');seen.add(parentId);const parent=nodes.get(parentId);if(!parent)throw Error('recorded-target-parent-missing');const pose=parent.get(7);if(pose&&((pose.get(2)??[]).some(v=>Number(v)!==0)||(pose.get(3)??[1073741824,0,0,0]).some((v,i)=>Number(v)!==(i===0?1073741824:0))))throw Error('recorded-target-nonidentity-parent');parentId=key(parent.get(3));}
  candidates.push({bundleUrl:url,bundleSha256:hash(bytes),rawSha256,positionM:node.get(7).get(2).map(v=>Number(v)/1e6)});
 }
 if(!agreeRecordedPoses(candidates,initial))throw Error('recorded-target-revisions-ambiguous-or-not-prewalk');
 return {targetTick:target,candidates,positionM:initial,toleranceM:0.001,basis:'All eligible actual captured public revisions agree with the older stationary pre-walk frame within1mm; native historyAt at integer20Hz target. Specifically consumed revision is not identified. Strict draw alignment remains1e-9.'};
}
export function depictedBodyIds(body) {const base=entityOf(body);return [base,entityWithLook(base,defaultLookOf(body))];}
export function recordAlignment(value,phase,body,file,check) {
 writeFileSync(file,JSON.stringify(value,null,2),{flag:'wx'});check(`${phase}-draw-matrix-alignment`,alignmentValid(value,body));
}
export function alignmentValid(readout,body) {
 if(readout?.frame?.status!=='observed')return false;
 const s=readout.frame.value.subjects.find(s=>s.id===body&&s.state==='present'),a=readout.alignment?.find(a=>a.id===body);
 return !!s&&!!a?.matrixPosition&&s.transform.positionM.every((v,i)=>Math.abs(v-a.matrixPosition[i])<1e-9)&&Number.isFinite(readout.frame.value.depicted.tick)&&readout.frame.value.depicted.tick===readout.drawn?.tick&&readout.frame.value.depicted.seconds===readout.drawn?.seconds;
}
export default async function({page,paths,check,fixture,signal}) {
 const responseState=documents.get(page);const html=await responseState?.documents[0];check('actual-native-document',typeof html==='string'&&!!suppliedNativeStream(html));writeFileSync(join(paths.dir,'native-document.html'),html,{flag:'wx'});
 const candidates=depictedBodyIds(fixture.actor.body);
 try {await page.waitForFunction(ids=>{const r=window.__cameraObservation;return r?.frame?.status==='observed'&&r.frame.value.subjects.some(s=>ids.includes(s.id)&&s.state==='present')&&!document.querySelector('.viewer-arrival')},candidates,{timeout:30000});}
 catch(error){writeFileSync(join(paths.dir,'failed-observation.json'),JSON.stringify(await page.evaluate(()=>({url:location.href,readout:window.__cameraObservation})),null,2),{flag:'wx'});throw error;}
 const depicted=await page.evaluate(ids=>window.__cameraObservation.frame.value.subjects.find(s=>ids.includes(s.id)&&s.state==='present').id,candidates);
 const read=()=>page.evaluate(()=>window.__cameraObservation),samples=[];
 const sample=async phase=>{const value=await read();recordAlignment(value,phase,depicted,join(paths.dir,`phase-${phase}.json`),check);samples.push({phase,...value});return value;};
 let input=0;const snapshot=async name=>writeFileSync(join(paths.dir,`accessibility-before-${++input}-${name}.yml`),await page.locator('body').ariaSnapshot(),{flag:'wx'});
 await snapshot('explore');await page.getByRole('button',{name:/^Explore /}).click();await snapshot('select-subject');await page.getByRole('dialog',{name:/^Explore /}).getByRole('button',{name:/Camera Subject/}).click();
 await page.waitForFunction(()=>document.querySelector('.viewer-history')?.getAttribute('data-viewer-mode')==='follow',null,{timeout:20000});
 await page.waitForTimeout(1500);check('selected-subject-visible',await page.locator('.world-name-tag').filter({hasText:'Camera Subject'}).isVisible());
 const before=await sample('live-before');const recordedTick=Math.floor(before.frame.value.depicted.tick);writeFileSync(join(paths.dir,'recorded-target.json'),JSON.stringify({targetTick:recordedTick,basis:'Older pre-walk frame, selected by real slider; public-byte oracle uses native historyAt, tolerance0.001m, draw alignment unchanged1e-9'},null,2),{flag:'wx'});const command=await fixture.actor.cli('act',fixture.target);check('legal-walk-accepted',command.ok!==false&&command.phase!=='refused');
 let moved=false;const until=Date.now()+15000;
 while(Date.now()<until){signal.throwIfAborted();const r=await read();if(r?.movement?.some(([id,m])=>id===depicted&&m.state==='travel')){moved=true;break}await page.waitForTimeout(50);}
 check('drawn-subject-travels',moved);await sample('live-moving');await page.waitForTimeout(1000);await page.screenshot({path:join(paths.dir,'live-moving.png')});
 await snapshot('time-route');const direct=page.getByRole('button',{name:/time controls$/});if(await direct.isVisible())await direct.click();else{await page.getByRole('button',{name:'Menu',exact:true}).click();await snapshot('time-menu');await page.getByRole('menuitem',{name:/^Time(?:\s|$)/}).click();}
 await snapshot('pause');await page.getByRole('dialog',{name:'Time',exact:true}).getByRole('button',{name:'Pause',exact:true}).click();
 await page.waitForFunction(()=>window.__cameraObservation?.frame?.value?.version.epoch.includes('history'),null,{timeout:20000});
 const slider=page.getByRole('slider',{name:'Every moment since the world began',exact:true});const box=await slider.boundingBox();if(!box)throw Error('recorded-slider-not-visible');
 const min=Number(await slider.getAttribute('min')),max=Number(await slider.getAttribute('max'));if(!Number.isInteger(min)||Number(await slider.getAttribute('step'))!==1||recordedTick<min||recordedTick>max)throw Error('recorded-target-outside-slider');
 await snapshot('recorded-target');await page.mouse.move(box.x+Math.max(1,Math.min(box.width-1,(recordedTick-min)/(max-min)*box.width)),box.y+box.height/2);await page.mouse.down();
 let selected=Number(await slider.inputValue());if(Math.abs(selected-recordedTick)>100)throw Error('recorded-target-slider-resolution');
 await snapshot('recorded-target-fine');for(let steps=0;selected!==recordedTick;steps++){signal.throwIfAborted();if(steps>=100)throw Error('recorded-target-slider-step-limit');const previous=selected;await slider.press(selected<recordedTick?'ArrowRight':'ArrowLeft');selected=Number(await slider.inputValue());if(!Number.isInteger(selected)||Math.abs(selected-recordedTick)>=Math.abs(previous-recordedTick))throw Error('recorded-target-slider-no-progress');}
 // The product commits scrub changes on pointerup; this is actual input on the visible control.
 await snapshot('recorded-target-commit');await page.mouse.up();
 const ui=()=>page.evaluate(()=>{const panel=document.querySelector('[data-time-panel]'),viewer=document.querySelector('.viewer-history'),play=[...panel?.querySelectorAll('button')??[]].find(b=>b.textContent==='Play'),r=window.__cameraObservation;return{ready:viewer?.getAttribute('data-viewer-ready')==='true',recorded:panel?.getAttribute('data-time-panel')==='recorded',playEnabled:!!play&&!play.disabled,loading:!!panel?.textContent?.includes('loading that moment'),epoch:r?.frame?.value?.version.epoch,tick:r?.frame?.value?.depicted.tick};});
 const readyUntil=Date.now()+20000;while(!pausedReady(await ui(),recordedTick)){signal.throwIfAborted();if(Date.now()>readyUntil)throw Error('recorded-ready-paused-target-timeout');await page.waitForTimeout(50);}
 const oracle=await publicTarget(responseState,recordedTick,fixture.actor.body,before.frame.value.subjects.find(s=>s.id===depicted).transform.positionM);signal.throwIfAborted();if(responseState.stopped||responseState.closed)throw Error('history-response-collection-closed');writeFileSync(join(paths.dir,'recorded-public-oracle.json'),JSON.stringify(oracle,null,2),{flag:'wx'});
 const paused=await sample('history-paused');await page.screenshot({path:join(paths.dir,'history-paused.png')});
 await page.waitForTimeout(150);const again=await sample('history-paused-stable');await page.screenshot({path:join(paths.dir,'history-paused-stable.png')});
 check('history-paused-stable',stablePaused(paused,again,depicted)&&pausedReady(await ui(),recordedTick));
 const subject=paused.frame.value.subjects.find(s=>s.id===depicted),initial=before.frame.value.subjects.find(s=>s.id===depicted);check('history-known-recorded-pose',agreeRecordedPoses(oracle.candidates,subject.transform.positionM,oracle.toleranceM)&&agreeRecordedPoses(oracle.candidates,initial.transform.positionM,oracle.toleranceM));
 await snapshot('return-live');await page.getByRole('button',{name:'Return to live',exact:true}).click();
 await page.waitForFunction(()=>window.__cameraObservation?.frame?.value?.version.epoch.includes('live'),null,{timeout:20000});await sample('returned-live');
 await snapshot('escape');await page.keyboard.press('Escape');await page.waitForTimeout(1200);
 writeFileSync(join(paths.dir,'observation-facts.json'),JSON.stringify({qualification:'displayed observation alignment only',samples},null,2),{flag:'wx'});
}
