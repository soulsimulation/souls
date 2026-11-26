import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mkdtemp, mkdir, writeFile, readFile, rm, symlink, readdir } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { placeRequest, drain, prepareData, publishData, streamPath, directoryStore, storeSettings, bucketNamed } from './place-created-world.mjs';

// Canonical T0 fixture data, independent of the initializer's decoder. Actual native proof uses Rust's real records.
const cbor = value => {
  const head = (major, n) => n < 24 ? Buffer.from([major*32+n]) : Buffer.from([major*32+24,n]);
  if (typeof value === 'number') return head(0,value);
  if (Buffer.isBuffer(value)) return Buffer.concat([head(2,value.length),value]);
  if (Array.isArray(value)) return Buffer.concat([head(4,value.length),...value.map(cbor)]);
  return Buffer.concat([head(5,value.size),...[...value].flatMap(([k,v])=>[cbor(k),cbor(v)])]);
};
const json = async (file, value) => { await mkdir(resolve(file,'..'),{recursive:true}); await writeFile(file,JSON.stringify(value)); };
async function fixture() {
  const scratch = resolve('.local'); await mkdir(scratch,{recursive:true});
  const dir = await mkdtemp(join(scratch,'w3b-placement-'));
  const request = 'a'.repeat(64), lineage = '1'.repeat(32), parent = 'e'.repeat(32), creator = `${'2'.repeat(32)}:0`;
  const instance = `${lineage}-${parent}-0`;
  const config = {format:'souls/placement/1',build:`1220${'3'.repeat(64)}`,worldsRoot:join(dir,'worlds'),templates:join(dir,'templates'),library:join(dir,'library'),
    placement:join(dir,'protected'),backup:join(dir,'backup'),worldRoutes:join(dir,'routes/worlds.json'),routesOut:join(dir,'slugs'),portFirst:7500,portLast:7502,
    directory:'http://localhost:7310',originUpstream:'http://localhost:7320'};
  for (const path of [config.templates,config.library,config.backup,...['requests','status','attempts'].map(n=>join(config.placement,n))]) await mkdir(path,{recursive:true});
  const row = {name:'new-world',label:'Owner',template:'eden-2026',lineage,zone:`${parent}:0`,creator,ready:false};
  await json(join(config.worldsRoot,'directory/world-create',request),{request,row,ask:{name:row.name,label:row.label,template:row.template,creator}});
  await json(join(config.worldsRoot,'directory/world-list'),{worlds:[row]});
  await mkdir(join(config.worldsRoot,'directory/world-name'),{recursive:true});
  await writeFile(join(config.worldsRoot,'directory/world-name',row.name),cbor(new Map([[1,Buffer.from(row.name)],[2,Buffer.from(lineage,'hex')],[3,[Buffer.from(parent,'hex'),0]],[4,[Buffer.from('2'.repeat(32),'hex'),0]],[5,Buffer.from(parent,'hex')]])));
  await mkdir(join(config.templates,row.template),{recursive:true});
  await writeFile(join(config.templates,row.template,'template'),cbor(new Map([[1,Buffer.from(row.template)],[2,Buffer.from(parent,'hex')],[3,[Buffer.from(parent,'hex'),0]],[4,Buffer.alloc(34)]])));
  return {dir,request,row,instance,config};
}

