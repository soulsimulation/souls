#!/usr/bin/env node
// W17: existing finite placement lifecycle only. Root authenticates the operator; the Souls child owns Store/data.
import { lstat, mkdir, unlink, readdir, chown } from 'node:fs/promises';
import { join, resolve, dirname } from 'node:path';
import { createHash } from 'node:crypto';
import { spawn, execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { record, beneath, data, atomic, command, checkedConfig, ready, directoryStore, readStoreSettings, STORE_KEYS } from './place-created-world.mjs';
import { readWorldRoutes } from '../origin/world-routes.mjs';
import { updateWorldRoute } from './proxy/route-config.mjs';

const REQUEST=/^[a-f0-9]{64}$/, INSTANCE=/^[a-f0-9]{32}-[a-f0-9]{32}-[0-9]+$/, SLUG=/^[a-z0-9][a-z0-9-]{0,39}$/;
const CONFIG='/etc/souls/placement.json';
const sha=bytes=>createHash('sha256').update(bytes).digest('hex');
const fail=name=>{throw Error(name);};
const same=(a,b)=>['world','lineage','zone','creator','creator_generation','generation','request','action'].every(k=>a?.[k]===b?.[k]);
const instance=phase=>`${phase.lineage}-${phase.zone.replace(':','-')}`;

async function boundedExit(child, ms) {
  let timer; const terminal=new Promise((ok,no)=>{child.once('error',no);child.once('exit',code=>ok(code));});
  try {
    const code=await Promise.race([terminal,new Promise((_,no)=>{timer=setTimeout(()=>no(Error('archive-command-deadline')),ms);})]);
    if(code!==0)fail('archive-command-refused');
  } catch(error) {
    if(child.exitCode===null&&child.signalCode===null)child.kill('SIGTERM');
    await Promise.race([terminal.catch(()=>{}),new Promise(ok=>setTimeout(ok,500))]);
    if(child.exitCode===null&&child.signalCode===null)child.kill('SIGKILL');
    await Promise.race([terminal.catch(()=>{}),new Promise(ok=>setTimeout(ok,500))]);
    throw error;
  } finally {clearTimeout(timer);}
}

async function capture(program,args,env) {
  const child=spawn(program,args,{env,stdio:['ignore','pipe','pipe']});let output='',overflow=false;child.stderr.resume();
  child.stdout.on('data',chunk=>{output+=chunk;if(output.length>1<<20){overflow=true;child.kill('SIGTERM');}});
  await boundedExit(child,15_000);if(overflow)fail('archive-command-output-invalid');return JSON.parse(output);
}
// The Souls child's supervisor reads the directory's store with the directory's settings (#1960 B7), as directoryd and
// worldd@ (both the souls user) already hold them.
export const state=async(config,args)=>capture(process.execPath,[fileURLToPath(import.meta.url),'--as-souls',...args],{PATH:'/usr/bin:/bin',BRAIN_MODE:'fake',...await readStoreSettings()});

async function identity(config,phase,store) {
  checkedConfig(config);
  if (!phase || !SLUG.test(phase.world) || !REQUEST.test(phase.request) || !INSTANCE.test(instance(phase)) || !['archive','restore'].includes(phase.action)
      || !Number.isSafeInteger(phase.generation) || phase.generation<1) fail('archive-state-invalid');
  const id=instance(phase),world=await beneath(config.worldsRoot,join(config.worldsRoot,'worlds',id));
  const metadata=JSON.parse(await data(join(world,'world.json')));
  if(metadata.name!==id)fail('archive-data-mismatch');
  const log=await lstat(await beneath(world,join(world,'log')));
  if(!log.isFile()||!log.size)fail('archive-data-missing');
  const metadataHash=sha(await data(join(world,'world.json'))),factsHash=sha(await data(await beneath(world,join(world,'facts.json')),256<<20));
  if(!/^1220[a-f0-9]{64}$/.test(phase.build))fail('archive-pin-invalid');
  const binary=await beneath(config.worldsRoot,join(config.worldsRoot,'builds',phase.build,'worldd'));
  if(`1220${sha(await data(binary,256<<20))}`!==phase.build)fail('archive-build-mismatch');
  const checkpoints=await beneath(world,join(world,'ckpt'));
  if(!(await readdir(checkpoints)).length)fail('archive-data-missing');
  const registry=JSON.parse(await data(await beneath(config.placement,join(config.placement,'authority.json'))));
  const authority=registry.worlds?.[phase.world];
  if(registry.format!=='souls/world-authority/1'||registry.worldsRoot!==config.worldsRoot||authority?.instance!==id
      ||authority.lineage!==phase.lineage||authority.zone!==phase.zone)fail('archive-authority-mismatch');
  store??=directoryStore(config,await readStoreSettings());
  const named=record(await store.get(`world-name/${phase.world}`));
  if(!(named instanceof Map)||named.get(1)?.toString('utf8')!==phase.world||named.get(2)?.toString('hex')!==phase.lineage
      ||`${named.get(3)?.[0]?.toString('hex')}:${named.get(3)?.[1]}`!==phase.zone
      ||`${named.get(4)?.[0]?.toString('hex')}:${named.get(4)?.[1]}`!==authority.creator)fail('archive-authority-mismatch');
  // Keep exact existing addresses; an alias is explicit route metadata pointing into this instance, never a guess.
  return {id,world,authority,metadataHash,factsHash,build:phase.build};
}
// A manually invoked root operator may have another primary group than the oneshot. Retain the
// protected installed directory's service group so only root writes and the Souls child can read.
async function protectedAtomic(path,value,mode=0o640) {
  const parent=await lstat(dirname(path));
  if(!parent.isDirectory()||parent.isSymbolicLink())fail('archive-protected-path-invalid');
  await atomic(path,value,mode);await chown(path,parent.uid,parent.gid);
}
async function receipt(config,id) {
  return JSON.parse(await data(await beneath(config.placement,join(config.placement,'archives',id))));
}
async function fence(config,phase) {
  const id=instance(phase),path=await beneath(config.placement,join(config.placement,'archived',id),{missing:true});
  await protectedAtomic(path,{format:'souls/archive-fence/1',instance:id,request:phase.request,generation:phase.generation},0o640);
}
async function inactive(run,id) {
  // systemctl is-active returns nonzero for inactive, so use explicit property output, never treat command failure as stopped.
  for(const unit of [`souls-gateway@${id}`,`worldd@${id}`]) {
    await run('/usr/bin/systemctl',['stop',unit]);
    const code=await run('/usr/bin/systemctl',['show',unit,'--property=ActiveState','--property=MainPID']);
    const status=typeof code==='string'?Object.fromEntries(code.trim().split('\n').map(line=>line.split('='))):{};
    if(status.ActiveState!=='inactive'||status.MainPID!=='0')fail('archive-stop-pending');
  }
}
async function system(program,args) {
  if(program==='/usr/bin/systemctl'&&args[0]==='show') {
    const child=spawn(program,args,{stdio:['ignore','pipe','pipe']});let text='';child.stdout.on('data',d=>text+=d);child.stderr.resume();
    await boundedExit(child,10_000);return text;
  }
  return command(program,args);
}
async function addresses(config,saved) {
  const current=readWorldRoutes(config.worldRoutes);
  // Validate every address before publishing any patch, and validate again inside each existing route lock.
  for(const [slug,expected]of Object.entries(saved)) {
    const row=current[slug];
    if(!row||['gateway','stream','history','canonical'].some(k=>row[k]!==expected[k]))fail('archive-address-occupied');
  }
  return current;
}
async function routes(config,saved,archived) {
  const current=await addresses(config,saved);
  for(const [slug,expected]of Object.entries(saved))await updateWorldRoute(config.worldRoutes,slug,{archived},{expected:{...expected,archived:current[slug].archived}});
}
async function checkSaved(config,phase,saved,store) {
  const actual=await identity(config,phase,store);
  if(saved.metadataHash!==actual.metadataHash||saved.factsHash!==actual.factsHash||saved.build!==actual.build)fail('archive-data-mismatch');
  if(saved.format!=='souls/world-archive/1'||saved.instance!==instance(phase)||saved.world!==phase.world
      ||saved.creator!==phase.creator||saved.creator_generation!==phase.creator_generation
      ||saved.generation!==(phase.action==='archive'?phase.generation:phase.generation-1)||!saved.routes?.[phase.world])fail('archive-receipt-mismatch');
  const expectedPrefix=`/s/w/${instance(phase)}/`;
  for(const [slug,row]of Object.entries(saved.routes))if(!SLUG.test(slug)||!row.stream.startsWith(expectedPrefix))fail('archive-address-mismatch');
}

async function retainedReceipt(config,phase,store) {
  const id=instance(phase);
  try{return await receipt(config,id);}catch(error){if(error.code!=='ENOENT')throw error;}
  const saved=JSON.parse(await data(await beneath(config.backup,join(config.backup,'archives',id))));
  await checkSaved(config,phase,saved,store);
  const current=readWorldRoutes(config.worldRoutes);
  for(const [name,row]of Object.entries(saved.routes)) {
    if(!current[name]||['gateway','stream','history','canonical'].some(key=>current[name][key]!==row[key]))fail('archive-address-occupied');
  }
  await protectedAtomic(join(config.placement,'archives',id),saved);return saved;
}

/** Same oneshot as creation, invoked only after its inbox item has been retained. */
export async function archiveRequest(config,request,{getState=state,run=system,probe=ready,mirror=mirrorReceipt,store}={}) {
  const phase=await getState(config,['request',request]);
  if(!phase)return false;
  if(!same(phase,await getState(config,['get',phase.world])))fail('archive-stale');
  if(phase.state==='active')return true;
  const id=instance(phase);if(!INSTANCE.test(id)||!REQUEST.test(phase.request))fail('archive-state-invalid');
  if(phase.action==='archive') {
    const {metadataHash,factsHash,build}=await identity(config,phase,store);
    let saved;try{saved=await receipt(config,id);}catch(e){if(e.code!=='ENOENT')throw e;}
    await fence(config,phase);
    await inactive(run,id);
    if(saved&&(saved.format!=='souls/world-archive/1'||saved.world!==phase.world||saved.instance!==id))fail('archive-receipt-mismatch');
    if(!saved||saved.generation!==phase.generation||saved.creator!==phase.creator||saved.creator_generation!==phase.creator_generation) {
      const map=readWorldRoutes(config.worldRoutes),prefix=`/s/w/${id}/`;
      const entries=Object.fromEntries(Object.entries(map).filter(([,row])=>row.stream.startsWith(prefix)));
      if(!entries[phase.world])fail('archive-address-missing');
      saved={format:'souls/world-archive/1',world:phase.world,instance:id,creator:phase.creator,creator_generation:phase.creator_generation,
        generation:phase.generation,metadataHash,factsHash,build,routes:entries};
      await protectedAtomic(join(config.placement,'archives',id),saved);
    }
    await checkSaved(config,phase,saved,store);
    await routes(config,saved.routes,true);
    await run('/usr/bin/systemctl',['start','souls-routes.service']);
    if(!same(phase,await getState(config,['get',phase.world])))fail('archive-stale');
    await mirror(config,id);
    await getState(config,['finish',phase.world,phase.request]);return true;
  }
  let saved;
  try {
    const {world}=await identity(config,phase,store);
    saved=await retainedReceipt(config,phase,store);await checkSaved(config,phase,saved,store);
    // No world output is overwritten on restore; all data/address validation precedes the first start.
    await routes(config,saved.routes,true);
    if(!same(phase,await getState(config,['get',phase.world])))fail('archive-stale');
    const fencePath=await beneath(config.placement,join(config.placement,'archived',id),{missing:true});
    await unlink(fencePath).catch(error=>{if(error.code!=='ENOENT')throw error;});
    await run('/usr/bin/systemctl',['start',`worldd@${id}`]);
    await run('/usr/bin/systemctl',['start',`souls-gateway@${id}`]);
    const registry=JSON.parse(await data(join(config.placement,'authority.json')));
    await probe(config,world,registry.worlds[phase.world].port);
    await routes(config,saved.routes,false);
    await run('/usr/bin/systemctl',['start','souls-routes.service']);
    if(!same(phase,await getState(config,['get',phase.world])))fail('archive-stale');
    await mirror(config,id);
    await getState(config,['finish',phase.world,phase.request]);return true;
  } catch(error) {
    await fence(config,phase);
    try{await inactive(run,id);if(saved)await routes(config,saved.routes,true);await run('/usr/bin/systemctl',['start','souls-routes.service']);await getState(config,['recover',phase.world,phase.request]);}
    catch{fail('archive-containment-pending');}
    throw error;
  }
}

async function mirrorReceipt(config,id) {
  await capture(process.execPath,[fileURLToPath(import.meta.url),'--as-souls','mirror',id],{PATH:'/usr/bin:/bin',BRAIN_MODE:'fake'});
}
export async function operator(config,args,{getState=state,run=system,uid=process.getuid?.(),store}={}) {
  if(uid!==0)fail('archive-root-only');
  if(args.length===1&&args[0]==='list')return getState(config,['list']);
  if(args.length!==2||args[0]!=='restore'||!SLUG.test(args[1]))fail('archive-arguments-invalid');
  let phase=await getState(config,['get',args[1]]);
  if(phase.action==='restore'&&phase.state==='active') {
    const path=await beneath(config.placement,join(config.placement,'archived',instance(phase)),{missing:true});
    let kept;try{kept=JSON.parse(await data(path));}catch(error){if(error.code!=='ENOENT')throw error;}
    if(!kept)return {restored:true,world:phase.world};
    if(kept.format!=='souls/archive-fence/1'||kept.instance!==instance(phase)||kept.request!==phase.request||kept.generation!==phase.generation)fail('archive-fence-invalid');
    phase=await getState(config,['recover',phase.world,phase.request]);
  }
  await identity(config,phase,store);
  // The saved archive generation is still current until the restore CAS below.
  const prior=await retainedReceipt(config,phase,store);await checkSaved(config,phase,prior,store);await addresses(config,prior.routes);
  phase=await getState(config,['restore',phase.world]);
  await mkdir(join(config.placement,'requests'),{recursive:false}).catch(error=>{if(error.code!=='EEXIST')throw error;});
  const {open}=await import('node:fs/promises');
  const inbox=await beneath(config.placement,join(config.placement,'requests'));
  try {const request=await open(join(inbox,phase.request),'wx',0o640);await request.sync();await request.close();}
  catch(error){if(error.code!=='EEXIST')throw error;const entry=await lstat(join(inbox,phase.request));if(!entry.isFile()||entry.isSymbolicLink())fail('archive-request-invalid');}
  await run('/usr/bin/systemctl',['start','souls-place.service']);
  const until=Date.now()+90_000;
  while(Date.now()<until) {
    const current=await getState(config,['get',phase.world]);
    if(!same(phase,current))fail('archive-stale');
    if(current.state==='active')return {restored:true,world:phase.world};
    await new Promise(ok=>setTimeout(ok,200));
  }
  fail('archive-restore-pending');
}

if(process.argv[1]&&resolve(process.argv[1])===fileURLToPath(import.meta.url)) {
  try {
    if(process.getuid?.()!==0)fail('archive-root-only');
    const stat=await lstat(CONFIG);if(!stat.isFile()||stat.isSymbolicLink()||stat.uid!==0||(stat.mode&0o022))fail('archive-config-untrusted');
    const config=JSON.parse(await data(CONFIG));checkedConfig(config);
    if(config.placement!=='/etc/souls/placement-data'||config.worldRoutes!=='/var/lib/souls/routes/worlds.json')fail('archive-config-untrusted');
    if(process.argv[2]==='--as-souls') {
      const args=process.argv.slice(3);
      const uid=Number(execFileSync('/usr/bin/id',['-u','souls'],{encoding:'utf8'}).trim()),gid=Number(execFileSync('/usr/bin/id',['-g','souls'],{encoding:'utf8'}).trim());
      if(!Number.isInteger(uid)||uid<=0||!Number.isInteger(gid)||gid<=0)fail('archive-account-invalid');
      process.setgroups([gid]);process.setgid(gid);process.setuid(uid);
      if(args[0]==='mirror'&&args.length===2&&INSTANCE.test(args[1])) {
        const kept=await receipt(config,args[1]);
        await atomic(join(config.backup,'archives',args[1]),kept);console.log('{}');
      } else {
        if(!['list','request','get','restore','finish','recover'].includes(args[0])||args.length>3)fail('archive-arguments-invalid');
        const child=spawn(join(config.library,'supervisor'),['archive-state',...args],{env:{PATH:'/usr/bin:/bin',WORLDS_ROOT:config.worldsRoot,...Object.fromEntries(STORE_KEYS.filter(k=>k in process.env).map(k=>[k,process.env[k]]))},stdio:'inherit'});
        await boundedExit(child,10_000);
      }
    } else console.log(JSON.stringify(await operator(config,process.argv.slice(2))));
  } catch(error){console.error(JSON.stringify({refused:error.message}));process.exitCode=1;}
}
