// G9 (lane Z1): a write in flight when the world is told to stop (a release handover) is answered before the process
// exits. The real main.ts on the Toy engine: a POST whose body is still arriving when SIGTERM lands gets its answer once
// the body is complete; with WRITE_DRAIN_MS=0 (no drain, as before) its connection simply closes with no answer.
// SIGTERM is sent only once the world itself has counted the write in flight (WRITE_DRAIN_TRACE=1 prints that line), and the
// test checks the write is still open at that moment. A fixed 200 ms was not enough on a busy runner (CI server-3,
// 2026-11-10), and neither was waiting for 100 Continue (#1778's merge group: the world had no write in flight at SIGTERM).
import test from 'node:test';import assert from 'node:assert/strict';import {spawn} from 'node:child_process';import {connect} from 'node:net';
import {mkdtempSync,readFileSync,rmSync} from 'node:fs';import {tmpdir} from 'node:os';import {join} from 'node:path';
import {setTimeout as delay} from 'node:timers/promises';
const readOr=(f:string)=>{try{return readFileSync(f,'utf8');}catch{return '';}};

async function stopWithWriteInFlight(t:import('node:test').TestContext,port:number,extra:Record<string,string>){
 const data=mkdtempSync(join(tmpdir(),'write-drain-')),logs:string[]=[];
 const child=spawn(process.execPath,[new URL('./main.ts',import.meta.url).pathname],{env:{PATH:process.env.PATH,DATA_DIR:data,WORLD_ID:'write-drain-fixture',WORLD_KEY:'toy',ENGINE:'toy',SEED_NATIVES:'0',BRAIN_MODE:'fake',BRAIN_BUDGET_USD_PER_DAY:'0',PORT:String(port),HOST:'127.0.0.1',WRITE_DRAIN_TRACE:'1',...extra},stdio:['ignore','pipe','pipe']});
 child.stdout!.on('data',d=>logs.push(String(d)));child.stderr!.on('data',d=>logs.push(String(d)));
 const exited=new Promise<number|null>(r=>child.once('exit',code=>r(code)));
 t.after(async()=>{if(child.exitCode===null&&child.signalCode===null)child.kill('SIGKILL');rmSync(data,{recursive:true,force:true});});
 let up=false;for(let i=0;i<300&&!up;i++){if(child.exitCode!==null)throw Error('startup failed: '+logs.join(''));try{up=(await fetch(`http://127.0.0.1:${port}/healthz`)).ok;}catch{}if(!up)await delay(20);}
 assert.ok(up,logs.join(''));
 const body=JSON.stringify({text:'drain probe',kind:'bug'}),half=Math.floor(body.length/2);
 const sock=connect(port,'127.0.0.1');let answer='';sock.on('data',d=>{answer+=d;});sock.on('error',()=>{});
 const closed=new Promise<void>(r=>sock.once('close',()=>r()));
 await new Promise<void>(r=>sock.once('connect',()=>r()));
 sock.write(`POST /v1/feedback HTTP/1.1\r\nHost: 127.0.0.1\r\nContent-Type: application/json\r\nContent-Length: ${body.length}\r\n\r\n${body.slice(0,half)}`);
 for(let i=0;i<500&&!/write in flight: 1\b/.test(logs.join(''));i++)await delay(20);   // the world has counted the write
 const before=logs.join('');
 assert.match(before,/write in flight: 1\b/,`the world counted the write before SIGTERM: ${before}`);
 assert.doesNotMatch(before,/write closed:/,`the write is still open at SIGTERM (answered early: ${JSON.stringify(answer)}): ${before}`);
 child.kill('SIGTERM');
 // the rest of the body arrives late: only once the world has begun to stop (live.json says so; shutdown writes it before
 // it counts its writes in flight). A fixed 300 ms let a world busy for longer (#2012: CI server-3, a 338 ms stall) read the
 // rest first, answer the write as usual and so take no drain at all.
 const live=join(data,'live.json');
 for(let i=0;i<500&&!/"phase":"stopping"/.test(readOr(live));i++)await delay(20);
 assert.match(readOr(live),/"phase":"stopping"/,`the world began to stop: ${logs.join('')}`);
 sock.write(body.slice(half));
 await Promise.race([closed,delay(5000)]);sock.destroy();
 return {answer,code:await exited,logs:logs.join('')};
}

test('a write in flight at SIGTERM is answered before the world exits',async t=>{
 const r=await stopWithWriteInFlight(t,5822,{});
 assert.match(r.answer,/^HTTP\/1\.1 \d{3} /,`the POST got an answer: ${r.logs}`);
 assert.equal(r.code,0);
 assert.match(r.logs,/SIGTERM: 1 of 1 write request\(s\) in flight answered in \d+ ms/);
});

test('without the drain (WRITE_DRAIN_MS=0) the same write gets no answer',async t=>{
 const r=await stopWithWriteInFlight(t,5823,{WRITE_DRAIN_MS:'0'});
 assert.equal(r.answer,'','the connection closed under it');
 assert.equal(r.code,0);
});