test('one request resumes after publish failure and restores only its validated identity from backup',async()=>{
  const f=await fixture(); const calls=[]; let failPublish=true,failRoutes=true,activate=false;
  const marker=join(f.config.routesOut,'slugs',f.row.name);
  const options={run:async(program,args)=>{
    if(program==='/usr/bin/systemctl'){
      assert.deepEqual(args,['start','souls-routes.service']);calls.push('routes');
      if(failRoutes)throw Error('fixture-routes-offline');
      await mkdir(resolve(marker,'..'),{recursive:true});if(activate)await writeFile(marker,'');return;
    }
    assert.equal(program,'/bin/bash');assert.equal(args[1],'--configuration-only');assert.equal(args[3],f.instance);assert.equal(args[args.indexOf('--creator')+1],`${'2'.repeat(32)}-0`);calls.push('configuration');},
    asSouls:async mode=>{calls.push(mode);if(mode==='publish'&&failPublish)throw Error('fixture-publication-offline');}};
  try {
    await assert.rejects(placeRequest(f.config,f.request,options),/fixture-publication-offline/);
    const statusPath=join(f.config.placement,'status',f.request);
    assert.equal(JSON.parse(await readFile(statusPath)).ready,false);
    failPublish=false;
    await assert.rejects(placeRequest(f.config,f.request,options),/fixture-routes-offline/);
    assert.equal(JSON.parse(await readFile(statusPath)).ready,false,'failed route service cannot report ready');
    failRoutes=false;
    await assert.rejects(placeRequest(f.config,f.request,options),/placement-route-pending/);
    assert.equal(JSON.parse(await readFile(statusPath)).ready,false,'coalesced old map cannot report ready');
    await symlink(join(f.dir,'untrusted-marker'),marker);
    await assert.rejects(placeRequest(f.config,f.request,options),/placement-symlink/);
    assert.equal(JSON.parse(await readFile(statusPath)).ready,false);
    await rm(marker);activate=true;
    const ready=await placeRequest(f.config,f.request,options); assert.equal(ready.ready,true);assert.equal(ready.instance,f.instance);
    assert.deepEqual(calls.slice(0,4),['prepare','configuration','probe','publish']);
    const before=calls.length;assert.deepEqual(await placeRequest(f.config,f.request,options),ready);assert.equal(calls.length,before);
    await json(join(f.config.backup,f.request),{format:'souls/placement-backup/1',receipt:ready});
    await rm(statusPath);
    const restored=await placeRequest(f.config,f.request,options);assert.equal(restored.port,ready.port);assert.equal(restored.instance,f.instance);
    await rm(statusPath);ready.creator=`${'4'.repeat(32)}:0`;
    await json(join(f.config.backup,f.request),{format:'souls/placement-backup/1',receipt:ready});
    await assert.rejects(placeRequest(f.config,f.request,options),/placement-backup-mismatch/);
  } finally {await rm(f.dir,{recursive:true,force:true});}
});

test('mismatched owner and symlinked input refuse before privileged configuration; malformed inbox is consumed',async()=>{
  const f=await fixture();let calls=0;
  try {
    const file=join(f.config.worldsRoot,'directory/world-create',f.request),value=JSON.parse(await readFile(file));
    value.row.creator=`${'4'.repeat(32)}:0`;value.ask.creator=value.row.creator;await json(file,value);
    await assert.rejects(placeRequest(f.config,f.request,{run:async()=>{calls++;}}),/placement-owner-mismatch/);assert.equal(calls,0);
    await rm(file);await symlink(join(f.dir,'outside'),file);
    await assert.rejects(placeRequest(f.config,f.request),/placement-symlink/);
    await mkdir(join(f.config.placement,'requests','invalid-directory'));await writeFile(join(f.config.placement,'requests','invalid-file'),'untrusted data');
    await drain(f.config);assert.deepEqual(await readdir(join(f.config.placement,'requests')),[]);assert.equal((await readdir(join(f.config.placement,'attempts'))).length,2);
  } finally {await rm(f.dir,{recursive:true,force:true});}
});

