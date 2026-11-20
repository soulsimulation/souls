// Committed W15 functional proof driver. Only helper-created synthetic homes are read or changed.
import { execFile } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';

let owned;
const delay=(ms,signal)=>new Promise((ok,fail)=>{const done=()=>{clearTimeout(timer);signal?.removeEventListener('abort',abort);};const abort=()=>{done();fail(signal.reason);};const timer=setTimeout(()=>{done();ok();},ms);if(signal?.aborted)abort();else signal?.addEventListener('abort',abort,{once:true});});
const requireThat=(ok,name)=>{if(!ok)throw Error(`account-proof.${name}`);};
const secret=value=>/sacct_[A-Za-z0-9_-]+|soul-[a-f0-9]{32}-\d+\.[A-Za-z0-9_-]+/.test(value);
async function command(home,args,probe=false){
  const s=owned;s.signal.throwIfAborted();
  const result=await new Promise((ok)=>{
    const entry=probe?'tools/proof/v2-account-fixture.mjs':'v2/client/src/cli/souls.mjs';
    const child=execFile(process.execPath,[join(s.recipe.checkout,entry),...args],{cwd:probe?s.paths.data:s.recipe.checkout,env:{...process.env,SOULS_HOME:home},signal:s.signal,timeout:probe?2500:15_000,maxBuffer:1<<20},(error,stdout,stderr)=>ok({pid:child.pid??null,purpose:probe?'presence-observation':'client-command',entry,error:error?{name:error.name,code:error.code,killed:error.killed??false}:null,exitCode:child.exitCode,signal:child.signalCode,stdout,stderr}));
    s.commands.add(child);child.once('close',()=>s.commands.delete(child));
  });
  if(secret(result.stdout)||secret(result.stderr)){
    const digest=text=>createHash('sha256').update(text).digest('hex');
    writeFileSync(join(s.paths.dir,`command-secret-refusal-${++s.ordinal}.json`),JSON.stringify({code:'credential-output',stdoutBytes:Buffer.byteLength(result.stdout),stderrBytes:Buffer.byteLength(result.stderr),stdoutHash:digest(result.stdout),stderrHash:digest(result.stderr)}),{flag:'wx',mode:0o600});
    throw Error('account-proof.credential-output');
  }
  writeFileSync(join(s.paths.dir,`command-${++s.ordinal}.json`),JSON.stringify({args,...result},null,2),{flag:'wx',mode:0o600});
  requireThat(!result.signal&&!result.error?.killed&&result.error?.name!=='AbortError'&&[0,1].includes(result.exitCode),'command-abnormal-termination');
  let body;try{body=JSON.parse(result.stdout.trim());}catch{throw Error('account-proof.command-json');}
  requireThat((result.exitCode===0&&!result.error&&body.ok===true)||(result.exitCode===1&&result.error?.code===1&&body.ok===false&&typeof body.code==='string'&&body.code.length>0),'command-exit-result-mismatch');
  return body;
}
function credential(home,soul){return JSON.parse(readFileSync(join(home,'credentials.json'),'utf8')).souls[soul].garden.token;}
function memory(home,soul){const dir=join(home,'souls',soul,'memory');mkdirSync(dir,{recursive:true});const file=join(dir,'account-proof.txt');writeFileSync(file,'Synthetic local memory retained.\n');return file;}
async function ask(home,device){return command(home,['login',owned.recipe.worldURL,'--as','proof','--device',device,'--label','Account parity proof']);}
async function control(page,role,name,act){
  const until=Date.now()+10_000;
  while(Date.now()<until){
    owned.signal.throwIfAborted();const text=await page.locator('body').ariaSnapshot();
    writeFileSync(join(owned.paths.dir,`accessibility-before-${++owned.observations}.yml`),text,{flag:'wx',mode:0o600});
    if(text.includes(name))return act(page.getByRole(role,{name,exact:true}));
    await delay(25,owned.signal);
  }
  throw Error('account-proof.control-absent-from-accessibility-snapshot');
}
async function approve(page,request,person){
  requireThat(request.ok&&request.step==='approve-account','approval-request');
  const url=new URL(request.link);requireThat(url.origin===new URL(owned.base).origin&&url.pathname==='/pair','owned-approval-origin');
  await page.goto(url.href);await control(page,'textbox','Test person',input=>input.fill(person));await control(page,'button','Show the request',button=>button.click());
  await page.locator('#card').waitFor({state:'visible'});requireThat(await page.locator('#code').textContent()===request.code,'displayed-code');
  await delay(1000,owned.signal);await control(page,'checkbox','The code matches the one on my screen',input=>input.check());await control(page,'button','Approve this device',button=>button.click());
  await page.getByText('Approved. This computer can now connect to your account.',{exact:true}).waitFor();await delay(1000,owned.signal);
}
function frame(socket){return new Promise((ok,fail)=>{
  const signal=owned.signal;const clean=()=>{clearTimeout(timer);socket.removeEventListener('message',message);socket.removeEventListener('close',close);signal.removeEventListener('abort',abort);};
  const message=event=>{clean();ok(event.data);},close=()=>{clean();fail(Error('account-proof.frame-closed'));},abort=()=>{clean();fail(signal.reason);};
  const timer=setTimeout(()=>{clean();fail(Error('account-proof.frame-timeout'));},5000);socket.addEventListener('message',message);socket.addEventListener('close',close);signal.addEventListener('abort',abort,{once:true});if(signal.aborted)abort();
});}
async function authenticate(token){
  const s=owned,socket=new WebSocket(s.recipe.gatewayURL);socket.binaryType='arraybuffer';s.sockets.add(socket);socket.addEventListener('close',()=>s.sockets.delete(socket),{once:true});
  await new Promise((ok,fail)=>{const signal=s.signal,clean=()=>{clearTimeout(timer);signal.removeEventListener('abort',abort);};const abort=()=>{clean();socket.close();fail(signal.reason);};const timer=setTimeout(()=>{clean();socket.close();fail(Error('account-proof.socket-open-timeout'));},5000);socket.onopen=()=>{clean();ok();};socket.onerror=()=>{clean();fail(Error('account-proof.socket-open'));};signal.addEventListener('abort',abort,{once:true});if(signal.aborted)abort();});
  let answer=frame(socket);socket.send(s.cbor.encode(new Map([[1,1],[2,new Uint8Array()]])));await answer;
  answer=frame(socket);socket.send(s.cbor.encode(new Map([[1,token]])));const code=s.cbor.decode(new Uint8Array(await answer),{useMaps:true}).get(4);
  return {socket,code};
}
async function close(socket){
  if(socket.readyState===3){owned.sockets.delete(socket);return;}
  await new Promise((ok,fail)=>{const timer=setTimeout(()=>fail(Error('account-proof.socket-close-timeout')),5000);socket.addEventListener('close',()=>{clearTimeout(timer);ok();},{once:true});socket.close();});
}
const admitted=code=>['stream.started','stream.resumed','stream.cannot-resume'].includes(code);
export async function prepare({base,paths,recipe,signal,arm}){
  requireThat(recipe?.kind==='v2-account','fixed-native-recipe');
  owned={base,paths,recipe,signal,commands:new Set(),sockets:new Set(),ordinal:0,observations:0,homes:{}};
  for(const name of ['desktop','laptop','other','phone']){const home=join(paths.data,'homes',name);mkdirSync(home,{recursive:true,mode:0o700});owned.homes[name]=home;}
  owned.cbor=await import(pathToFileURL(join(recipe.checkout,'v2/web/node_modules/cborg/cborg.js')).href);
  owned.first=await ask(arm==='phone'?owned.homes.phone:owned.homes.desktop,arm==='phone'?'Proof phone':'Proof desktop');return {first:owned.first};
}
export async function beforeNavigation(){
  return async()=>{
    const s=owned,sockets=[...s.sockets],commands=[...s.commands];
    const results=await Promise.allSettled([
      ...sockets.map(close),
      ...commands.map(child=>new Promise((ok,fail)=>{if(!s.commands.has(child))return ok();const timer=setTimeout(()=>{child.kill('SIGKILL');fail(Error('account-proof.command-cleanup'));},2000);child.once('close',()=>{clearTimeout(timer);ok();});if(child.exitCode===null&&child.signalCode===null)child.kill('SIGTERM');})),
    ]);
    const failures=results.map((result,index)=>result.status==='rejected'?{index,kind:result.reason?.name??'Error',hash:createHash('sha256').update(String(result.reason)).digest('hex')}:null).filter(Boolean);
    writeFileSync(join(s.paths.dir,'transient-cleanup.json'),JSON.stringify({sockets:sockets.length,commands:commands.map(child=>({pid:child.pid,exitCode:child.exitCode,signal:child.signalCode})),failures,remainingSockets:s.sockets.size,remainingCommands:s.commands.size}),{flag:'wx',mode:0o600});
    requireThat(!failures.length&&!s.sockets.size&&!s.commands.size,'transient-cleanup');
  };
}
export default async function({page,arm,check,expectHttp}) {
  const s=owned,h=s.homes;
  expectHttp('/v1/auth/config',503,'Deliberately unconfigured provider on explicit plain-HTTP loopback test fixture.');
  if(arm==='phone'){
    check('phone-viewport',page.viewportSize().width<=700);
    await approve(page,s.first,'proof-owner');const result=await command(h.phone,['login','--wait','--as','proof']);check('phone-visible-approval-and-private-account-login',result.ok&&result.connected);return;
  }
  requireThat(arm==='desktop','predeclared-functional-slot');check('desktop-viewport',page.viewportSize().width>700);
  await approve(page,s.first,'proof-owner');let result=await command(h.desktop,['login','--wait','--as','proof']);check('account-login',result.ok&&result.connected);
  result=await command(h.desktop,['accounts']);check('one-connected-account-without-secret-output',result.ok&&result.accounts.length===1);
  result=await command(h.desktop,['pair',s.recipe.worldURL]);check('new-soul-no-second-code',result.ok&&result.paired&&result.memoryTransferred===false);
  const soul=result.soul,old=credential(h.desktop,soul),a=memory(h.desktop,soul),b=memory(h.laptop,soul);
  const first=await authenticate(old);check('actual-native-session',admitted(first.code));
  const second=await ask(h.laptop,'Proof laptop');await approve(page,second,'proof-owner');result=await command(h.laptop,['login','--wait','--as','proof']);check('second-computer-account-approved',result.ok);
  result=await command(h.laptop,['list','--account']);check('same-account-lists-owned-soul',result.ok&&result.souls.some(row=>row.id===`soul-${soul.slice(2)}`));
  result=await command(h.laptop,['adopt',soul,s.recipe.worldURL]);check('live-device-refusal',result.ok===false&&result.code==='soul-connected');
  result=await command(h.laptop,['adopt',soul,s.recipe.worldURL,'--move']);check('explicit-move-retains-soul',result.ok&&result.soul===soul&&result.memoryTransferred===false);
  // The normal new handshake refreshes the existing gateway token source before the older session's next message.
  const refused=await authenticate(old);check('old-credential-refused',refused.code==='token.refused');await close(refused.socket);
  let answer=frame(first.socket);first.socket.send(s.cbor.encode(new Map()));check('old-session-next-message-refused',s.cbor.decode(new Uint8Array(await answer),{useMaps:true}).get(4)==='token.refused');await close(first.socket);
  const moved=await authenticate(credential(h.laptop,soul));check('moved-credential-signs-in',admitted(moved.code));await close(moved.socket);
  const probeFile=join(s.paths.data,'presence-observation.json');writeFileSync(probeFile,JSON.stringify({data:s.paths.data,control:s.recipe.control,grant:`soul-${soul.slice(2)}`}),{flag:'wx',mode:0o600});
  result=await command(s.paths.data,['--wait-disconnected',probeFile],true);check('actual-owned-native-control-disconnected',result.ok&&result.disconnected);
  result=await command(h.laptop,['adopt',soul,s.recipe.worldURL]);check('disconnected-adoption-without-move',result.ok&&result.soul===soul);
  const outsider=await ask(h.other,'Proof other account');await approve(page,outsider,'proof-other');result=await command(h.other,['login','--wait','--as','proof']);check('other-account-login',result.ok);
  result=await command(h.other,['list','--account']);check('other-account-sees-no-owned-soul',result.ok&&result.souls.length===0);
  result=await command(h.other,['adopt',soul,s.recipe.worldURL]);check('other-account-adoption-refused',result.ok===false&&result.code==='not-yours');
  await page.goto(new URL('/src/account/',s.base).href);await control(page,'textbox','Signed in as (test sign-in)',input=>input.fill('proof-other'));await control(page,'textbox','Signed in as (test sign-in)',input=>input.press('Enter'));
  await delay(1000,s.signal);page.once('dialog',dialog=>{requireThat(dialog.message()==='Disconnect this account login? Soul credentials and memories stay where they are.','disconnect-confirmation');return dialog.accept();});await control(page,'button','Disconnect account',button=>button.click());await page.getByText('No connected agents.',{exact:true}).waitFor();await delay(1000,s.signal);
  result=await command(h.other,['list','--account']);check('browser-revocation-blocks-account',result.ok===false&&result.code==='account.revoked');
  const current=credential(h.laptop,soul);result=await command(h.laptop,['logout']);check('logout-retains-private-soul-credential',result.ok&&credential(h.laptop,soul)===current);
  check('memory-never-silently-transferred-or-overwritten',[a,b].every(file=>readFileSync(file,'utf8')==='Synthetic local memory retained.\n'));
  const retained=await authenticate(current);check('logout-does-not-revoke-soul',admitted(retained.code));await close(retained.socket);
};
