// Collection/reduction only; this module never launches a browser or modifies a world/camera.
import { COST_LAYOUT } from '../../../apps/web/src/cinematography/observation-cost.ts';
import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { nativeCameraMode } from './camera-native-page.mjs';
import { OwnedBrowserCost } from './camera-observation-cost-process.mjs';
import { installPageCostProbe, clockCostProbe, sampledWitnessValid } from './camera-observation-cost-probes.mjs';
export function decodeCostSnapshot(snapshot, previous = {epoch:snapshot.epoch,last:0}) {
 if(snapshot.failure)throw Error('camera-cost-producer-failed');
 if(snapshot.version!==COST_LAYOUT.version||snapshot.encoding!=='float64-le-base64'||snapshot.epoch!==previous.epoch)throw Error('camera-cost-epoch-or-layout');
 if(![snapshot.epoch,snapshot.first,snapshot.last,snapshot.total,snapshot.count,snapshot.dropped,snapshot.overwrites,snapshot.exports].every(Number.isSafeInteger)||snapshot.epoch<1||snapshot.first<1||snapshot.exports<1||snapshot.numericBufferBytes!==384000||!Number.isFinite(snapshot.exportMs)||snapshot.exportMs<0||!Array.isArray(snapshot.identities)||snapshot.identities.length>8||snapshot.identities.some(v=>!Array.isArray(v)||v.length!==3||v.some(s=>typeof s!=='string'||Buffer.byteLength(s)>256)))throw Error('camera-cost-invalid-metadata');
 if(!Array.isArray(snapshot.shots)||snapshot.shots.length>256||snapshot.shots.some(s=>typeof s!=='string'||Buffer.byteLength(s)>256))throw Error('camera-cost-shot-table');
 const bytes=Buffer.from(snapshot.data,'base64');if(bytes.toString('base64')!==snapshot.data)throw Error('camera-cost-invalid-encoding');if(snapshot.dropped!==0||snapshot.first!==previous.last+1||snapshot.count!==snapshot.last-snapshot.first+1||snapshot.last!==snapshot.total||snapshot.count>600||snapshot.count<0||bytes.length!==snapshot.count*80*8)throw Error('camera-cost-loss-or-count');
 const rows=[],view=new DataView(bytes.buffer,bytes.byteOffset,bytes.byteLength);for(let i=0;i<snapshot.count;i++){const row=Array.from({length:80},(_,j)=>view.getFloat64((i*80+j)*8,true));if(row.some(v=>!Number.isFinite(v))||row[0]!==snapshot.first+i||row[1]!==snapshot.epoch||![0,1].includes(row[7])||!Number.isInteger(row[10])||row[10]<0||row[10]>3||![0,1,2].includes(row[53])||!Number.isSafeInteger(row[54])||row[54]<1||row[54]>snapshot.identities.length||![0,1].includes(row[55])||!Number.isSafeInteger(row[63])||row[63]<0||row[63]>=snapshot.shots.length||row[4]<0||row[6]<0||row[6]>.1||![0,1].includes(row[62])||row[11]<0||row[2]<row[11]||row[12]<row[2]||row[9]<row[8]||(row[7]===0&&(row[8]!==0||row[9]!==0||row[10]!==0))||(row[7]===1&&(row[8]<row[2]||row[9]>row[12]||row[10]===0)))throw Error('camera-cost-invalid-time-or-record');rows.push(row);}
 for(let i=1;i<rows.length;i++)if(rows[i][2]<rows[i-1][2]||rows[i][11]<rows[i-1][11])throw Error('camera-cost-nonmonotonic');
 return {rows,cursor:{epoch:snapshot.epoch,last:snapshot.last}};
}
export function reduceCost(rows,{uncertaintyMs}={}) {
 if(!Number.isFinite(uncertaintyMs)||uncertaintyMs<0)throw Error('camera-cost-uncertainty-required');
 const durations=rows.map(r=>r[7]?r[9]-r[8]+2*uncertaintyMs:0).sort((a,b)=>a-b),rank=p=>durations.length?durations[Math.ceil(p*durations.length)-1]:null;
 const intervals=rows.filter(r=>r[7]).map(r=>[r[8]-uncertaintyMs,r[9]+uncertaintyMs]),seconds=new Map();if(rows.length)for(let s=Math.floor(rows[0][11]/1000);s*1000<=rows.at(-1)[12];s++)seconds.set(s,0);for(const [a,b]of intervals)for(let s=Math.floor(a/1000);s*1000<b;s++)seconds.set(s,(seconds.get(s)??0)+Math.max(0,Math.min(b,(s+1)*1000)-Math.max(a,s*1000)));
 // Sweep the derivative of the rolling integral: four events per invocation, O(n log n).
 const events=new Map(),event=(at,delta)=>events.set(at,(events.get(at)??0)+delta);for(const [a,b]of intervals){event(a-1000,1);event(b-1000,-1);event(a,-1);event(b,1);}let rolling=rows.length?0:null,value=0,slope=0,previous=0;for(const [at,delta]of [...events].sort((a,b)=>a[0]-b[0])){value+=slope*(at-previous);rolling=Math.max(rolling??0,value);slope+=delta;previous=at;}
 return {draws:rows.length,callbackFailed:rows.filter(r=>r[62]===1).length,invocations:intervals.length,rejected:rows.filter(r=>r[10]===2).length,thrown:rows.filter(r=>r[10]===3).length,median:rank(.5),p95:rank(.95),p99:rank(.99),max:durations.at(-1)??null,perSecond:[...seconds],rollingOneSecondMaxMs:rolling,uncertaintyMs,scope:'direct synchronous elapsed upper bound only; deferred GC/history/worker/serialization attribution remains separate'};
}
/** Caller owns the1Hz schedule. One inflight request; no internal timer or browser lifecycle. */
export class CostCollector {
 constructor(read,consume){if(typeof consume!=='function')throw Error('camera-cost-sink-required');this.read=read;this.consume=consume;this.cursor=null;this.count=0;this.lastAt=-Infinity;this.lastEnd=-Infinity;this.lastPoll=-Infinity;this.inflight=false;this.closed=false;}
 async poll({final=false}={}){if(this.inflight||this.closed)throw Error('camera-cost-collection-closed-or-inflight');const now=performance.now();if(!final&&now-this.lastPoll<1000)throw Error('camera-cost-export-cadence');this.lastPoll=now;this.inflight=true;try{const s=await this.read(this.cursor?.last??0,this.cursor?.epoch);if(this.closed)throw Error('camera-cost-late-export');let result;try{result=decodeCostSnapshot(s,this.cursor??{epoch:s.epoch,last:0});if(result.rows.length&&(result.rows[0][2]<this.lastAt||result.rows[0][11]<this.lastEnd))throw Error('camera-cost-nonmonotonic');}catch(error){this.closed=true;this.consume({snapshot:s,rows:null,error:'camera-cost-invalid-or-lost'});throw error;}const consumed=this.consume({snapshot:s,rows:result.rows});if(consumed&&typeof consumed.then==='function')throw Error('camera-cost-sink-must-be-synchronous');this.cursor=result.cursor;this.count+=result.rows.length;if(result.rows.length)this.lastAt=result.rows.at(-1)[2];if(result.rows.length)this.lastEnd=result.rows.at(-1)[12];if(final){this.closed=true;return {total:s.total,collected:this.count,complete:s.total===this.count};}return result.rows.length;}finally{this.inflight=false;}}
 stop(){this.closed=true;}
}