test('configuration-only placement writes exact existing units without reading or changing world data',async()=>{
  const f=await fixture();
  try {
    const root=join(f.dir,'install'),outside=join(f.dir,'must-not-be-created');await mkdir(root);
    await symlink(outside,join(root,'var'));
    const script=join(import.meta.dirname,'place-world.sh');
    const args=[script,'--configuration-only','--instance',f.instance,'--creator',`${'2'.repeat(32)}-0`,'--port','7500','--build',f.config.build,'--directory','localhost:7310','--resume'];
    const result=spawnSync('/bin/bash',args,{env:{...process.env,PLACE_ROOT:root},encoding:'utf8'});
    assert.equal(result.status,0,result.stderr);
    await assert.rejects(readdir(outside),{code:'ENOENT'});
    const env=await readFile(join(root,'etc/souls',`gateway-${f.instance}.env`),'utf8');
    assert.match(env,new RegExp(`--creator ${'2'.repeat(32)}-0 --directory localhost:7310`));
    assert.match(env,new RegExp(` --entries /var/lib/souls/worlds/worlds/${f.instance}/entries `),'#3760: the gateway serves the world\'s kind entries');
    assert.match(env,/ --view-key \/etc\/souls\/view\.key /,'the gateway checks the page\'s view tokens with the install\'s key');
    assert.match(env,new RegExp(` --uploads /var/lib/souls/worlds/worlds/${f.instance}/uploads `),'#1960: the creator\'s uploads are on, kept in the world\'s folder');
    assert.match(env,/ --mailbox localhost:7310 --mailbox-key \/etc\/souls\/mailbox\.key\n$/,'R13: the owner\'s messages reach the world\'s Souls through the installed directory');
    assert.match(await readFile(join(root,'etc/souls/view.key'),'utf8'),/^[0-9a-f]{64}$/,'made once when absent: 64 hex digits');
    assert.match(await readFile(join(root,'etc/souls/mailbox.key'),'utf8'),/^[0-9a-f]{64}$/,'the mailbox key too');
    const again=spawnSync('/bin/bash',args,{env:{...process.env,PLACE_ROOT:root},encoding:'utf8'});assert.equal(again.status,0,again.stderr);
  } finally {await rm(f.dir,{recursive:true,force:true});}
});

test('public routing and private backup carry the same placed identity while preserving preview Eden',async()=>{
  const f=await fixture();
  try {
    const phase={request:f.request,...f.row,instance:f.instance,port:7500};
    const binary=Buffer.from('focused command-boundary fixture; never executed');
    await writeFile(join(f.config.library,'worldd'),binary);
    f.config.build=`1220${createHash('sha256').update(binary).digest('hex')}`;
    let forkCalls=0;
    await prepareData(f.config,phase,{run:async(program,args)=>{
      if(program===join(f.config.library,'worldd')){
        forkCalls++;assert.equal(args[0],'fork');
        assert.equal(args[args.indexOf('--through')+1],`${'2'.repeat(32)}:0`);
        assert.equal(args[args.indexOf('--scope')+1],f.row.lineage);
        await json(join(args[args.indexOf('--to')+1],'world.json'),{name:f.instance,creator:`${'2'.repeat(32)}-0`,fork:true});
      }else{assert.equal(program,'/bin/bash');assert.equal(args.at(-1),'--data-only');}
    }});
    assert.equal(forkCalls,1);assert.equal(phase.creator,f.row.creator);
    await json(join(f.config.worldsRoot,'worlds',f.instance,'views/world.json'),{stream:'views/public-stream/'});
    await json(f.config.worldRoutes,{schema:'souls/world-routes/1',worlds:{eden:{canonical:false,gateway:'http://localhost:7400',stream:'/s/eden/'}}});
    await json(join(f.config.placement,'authority.json'),{format:'souls/world-authority/1',worldsRoot:f.config.worldsRoot,worlds:{'new-world':{instance:f.instance,creator:f.row.creator}}});
    await publishData(f.config,phase);
    const routes=JSON.parse(await readFile(f.config.worldRoutes));assert.equal(routes.worlds.eden.canonical,false);assert.equal(routes.worlds['new-world'].stream,`/s/w/${f.instance}/views/public-stream/`);
    await assert.rejects(readdir(f.config.routesOut),{code:'ENOENT'},'unprivileged publisher never writes the existing route service output');
    const backup=JSON.parse(await readFile(join(f.config.backup,f.request)));assert.equal(backup.receipt.instance,f.instance);assert.equal(backup.authority.worlds['new-world'].instance,f.instance);
  } finally {await rm(f.dir,{recursive:true,force:true});}
});

