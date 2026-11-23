// #3647: the actual direct-ground planner handoff after three ordinary C3 joins.
// GROUND_WALK_FACTS selects a hash-bound Eden export for the declared reproduction; CI uses N2's generated fixture.
import { strict as assert } from 'node:assert';
import { spawn } from 'node:child_process';
import { createHash, randomBytes } from 'node:crypto';
import { existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { createConnection, createServer } from 'node:net';
import { test } from 'node:test';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { isDeepStrictEqual } from 'node:util';
import { request } from '../src/daemon/client.mjs';
import { runtimeOf } from '../src/home/home.mjs';
import { decode, idText, sequenceOf } from '../src/brief/copy.mjs';

const v2=resolve(dirname(fileURLToPath(import.meta.url)),'../..');
const scratch=process.env.GROUND_WALK_SCRATCH??resolve(v2,'../.local/served-ground-walk');mkdirSync(scratch,{recursive:true});
const pause=ms=>new Promise(ok=>setTimeout(ok,ms));
const hash=bytes=>createHash('sha256').update(bytes).digest('hex');
const bin=name=>process.env[name.toUpperCase()]??join(v2,'target/debug',name);
const pkg=process.env.SOULS_REPLICA_PKG??join(v2,'target/wasm-load/pkg');
const CLI=join(v2,'client/src/cli/souls.mjs'),DAEMON=join(v2,'client/src/daemon/daemon.mjs');

// All direct-ground assertions have one owner and a retained private receipt.
test('served ground walk: current planner result moves the ordinarily joined body', {timeout:150_000}, async t=>{
  const base=mkdtempSync(join(scratch,'attempt-')),children=[],stopping=new Set(),deaths=[],observers=[],reports={stages:[]};
  let recoveredSource=null,donorBefore=null,recoveredStore=null,storeBefore=null;
  const snapshot=dir=>Object.fromEntries(readdirSync(dir,{recursive:true}).sort().flatMap(name=>{const p=join(dir,name),st=lstatSync(p);assert.ok(!st.isSymbolicLink(),'recovered fixture has no links');if(st.isDirectory())return[];assert.ok(st.isFile(),'recovered fixture has only regular data');return[[name,hash(readFileSync(p))]];}));
  const home=join(base,'home');mkdirSync(home,{mode:0o700});const began=performance.now();
  const save=()=>writeFileSync(join(base,'report.json'),JSON.stringify(reports,null,2),{mode:0o600});
  const stage=name=>{reports.stages.push({name,ms:Math.round(performance.now()-began)});save();};
  const healthy=()=>assert.deepEqual(deaths,[],'every owned fixture child/socket stays live');
  const until=async(f,ms=10_000)=>{const end=performance.now()+ms;for(;;){healthy();const value=await f();if(value)return value;if(performance.now()>=end)throw Error('bounded served-ground-walk phase timed out');await pause(50);}};
  const run=(path,args,ready=null,{cwd=base,env={}}={})=>new Promise((ok,fail)=>{
    const p=spawn(path,args,{cwd,env:{...process.env,...env,BRAIN_MODE:'fake'},stdio:['ignore','pipe','pipe']});children.push(p);
    const log=join(base,`child-${children.length}.log`);let text='';const take=b=>{writeFileSync(log,b,{flag:'a',mode:0o600});text+=b;if(text.length>512*1024)text=text.slice(-512*1024);const m=ready instanceof RegExp?ready.exec(text):null;if(m)ok({p,m});};
    p.stdout.on('data',take);p.stderr.on('data',take);
    p.once('error',e=>{deaths.push({pid:p.pid,error:e.code});fail(Error('owned fixture child failed to start'));});
    p.once('exit',(code,signal)=>{if(!stopping.has(p)&&(ready||code!==0||signal))deaths.push({pid:p.pid,code,signal});if(!ready&&code===0&&!signal)ok({p,text});else if(!stopping.has(p))fail(Error('owned fixture child ended before readiness'));});
    if(ready===true)ok({p});
  });
  const stop=async p=>{
    if(p.exitCode!==null||p.signalCode!==null)return;stopping.add(p);
    const ended=ms=>new Promise(ok=>{let timer;const done=v=>{clearTimeout(timer);p.off('exit',exit);ok(v);},exit=()=>done(true);p.once('exit',exit);timer=setTimeout(()=>done(false),ms);if(p.exitCode!==null||p.signalCode!==null)done(true);});
    p.kill('SIGTERM');if(!await ended(3000)){p.kill('SIGKILL');assert.ok(await ended(2000),'owned child exits after escalation');}
    try{process.kill(p.pid,0);assert.fail('owned child still present');}catch(e){if(e.code!=='ESRCH')throw e;}
  };
  const daemons=[];
  t.after(async()=>{
    const cleanup=[];
    const ended=await Promise.allSettled(observers.map(o=>o.close()));for(const e of ended)if(e.status==='rejected')cleanup.push('observer-close');
    await Promise.allSettled(daemons.map(async s=>{stopping.add(s.p);try{await request(s.rt.socket,{op:'stop'},2000);}catch{cleanup.push('daemon-stop');}}));
    const results=await Promise.allSettled(children.map(stop));for(const e of results)if(e.status==='rejected')cleanup.push('child-stop');
    if(recoveredSource){try{const after=snapshot(recoveredSource);reports.donorUnchanged=JSON.stringify(after)===JSON.stringify(donorBefore);if(!reports.donorUnchanged)cleanup.push('donor-changed');}catch{cleanup.push('donor-observation');}}
    if(recoveredStore){try{const after=snapshot(recoveredStore);reports.storeDonorUnchanged=JSON.stringify(after)===JSON.stringify(storeBefore);if(!reports.storeDonorUnchanged)cleanup.push('store-donor-changed');}catch{cleanup.push('store-donor-observation');}}
    reports.processes=children.map(p=>({pid:p.pid,exit:p.exitCode,signal:p.signalCode}));reports.deaths=deaths;reports.cleanup=cleanup;save();
    assert.deepEqual(cleanup,[],'all owned cleanup completes');healthy();
  });
  const post=async(origin,path,body)=>{const r=await fetch(new URL(path,origin),{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify(body),signal:AbortSignal.timeout(3000)});return{status:r.status,body:await r.json()};};
  const cli=async(soul,...args)=>{const got=await run(process.execPath,[CLI,...args,'--soul',soul],null,{env:{SOULS_HOME:home,SOULS_REPLICA_PKG:pkg}});return JSON.parse(got.text);};
  let facts=process.env.GROUND_WALK_FACTS;
  if(!facts){await run(bin('testworld'),['--seed','1','--things','0','--out',base]);facts=join(base,'testworld-s1-t0.facts.json');}
  reports.factsSha256=hash(readFileSync(facts));reports.fullEden=Boolean(process.env.GROUND_WALK_FACTS);stage('facts-bound');
  const world=join(base,'world');
  if(process.env.GROUND_WALK_RECOVERED_WORLD){
    assert.ok(process.env.GROUND_WALK_FACTS&&process.env.GROUND_WALK_RECOVERED_MANIFEST,'recovery has explicit bound full Eden inputs');
    recoveredSource=resolve(process.env.GROUND_WALK_RECOVERED_WORLD);const binding=JSON.parse(readFileSync(process.env.GROUND_WALK_RECOVERED_MANIFEST,'utf8'));
    assert.equal(recoveredSource,resolve(binding.donor));assert.deepEqual(binding.links,{});assert.deepEqual(binding.special,[]);
    donorBefore=snapshot(recoveredSource);assert.deepEqual(donorBefore,binding.files,'all genuine donor bytes match the reviewed manifest');
    assert.equal(donorBefore['facts.json'],reports.factsSha256);assert.equal(binding.entryCatalogueFiles,371);assert.equal(binding.checkpointFiles,2);
    await run('/bin/cp',['-cR',recoveredSource,world]);assert.deepEqual(snapshot(world),donorBefore,'own clone preserves every genuine file');
    reports.recovered={files:Object.keys(donorBefore).length,entries:binding.entryCatalogueFiles,checkpoints:binding.checkpointFiles,metadataUnchanged:true};stage('genuine-recovered-clone');
    assert.ok(process.env.GROUND_WALK_RECOVERED_STORE_MANIFEST,'genuine public pointer has its bound recovery companion');
    const storeBinding=JSON.parse(readFileSync(process.env.GROUND_WALK_RECOVERED_STORE_MANIFEST,'utf8')),header=decode(readFileSync(join(world,'header')));
    const namespace=`stream-recovery/${Buffer.from(header.get(3)).toString('hex')}/${idText(header.get(4))}/${header.get(5)}`;
    assert.equal(storeBinding.namespace,namespace);assert.equal(storeBinding.headerFileSha256,binding.files.header);assert.equal(storeBinding.seedHeaderSha256,binding.files.header);
    recoveredStore=resolve(storeBinding.donor);storeBefore=snapshot(recoveredStore);assert.deepEqual(storeBefore,storeBinding.files);assert.equal(Object.keys(storeBefore).length,16);
    const destination=join(world,'.stream-recovery-store',namespace);assert.ok(!existsSync(destination));mkdirSync(dirname(destination),{recursive:true});
    await run('/bin/cp',['-cR',recoveredStore,destination]);assert.deepEqual(snapshot(destination),storeBefore,'all referenced immutable companion objects are copied unchanged');
    reports.recoveryCompanion={files:16,bytes:storeBinding.bytes,namespaceMatchesHeader:true,referencedObjects:storeBinding.referencedObjectsVerified};stage('genuine-recovery-companion-clone');

  }else{
    // Generated CI and fresh-facts paths keep their original seed and empty-token assertions.
    await run(bin('worldd'),['seed','--facts',facts,'--dir','world','--souls','0','--at','20,20']);
    assert.equal(readFileSync(join(world,'tokens'),'utf8'),'');
  }
  await run(bin('worldd'),['serve','--dir','world'],/listening /);
  const gatewayProcess=await run(bin('gatewayd'),['--listen','127.0.0.1:0','--world','world/gateway.sock','--tokens','world/tokens','--build',`1220${'ab'.repeat(32)}`],/listening (\S+)\n/);
  const gateway='ws://'+gatewayProcess.m[1]+'/v2/ws';
  const directoryProcess=await run(bin('directoryd'),['--listen','127.0.0.1:0','--public-url','http://127.0.0.1:1','--store',join(base,'accounts.sqlite'),'--test-sign-in','--pairing',join(base,'pairing.sqlite'),'--gateway-tokens',join(world,'tokens')],/listening on (\S+)\n/);
  const origin='http://'+directoryProcess.m[1],seats=[];
  for(const soul of ['s_ground_a','s_ground_b','s_ground_c']){
    const secret=randomBytes(32).toString('hex');
    const asked=await post(origin,'/v1/pair/request',{secret_hash:hash(secret),device:'ground fixture',label:'served ground',scope:'soul',new:true,world:'local'});assert.equal(asked.status,200);
    const approved=await post(origin,'/v1/pair/approve',{code:asked.body.code,confirm:true,test_person:'Ground owner'});assert.equal(approved.status,200);
    seats.push({soul,secret,interval:asked.body.interval});
  }
  await pause(Math.max(...seats.map(s=>s.interval))*1000);
  for(const s of seats){const paired=await post(origin,'/v1/pair/poll',{secret:s.secret});assert.equal(paired.status,200);assert.ok(paired.body.token&&paired.body.grant);s.token=paired.body.token;s.grant=paired.body.grant;s.id=s.grant.slice(5);delete s.secret;}
  writeFileSync(join(home,'config.json'),JSON.stringify({worlds:{local:{gateway,directory:origin}}}));
  writeFileSync(join(home,'credentials.json'),JSON.stringify({souls:Object.fromEntries(seats.map(s=>[s.soul,{local:{token:s.token}}]))}),{mode:0o600});
  const wire=await import(pathToFileURL(join(pkg,'replica.js')).href);wire.initSync({module:readFileSync(join(pkg,'replica_bg.wasm'))});
  // Passive byte-exact relays watch only each daemon's actual authorized connection. Nothing is held or injected.
  const observe=async s=>{
    const sockets=new Set(),copy=new wire.Copy(),items=[],references=new Set();let data=Buffer.alloc(0),upgraded=false,active=false,closed=false,connections=0,fragment=null,failure=null;
    const fail=e=>{if(!failure){failure=e;deaths.push({observer:s.soul,error:'passive-observer'});reports.observerError={name:e.name,message:e.message};save();}};
    const delivered=bytes=>{
      const value=decode(bytes);assert.ok(value instanceof Map,'actual binary message is a record');
      if(value.has(20)){
        assert.ok(!value.has(24),'actual R5 request was not refused');
        if(value.has(25)||value.has(21)){copy.onHashes(bytes);active=true;}
        else if(value.has(22)){assert.ok(active,'record reply belongs to an active actual sync');copy.onRecords(bytes);}
        else return; // Existing metadata replies do not alter canonical Copy records.
        if(!copy.next(0n).length){copy.finish();active=false;}
      }
      if(value.has(31)){
        const item=decode(value.get(31)),line=wire.wireHeard(bytes);
        if(item.get(2) instanceof Uint8Array){const scan=v=>{if(v instanceof Map){const ref=v.get(21);if(Array.isArray(ref)&&ref[0] instanceof Uint8Array&&ref[0].length===16&&Number.isSafeInteger(ref[1]))references.add(idText(ref));for(const x of v.values())scan(x);}else if(Array.isArray(v))for(const x of v)scan(x);};scan(decode(item.get(2)));assert.ok(references.size<=100000,'finite delivered reference set');}
        if(line){const entry=decode(item.get(2)),said=(entry.get(8)??[]).find(e=>e.get(1)==='souls:said');items.push({line,words:item.get(3)??null,reference:said?.get(2)?.get(1)?.get(21)??null});assert.ok(items.length<=64,'finite observer event ledger');reports.observed=seats.map(x=>x.observer?.items??[]);save();}
      }
    };
    const inspect=chunk=>{
      data=Buffer.concat([data,chunk]);assert.ok(data.length<=16*1024*1024+65536,'bounded transport buffer');
      if(!upgraded){const end=data.indexOf('\r\n\r\n');if(end<0){assert.ok(data.length<=65536);return;}assert.match(data.subarray(0,end).toString('ascii'),/^HTTP\/1\.1 101 /);data=data.subarray(end+4);upgraded=true;}
      while(data.length>=2){
        const tag=data[1]&127,opcode=data[0]&15,fin=Boolean(data[0]&128);let size=tag,at=2;
        assert.equal(data[1]&128,0,'server frames are not masked');assert.equal(data[0]&112,0,'no unnegotiated extensions');
        if(tag===126){if(data.length<4)return;size=data.readUInt16BE(2);at=4;}
        else if(tag===127){if(data.length<10)return;const big=data.readBigUInt64BE(2);assert.ok(big<=16n*1024n*1024n);size=Number(big);at=10;}
        assert.ok(size<=16*1024*1024,'bounded actual frame');if(data.length<at+size)return;
        const payload=data.subarray(at,at+size);data=data.subarray(at+size);
        if(opcode>=8){assert.ok(fin&&size<=125,'valid control frame');if(opcode===8&&!closed)throw Error('owned daemon transport closed unexpectedly');continue;}
        if(opcode===0){assert.ok(fragment,'continuation has an initial frame');fragment.parts.push(payload);fragment.bytes+=size;assert.ok(fragment.bytes<=16*1024*1024);if(fin){if(fragment.opcode===2)delivered(Buffer.concat(fragment.parts));fragment=null;}continue;}
        assert.ok((opcode===1||opcode===2)&&!fragment,'valid data message');
        if(!fin)fragment={opcode,parts:[payload],bytes:size};else if(opcode===2)delivered(payload);
      }
    };
    const server=createServer(down=>down.once('data',first=>{
      const up=createConnection(Number(new URL(gateway).port),'127.0.0.1');up.write(first);
      // The daemon's entries fetch at sign-in (#3760) is a plain HTTP exchange, not the observed transport.
      if(first.subarray(0,15).toString('latin1')==='GET /v2/entries'){sockets.add(down);sockets.add(up);down.pipe(up);up.pipe(down);for(const socket of[down,up])socket.on('error',()=>{});return;}
      connections++;sockets.add(down);sockets.add(up);
      down.pipe(up);up.pipe(down); // Forward original bytes even when an observer fails; teardown is owned elsewhere.
      if(connections!==1)fail(Error('unexpected daemon reconnection'));
      up.on('data',chunk=>{if(!failure)try{inspect(chunk);}catch(e){fail(e);}});
      for(const socket of[down,up]){socket.on('error',()=>{if(!closed)fail(Error('owned transport error'));});socket.on('close',()=>{sockets.delete(socket);if(!closed)fail(Error('owned transport closed'));});}
    }));
    await new Promise((ok,fail)=>{server.once('error',fail);server.listen(0,'127.0.0.1',ok);});
    const o={items,references,gateway:`ws://127.0.0.1:${server.address().port}/v2/ws`,async snapshot(){
      // A follow sync may start after any entry near the body (the walk's own entries included): read the mirror at a
      // moment the daemon is between syncs and the relay has seen every answer, never mid-sync.
      const end=performance.now()+10_000;
      for(;;){
        if(failure)throw failure;healthy();
        const status=await request(s.rt.socket,{op:'status'});
        if(!status.syncing&&!active&&isDeepStrictEqual(JSON.parse(copy.roots()),status.roots))return copy;
        if(performance.now()>=end){assert.equal(status.syncing,false);assert.equal(active,false);assert.deepEqual(JSON.parse(copy.roots()),status.roots,'mirror is the actual daemon canonical copy');}
        await pause(50);
      }
    },async close(){closed=true;for(const socket of sockets)socket.destroy();await new Promise((ok,fail)=>{const timer=setTimeout(()=>fail(Error('relay-close-timeout')),2000);server.close(e=>{clearTimeout(timer);e?fail(e):ok();});});copy.free();}};
    observers.push(o);return o;
  };
  for(const s of seats){
    s.observer=await observe(s);
    writeFileSync(join(home,'config.json'),JSON.stringify({worlds:{local:{gateway:s.observer.gateway,directory:origin}}}));
    s.rt=runtimeOf(home,s.soul);s.p=(await run(process.execPath,[DAEMON,'--home',home,'--soul',s.soul,'--pkg',pkg],true,{cwd:s.rt.dir})).p;daemons.push(s);
    await until(async()=>{try{return(await request(s.rt.socket,{op:'status'})).connected;}catch{return false;}});
    const joined=await cli(s.soul,'act','life:join');reports.lastJoin=joined;save();assert.equal(joined.ok,true);assert.equal(joined.sent,true);
    await until(async()=>{const st=await request(s.rt.socket,{op:'status'});return st.connected&&!st.syncing&&st.answered>=1&&st.unanswered.length===0&&typeof st.hearing==='string'&&st.hearing!==s.id&&st.viewGrants>0;});
  }
  stage('three-real-c3-joins');
  const records=copy=>{const out=[],todo=Object.values(JSON.parse(copy.roots())),seen=new Set();while(todo.length){const h=todo.pop();if(seen.has(h))continue;seen.add(h);const raw=copy.record(h);assert.ok(raw,'all canonical copy records held');const m=decode(raw);out.push({hash:h,raw,m});for(const c of m.get(10)??[])todo.push(Buffer.from(c).toString('hex'));}return out;};
  const bodyIn=(rs,s)=>{const own=rs.find(({m})=>(m.get(9)??[]).some(([,l])=>String(l.get(1)).split('@')[0]==='souls:body-of'&&idText(l.get(2)[1])===s.id));assert.ok(own,'authoritative body-of exists');const pose=own.m.get(7);assert.ok(pose instanceof Map,'actual committed body pose exists');return{id:idText(own.m.get(1)),frame:idText(pose.get(1)[0]),point:pose.get(2)};};
  for(const s of seats){const copy=await s.observer.snapshot();s.body=bodyIn(records(copy),s);assert.equal((await request(s.rt.socket,{op:'status'})).hearing,s.body.id,'daemon follows its actual C3 body');}
  const [a,b,c]=seats;
  assert.ok(seats.every(s=>s.body.frame===a.body.frame));
  const beforePoint=c.body.point;
  const targetPoint=recoveredSource?[a.body.point[0],a.body.point[1],a.body.point[2]+1500000]:[20000000,0,21000000];
  if(recoveredSource){for(const s of seats){assert.ok(s.body.point[0]>=-21000000&&s.body.point[0]<=-19000000&&s.body.point[2]>=-21000000&&s.body.point[2]<=-19000000,'actual first-ring C3 body is in the reviewed clear patch');}assert.ok(targetPoint[0]>=-22000000&&targetPoint[0]<=-18000000&&targetPoint[2]>=-22000000&&targetPoint[2]<=-17000000);}
  reports.initialBodies=seats.map(s=>s.body);reports.walkTarget=targetPoint;save();
  const walked=await request(c.rt.socket,{op:'act',verb:'eden:walk',target:c.body.frame,params:{1:targetPoint}});reports.walkReply=walked;reports.walkReads=[];save();assert.equal(walked.ok,true);assert.equal(walked.sent,true);
  const walkAnswers=[],walkBegan=performance.now();let readBytes=0;
  await until(async()=>{const r=await request(c.rt.socket,{op:'read'});readBytes+=Buffer.byteLength(JSON.stringify(r));assert.ok(reports.walkReads.length<256&&readBytes<=1024*1024,'finite complete private read ledger');reports.walkReads.push({ms:Math.round(performance.now()-walkBegan),reply:r});save();walkAnswers.push(...(r.events??[]).filter(e=>e.kind==='answer'&&e.sequence===walked.sequence));return walkAnswers.some(e=>e.answer===1||e.answer===4||e.answer===2);},10_000);
  reports.walkAnswers=walkAnswers;save();
  assert.ok(walkAnswers.some(e=>e.answer===1||e.answer===4),'ordinary walk resolved successfully');assert.ok(!walkAnswers.some(e=>e.answer===2),'ordinary walk was not refused');
  const looked=await request(c.rt.socket,{op:'look'});reports.walkLook=looked;save();
  assert.equal(looked.ok,true);assert.ok(!looked.stale&&!looked.gap,'ordinary look refreshed the authorized copy');
  assert.ok(looked.at>=Math.max(...walkAnswers.map(e=>sequenceOf(e.version))),'look includes the actual walk answer version');
  const moved=await c.observer.snapshot();reports.structuralBody=bodyIn(records(moved),c);save();
  // Bodies are committed in K4 field 4, not written back into the structural R5 tree.
  const logPath=join(world,'log');assert.ok(lstatSync(logPath).size<=64*1024*1024,'bounded owned K4 log');
  const log=readFileSync(logPath);assert.ok(log.length>=32&&log.length<=64*1024*1024);
  const crc=bytes=>{let n=0xffffffff;for(const byte of bytes){n^=byte;for(let k=0;k<8;k++)n=n&1?(n>>>1)^0x82f63b78:n>>>1;}return(n^0xffffffff)>>>0;};
  assert.equal(log.subarray(0,8).toString(),'souls-lg');assert.equal(log.readUInt32LE(8),1);
  assert.equal(log.readUInt32LE(12),0);assert.equal(log.readUInt32LE(24),0);
  const expectedEpoch=recoveredSource?decode(readFileSync(join(world,'header'))).get(5):1;
  assert.equal(log.readBigUInt64LE(16),BigInt(expectedEpoch));
  const salt=log.readUInt32LE(28);assert.equal(crc(log.subarray(0,28)),salt,'K4 header checksum');
  const parts=[];let at=32,previous=salt,recordCount=0;
  while(at<log.length){
    assert.ok(at+12<=log.length,'complete K4 record head');const length=log.readUInt32LE(at);
    assert.ok(length>0&&length<=64*1024*1024&&at+12+length<=log.length,'complete bounded K4 record');
    assert.equal(log.readUInt32LE(at+4),previous,'K4 previous-checksum chain');
    const seed=Buffer.alloc(4);seed.writeUInt32LE(salt);const bytes=log.subarray(at+12,at+12+length);
    const checksum=log.readUInt32LE(at+8);assert.equal(crc(Buffer.concat([seed,log.subarray(at,at+8),bytes])),checksum,'K4 record checksum');
    const part=decode(bytes);assert.ok(part instanceof Map,'actual K4 CBOR record');
    if(!part.has(0))parts.push({part,record:recordCount});else assert.equal(part.get(0),'souls:input');
    previous=checksum;at+=12+length;recordCount++;
  }
  const matches=[];
  for(const entry of parts)for(const row of entry.part.get(3)??[]){
    const intent=row.get(5),actor=intent?.get(1);
    if(row.get(2)===walked.sequence&&intent?.get(2)==='eden:walk'&&actor?.get(1)===1&&idText(actor.get(2))===c.id)matches.push({...entry,row,intent});
  }
  assert.equal(matches.length,1,'one durable answer for this actual principal and sequence');
  const committed=matches[0],intent=committed.intent,answer=decode(committed.row.get(4)),receipt=answer.get(2);
  assert.equal(intent.get(5),walked.sequence);assert.equal(idText(intent.get(3)),c.body.frame);
  assert.deepEqual(intent.get(4).get(1),targetPoint,'same actual signed target');
  assert.equal(receipt.get(2),walked.sequence);assert.equal(receipt.get(3),1);assert.equal(receipt.get(1).get(1),1);assert.equal(idText(receipt.get(1).get(2)),c.id);
  assert.deepEqual(answer.get(1),decode(Buffer.from(walkAnswers.find(e=>e.answer===1).version,'hex')),'durable and actual client receipt version');
  const intentId=idText(committed.row.get(3));assert.equal(idText(receipt.get(4)),intentId);
  const events=[],poses=[];
  for(const entry of parts.filter(x=>x.record<=committed.record)){
    for(const row of entry.part.get(4)??[])if(idText(row[0])===c.body.id)poses.push({id:c.body.id,frame:idText(row[1].get(1)[0]),point:row[1].get(2)});
    for(const effect of entry.part.get(2)??[]){const cause=effect.get(3);if(cause?.get(1)!==1||idText(cause.get(2))!==intentId)continue;
      assert.equal(effect.get(4).get(1),1);assert.equal(idText(effect.get(4).get(2)),c.id);
      for(const event of effect.get(8)??[])if(['souls:move-started','souls:move-ended'].includes(event.get(1)))events.push({name:event.get(1),fields:event.get(2)});
    }
  }
  assert.deepEqual(events.map(e=>e.name),['souls:move-started','souls:move-ended']);
  for(const e of events)assert.equal(idText(e.fields.get(1)),c.body.id,'same actual joined body');
  assert.deepEqual(events[0].fields.get(3),beforePoint);assert.equal(idText(events[0].fields.get(6)),c.body.frame);
  const end=events[1].fields;assert.equal(Buffer.from(end.get(2)).toString(),'done');assert.ok(poses.length>1,'actual committed body motion rows');
  c.body=poses.at(-1);assert.equal(c.body.frame,idText(end.get(4)));assert.deepEqual(c.body.point,end.get(3),'last committed BODIES row agrees with move-ended');
  reports.commit={logSha256:hash(log),bytes:log.length,records:recordCount,bodyRows:poses.length,answeredRecord:committed.record};reports.finalBody=c.body;save();
  assert.equal(c.body.frame,a.body.frame,'the actual body remains on the target ground frame');
  assert.notDeepEqual(c.body.point,beforePoint,'the controller committed actual motion');
  // skills/src/route.rs AT_SPOT: a point walk arrives within the existing 50 mm contract.
  const distance=Math.hypot(...c.body.point.map((v,k)=>v-targetPoint[k]));reports.arrivalDistanceMicrometers=distance;save();
  assert.ok(distance<=50_000,'the actual body arrives within the existing AT_SPOT tolerance');
  reports.pass=true;stage('ordinary-ground-walk-complete');
  console.log('served ground walk aggregate: joined=3 walked=1 same-frame-within-50mm=1');
});