const sessions = new WeakMap();
export function validateCostCell(measurement, plan) {
 if(!measurement||!plan||![measurement.warmupMs,measurement.sampleMs,plan.targetTick].every(Number.isSafeInteger)||measurement.warmupMs<0||measurement.sampleMs<=0||measurement.warmupMs+measurement.sampleMs>600000||plan.targetTick<0||!Number.isSafeInteger(plan.targetTick*50000)||typeof plan.observer!=='boolean')throw Error('camera-cost-cell-declaration');
 const witnessExpectation=plan.witnessExpectation??'represented';if(!['absent','represented'].includes(witnessExpectation))throw Error('camera-cost-witness-expectation');
 const witnessOffsetsMs=plan.witnessOffsetsMs??[0,Math.floor(measurement.sampleMs/2),measurement.sampleMs-100];if(witnessOffsetsMs.length!==3||witnessOffsetsMs[0]!==0||witnessOffsetsMs.some((n,i)=>!Number.isSafeInteger(n)||n<0||n>=measurement.sampleMs||(i>0&&n<=witnessOffsetsMs[i-1])))throw Error('camera-cost-witness-offsets');
 if(plan.seed!==undefined&&(!Number.isSafeInteger(plan.seed)||plan.seed<0||plan.seed>0xffffffff))throw Error('camera-cost-seed');
 const witnesses=plan.witnesses??[];if(!Array.isArray(witnesses)||witnesses.length>8||new Set(witnesses).size!==witnesses.length||witnesses.some(n=>!Number.isSafeInteger(n)||n<1))throw Error('camera-cost-witness-plan');return {warmupMs:measurement.warmupMs,sampleMs:measurement.sampleMs,targetTick:plan.targetTick,observer:plan.observer,witnesses,witnessExpectation,witnessOffsetsMs,seed:plan.seed??null};
}
export function costProgressValid(p, observer) { return p.rows > 1 && p.history === p.rows && p.broadcast === p.rows && p.lastTick > p.firstTick && (observer ? p.invoked > 0 : p.invoked === 0); }
export async function prepare({recipe}) {
 if(!recipe?.costMeasurement)throw Error('camera-cost-sealed-fixture-declaration-required');
 return recipe.costMeasurement;
}
/** Installs ownership before navigation; late evaluate completions cannot write after cleanup. */
export function beforeNavigation({page,paths}) {
 const state={closed:false,files:0,processFiles:0,collector:null,task:null,stop:new AbortController(),error:null,startAt:Infinity,endAt:Infinity,progress:{rows:0,history:0,broadcast:0,invoked:0,firstTick:null,lastTick:null},process:new OwnedBrowserCost(page.context().browser())};sessions.set(page,state);
 state.processSample=(label,cleanup=false)=>{const pending=(state.processPending??Promise.resolve()).catch(()=>{}).then(async()=>{const value=await state.process.sample(label);if(state.closed&&!cleanup)throw Error('camera-cost-late-process-result');writeFileSync(join(paths.dir,`cost-process-${String(state.processFiles++).padStart(4,'0')}.json`),JSON.stringify(value,null,2)+'\n',{flag:'wx'});return value;});state.processPending=pending;return pending;};
 const ready=(async()=>{await page.addInitScript(installPageCostProbe);await state.processSample('before-navigation');})();
 const stop=async()=>{
  state.closed=true;state.stop.abort();state.collector?.stop();
  let timer;try{await Promise.race([Promise.allSettled([ready,state.task,state.processPending]),new Promise((_,reject)=>{timer=setTimeout(()=>reject(Error('camera-cost-drain-cleanup-timeout')),5000);})]);await state.processSample('before-browser-close',true);await state.process.stop();}finally{clearTimeout(timer);}
  try{await page.evaluate(()=>globalThis.__cameraCostPageProbe?.stop());}catch{/* Closing a failed page must still close its owned browser. */}
  writeFileSync(join(paths.dir,'cost-collection-close.json'),JSON.stringify({closed:true,batches:state.files,error:state.error},null,2),{flag:'wx'});
 };
 stop.ready=ready;stop.afterBrowserClose=()=>state.process.afterClose();return stop;
}
export default async function({page,paths,signal,fixture,measurement,arm,check}) {
 const plan=validateCostCell(measurement,fixture),state=sessions.get(page);if(!state||state.closed)throw Error('camera-cost-collection-not-owned');
 if(!['off','on'].includes(arm)||plan.observer!==(arm==='on'))throw Error('camera-cost-arm-declaration-mismatch');
 const save=(name,value)=>{if(state.closed||signal.aborted)throw Error('camera-cost-late-write-refused');writeFileSync(join(paths.dir,name),JSON.stringify(value,null,2)+'\n',{flag:'wx'});};
 save('cost-cell-declaration.json',{...plan,scope:'Interface capability only unless separately declared full frozen cell; original recording and playback artifact pins live in fixture provenance',unknown:['complete process/worker CPU','resident memory','deferred GC attribution','presented FPS','cross-run camera/pixel equivalence','physical mobile','perceptual playback']});
 await page.waitForFunction(()=>!!window.__cameraObservationCost,null,{timeout:30000});
 state.collector=new CostCollector(async(after,epoch)=>{const hostBefore=performance.now();const value=await page.evaluate(({after,epoch})=>{const before=performance.now(),snapshot=window.__cameraObservationCost.read(after,epoch),encodeStart=performance.now(),text=JSON.stringify(snapshot),bytes=new TextEncoder().encode(text).byteLength;return{snapshot,probe:{browserReadAndEncodeMs:performance.now()-before,jsonEncodeMs:performance.now()-encodeStart,serializedBytes:bytes}};},{after,epoch});state.exportProbe={...value.probe,hostBracket:[hostBefore,performance.now()]};return value.snapshot;},batch=>{if(state.closed||signal.aborted)throw Error('camera-cost-late-write-refused');if(state.files>=602)throw Error('camera-cost-batch-bound');const index=String(state.files++).padStart(4,'0'),encodeStart=performance.now(),text=JSON.stringify({snapshot:batch.snapshot,error:batch.error??null})+'\n',encodeEnd=performance.now();writeFileSync(join(paths.dir,`cost-batch-${index}.json`),text,{flag:'wx'});save(`cost-export-${index}.json`,{...state.exportProbe,hostEncodeMs:encodeEnd-encodeStart,hostWriteMs:performance.now()-encodeEnd,hostSerializedBytes:Buffer.byteLength(text),scope:'Browser read plus JSON/UTF8 probe; host RPC bracket includes protocol serialization/transfer. Host JSON/file costs separate; no observer-exclusive CPU attribution.'});});
 await state.collector.poll();
 state.task=(async()=>{try{while(!state.stop.signal.aborted){await delay(1000,null,{signal:state.stop.signal});if(!state.stop.signal.aborted){await state.collector.poll();await state.processSample('periodic');}}}catch(error){if(!state.stop.signal.aborted)state.error=String(error);}})();
 let cdp;const metrics=async label=>{try{if(!cdp){cdp=await page.context().newCDPSession(page);await cdp.send('Performance.enable',{timeDomain:'threadTicks'});}save(`cost-cdp-${label}.json`,{supported:true,metrics:await cdp.send('Performance.getMetrics'),scope:'Reported renderer metrics only; complete worker/process attribution and resident memory unknown'});}catch(error){save(`cost-cdp-${label}.json`,{supported:false,error:String(error),scope:'Unknown; no metric substituted'});}};
 try{
  await page.waitForFunction(costHistoryReady,undefined,{timeout:30000});
  const snapshot=async label=>save(`cost-ui-before-${label}.json`,{accessibility:await page.locator('body').ariaSnapshot()});
  await nativeCameraMode(page,'broadcast',snapshot);
  await openCostTime(page,snapshot);const panel=page.getByRole('dialog',{name:'Time',exact:true});
  if(await panel.getByRole('button',{name:'Pause',exact:true}).isVisible()){await snapshot('pause');await panel.getByRole('button',{name:'Pause',exact:true}).click();}
  const slider=page.getByRole('slider',{name:'Every moment since the world began',exact:true});
  await snapshot('seek-keys');await seekCostTarget(slider,plan.targetTick,signal);
  await page.waitForFunction(target=>{const p=document.querySelector('[data-time-panel="recorded"]');return p&&!p.textContent.includes('loading that moment')&&Number(document.querySelector('[data-viewer-tick]')?.getAttribute('data-viewer-tick'))===target&&[...p.querySelectorAll('button')].some(b=>b.textContent==='Play'&&!b.disabled);},plan.targetTick,{timeout:30000});
  const paused=await page.evaluate(()=>Number(document.querySelector('[data-viewer-tick]')?.getAttribute('data-viewer-tick')));check('camera-cost-known-paused-target',paused===plan.targetTick);
  save('cost-clock-probe.json',await page.evaluate(clockCostProbe));const beforeProcesses=await state.processSample('before-play');
  await metrics('before');save('cost-boundary-before.json',await page.evaluate(()=>({status:window.__cameraObservationCost.status(),drawnTick:document.querySelector('[data-viewer-tick]')?.getAttribute('data-viewer-tick')})));
  await snapshot('play');await panel.getByRole('button',{name:'Play',exact:true}).click();await page.keyboard.press('Escape');
  const started=performance.now();await delay(plan.warmupMs,null,{signal});const startHost=performance.now(),sampleStart=await page.evaluate(offsets=>({at:performance.now(),armed:window.__cameraObservationCost.armSampleWitnesses(offsets),status:window.__cameraObservationCost.status()}),plan.witnessOffsetsMs);state.startAt=sampleStart.at;save('cost-sample-start.json',{browser:sampleStart,hostBracket:[startHost,performance.now()],elapsedNodeMs:performance.now()-started});
  await delay(plan.sampleMs,null,{signal});const endHost=performance.now(),sampleEnd=await page.evaluate(()=>({at:performance.now(),status:window.__cameraObservationCost.status(),tick:Number(document.querySelector('[data-viewer-tick]')?.getAttribute('data-viewer-tick'))}));state.endAt=sampleEnd.at;save('cost-sample-end.json',{browser:sampleEnd,hostBracket:[endHost,performance.now()],elapsedNodeMs:performance.now()-started});
  state.stop.abort();await state.task;if(state.error)throw Error(state.error);const afterProcesses=await state.processSample('after-sample');const pageProbe=await page.evaluate(()=>globalThis.__cameraCostPageProbe.read());save('cost-page-probe.json',pageProbe);check('camera-cost-page-probe-complete',!pageProbe.overflow&&pageProbe.supported.resource&&pageProbe.supported.longtask);check('camera-cost-owned-process-metrics',[beforeProcesses,afterProcesses].every(p=>p.supported&&p.memorySupported&&p.rssSumBytes!==null&&p.processes.some(p=>p.type==='browser')&&p.processes.some(p=>p.type==='renderer')));
  const final=await state.collector.poll({final:true});save('cost-final-counts.json',final);check('camera-cost-lossless-final-count',final.complete&&final.collected>0);
  // Reclassify retained batches after both browser-clock boundaries are fixed. Never rely on host RPC ordering.
  state.progress={rows:0,history:0,broadcast:0,invoked:0,firstTick:null,lastTick:null};let cursor;const sampledRows=[],cameraTrace=[];
  for(let i=0;i<state.files;i++){const batch=JSON.parse(readFileSync(join(paths.dir,`cost-batch-${String(i).padStart(4,'0')}.json`))),decoded=decodeCostSnapshot(batch.snapshot,cursor);cursor=decoded.cursor;for(const r of decoded.rows){if(r[2]<state.startAt||r[2]>state.endAt)continue;sampledRows.push(r);cameraTrace.push({sequence:r[0],at:r[2],tick:r[3],history:r[55],seek:r[56],shot:batch.snapshot.shots[r[63]],cameraWorld:r.slice(16,32),projection:r.slice(32,48)});const p=state.progress;p.rows++;p.history+=r[55]===1?1:0;p.broadcast+=r[53]===0?1:0;p.invoked+=r[7];p.firstTick??=r[3];p.lastTick=r[3];}}
  save('cost-camera-trace.json',{seed:plan.seed,rows:cameraTrace,scope:'Actual drawn camera, director choice key and rendered shot label by source tick; seed and equal input do not imply cross-run trajectory equality'});save('cost-progress.json',state.progress);check('camera-cost-recorded-broadcast-progress-and-arm',costProgressValid(state.progress,plan.observer));
  await metrics('after');const witnesses=await page.evaluate(()=>window.__cameraObservationCost.witnesses());save('cost-witnesses.json',{planned:plan.witnesses,witnesses,scope:plan.witnesses.length?'Declared same-draw sequences only; phase coverage requires retained sequence/time review':'UNKNOWN: no witness plan declared'});if(plan.witnesses.length)check('camera-cost-declared-witnesses',plan.witnesses.every(seq=>witnesses.some(w=>w.sequence===seq&&w.status==='complete'&&w.equal)));
  const phases=witnesses.filter(w=>w.phase==='sample');save('cost-sample-witness.json',{requested:sampleStart.armed,expectation:plan.witnessExpectation,witnesses:phases,scope:'Three declared actual sample draws only; same-call non-mutation, not every frame or cross-run camera equivalence'});check('camera-cost-sampled-scene-witness',phases.length===3&&['start','middle','end'].every(point=>phases.some(w=>w.point===point&&sampledWitnessValid(w,sampledRows,state.startAt,state.endAt,{expectation:plan.witnessExpectation}))));
  await page.screenshot({path:join(paths.dir,'cost-final.png')});
 }finally{state.stop.abort();if(cdp){try{await cdp.send('Performance.disable');}finally{await cdp.detach();}}}
}

