import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mkdtemp, mkdir, writeFile, readFile, rm, lstat } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { createHash } from 'node:crypto';
import { archiveRequest, operator, archiveStoreEnvironment } from './archive-world.mjs';
import { readWorldRoutes } from '../origin/world-routes.mjs';
import { updateWorldRoute } from './proxy/route-config.mjs';

const hash=bytes=>createHash('sha256').update(bytes).digest('hex');
const json=async(path,value)=>{await mkdir(resolve(path,'..'),{recursive:true});await writeFile(path,JSON.stringify(value));};
async function fixture(){
  const base=resolve('.local');await mkdir(base,{recursive:true});const dir=await mkdtemp(join(base,'w17-archive-'));
  const lineage='1'.repeat(32),scope='2'.repeat(32),founder=`${'3'.repeat(32)}:0`,creator=`${'4'.repeat(32)}:0`,id=`${lineage}-${scope}-0`;
  const binary=Buffer.from('bounded hash-pinned fixture; never executed');const build=`1220${hash(binary)}`;
  const config={format:'souls/placement/1',build,worldsRoot:join(dir,'worlds'),templates:join(dir,'templates'),library:join(dir,'library'),placement:join(dir,'protected'),backup:join(dir,'backup'),worldRoutes:join(dir,'routes/worlds.json'),routesOut:join(dir,'route-output'),portFirst:7500,portLast:7502,directory:'http://localhost:7310',originUpstream:'http://localhost:7320'};
  const world=join(config.worldsRoot,'worlds',id);
  for(const path of [world,join(world,'ckpt'),join(config.worldsRoot,'builds',build),...['archived','archives','requests'].map(p=>join(config.placement,p))])await mkdir(path,{recursive:true});
  await json(join(world,'world.json'),{name:id,creator:founder.replace(':','-')});await writeFile(join(world,'facts.json'),'public fixture facts');await writeFile(join(world,'log'),'canonical-source-placeholder; focused lifecycle test only');await writeFile(join(world,'ckpt','0'),'checkpoint-placeholder; never replayed');
  await writeFile(join(world,'tokens'),'owned hash fixture');await writeFile(join(config.worldsRoot,'builds',build,'worldd'),binary);
  await json(join(config.placement,'authority.json'),{format:'souls/world-authority/1',worldsRoot:config.worldsRoot,worlds:{garden:{instance:id,lineage,zone:`${scope}:0`,creator:founder,port:7500}}});
  const route={gateway:'http://127.0.0.1:7500',stream:`/s/w/${id}/views/public/`,history:`/s/w/${id}/history/`,canonical:true};
  await json(config.worldRoutes,{schema:'souls/world-routes/1',worlds:{garden:route,'old-garden':route,other:{gateway:'http://127.0.0.1:7501',stream:'/s/other/',canonical:false}}});
  let phase={world:'garden',lineage,zone:`${scope}:0`,founder,creator,creator_generation:1,generation:1,request:'a'.repeat(64),action:'archive',state:'archiving',build};
  const units=new Set([`worldd@${id}`,`souls-gateway@${id}`]),calls=[];let failProbe=false,failFinish=false,failAfterFinish=false;
  const getState=async(_config,args)=>{
    if(args[0]==='list')return phase.state==='active'?[]:[{...phase}];
    if(args[0]==='request')return args[1]===phase.request?{...phase}:null;
    if(args[0]==='get')return {...phase};
    if(args[0]==='restore'){if(phase.state==='archived')phase={...phase,generation:phase.generation+1,request:'b'.repeat(64),action:'restore',state:'restoring'};return {...phase};}
    if(args[0]==='recover'){assert.equal(args[2],phase.request);phase={...phase,state:'restoring'};return {...phase};}
    assert.equal(args[0],'finish');assert.equal(args[2],phase.request);if(failFinish&&phase.action==='restore')throw Error('fixture-final-cas-offline');phase={...phase,state:phase.action==='archive'?'archived':'active'};if(failAfterFinish&&phase.action==='restore')throw Error('fixture-final-reply-lost');return {...phase};
  };
  const mirror=async()=>{const p=join(config.backup,'archives',id);await mkdir(resolve(p,'..'),{recursive:true});await writeFile(p,await readFile(join(config.placement,'archives',id)));};
  const probe=async()=>{assert.ok(units.has(`worldd@${id}`));assert.ok(units.has(`souls-gateway@${id}`));if(failProbe)throw Error('fixture-probe-offline');};
  const options={getState,mirror,probe,run:async(program,args)=>{
    assert.equal(program,'/usr/bin/systemctl');calls.push([...args]);
    if(args[0]==='stop'){units.delete(args[1]);return;}
    if(args[0]==='show')return `ActiveState=${units.has(args[1])?'active':'inactive'}\nMainPID=${units.has(args[1])?'123':'0'}\n`;
    assert.equal(args[0],'start');
    if(args[1]==='souls-place.service'){await archiveRequest(config,phase.request,options);return;}
    if(args[1]==='souls-routes.service')return;
    assert.ok([`worldd@${id}`,`souls-gateway@${id}`].includes(args[1]));units.add(args[1]);
  }};
  const immutable=Object.fromEntries(await Promise.all(['world.json','facts.json','log','tokens'].map(async name=>[name,hash(await readFile(join(world,name)))])));
  return {config,dir,world,id,options,calls,units,immutable,set founder(value){phase={...phase,founder:value};},nextOwnerArchive(){phase={...phase,creator:`${'5'.repeat(32)}:0`,creator_generation:2,generation:1,request:'d'.repeat(64),action:'archive',state:'archiving'};},get phase(){return phase;},set failProbe(value){failProbe=value;},set failFinish(value){failFinish=value;},set failAfterFinish(value){failAfterFinish=value;}};
}
async function unchanged(f){for(const[name,expected]of Object.entries(f.immutable))assert.equal(hash(await readFile(join(f.world,name))),expected,name);}