// The first value is the exact nested shape emitted by a retained actual native V1 world pointer.
test('native nested stream paths retain canonical segments and refuse traversal or encoded escapes',()=>{
  const native='views/1097fa99efd1cc1cc34ea996f7157200/1097fa99efd1cc1cc34ea996f7157200-0/0/1097fa99efd1cc1cc34ea996f7157200-0/1/everyone/';
  assert.equal(streamPath(native),true);
  for(const path of ['/views/a/','views/../a/','views/./a/','views/a%2fb/','views/a/?x','views/a/#x','views//a/','views/a\\b/'])assert.equal(streamPath(path),false,path);
});

test('#1960 B7: the store is the bucket the secrets file names, else the folder; settings carry only the store keys',()=>{
  const text=['# Secrets','SOULS_BACKUP_URL=s3:https://host/backups','export DIRECTORY_STORE_URL="s3:https://host/bucket/dir"',
    "AWS_ACCESS_KEY_ID='id'",'AWS_SECRET_ACCESS_KEY=s=e=c','AWS_DEFAULT_REGION=auto','SOULS_BACKUP_KEY_FILE=/k','=x','junk'].join('\n');
  assert.deepEqual(storeSettings(text),{DIRECTORY_STORE_URL:'s3:https://host/bucket/dir',AWS_ACCESS_KEY_ID:'id',AWS_SECRET_ACCESS_KEY:'s=e=c',AWS_DEFAULT_REGION:'auto'});
  assert.equal(bucketNamed(storeSettings(text)),true);
  assert.equal(bucketNamed({DIRECTORY_STORE_URL:'  '}),false);assert.equal(bucketNamed({}),false);
  assert.equal(bucketNamed({DIRECTORY_STORE_ENDPOINT:'http://127.0.0.1:9000'}),true,'directoryd: the endpoint form names a bucket too');
});

const routed=f=>async(program,args)=>{
  if(program==='/usr/bin/systemctl'){const marker=join(f.config.routesOut,'slugs',f.row.name);await mkdir(resolve(marker,'..'),{recursive:true});await writeFile(marker,'');return;}
  f.configured=args;
};

test('#1960 B7: on a bucket, placement reads intent, name and list there, and the world is not pinned to the folder',async()=>{
  const f=await fixture();
  try {
    const folder=join(f.config.worldsRoot,'directory'),objects=new Map();
    for(const key of [`world-create/${f.request}`,`world-name/${f.row.name}`,'world-list'])objects.set(key,await readFile(join(folder,key)));
    await rm(folder,{recursive:true});
    const settings={DIRECTORY_STORE_URL:'s3:http://127.0.0.1:9/souls',AWS_ACCESS_KEY_ID:'stand-in-key'},reads=[];
    const store=directoryStore(f.config,settings,{read:async(config,key,given)=>{
      reads.push(key);assert.equal(given,settings);if(!objects.has(key))throw Object.assign(Error('absent'),{code:'ENOENT'});return objects.get(key);}});
    assert.equal(store.kind,'bucket');
    const ready=await placeRequest(f.config,f.request,{run:routed(f),asSouls:async()=>{},store});
    assert.equal(ready.ready,true);assert.equal(ready.instance,f.instance);
    assert.deepEqual(reads,[`world-create/${f.request}`,`world-name/${f.row.name}`,'world-list']);
    assert.ok(!f.configured.includes('--folder-store'),'on a bucket the world reads DIRECTORY_STORE_URL, as the directory does');
    await assert.rejects(store.get('../world-list'),/placement-store-key-invalid/);
  } finally {await rm(f.dir,{recursive:true,force:true});}
});