/** Real keyboard controls from the paused nearby value; independent of pixel/wall-clock slider resolution. */
export async function seekCostTarget(slider,target,signal){const min=Number(await slider.getAttribute('min')),max=Number(await slider.getAttribute('max'));let selected=Number(await slider.inputValue());if(!Number.isInteger(min)||Number(await slider.getAttribute('step'))!==1||!Number.isInteger(selected)||target<min||target>max||Math.abs(selected-target)>256)throw Error('camera-cost-target-keyboard-range');if(selected===target){signal.throwIfAborted();await slider.press('ArrowRight');const right=Number(await slider.inputValue());if(right!==target+1)throw Error('camera-cost-target-no-progress');selected=right;}for(let steps=0;selected!==target;steps++){signal.throwIfAborted();if(steps>=256)throw Error('camera-cost-target-step-limit');const direction=selected<target?1:-1,previous=selected;await slider.press(direction>0?'ArrowRight':'ArrowLeft');selected=Number(await slider.inputValue());if(selected!==previous+direction)throw Error('camera-cost-target-no-progress');}}

/** Same page readiness as before, plus the real arrival layer must be gone before input. */
export function costHistoryReady(doc=globalThis.document){const v=doc.querySelector('.viewer-history');return v?.getAttribute('data-viewer-ready')==='true'&&v?.getAttribute('data-viewer-presentation')==='history'&&!doc.querySelector('.viewer-arrival');}
/** Semantic openness, independent of the closing panel's delayed CSS visibility. */
export function costMenuOpen(doc=globalThis.document){const toggle=doc.querySelector('.hud-menu[aria-label="Menu"]'),panel=doc.getElementById('hud-menu-panel');return toggle?.getAttribute('aria-expanded')==='true'&&panel?.getAttribute('data-open')==='true'&&!panel.hasAttribute('inert');}
/** Wait for camera dismissal; use semantic Menu state before real actionable input. */
export async function openCostTime(page,snapshot){
 await page.getByRole('dialog',{name:'Camera modes and help',exact:true}).waitFor({state:'hidden',timeout:30000});
 const direct=page.getByRole('button',{name:/time controls$/});if(await direct.isVisible()){await snapshot('time');await direct.click();return;}
 const toggle=page.getByRole('button',{name:'Menu',exact:true});
 if(await toggle.getAttribute('aria-expanded')!=='true'){await snapshot('time-menu');await toggle.click();}
 await page.waitForFunction(costMenuOpen,undefined,{timeout:30000});
 await snapshot('time-route');await page.getByRole('menu',{name:'Menu',exact:true}).getByRole('menuitem',{name:/^Time(?:\s|$)/}).click();
}
