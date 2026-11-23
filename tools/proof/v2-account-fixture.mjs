// Fixed native-v2 account proof recipe. Private artifact receipts are pinned by the attempt wrapper.
import { isMain } from '../lib/is-main.mjs';
import { createHash } from 'node:crypto';
import { spawn, execFileSync } from 'node:child_process';
import { mkdirSync, readFileSync, writeFileSync, openSync, closeSync, lstatSync } from 'node:fs';
import { basename, isAbsolute, join, relative, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { createConnection } from 'node:net';
import { checkPort, portFree } from '../../e2e/local-smoke.mjs';

const hash = bytes => createHash('sha256').update(bytes).digest('hex');
const fail = name => { throw Error(`proof.v2-account-${name}`); };
const inside = (root, file) => { const p=relative(root,resolve(root,file)); if (!p || p==='..' || p.startsWith('../') || isAbsolute(p)) fail('artifact-path'); return resolve(root,file); };
const read = file => JSON.parse(readFileSync(file,'utf8'));
const proofFiles = new Set(['tools/proof/owned-attempt.mjs','tools/proof/owned-attempt.test.mjs','tools/proof/v2-account-fixture.mjs','tools/proof/drivers/v2-account-login.mjs','docs/testing/e2e.md']);

/** No commands, URLs, profiles or mutable data roots can be selected by this recipe. */
export function verifyAccountArtifacts(checkout, pin) {
  if (!pin?.file || !/^[a-f0-9]{64}$/.test(pin.hash)) fail('artifact-pin');
  const file=inside(checkout,pin.file);
  if (hash(readFileSync(file))!==pin.hash) fail('artifact-pin');
  const manifest=read(file);
  if (manifest.schema!=='v2-account-proof-artifacts/1' || !/^[a-f0-9]{40}$/.test(manifest.sourceHead)) fail('artifact-schema');
  const changed=execFileSync('git',['-C',checkout,'diff','--name-only',manifest.sourceHead,'HEAD'],{encoding:'utf8'}).trim().split('\n').filter(Boolean);
  if (changed.some(path=>!proofFiles.has(path))) fail('artifact-source-difference');
  for (const [path,expected] of Object.entries(manifest.source)) if(hash(readFileSync(inside(checkout,path)))!==expected) fail('artifact-source');
  for (const required of ['v2/crates/directoryd/src/pairing/account.rs','v2/crates/gatewayd/src/control.rs','v2/web/src/pairing/card.ts','v2/client/src/account/account.mjs']) if(!manifest.source[required]) fail('artifact-source-missing');
  for (const name of ['directoryd','gatewayd']) {
    const binary=manifest.bins?.[name];
    if (!binary || basename(binary.path)!==name || hash(readFileSync(inside(checkout,binary.path)))!==binary.hash) fail('binary');
  }
  for (const [path,expected] of Object.entries(manifest.web.files)) if(hash(readFileSync(inside(inside(checkout,manifest.web.path),path)))!==expected) fail('web');
  for(const file of ['src/pairing/card.html','src/account/index.html']) if(!manifest.web.files[file]) fail('web-missing');
  if (basename(manifest.caddy.path)!=='caddy' || hash(readFileSync(manifest.caddy.path))!==manifest.caddy.hash) fail('caddy');
  return manifest;
}

export async function startV2AccountFixture({ checkout, data, log, port, artifacts, signal, onSpawn, timeoutMs = 30_000 }) {
  if(!Number.isSafeInteger(timeoutMs)||timeoutMs<=0||timeoutMs>30_000)fail('boot-timeout-value');
  const until=Date.now()+timeoutMs;const remaining=()=>{signal?.throwIfAborted();const left=until-Date.now();if(left<=0)fail('readiness-timeout');return left;};
  const root=resolve(checkout), target=resolve(data), manifest=verifyAccountArtifacts(root,artifacts);remaining();
  const ports=[port,port+1,port+2,port+3];
  for(const value of ports){remaining();checkPort(value);if(!await portFree(value))fail('occupied-port');remaining();}
  const [publicPort,directoryPort,gatewayPort,originPort]=ports;
  const base=`http://127.0.0.1:${publicPort}`, instance=`${'01'.repeat(16)}-${'02'.repeat(16)}-0`;
  const world=join(target,'worlds',instance), tokens=join(world,'tokens');
  mkdirSync(world,{recursive:true,mode:0o700});mkdirSync(join(target,'public'),{mode:0o700});mkdirSync(join(target,'slugs'),{mode:0o700});mkdirSync(join(target,'tmp'),{mode:0o700});
  // All native children use their own data cwd; this complete relative socket path stays below SUN_LEN.
  const socket=relative(target,join(world,'ctl.sock'));if(Buffer.byteLength(socket)>=104)fail('socket-length');
  writeFileSync(tokens,'',{mode:0o600});
  const authority=join(target,'authority.json'), routes=join(target,'routes.json');
  writeFileSync(authority,JSON.stringify({format:'souls/world-authority/1',worldsRoot:target,worlds:{garden:{instance,creator:`${'03'.repeat(16)}:0`}}}),{mode:0o600});
  writeFileSync(routes,JSON.stringify({schema:'souls/world-routes/1',worlds:{garden:{gateway:`http://127.0.0.1:${gatewayPort}`,stream:'/s/unused/',canonical:false}}}),{mode:0o600});
  const children=[], env={...process.env,BRAIN_MODE:'fake',TMPDIR:join(target,'tmp')};
  const launch=(file,args,extra={})=>{
    remaining();const fd=openSync(log,'a',0o600);let child;
    try{child=spawn(file,args,{cwd:target,env:{...env,...extra},stdio:['ignore',fd,fd]});children.push(child);onSpawn(child);}finally{closeSync(fd);}
    return child;
  };
  launch(inside(root,manifest.bins.directoryd.path),['--listen',`127.0.0.1:${directoryPort}`,'--public-url',base,'--store',join(target,'accounts.db'),'--pairing',join(target,'pairing.db'),'--test-sign-in'],{DIRECTORYD_AUTHORITY_MAP:authority});
  launch(inside(root,manifest.bins.gatewayd.path),['--listen',`127.0.0.1:${gatewayPort}`,'--world','world.sock','--tokens',relative(target,tokens),'--build','1220'+'00'.repeat(32)]);
  const originConfig=join(target,'origin.json');writeFileSync(originConfig,JSON.stringify({root,port:originPort,web:inside(root,manifest.web.path),data:target,routes}),{mode:0o600});
  launch(process.execPath,[join(root,'tools/proof/v2-account-fixture.mjs'),'--origin',originConfig]);
  let caddy=readFileSync(join(root,'v2/tools/ops/proxy/soul-game.caddy'),'utf8');
  caddy=caddy.replace('https://soul.game',base).replaceAll('/usr/local/lib/souls/web',inside(root,manifest.web.path)).replaceAll('/var/lib/souls-routes/slugs',join(target,'slugs')).replaceAll('/var/lib/souls-routes',join(target,'routes-unused')).replaceAll('localhost:7310',`127.0.0.1:${directoryPort}`).replaceAll('localhost:7320',`127.0.0.1:${originPort}`).replaceAll('localhost:@@PRODUCTION_PORT@@',`127.0.0.1:${originPort}`);
  // Do not let this synthetic proxy persist config/storage in any default or personal directory.
  const caddyConfig=join(target,'caddy-config'),caddyData=join(target,'caddy-data'),storage=join(target,'caddy-storage');
  for(const dir of [caddyConfig,caddyData,storage])mkdirSync(dir,{mode:0o700});
  const diagnostic=`
 log {
  output stderr
  format filter {
   wrap json
   fields {
    request delete
    resp_headers delete
   }
  }
 }
 map {http.request.uri.path} {proof_route} {
  ~^/v1/agent/account(?:/|$) account-agent
  ~^/v1/account/ account-browser
  ~^/v1/pair/ pairing-api
  /pair pairing-page
  /v1/auth/config auth-config
  ~^/src/account account-page
  default other
 }
 log_append method {method}
 log_append route {proof_route}
`;
  if(!caddy.includes(base+' {'))fail('proxy-site');
  caddy=caddy.replace(base+' {',base+' {\n'+diagnostic);
  const config=join(target,'Caddyfile');writeFileSync(config,'{\n admin off\n auto_https off\n persist_config off\n storage file_system '+JSON.stringify(storage)+'\n}\n'+caddy,{mode:0o600});
  launch(manifest.caddy.path,['run','--adapter','caddyfile','--config',config],{XDG_CONFIG_HOME:caddyConfig,XDG_DATA_HOME:caddyData});
  const probe=async address=>new Promise((ok,reject)=>{
    const within=Math.min(250,remaining()),stream=createConnection(address);const abort=()=>stream.destroy(signal.reason);
    signal?.addEventListener('abort',abort,{once:true});if(signal?.aborted)abort();stream.setTimeout(within,()=>stream.destroy(Error('readiness-timeout')));
    stream.once('connect',()=>{stream.destroy();ok();});stream.once('error',reject);stream.once('close',()=>signal?.removeEventListener('abort',abort));
  });
  const get=url=>fetch(url,{signal:AbortSignal.any([signal,AbortSignal.timeout(Math.min(500,remaining()))].filter(Boolean))});
  while(Date.now()<until){
    signal?.throwIfAborted();if(children.some(c=>c.exitCode!==null||c.signalCode!==null))fail('child-exited');
    try{
      for(const endpoint of [`http://127.0.0.1:${directoryPort}`,base]){
        const response=await get(endpoint+'/v1/agent/account');
        if(response.status!==405||(await response.json()).refused!=='method')throw Error('directory-not-ready');
      }
      await probe({host:'127.0.0.1',port:gatewayPort});
      const control=lstatSync(join(target,socket));if(!control.isSocket()||(control.mode&0o777)!==0o600)throw Error('control-not-ready');
      const answer=await get(base+'/preview/w/garden/v1/bootstrap');
      if(answer.ok){const body=await answer.json();remaining();if(body.world==='garden'&&body.gateway==='/preview/w/garden/v2/ws'&&children.every(c=>c.exitCode===null&&c.signalCode===null))return {child:children[0],children,base,dataDir:target,recipe:{kind:'v2-account',checkout:root,worldURL:base+'/preview/w/garden/',gatewayURL:base.replace('http:','ws:')+'/preview/w/garden/v2/ws',control:socket}};}
    }catch(error){if(signal?.aborted)throw error;}
    await new Promise(r=>setTimeout(r,Math.min(25,remaining())));
  }
  fail('readiness-timeout');
}

// This finite child is only a read-only observation of the same owned gateway control socket.
async function waitDisconnected(config) {
  const expected=`worlds/${'01'.repeat(16)}-${'02'.repeat(16)}-0/ctl.sock`;
  if(resolve(config.data)!==process.cwd()||config.control!==expected||!/^soul-[a-f0-9]{32}-\d+$/.test(config.grant))fail('presence-input');
  const until=Date.now()+2000;let checks=0;
  while(Date.now()<until){
    const response=await new Promise((ok,reject)=>{
      let bytes=Buffer.alloc(0);const socket=createConnection(config.control);socket.setTimeout(Math.max(1,Math.min(500,until-Date.now())),()=>socket.destroy(Error('presence-timeout')));
      socket.on('connect',()=>socket.end(`presence/1 ${config.grant}\n`));socket.on('data',part=>{bytes=Buffer.concat([bytes,part]);if(bytes.length>16)socket.destroy(Error('presence-invalid'));});socket.on('error',()=>reject(Error('presence-unavailable')));socket.on('end',()=>ok(bytes.toString('utf8')));
    });checks++;
    if(response==='disconnected\n')return {ok:true,disconnected:true,checks};
    if(response!=='connected\n')fail('presence-invalid');
    await new Promise(r=>setTimeout(r,Math.max(1,Math.min(25,until-Date.now()))));
  }
  fail('presence-still-connected');
}

// Fixed entry modes only: the owned static origin, or a finite private readiness observation.
if(isMain(import.meta.url)){
  if(process.argv.length!==4)fail('entry-mode');
  if(process.argv[2]==='--wait-disconnected'){
    try{const file=inside(process.cwd(),process.argv[3]);const config=read(file);console.log(JSON.stringify(await waitDisconnected(config)));}
    catch{console.log(JSON.stringify({ok:false,code:'presence-readiness-failed'}));process.exitCode=1;}
  }else if(process.argv[2]==='--origin'){
    const c=read(process.argv[3]);const {createOrigin}=await import(pathToFileURL(join(c.root,'v2/tools/origin/origin.mjs')).href);
    const {server}=createOrigin(join(c.data,'public'),{web:c.web,data:c.data,worldRoutes:c.routes,auth:{}});
    server.listen(c.port,'127.0.0.1');
    const stop=()=>server.close(()=>process.exit(0));process.on('SIGTERM',stop);process.on('SIGINT',stop);
  }else fail('entry-mode');
}
