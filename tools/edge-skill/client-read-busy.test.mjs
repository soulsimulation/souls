import test from 'node:test';
import assert from 'node:assert/strict';
import {createServer} from 'node:http';
import {spawn} from 'node:child_process';
import {mkdtempSync,rmSync,writeFileSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join,resolve} from 'node:path';
import {shedReadWaitMs,READ_BUSY_WAITS} from './eden-agent.mjs';

// #1372: a world at load level red sheds reads with 503 world.busy and a stated wait. The CLI waits at least that long
// and reads again, instead of failing the observe, or the capabilities read in front of an act, at once.
const SHED={ok:false,code:'world.busy',message:'The world is very busy (red) and asked you to wait 2 s before reading again; actions still go through',retry_after:0.4,retryAfterMs:400,limit:{scope:'load:red'}};

test('a shed read states its wait; anything else is not waited out',()=>{
 const none=new Headers();
 assert.equal(shedReadWaitMs(503,none,SHED),400,'retryAfterMs in the body');
 assert.equal(shedReadWaitMs(503,none,{code:'world.busy',retry_after:2}),2000,'retry_after in seconds');
 assert.equal(shedReadWaitMs(429,new Headers({'retry-after':'3'}),{error:{code:'soul.slow-down'}}),3000,'the header wins');
 assert.equal(shedReadWaitMs(503,none,{code:'world.busy'}),null,'no stated wait: the answer stands');
 assert.equal(shedReadWaitMs(503,none,{code:'world.stalled',retry_after:2}),null,'not a busy code');
 assert.equal(shedReadWaitMs(500,none,{code:'world.busy',retry_after:2}),null,'not a shed status');
 assert.equal(shedReadWaitMs(503,none,{code:'world.busy',retry_after:600}),60_000,'capped at a minute');
 assert.equal(READ_BUSY_WAITS,3);
});

// Both the source and the copy every launcher world serves (the pinned build) must behave the same.
for(const [label,file] of [['source','tools/edge-skill/eden-agent.mjs'],['served copy','tools/world-launcher/soul/eden-agent.mjs']]){
 test(`${label}: observe and act wait out one shed read and succeed, with no write before the read`,async t=>{
  const folder=mkdtempSync(join(tmpdir(),'eden-read-busy-')),log=[];let shedObserve=1,shedCaps=1,always=false;
  const server=createServer(async(req,res)=>{let text='';for await(const c of req)text+=c;const path=req.url.split('?')[0];log.push({at:Date.now(),method:req.method,path});res.setHeader('content-type','application/json');
   const shed=()=>{res.statusCode=503;res.end(JSON.stringify(SHED));};
   if(path==='/v1/edge/observe'){if(always||shedObserve-->0)return shed();return res.end(JSON.stringify({contract:'eden-edge/1',self:{name:'Ana',placePath:[{name:'Commons'}],state:'idle'},here:{souls:[],objects:[]},capabilities:[]}));}
   if(path==='/v1/edge/capabilities'){if(shedCaps-->0)return shed();return res.end(JSON.stringify({capabilities:[{id:'pray:here',verb:'pray',label:'pray',available:true}]}));}
   if(path==='/v1/edge/act')return res.end(JSON.stringify({accepted:true,receipt:{id:'rc_1',capability:JSON.parse(text).capability,phase:'started'},channel:'body'}));
   res.statusCode=404;res.end(JSON.stringify({code:'unexpected-route'}));});
  await new Promise(r=>server.listen(0,'127.0.0.1',r));
  t.after(async()=>{server.closeAllConnections();await new Promise(r=>server.close(r));rmSync(folder,{recursive:true,force:true});});
  writeFileSync(join(folder,'.eden-agent.json'),JSON.stringify({world:'http://127.0.0.1:'+server.address().port,soul:'s_fixture',token:'synthetic-only',mode:'edge'}));
  const run=async(...args)=>{const child=spawn(process.execPath,[resolve(file),...args],{cwd:folder,stdio:['ignore','pipe','pipe']});let out='',err='';child.stdout.on('data',b=>out+=b);child.stderr.on('data',b=>err+=b);const code=await new Promise(r=>child.once('exit',r));return {code,out,err};};
  const gap=(path)=>{const hits=log.filter(x=>x.path===path);return hits[1].at-hits[0].at;};

  const seen=await run('observe');
  assert.equal(seen.code,0,seen.err);assert.equal(JSON.parse(seen.out).me.name,'Ana');
  assert.equal(log.filter(x=>x.path==='/v1/edge/observe').length,2,'one shed read, then the same read again');
  assert.ok(gap('/v1/edge/observe')>=400,'asked again only after the stated wait');
  assert.match(seen.err,/asked me to wait 1 s before reading again/);

  const before=log.length,did=await run('act','pray');
  assert.equal(did.code,0,did.err);assert.equal(JSON.parse(did.out).accepted,true);
  const mine=log.slice(before);
  assert.deepEqual(mine.map(x=>`${x.method} ${x.path}`),['GET /v1/edge/capabilities','GET /v1/edge/capabilities','POST /v1/edge/act'],'the act is sent once, after the read succeeds');
  assert.ok(gap('/v1/edge/capabilities')>=400);

  always=true;const n=log.length,gave=await run('observe');
  assert.notEqual(gave.code,0,'a world that keeps shedding still gets an answer: the error');
  assert.match(gave.err,/observe: HTTP 503/);
  assert.equal(log.length-n,1+READ_BUSY_WAITS,'bounded: the first read and three more');
 });
}