test('W17 exact current-owner identity stops both units, retains aliases and repeats without deleting data',async()=>{
  const f=await fixture();try{
    const other=readWorldRoutes(f.config.worldRoutes).other;
    const founder=f.phase.founder;f.founder=`${'6'.repeat(32)}:0`;await assert.rejects(archiveRequest(f.config,f.phase.request,f.options),/authority-mismatch/);assert.equal(f.calls.length,0);f.founder=founder;
    assert.equal(await archiveRequest(f.config,f.phase.request,f.options),true);assert.equal(f.phase.state,'archived');assert.equal(f.units.size,0);
    assert.equal((await lstat(join(f.config.placement,'archived',f.id))).mode&0o777,0o640);
    const routes=readWorldRoutes(f.config.worldRoutes);assert.equal(routes.garden.archived,true);assert.equal(routes['old-garden'].archived,true);assert.deepEqual(routes.other,other);
    assert.equal(await archiveRequest(f.config,f.phase.request,f.options),true);await unchanged(f);
    assert.deepEqual(JSON.parse(await readFile(join(f.config.backup,'archives',f.id))),JSON.parse(await readFile(join(f.config.placement,'archives',f.id))));
    const before=f.calls.length;assert.equal(await archiveRequest(f.config,'c'.repeat(64),f.options),false);assert.equal(f.calls.length,before,'stale inbox has no privileged action');
  }finally{await rm(f.dir,{recursive:true,force:true});}
});

