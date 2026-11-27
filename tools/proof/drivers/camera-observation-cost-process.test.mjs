import test from'node:test';import assert from'node:assert/strict';
import{processList,parseProcessMemory,targetedProcessMemory,processDelta,OwnedBrowserCost}from'./camera-observation-cost-process.mjs';
test('only valid bounded CDP process identities can reach targeted ps',async()=>{
 assert.deepEqual(processList({processInfo:[{id:1,type:'renderer',cpuTime:2}]}),[{id:1,type:'renderer',cpuSeconds:2}]);
 for(const processInfo of[[{id:0,type:'x',cpuTime:0}],[{id:1,type:'x',cpuTime:0},{id:1,type:'x',cpuTime:1}],Array(129).fill({id:1,type:'x',cpuTime:0})])assert.throws(()=>processList({processInfo}),/camera-cost-process/);
 let args;const m=await targetedProcessMemory([41,42],async(...a)=>{args=a;return{stdout:' 41 100 Fri Nov 27 10:00:00 2026\n'};},'darwin');assert.deepEqual(args[1],['-p','41,42','-o','pid=,rss=,lstart=']);assert.equal(m.rows[0].rssBytes,102400);assert.equal(args[2].timeout,750);
 assert.throws(()=>parseProcessMemory('43 10 start',[41]),/identity/);assert.throws(()=>parseProcessMemory('41 10 start\n41 20 start',[41]),/identity/);assert.equal((await targetedProcessMemory([],null,'win32')).supported,false);
 const gone=await targetedProcessMemory([41],async()=>{throw Object.assign(Error('gone'),{code:1,stdout:''});},'darwin');assert.deepEqual(gone.rows,[]);
});
test('known CPU deltas never imply complete lifetimes, and reuse/exit stay unknown',()=>{
 const p={processes:[{id:1,startIdentity:'a',cpuSeconds:2},{id:2,startIdentity:'b',cpuSeconds:4}]},c={processes:[{id:1,startIdentity:'a',cpuSeconds:3},{id:2,startIdentity:'new',cpuSeconds:1},{id:3,startIdentity:'c',cpuSeconds:2}]};
 const d=processDelta(p,c);assert.equal(d.knownCpuSeconds,1);assert.equal(d.completeLifetimeCpu,false);assert.deepEqual(d.newOrReused,[2,3]);assert.deepEqual(processDelta(c,{processes:[]}).missing,[1,2,3]);
 assert.equal(processDelta(p,p).completeLifetimeCpu,false);
});
test('owned endpoint sampling, memory limits, stop and post-close identity reuse remain distinct',async()=>{
 let detached=false,cpu=1;const cdp={send:async name=>{assert.equal(name,'SystemInfo.getProcessInfo');return{processInfo:[{id:41,type:'renderer',cpuTime:cpu++}]};},detach:async()=>{detached=true;}};
 const sampler=new OwnedBrowserCost({newBrowserCDPSession:async()=>cdp},{memory:async ids=>({supported:true,rows:ids.map(id=>({id,rssBytes:100,startIdentity:detached?'reused':'original'}))})});
 const a=await sampler.sample('blank'),b=await sampler.sample('sample');assert.equal(a.rssSumBytes,100);assert.equal(b.delta.knownCpuSeconds,1);await sampler.stop();assert.equal(detached,true);await assert.rejects(sampler.sample('late'),/closed/);const end=await sampler.afterClose();assert.deepEqual(end.survivingOriginals,[]);assert.deepEqual(end.reusedIds,[41]);
 const unsupported=new OwnedBrowserCost({newBrowserCDPSession:async()=>{throw Error('not available');}});assert.equal((await unsupported.sample('blank')).supported,false);await unsupported.stop();
});
test('late memory results cannot mutate closed measurement state and failed endpoints stay unsupported',async()=>{
 let release;const sampler=new OwnedBrowserCost({newBrowserCDPSession:async()=>({send:async()=>({processInfo:[{id:41,type:'renderer',cpuTime:1}]}),detach:async()=>{}})},{memory:()=>new Promise(r=>{release=r;})});
 const pending=sampler.sample('late');while(!release)await new Promise(r=>setImmediate(r));await sampler.stop();release({supported:true,rows:[{id:41,rssBytes:100,startIdentity:'a'}]});assert.equal((await pending).supported,false);assert.equal(sampler.known.size,0);assert.equal(sampler.previous,null);
 let fail=false;const endpoint=new OwnedBrowserCost({newBrowserCDPSession:async()=>({send:async()=>{if(fail)throw Error('endpoint query failed');return{processInfo:[{id:41,type:'renderer',cpuTime:1}]};},detach:async()=>{}})},{memory:async()=>({supported:true,rows:[{id:41,rssBytes:100,startIdentity:'a'}]})});
 assert.equal((await endpoint.sample('before')).supported,true);fail=true;assert.equal((await endpoint.sample('after')).supported,false);assert.equal(endpoint.previous.label,'before');await endpoint.stop();
});
