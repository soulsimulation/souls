// Private, bounded observations of the dedicated browser only. Never enumerates the host process table.
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
const execute = promisify(execFile), MAX_PROCESSES = 128;
const failure = message => { throw Error('camera-cost-process-' + message); };
export function processList(result) {
 const rows=result?.processInfo;
 if(!Array.isArray(rows)||rows.length>MAX_PROCESSES)failure('list-bound');
 const seen=new Set();
 return rows.map(p=>{if(!Number.isSafeInteger(p.id)||p.id<1||seen.has(p.id)||typeof p.type!=='string'||p.type.length>64||!Number.isFinite(p.cpuTime)||p.cpuTime<0)failure('invalid');seen.add(p.id);return{id:p.id,type:p.type,cpuSeconds:p.cpuTime};});
}
export function parseProcessMemory(text,ids) {
 const allowed=new Set(ids),seen=new Set(),rows=[];
 if(Buffer.byteLength(text)>65536)failure('memory-bound');
 for(const line of text.trim().split('\n').filter(Boolean)){const m=line.match(/^\s*(\d+)\s+(\d+)\s+(.+?)\s*$/);if(!m)failure('memory-format');const id=Number(m[1]),rssKiB=Number(m[2]);if(!allowed.has(id)||seen.has(id)||!Number.isSafeInteger(rssKiB*1024))failure('memory-identity');seen.add(id);rows.push({id,rssBytes:rssKiB*1024,startIdentity:m[3]});}
 return rows;
}
export async function targetedProcessMemory(ids,run=execute,platform=process.platform) {
 if(!['darwin','linux'].includes(platform))return{supported:false,reason:'targeted RSS unavailable on this platform'};
 if(ids.length>MAX_PROCESSES||new Set(ids).size!==ids.length||ids.some(id=>!Number.isSafeInteger(id)||id<1))failure('requested-ids');
 if(!ids.length)return{supported:true,rows:[]};
 try{const {stdout}=await run('/bin/ps',['-p',ids.join(','),'-o','pid=,rss=,lstart='],{encoding:'utf8',timeout:750,maxBuffer:65536,env:{...process.env,LC_ALL:'C'}});return{supported:true,rows:parseProcessMemory(stdout,ids)};}
 catch(error){if(error.code===1&&!String(error.stdout??'').trim())return{supported:true,rows:[]};return{supported:false,reason:String(error.message??error)};}
}
async function deadline(work,ms=1500){let timer;try{return await Promise.race([work(),new Promise((_,reject)=>{timer=setTimeout(()=>reject(Error('camera-cost-process-query-timeout')),ms);})]);}finally{clearTimeout(timer);}}
export function processDelta(previous,current) {
 const old=new Map((previous?.processes??[]).map(p=>[p.id,p])),known=[],newOrReused=[],missing=[];
 for(const p of current.processes??[]){const a=old.get(p.id);if(a&&p.startIdentity&&a.startIdentity===p.startIdentity&&p.cpuSeconds>=a.cpuSeconds)known.push({id:p.id,type:p.type,cpuSeconds:p.cpuSeconds-a.cpuSeconds});else newOrReused.push(p.id);old.delete(p.id);}
 missing.push(...old.keys());
 return{known,knownCpuSeconds:known.reduce((sum,p)=>sum+p.cpuSeconds,0),newOrReused,missing,completeLifetimeCpu:false,scope:'Known surviving process deltas only; processes born and exited between polls can be missed even without observed churn. Renderer worker threads are included in renderer process CPU; no observer-specific or per-worker attribution.'};
}
export class OwnedBrowserCost {
 constructor(browser,{memory=targetedProcessMemory,now=()=>performance.now()}={}){this.browser=browser;this.memory=memory;this.now=now;this.known=new Map();this.samples=0;this.closed=false;this.previous=null;}
 async sample(label){
  if(this.closed||this.samples++>=608)failure('closed-or-sample-bound');const started=this.now();
  try{this.cdp??=await deadline(()=>this.browser.newBrowserCDPSession());const cpuStart=this.now(),processes=processList(await deadline(()=>this.cdp.send('SystemInfo.getProcessInfo'))),cpuEnd=this.now(),memoryStart=this.now(),memory=await this.memory(processes.map(p=>p.id)),memoryEnd=this.now();
   if(this.closed)failure('closed-during-query');const rss=new Map((memory.rows??[]).map(p=>[p.id,p]));
   for(const p of processes){const m=rss.get(p.id);Object.assign(p,m??{rssBytes:null,startIdentity:null});if(m){if(!this.known.has(p.id)&&this.known.size>=MAX_PROCESSES)failure('lifetime-identity-bound');this.known.set(p.id,m);}}
   const result={label,hostBracket:[started,this.now()],cpuHostBracket:[cpuStart,cpuEnd],memoryHostBracket:[memoryStart,memoryEnd],at:this.now(),supported:true,processes,memorySupported:memory.supported,memoryReason:memory.reason??null,rssSumBytes:memory.supported&&rss.size===processes.length?processes.reduce((sum,p)=>sum+p.rssBytes,0):null,scope:'Dedicated browser processes reported by its own CDP endpoint. RSS sum double-counts shared pages, excludes GPU device allocations and is not observer resident memory.',queryMs:this.now()-started};result.delta=processDelta(this.previous,result);this.previous=result;return result;
  }catch(error){return{label,at:this.now(),supported:false,reason:String(error),queryMs:this.now()-started,completeLifetimeCpu:false};}
 }
 async stop(){this.closed=true;if(this.cdp)try{await deadline(()=>this.cdp.detach());}catch{/* Browser teardown remains independently owned. */}}
 async afterClose(){const started=this.now(),memory=await this.memory([...this.known.keys()]);return{supported:memory.supported,reason:memory.reason??null,queryMs:this.now()-started,remembered:this.known.size,survivingOriginals:memory.supported?memory.rows.filter(p=>p.startIdentity===this.known.get(p.id)?.startIdentity):null,reusedIds:memory.supported?memory.rows.filter(p=>p.startIdentity!==this.known.get(p.id)?.startIdentity).map(p=>p.id):null,scope:'Remembered PID/start-time identities after browser close only; start time has one-second resolution, so same-second PID reuse remains ambiguous. Disappearance is lifecycle evidence, not proof of component memory reclamation or unobserved descendant cleanup.'};}
}