test('W17 failed restore re-fences and stops both; repeated operator restores exact identity from validated backup',async()=>{
  const f=await fixture();try{
    await archiveRequest(f.config,f.phase.request,f.options);
    await assert.rejects(operator(f.config,['restore','garden'],{...f.options,uid:501}),/root-only/);
    await rm(join(f.config.placement,'archives',f.id));f.failProbe=true;
    await assert.rejects(operator(f.config,['restore','garden'],{...f.options,uid:0}),/probe-offline/);
    assert.equal(f.phase.state,'restoring');assert.equal(f.units.size,0);assert.equal(readWorldRoutes(f.config.worldRoutes).garden.archived,true);
    assert.ok((await lstat(join(f.config.placement,'archived',f.id))).isFile());await unchanged(f);
    f.failProbe=false;f.failFinish=true;
    await assert.rejects(operator(f.config,['restore','garden'],{...f.options,uid:0}),/final-cas-offline/);
    assert.equal(f.phase.state,'restoring');assert.equal(f.units.size,0);assert.equal(readWorldRoutes(f.config.worldRoutes).garden.archived,true);
    f.failFinish=false;f.failAfterFinish=true;
    await assert.rejects(operator(f.config,['restore','garden'],{...f.options,uid:0}),/final-reply-lost/);
    assert.equal(f.phase.state,'restoring');assert.equal(f.units.size,0);assert.equal(readWorldRoutes(f.config.worldRoutes).garden.archived,true);
    f.failAfterFinish=false;assert.deepEqual(await operator(f.config,['restore','garden'],{...f.options,uid:0}),{restored:true,world:'garden'});
    assert.equal(f.phase.state,'active');assert.equal(f.units.size,2);assert.equal(readWorldRoutes(f.config.worldRoutes)['old-garden'].archived,false);
    const calls=f.calls.length;assert.deepEqual(await operator(f.config,['restore','garden'],{...f.options,uid:0}),{restored:true,world:'garden'});assert.equal(f.calls.length,calls);
    await unchanged(f);
    const prior=JSON.parse(await readFile(join(f.config.placement,'archives',f.id)));
    f.nextOwnerArchive();assert.equal(f.phase.generation,prior.generation,'handoff removes the prior active row; operation generation restarts');
    assert.notEqual(f.phase.creator,prior.creator);
    await archiveRequest(f.config,f.phase.request,f.options);
    const current=JSON.parse(await readFile(join(f.config.placement,'archives',f.id)));
    assert.equal(current.creator,f.phase.creator);assert.equal(current.creator_generation,2);assert.equal(current.generation,1);
    assert.equal(f.phase.state,'archived');assert.equal(f.units.size,0);await unchanged(f);
  }finally{await rm(f.dir,{recursive:true,force:true});}
});

test('W17 missing data or occupied address refuses restore before CAS/start and preserves foreign route',async()=>{
  const f=await fixture();try{
    await archiveRequest(f.config,f.phase.request,f.options);const request=f.phase.request;
    await rm(join(f.world,'facts.json'));await assert.rejects(operator(f.config,['restore','garden'],{...f.options,uid:0}),{code:'ENOENT'});
    assert.equal(f.phase.state,'archived');assert.equal(f.phase.request,request);assert.equal(f.units.size,0);
    await writeFile(join(f.world,'facts.json'),'public fixture facts');
    await updateWorldRoute(f.config.worldRoutes,'old-garden',{gateway:'http://127.0.0.1:7502'});
    const foreign=readWorldRoutes(f.config.worldRoutes)['old-garden'];await assert.rejects(operator(f.config,['restore','garden'],{...f.options,uid:0}),/address-occupied/);
    assert.deepEqual(readWorldRoutes(f.config.worldRoutes)['old-garden'],foreign);assert.equal(f.phase.state,'archived');await unchanged(f);
  }finally{await rm(f.dir,{recursive:true,force:true});}
});


