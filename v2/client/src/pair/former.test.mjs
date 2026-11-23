// A Soul of today's client paired again by its owner (Engine v2 R18, #2821): R18's `pairFormer` against the real
// directory (`directoryd` with the sign-in for test worlds), its account store holding X11's import of the Soul. The
// contract is the one `client/test/compat/frozen-world.mjs` stands in for: a request names the Soul's `former` id and
// its `world`; the owner's approval pairs the Soul X11 brought over for that former id, and only for its own account;
// the poll answers `{token, grant, former}`. Run from v2/ after `cargo build -p directoryd --locked`.

import { strict as assert } from 'node:assert';
import { spawn } from 'node:child_process';
import { createHash, randomBytes } from 'node:crypto';
import { mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { after, test } from 'node:test';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { pairFormer, upgradeHome } from '../upgrade/upgrade.mjs';

const v2 = resolve(dirname(fileURLToPath(import.meta.url)), '../../..');
const bin = process.env.DIRECTORYD ?? join(v2, 'target/debug/directoryd');
const scratch = join(v2,'..','.local','former-upgrade');mkdirSync(scratch,{recursive:true});
const dir = mkdtempSync(join(scratch, 'souls-r18-dir-'));
const store = join(dir, 'accounts.sqlite'), tokens = join(dir, 'gateway-tokens.txt');
const procs = new Set();
after(() => { for (const p of procs) p.kill(); if (!process.env.X11B_KEEP_FIXTURE) rmSync(dir, { recursive: true, force: true }); });

/** directoryd on its own store, as the switch-over runs it: its origin and a stop that waits for its exit. */
async function directoryd({storePath=store,tokensPath=tokens,pairingPath=join(dir,'pairing.sqlite')}={}) {
  const p = spawn(bin, ['--listen', '127.0.0.1:0', '--public-url', 'http://127.0.0.1:1', '--store', storePath, '--test-sign-in',
    '--pairing', pairingPath, '--gateway-tokens', tokensPath], { stdio: ['ignore', 'pipe', 'pipe'] });
  procs.add(p);
  const origin = await new Promise((ok, fail) => {
    let out = '';
    const take = (d) => { out += d; const m = /listening on (\S+)\n/.exec(out); if (m) ok(`http://${m[1]}`); };
    p.stdout.on('data', take); p.stderr.on('data', take);
    p.on('exit', (c) => fail(new Error(`directoryd ended (${c}): ${out}`)));
  });
  const stop = () => new Promise((ok) => { p.removeAllListeners('exit'); p.on('exit', ok); p.kill(); procs.delete(p); });
  return { origin, stop };
}

const post = async (origin, path, body) => {
  const r = await fetch(new URL(path, origin), { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
  return { status: r.status, body: await r.json() };
};

test('R18: the real directory pairs a former Soul as the Soul X11 brought over, for its owner only', async () => {
  // Two people sign in once, so the store knows their accounts; then, with directoryd stopped, X11 writes its import.
  let d = await directoryd();
  for (const person of ['Ada owner', 'Someone else']) assert.equal((await post(d.origin, '/v1/account/souls', { test_person: person })).status, 200);
  await d.stop();
  const db = new DatabaseSync(store);
  const account = (subject) => db.prepare('SELECT account_id FROM provider_accounts_v1 WHERE subject = ?').get(subject).account_id;
  const scope = randomBytes(16).toString('hex');
  // X11's private tables, in its shape (v2/tools/import-accounts/src/lib.rs), and its row for Ada.
  db.exec(`CREATE TABLE IF NOT EXISTS imported_souls_v1(world TEXT NOT NULL, old_soul TEXT NOT NULL, soul TEXT NOT NULL UNIQUE,
      PRIMARY KEY(world, old_soul));
    CREATE TABLE IF NOT EXISTS souls_v1(soul TEXT PRIMARY KEY, account_id TEXT NOT NULL
      REFERENCES provider_accounts_v1(account_id), name TEXT NOT NULL, description TEXT NOT NULL, family TEXT NOT NULL,
      preset TEXT NOT NULL, look TEXT NOT NULL);`);
  db.prepare('INSERT INTO imported_souls_v1(world, old_soul, soul) VALUES (?, ?, ?)').run('eden', 's_ada', `${scope}:0`);
  db.prepare('INSERT INTO souls_v1 VALUES (?, ?, ?, ?, ?, ?, ?)').run(`${scope}:0`, account('Ada owner'), 'Ada', '', 'eden:humanoid', 'default', 'ab'.repeat(32));
  db.close();
  d = await directoryd();

  // The request is checked: a former Soul names its world, and names nothing else.
  const ask = { secret_hash: 'cd'.repeat(32), device: 'studio laptop', label: 'test agent', scope: 'soul' };
  assert.deepEqual((await post(d.origin, '/v1/pair/request', { ...ask, former: 's_ada' })).body, { refused: 'world' });
  assert.deepEqual((await post(d.origin, '/v1/pair/request', { ...ask, former: 's_ada', world: 'eden', new: true })).body, { refused: 'request' });
  assert.deepEqual((await post(d.origin, '/v1/pair/request', { ...ask, former: '../x', world: 'eden' })).body, { refused: 'former' });

  // R18's client, as `souls.mjs upgrade` runs it; the owner approves from the card, signed in.
  const cards = [];
  const approve = (person) => async ({ code }) => {
    cards.push((await post(d.origin, '/v1/pair/show', { code, test_person: person })).body);
    return post(d.origin, '/v1/pair/approve', { code, confirm: true, test_person: person });
  };
  const run = (former, person) => {
    let approved;
    return pairFormer({
      directory: d.origin, world: 'eden', former, device: 'studio laptop', label: 'test agent',
      onAsk: (a) => { approved = approve(person)(a); },
      sleep: async (ms) => { await approved; await new Promise((r) => setTimeout(r, ms)); },
    }).then((got) => ({ got }), (e) => ({ refused: e.code }));
  };
  const [ada, other, nobody] = await Promise.all([run('s_ada', 'Ada owner'), run('s_ada', 'Someone else'), run('s_nobody', 'Ada owner')]);

  // The owner's approval: the Soul X11 brought over, its token, and the former id said back.
  const grant = `soul-${scope}-0`;
  assert.equal(ada.got?.grant, grant, JSON.stringify(ada));
  assert.equal(ada.got.former, 's_ada');
  assert.match(ada.got.token, new RegExp(`^${grant}\\.[0-9a-f]{64}$`));
  const hash = createHash('sha256').update(ada.got.token).digest('hex');
  assert.ok(readFileSync(tokens, 'utf8').split('\n').includes(`${grant} ${hash}`), 'the gateway knows the new token');
  assert.ok(cards.some((c) => c.former === 's_ada' && c.soul === null), 'the card names the former Soul');
  const listed = (await post(d.origin, '/v1/account/souls', { test_person: 'Ada owner' })).body.souls;
  assert.deepEqual(listed.map((s) => [s.soul, s.device, s.world]), [[grant, 'studio laptop', 'eden']]);
  // Another account, or a former id X11 did not bring over: refused by name, and no Soul is made.
  assert.deepEqual([other, nobody], [{ refused: 'unknown-soul' }, { refused: 'unknown-soul' }]);
  assert.deepEqual((await post(d.origin, '/v1/account/souls', { test_person: 'Someone else' })).body.souls, []);
  await d.stop();
});


test('R18c: actual importer and directory preserve a former Soul across distinct world names', async (t) => {
  const base=join(dir,'real-import'), backup=join(base,'backup'), out=join(base,'out');mkdirSync(join(backup,'worlds'),{recursive:true});
  const owner='acct_00000000-0000-4000-8000-00000000000a', stranger='acct_00000000-0000-4000-8000-00000000000b';
  const worldId='world-internal-7', slug='public-eden', alias='my-eden';
  // Existing import-accounts/tests/owned.rs backup shape: synthetic source rows, never imported-map fabrication.
  for(const [name,rows] of [['accounts.sqlite',[[owner,'Ada owner'],[stranger,'Someone else']]],['forks-accounts.sqlite',[]]]){
    const db=new DatabaseSync(join(backup,name));db.exec('CREATE TABLE provider_accounts_v1(account_id TEXT PRIMARY KEY,issuer TEXT,subject TEXT,created_at INTEGER)');
    for(const [id,subject]of rows)db.prepare('INSERT INTO provider_accounts_v1 VALUES (?, ?, ?, 0)').run(id,'test:local',subject);db.close();
  }
  writeFileSync(join(backup,'worlds.json'),JSON.stringify([{slug,owner}]));
  const old=new DatabaseSync(join(backup,'worlds',slug+'.db'));
  old.exec('CREATE TABLE worlds(id TEXT PRIMARY KEY); CREATE TABLE snapshots(world_id TEXT,tick INTEGER,snapshot TEXT); CREATE TABLE souls(id TEXT,world_id TEXT,owner TEXT,entity_id TEXT,name TEXT,description TEXT,retired_at INTEGER,created_at INTEGER)');
  old.prepare('INSERT INTO worlds VALUES (?)').run(worldId);
  old.prepare('INSERT INTO souls VALUES (?, ?, ?, ?, ?, ?, NULL, 0)').run('s_ada',worldId,owner,'s_ada','Ada','kept identity');old.close();
  const importer=process.env.IMPORT_ACCOUNTS??join(v2,'target/debug/import-accounts');
  await new Promise((ok,fail)=>{
    const p=spawn(importer,[backup,'--out',out,'--json'],{stdio:['ignore','pipe','pipe']});procs.add(p);let stdout='',stderr='';
    p.stdout.on('data',b=>stdout+=b);p.stderr.on('data',b=>stderr+=b);p.once('error',fail);
    p.once('exit',code=>{procs.delete(p);if(code!==0)return fail(Error('actual importer failed: '+stderr));try{assert.equal(JSON.parse(stdout).clean,true);ok();}catch(e){fail(e);}});
  });
  const imported=new DatabaseSync(join(out,'accounts.sqlite'));
  const mapped=imported.prepare('SELECT soul FROM imported_souls_v1 WHERE world=? AND old_soul=?').get(worldId,'s_ada').soul;
  const before=imported.prepare('SELECT COUNT(*) AS n FROM souls_v1').get().n;imported.close();
  let d=await directoryd({storePath:join(out,'accounts.sqlite'),tokensPath:join(base,'gateway-tokens'),pairingPath:join(base,'pairing.sqlite')});t.after(async()=>{if(d)await d.stop();});
  const url=d.origin+'/w/'+slug;
  const home=join(base,'.souls');mkdirSync(join(home,'souls','s_ada'),{recursive:true});
  writeFileSync(join(home,'config.json'),JSON.stringify({worlds:{[alias]:{url,worldId}},souls:{s_ada:{state:'active',world:alias}}}));
  writeFileSync(join(home,'credentials.json'),JSON.stringify({souls:{s_ada:{[alias]:{token:'sim_synthetic'}}}}),{mode:0o600});
  writeFileSync(join(home,'souls','s_ada','memory.txt'),'the original memory');
  const approve=person=>({code})=>post(d.origin,'/v1/pair/approve',{code,confirm:true,test_person:person});
  const crossing=async(person,world,former='s_ada')=>{
    let approved;
    return pairFormer({directory:d.origin,world,former,device:'fixture device',label:'R18c',onAsk:a=>{approved=approve(person)(a);},sleep:async(ms)=>{await approved;await new Promise(r=>setTimeout(r,ms));}}).then(got=>({got}),e=>({refused:e.code}));
  };
  assert.deepEqual(await crossing('Someone else',worldId),{refused:'unknown-soul'});
  assert.deepEqual(await crossing('Ada owner','another-world'),{refused:'unknown-soul'});
  assert.deepEqual(await crossing('Ada owner',worldId,'s_absent'),{refused:'unknown-soul'});
  let approved;
  // This isolated identity fixture has no public proxy; gateway connectivity is covered by R18d's served journey.
  const get=async(at,options)=>{assert.equal(at,url+'/v1/bootstrap');const {signal,...security}=options;assert.ok(signal instanceof AbortSignal);assert.deepEqual(security,{redirect:'error',credentials:'omit',cache:'no-store'});return Response.json({world:slug,directory:'/',gateway:'/w/'+slug+'/v2/ws'});};
  const upgraded=await upgradeHome({home,get,device:'fixture device',onAsk:a=>{approved=approve('Ada owner')(a);},sleep:async(ms)=>{await approved;await new Promise(r=>setTimeout(r,ms));}});
  const grant='soul-'+mapped.replace(':','-'),id='s_'+mapped.replace(':','-');
  assert.deepEqual(upgraded.souls,[{formerly:'s_ada',soul:id}]);
  assert.equal(readFileSync(join(home,'souls',id,'memory.txt'),'utf8'),'the original memory');
  const config=JSON.parse(readFileSync(join(home,'config.json')));assert.deepEqual(Object.keys(config.worlds),[alias]);assert.equal(config.worlds[alias].worldId,worldId);
  const listed=(await post(d.origin,'/v1/account/souls',{test_person:'Ada owner'})).body.souls;
  assert.deepEqual(listed.map(s=>[s.soul,s.device,s.world]),[[grant,'fixture device',worldId]]);
  assert.deepEqual((await post(d.origin,'/v1/account/souls',{test_person:'Someone else'})).body.souls,[]);
  await d.stop();d=null;
  const check=new DatabaseSync(join(out,'accounts.sqlite'));assert.equal(check.prepare('SELECT COUNT(*) AS n FROM souls_v1').get().n,before,'no replacement Soul minted');check.close();
});

// X11b exercises real importer -> served owner route -> ordinary C3 join -> canonical public view/text files.
// The facts and native artifacts are the same synthetic C3 fixture closure; no legacy tokens/bodies are copied.
test('X11b: imported profiles reach the owner route and a real C3 public body', { timeout: 110_000 }, async t => {
  const base=join(dir,'x11b'), backup=join(base,'backup'), out=join(base,'import');mkdirSync(join(backup,'worlds'),{recursive:true});
  const owner='acct_00000000-0000-4000-8000-00000000000a', other='acct_00000000-0000-4000-8000-00000000000b';
  for(const [file,rows] of [['accounts.sqlite',[[owner,'Imported owner'],[other,'Other account']]],['forks-accounts.sqlite',[]]]){
    const db=new DatabaseSync(join(backup,file));db.exec('CREATE TABLE provider_accounts_v1(account_id TEXT PRIMARY KEY,issuer TEXT,subject TEXT,created_at INTEGER)');
    for(const [id,subject]of rows)db.prepare('INSERT INTO provider_accounts_v1 VALUES(?,?,?,0)').run(id,'test:local',subject);db.close();
  }
  writeFileSync(join(backup,'worlds.json'),JSON.stringify([{slug:'local',owner}]));
  const old=new DatabaseSync(join(backup,'worlds/local.db'));
  old.exec('CREATE TABLE worlds(id TEXT PRIMARY KEY); CREATE TABLE snapshots(world_id TEXT,tick INTEGER,snapshot TEXT); CREATE TABLE souls(id TEXT,world_id TEXT,owner TEXT,entity_id TEXT,name TEXT,description TEXT,retired_at INTEGER,created_at INTEGER)');
  old.exec("INSERT INTO worlds VALUES('local')");
  for(const [id,name,description,retired]of [['s_ada','Imported Ada','kept identity',null],['s_bea','Imported Bea','second identity',null],['s_gone','Retired source','not imported',1]])
    old.prepare('INSERT INTO souls VALUES(?,?,?,?,?,?,?,0)').run(id,'local',owner,id,name,description,retired);
  old.close();
  const children=[],expectedStops=new Set(),unexpectedDeaths=[];
  const healthy=()=>assert.deepEqual(unexpectedDeaths,[], 'no owned fixture child may die unexpectedly');
  const run=(path,args,ready,options={})=>new Promise((ok,fail)=>{
    const p=spawn(path,args,{cwd:base,stdio:['ignore','pipe','pipe'],...options,env:{...process.env,...options.env,BRAIN_MODE:'fake'}});
    children.push(p);procs.add(p);let output='';
    const take=b=>{output+=String(b);if(output.length>512*1024)output=output.slice(-512*1024);const m=ready instanceof RegExp?ready.exec(output):null;if(m)ok({p,m});};
    p.stdout.on('data',take);p.stderr.on('data',take);
    p.once('error',e=>{unexpectedDeaths.push({pid:p.pid,error:e.code??'spawn-error'});fail(Error('X11b owned child could not start'));});
    p.once('exit',(code,signal)=>{
      procs.delete(p);
      if(!expectedStops.has(p)&&(ready||code!==0||signal))unexpectedDeaths.push({pid:p.pid,code,signal});
      if(!ready&&code===0&&!signal)ok({p});else if(!expectedStops.has(p))fail(Error('X11b owned native child ended before readiness'));
    });
    if(ready===true)ok({p}); // its real command-socket readiness is checked separately below
  });
  const stop=async p=>{
    if(!p||p.exitCode!==null||p.signalCode!==null)return;
    expectedStops.add(p);
    const ended=ms=>new Promise(ok=>{
      let timer;const done=value=>{clearTimeout(timer);p.off('exit',exit);ok(value);},exit=()=>done(true);
      p.once('exit',exit);timer=setTimeout(()=>done(false),ms);
      if(p.exitCode!==null||p.signalCode!==null)done(true);
    });
    p.kill('SIGTERM');if(!await ended(3000)){p.kill('SIGKILL');assert.equal(await ended(2000),true,'owned child exits after bounded escalation');}
    try{process.kill(p.pid,0);assert.fail('owned child remains after exit');}catch(e){if(e.code!=='ESRCH')throw e;}
  };
  let rt,daemon;
  t.after(async()=>{
    const cleanupFailures=[];
    if(rt&&daemon?.exitCode===null&&daemon?.signalCode===null){
      expectedStops.add(daemon);
      try{await (await import('../daemon/client.mjs')).request(rt.socket,{op:'stop'},2000);}catch(e){cleanupFailures.push(e.code??'daemon-stop');}
    }
    const results=await Promise.allSettled(children.map(stop));
    writeFileSync(join(base,'owned-processes.json'),JSON.stringify({children:children.map(p=>({pid:p.pid,exit:p.exitCode,signal:p.signalCode})),unexpectedDeaths,cleanupFailures},null,2));
    assert.ok(results.every(r=>r.status==='fulfilled'),'every owned native child stopped');
    assert.deepEqual(cleanupFailures,[],'bounded daemon stop completed');healthy();
  });
  const binaries=name=>process.env[name.toUpperCase().replaceAll('-','_')]??join(v2,'target/debug',name);
  await run(binaries('import-accounts'),[backup,'--out',out,'--json']);
  const imported=new DatabaseSync(join(out,'accounts.sqlite'));
  const mapped=id=>imported.prepare('SELECT soul FROM imported_souls_v1 WHERE world=? AND old_soul=?').get('local',id)?.soul;
  const ada=mapped('s_ada'),bea=mapped('s_bea');assert.ok(ada&&bea);assert.equal(mapped('s_gone'),undefined);imported.close();
  const adaGrant='soul-'+ada.replace(':','-'),beaGrant='soul-'+bea.replace(':','-');
  const facts=process.env.X11B_FACTS??join(base,'testworld-s1-t3.facts.json');
  if(!process.env.X11B_FACTS)await run(binaries('testworld'),['--seed','1','--things','3','--out',base]);
  const world=join(base,'world');
  // The same C3 clear entry: 4 m west of a real open-ground box; first birth stands 1 m east of it.
  const box=JSON.parse(readFileSync(facts,'utf8')).things.find(t=>t.id==='box-00003'&&!t.parent);assert.ok(box);
  await run(binaries('worldd'),['seed','--facts',facts,'--dir','world','--souls','0','--at',`${(box.pose[0]-4000)/1000},${box.pose[2]/1000}`]);
  assert.equal(readFileSync(join(world,'tokens'),'utf8'),'');
  await run(binaries('worldd'),['serve','--dir','world'],/listening /);
  const gatewayProcess=await run(binaries('gatewayd'),['--listen','127.0.0.1:0','--world','world/gateway.sock','--tokens','world/tokens','--build',`1220${'ab'.repeat(32)}`],/listening (\S+)\n/);
  const gateway='ws://'+gatewayProcess.m[1]+'/v2/ws';
  const directoryArgs=['--listen','127.0.0.1:0','--public-url','http://127.0.0.1:1','--store',join(out,'accounts.sqlite'),'--test-sign-in','--pairing',join(base,'pairing.sqlite'),'--gateway-tokens',join(world,'tokens')];
  let directoryProcess=await run(bin,directoryArgs,/listening on (\S+)\n/),origin='http://'+directoryProcess.m[1];
  const beforeListingTokens=readFileSync(join(world,'tokens'),'utf8');
  const credentialRows=text=>text.split('\n').filter(line=>line.trim()&&!line.trim().startsWith('#'));
  assert.equal(credentialRows(beforeListingTokens).length,0,'directory startup creates no credential');
  const listed=async person=>(await post(origin,'/v1/account/souls',{test_person:person})).body.souls;
  const before=await listed('Imported owner');
  assert.deepEqual(before.map(s=>[s.soul,s.world,s.name,s.description]).sort(),[[adaGrant,'local','Imported Ada','kept identity'],[beaGrant,'local','Imported Bea','second identity']].sort());
  assert.ok(before.every(s=>s.device===null));assert.deepEqual(await listed('Other account'),[]);
  assert.deepEqual(await listed('Imported owner'),before);
  const pairingRead=new DatabaseSync(join(base,'pairing.sqlite'),{readOnly:true});
  assert.equal(pairingRead.prepare('SELECT COUNT(*) AS n FROM paired_souls_v1').get().n,0);pairingRead.close();
  assert.equal(readFileSync(join(world,'tokens'),'utf8'),beforeListingTokens,'listing never changes the exact token file');
  assert.equal(credentialRows(readFileSync(join(world,'tokens'),'utf8')).length,0,'listing creates no credential');
  const ask=async body=>(await post(origin,'/v1/pair/request',{secret_hash:createHash('sha256').update(randomBytes(32)).digest('hex'),device:'fixture device',label:'X11b',scope:'soul',world:'local',...body})).body;
  const wrong=await ask({former:'s_ada'});
  assert.equal((await post(origin,'/v1/pair/approve',{code:wrong.code,confirm:true,test_person:'Other account'})).body.refused,'unknown-soul');
  const direct=await ask({soul:beaGrant});
  assert.equal((await post(origin,'/v1/pair/approve',{code:direct.code,confirm:true,test_person:'Imported owner'})).body.soul,beaGrant);
  let approval;
  const paired=await pairFormer({directory:origin,world:'local',former:'s_ada',device:'fixture device',label:'X11b',onAsk:a=>{approval=post(origin,'/v1/pair/approve',{code:a.code,confirm:true,test_person:'Imported owner'});},sleep:async ms=>{await approval;await new Promise(ok=>setTimeout(ok,ms));}});
  assert.equal(paired.grant,adaGrant);
  const home=join(base,'home');mkdirSync(home,{recursive:true});const soul='s_x11b';
  writeFileSync(join(home,'config.json'),JSON.stringify({worlds:{local:{gateway,directory:origin}}}));
  writeFileSync(join(home,'credentials.json'),JSON.stringify({souls:{[soul]:{local:{token:paired.token}}}}),{mode:0o600});
  const {runtimeOf}=await import('../home/home.mjs'),{call,request,DEFAULT_PKG}=await import('../daemon/client.mjs');
  rt=runtimeOf(home,soul);const pkg=process.env.SOULS_REPLICA_PKG??DEFAULT_PKG;
  const until=async(f,ms=30_000)=>{const end=Date.now()+ms;for(;;){healthy();const value=await f();if(value)return value;if(Date.now()>end)throw Error('X11b bounded assertion timed out');await new Promise(ok=>setTimeout(ok,20));}};
  daemon=(await run(process.execPath,[join(v2,'client/src/daemon/daemon.mjs'),'--home',home,'--soul',soul,'--pkg',pkg],true,{cwd:rt.dir,env:{PATH:process.env.PATH??''}})).p;
  await until(async()=>{try{return (await request(rt.socket,{op:'status'})).connected;}catch{return false;}});
  const joined=await call(home,soul,{op:'act',verb:'life:join'},{pkg});assert.equal(joined.ok,true);
  const status=await until(async()=>{const s=await request(rt.socket,{op:'status'});assert.equal(s.pid,daemon.pid);return s.connected&&s.answered>=1&&!s.unanswered.length&&s;});
  assert.equal(status.sent,1,'the ordinary C3 join was sent once');
  const wire=await import(pathToFileURL(join(pkg,'replica.js')).href);wire.initSync({module:readFileSync(join(pkg,'replica_bg.wasm'))});
  const {decode,idText}=await import('../brief/copy.mjs'),{encode}=await import('../history/day.mjs');
  const pointers=folder=>readdirSync(folder,{withFileTypes:true}).flatMap(d=>d.isDirectory()?pointers(join(folder,d.name)):d.name==='pointer'&&folder.endsWith('/everyone')?[folder]:[]);
  const soulId=[new Uint8Array(Buffer.from(ada.split(':')[0],'hex')),Number(ada.split(':')[1])];
  const publicWords=()=>{
    for(const stream of pointers(join(world,'views'))){
      const pointer=decode(readFileSync(join(stream,'pointer')));if(!pointer.has(1))continue;
      const header=readFileSync(resolve(stream,'../../../headers',Buffer.from(pointer.get(3)).toString('hex')));
      const generation=pointer.get(8),words=new Map();
      let player,parts=stream;
      if(generation!==undefined){
        assert.ok(generation instanceof Uint8Array&&generation.byteLength===32,'actual public generation is a SHA-256 digest');
        const digest=Buffer.from(generation).toString('hex');parts=join(stream,'g',digest);
        const baseline=readFileSync(join(parts,'baseline'));
        assert.equal(createHash('sha256').update(baseline).digest('hex'),digest,'actual baseline matches the published generation');
        player=wire.StreamPlayer.fromBaseline(header,baseline);
        for(const [ref,text]of decode(readFileSync(join(parts,'baseline.text'))))if(!(ref instanceof Uint8Array))words.set(idText(ref),Buffer.from(text).toString('utf8'));
      }else player=new wire.StreamPlayer(header);
      try{
        for(let n=player.next();n<=pointer.get(1);n++){
          player.play(readFileSync(join(parts,String(n))));
          for(const [ref,text]of decode(readFileSync(join(parts,`${n}.text`))))if(!(ref instanceof Uint8Array))words.set(idText(ref),Buffer.from(text).toString('utf8'));
        }
        const links=decode(player.query(encode(new Map([[1,3],[2,soulId]]))));
        const of=links.find(l=>String(l[1]).split('@')[0]==='souls:body-of');
        if(!of)continue;
        const body=decode(player.query(encode(new Map([[1,1],[2,of[2][0]]]))));
        assert.equal(String(body.get(2)).split('@')[0],'souls:body');
        assert.deepEqual(of[2][1],soulId,'public body-of names this exact imported Soul');
        const fields=body.get(6),name=fields.get(30)?.get(21),description=fields.get(31)?.get(21);
        if(name&&description)return [words.get(idText(name)),words.get(idText(description))];
      }finally{player.free();}
    }
    return null;
  };
  const words=await until(()=>{const w=publicWords();return w?.[0]==='Imported Ada'&&w[1]==='kept identity'&&w;});
  assert.deepEqual(words,['Imported Ada','kept identity'],'actual canonical public body refs resolve via public-only text sidecars');
  assert.equal((await post(origin,'/v1/account/souls/profile',{test_person:'Imported owner',soul:adaGrant,name:'Owner edited',description:''})).status,200);
  const connected=await ask({soul:adaGrant});
  assert.equal((await post(origin,'/v1/pair/approve',{code:connected.code,confirm:true,test_person:'Imported owner'})).body.refused,'soul-connected');
  assert.equal((await post(origin,'/v1/account/souls/retire',{test_person:'Imported owner',soul:beaGrant,confirm:true})).status,200);
  await stop(directoryProcess.p);directoryProcess=await run(bin,directoryArgs,/listening on (\S+)\n/);origin='http://'+directoryProcess.m[1];
  const after=await listed('Imported owner');assert.equal(after.length,1);assert.equal(after[0].soul,adaGrant);assert.equal(after[0].name,'Owner edited');assert.equal(after[0].description,'');
  assert.deepEqual(await listed('Imported owner'),after);assert.deepEqual(await listed('Other account'),[]);
  healthy();
  console.log('X11b aggregate: imported-live=2 source-retired-excluded=1 prepair-listed=2 isolated=1 same-grants-approved=2 c3-joined=1 public-profile-fields=2 edited-restart=1 retired-hidden=1');
});