test('#1960 B7: on a folder store placement names the folder, and place-world.sh pins WORLDD_STORE only then',async()=>{
  const f=await fixture();
  try {
    assert.equal(directoryStore(f.config,{}).kind,'folder');
    await placeRequest(f.config,f.request,{run:routed(f),asSouls:async()=>{},store:directoryStore(f.config,{})});
    assert.ok(f.configured.includes('--folder-store'));
    const script=join(import.meta.dirname,'place-world.sh');
    for (const folder of [true,false]) {
      const root=join(f.dir,`install-${folder}`);await mkdir(root);
      const args=[script,'--configuration-only','--instance',f.instance,'--creator',`${'2'.repeat(32)}-0`,'--port','7500','--build',f.config.build,
        '--directory','localhost:7310','--resume',...(folder?['--folder-store']:[])];
      const result=spawnSync('/bin/bash',args,{env:{...process.env,PLACE_ROOT:root},encoding:'utf8'});assert.equal(result.status,0,result.stderr);
      const conf=await readFile(join(root,'etc/systemd/system',`worldd@${f.instance}.service.d/place.conf`),'utf8');
      assert.equal(conf.includes('Environment=WORLDD_STORE=/var/lib/souls/worlds/directory'),folder,conf);
    }
  } finally {await rm(f.dir,{recursive:true,force:true});}
});

// Run as souls-place.service runs it: the script is node's entry, with one request in the inbox. drain imports
// archive-world.mjs, which imports this script; with a top-level await in the entry that import never settled, Node exited
// 13 ("unsettled top-level await") and every request was set aside unplaced (26 Nov). Root and the fixed configuration
// path are stood in for by a preload (uid 0, /etc/souls/placement.json read from the fixture); the state lookup's child
// is not root, so the request is refused and kept, as a request with no readable state is.
test('as its own entry, a drain imports the archive path, refuses a request it cannot read and exits', async () => {
  const scratch = resolve('.local'); await mkdir(scratch,{recursive:true});
  const dir = await mkdtemp(join(scratch,'w3b-main-'));
  try {
    const placement = join(dir,'protected'), request = 'b'.repeat(64);
    for (const n of ['requests','attempts','status']) await mkdir(join(placement,n),{recursive:true});
    await writeFile(join(placement,'requests',request),'');
    const config = join(dir,'placement.json');
    await json(config,{format:'souls/placement/1',build:`1220${'3'.repeat(64)}`,worldsRoot:join(dir,'worlds'),templates:join(dir,'templates'),library:join(dir,'library'),
      placement,backup:join(dir,'backup'),worldRoutes:'/var/lib/souls/routes/worlds.json',routesOut:'/var/lib/souls-routes',portFirst:7500,portLast:7502,
      directory:'http://localhost:7310',originUpstream:'http://localhost:7320'});
    const preload = join(dir,'as-root.mjs');
    await writeFile(preload,`import fs from 'node:fs';\nimport { syncBuiltinESMExports } from 'node:module';\n`
      + `const CONFIG = '/etc/souls/placement.json', FIXTURE = ${JSON.stringify(config)}, { lstat, open } = fs.promises;\n`
      + `process.getuid = () => 0;\n`
      + `fs.promises.lstat = async (p, ...a) => { if (p !== CONFIG) return lstat(p, ...a); const s = await lstat(FIXTURE, ...a); s.uid = 0; s.mode &= ~0o022; return s; };\n`
      + `fs.promises.open = (p, ...a) => open(p === CONFIG ? FIXTURE : p, ...a);\nsyncBuiltinESMExports();\n`);
    const run = spawnSync(process.execPath,['--import',preload,join(import.meta.dirname,'place-created-world.mjs')],{encoding:'utf8',timeout:60_000});
    assert.notEqual(run.status,13,`unsettled top-level await: ${run.stderr}`);
    assert.doesNotMatch(run.stderr,/unsettled top-level await/i);
    assert.match(run.stderr,/placement: request refused/,'the drain reached the request and refused it');
    assert.deepEqual(await readdir(join(placement,'requests')),[],'the inbox is drained');
    assert.equal((await readdir(join(placement,'attempts'))).length,1,'the request is kept aside');
  } finally { await rm(dir,{recursive:true,force:true}); }
});