test('W17 private supervisor Store selection uses fixed trusted files, exact precedence and no caller environment',async()=>{
  const config={worldsRoot:'/var/lib/souls/worlds'},first='/etc/souls/directory.args',second='/etc/souls/secrets.env';
  let files={
    [first]:"DIRECTORY_STORE_URL=s3:https://store.example.invalid/bucket/old\nAWS_ACCESS_KEY_ID=first\nAWS_SECRET_ACCESS_KEY=first-secret\nPATH=/untrusted\nCLERK_SECRET_KEY=never-forward\n",
    [second]:"DIRECTORY_STORE_URL='s3:https://store.example.invalid/bucket/current'\nAWS_ACCESS_KEY_ID=second\nAWS_SECRET_ACCESS_KEY=second-secret\nAWS_DEFAULT_REGION=auto\n",
  };
  let untrusted=null,symlink=null;const loaded=[];
  const io={inspect:async file=>{if(file!=='/etc/souls'&&!(file in files))throw Object.assign(Error('missing'),{code:'ENOENT'});return {uid:0,mode:file===untrusted?0o666:0o640,isFile:()=>file!== '/etc/souls',isDirectory:()=>file==='/etc/souls',isSymbolicLink:()=>file===symlink};},load:async file=>{assert.ok([first,second].includes(file));loaded.push(file);if(!(file in files))throw Object.assign(Error('missing'),{code:'ENOENT'});return Buffer.from(files[file]);}};
  assert.deepEqual(await archiveStoreEnvironment(config,io),{DIRECTORY_STORE_URL:'s3:https://store.example.invalid/bucket/current',AWS_ACCESS_KEY_ID:'second',AWS_SECRET_ACCESS_KEY:'second-secret',AWS_DEFAULT_REGION:'auto'});
  assert.deepEqual(loaded,[first,second]);
  files={[first]:'DIRECTORY_STORE_ENDPOINT=https://store.example.invalid\nDIRECTORY_STORE_BUCKET=bucket\nDIRECTORY_STORE_REGION=auto\nDIRECTORY_STORE_ACCESS_KEY_ID=legacy-id\nDIRECTORY_STORE_SECRET_ACCESS_KEY=legacy-secret\nDIRECTORY_STORE_PREFIX=worlds/\n',[second]:'DIRECTORY_STORE_URL=\nDIRECTORY_STORE_PREFIX=\n'};
  const legacy=await archiveStoreEnvironment(config,io);assert.equal(legacy.DIRECTORY_STORE_URL,'');assert.equal(legacy.DIRECTORY_STORE_PREFIX,'');assert.equal(legacy.DIRECTORY_STORE_ACCESS_KEY_ID,'legacy-id');
  files={[first]:'DIRECTORYD_WORLD_STORE=/var/lib/souls/worlds/directory\n',[second]:'# no remote store\n'};
  const oldCaller=process.env.DIRECTORY_STORE_URL;
  try {process.env.DIRECTORY_STORE_URL='s3:https://caller.example.invalid/wrong';assert.deepEqual(await archiveStoreEnvironment(config,io),{});}
  finally {if(oldCaller===undefined)delete process.env.DIRECTORY_STORE_URL;else process.env.DIRECTORY_STORE_URL=oldCaller;}

  delete files[second];assert.deepEqual(await archiveStoreEnvironment(config,io),{});
  files[second]='DIRECTORYD_WORLD_STORE=/wrong/folder\n';await assert.rejects(archiveStoreEnvironment(config,io),/store-mismatch/);
  for(const malformed of ['DIRECTORY_STORE_URL broken','DIRECTORY_STORE_URL=s3:https://store.example.invalid/bucket\nDIRECTORY_STORE_URL broken',"DIRECTORY_STORE_URL='unterminated",'export DIRECTORY_STORE_URL=s3:https://store.example.invalid/bucket','DIRECTORY_STORE_URL=s3:https://store.example.invalid/bucket\\\ncontinued',"OTHER='prefix\nDIRECTORY_STORE_URL=s3:https://store.example.invalid/bucket\n'"]) {
    files[second]=malformed;await assert.rejects(archiveStoreEnvironment(config,io),/store-settings/);
  }
  files[second]='';untrusted=second;await assert.rejects(archiveStoreEnvironment(config,io),/store-untrusted/);untrusted=null;symlink=second;await assert.rejects(archiveStoreEnvironment(config,io),/store-untrusted/);
});
