// Physical Safari adapter for the existing source-bound native fixture.
// Session requests follow the proven separate-request touch-down/up method.
import {spawn} from 'node:child_process';
import {createServer,request} from 'node:http';
import {createServer as tcpServer} from 'node:net';
import {writeFileSync} from 'node:fs';
import {join} from 'node:path';
import {setTimeout as delay} from 'node:timers/promises';
import {stopOwnedChild} from '../owned-attempt.mjs';

export async function freeLocalPort(){const server=tcpServer();await new Promise((ok,no)=>{server.once('error',no);server.listen(0,'127.0.0.1',ok);});const port=server.address().port;await new Promise(ok=>server.close(ok));return port;}
export function privateAddress(ip){const p=String(ip).split('.').map(Number);return p.length===4&&p.every(n=>Number.isInteger(n)&&n>=0&&n<=255)&&(p[0]===10||(p[0]===172&&p[1]>=16&&p[1]<=31)||(p[0]===192&&p[1]===168)||(p[0]===169&&p[1]===254)||(p[0]===100&&p[1]>=64&&p[1]<=127));}
// Reuses the carry-page helper's private-origin forwarding method, with bounded upstream requests.
export async function privatePhoneDoor(target,address){
 const to=new URL(target);if(to.protocol!=='http:'||!['127.0.0.1','localhost'].includes(to.hostname)||!privateAddress(address))throw Error('phone-private-origin-required');
 const server=createServer((req,res)=>{const upstream=request({host:to.hostname,port:to.port,path:req.url,method:req.method,headers:{...req.headers,host:to.host}},back=>{res.writeHead(back.statusCode??502,back.headers);back.pipe(res);});upstream.setTimeout(30000,()=>upstream.destroy());upstream.on('error',()=>{if(!res.headersSent)res.writeHead(502);res.end();});req.on('aborted',()=>upstream.destroy());req.pipe(upstream);});
 await new Promise((ok,no)=>{server.once('error',no);server.listen(0,address,ok);});return{origin:`http://${address}:${server.address().port}`,async close(){server.closeAllConnections();await new Promise(ok=>server.close(ok));}};
}
export async function separateTouch(call,points,{wait=delay,holdMs=150}={}){
 if(!Array.isArray(points)||!points.length||points.length>32||points.some(p=>!Array.isArray(p)||p.length!==2||!p.every(Number.isFinite)))throw Error('phone-touch-points');
 const pointer=actions=>({actions:[{type:'pointer',id:'finger',parameters:{pointerType:'touch'},actions}]}),move=([x,y])=>({type:'pointerMove',duration:0,origin:'viewport',x:Math.round(x),y:Math.round(y)});
 try{await call('POST','/actions',pointer([move(points[0]),{type:'pointerDown',button:0}]));await wait(holdMs);for(const p of points.slice(1)){await call('POST','/actions',pointer([move(p)]));await wait(100);}await call('POST','/actions',pointer([{type:'pointerUp',button:0}]));await wait(150);}finally{await call('DELETE','/actions');}
}
export async function openPhysicalSafari({directory,signal,requestMs=15000}){
 const port=await freeLocalPort(),driver=spawn('/usr/bin/safaridriver',['-p',String(port)],{stdio:['ignore','pipe','pipe']}),log=[];driver.stdout.on('data',b=>log.push(String(b)));driver.stderr.on('data',b=>log.push(String(b)));let session=null,closed=false;
 const call=async(method,path,body,cleanup=false)=>{const deadline=AbortSignal.timeout(requestMs),abort=signal&&!cleanup?AbortSignal.any([signal,deadline]):deadline;const response=await fetch(`http://127.0.0.1:${port}${path}`,{method,signal:abort,headers:{'content-type':'application/json'},...(body===undefined?{}:{body:JSON.stringify(body)})});const data=await response.json();if(!response.ok||data.value?.error)throw Error(`phone.${data.value?.error??response.status}: ${data.value?.message??''}`);return data.value;};
 const close=async()=>{if(closed)return;closed=true;let deleted=false,error=null;try{if(session){await call('DELETE',`/session/${session}`,undefined,true);deleted=true;}}catch(e){error=String(e);}finally{await stopOwnedChild(driver);writeFileSync(join(directory,'safari-driver.log'),log.join(''));writeFileSync(join(directory,'safari-cleanup.json'),JSON.stringify({sessionDeleted:deleted,driverExited:driver.exitCode!==null||driver.signalCode!==null,error},null,2));}if(error)throw Error(error);};
 try{
  let ready=false;for(let i=0;i<40;i++){signal?.throwIfAborted();if(driver.exitCode!==null)throw Error('phone-driver-exited');try{await call('GET','/status');ready=true;break;}catch{await delay(100,null,{signal});}}if(!ready)throw Error('phone-driver-unavailable');
  const made=await call('POST','/session',{capabilities:{alwaysMatch:{browserName:'safari',platformName:'iOS','safari:useSimulator':false}}});session=made.sessionId;if(!session)throw Error('phone-session-missing');writeFileSync(join(directory,'safari-session.json'),JSON.stringify(made,null,2));
  if(made.capabilities?.platformName!=='iOS'||made.capabilities?.['safari:useSimulator']!==false)throw Error('phone-not-physical');
  const at=`/session/${session}`,sessionCall=(method,path,body)=>call(method,at+path,body);
  await sessionCall('POST','/timeouts',{pageLoad:30000,script:10000,implicit:0});
  return{capabilities:made.capabilities,open:url=>sessionCall('POST','/url',{url}),evaluate:(script,args=[])=>sessionCall('POST','/execute/sync',{script,args}),touch:points=>separateTouch(sessionCall,points,{wait:ms=>delay(ms,null,{signal})}),async screenshot(file){writeFileSync(file,Buffer.from(await sessionCall('GET','/screenshot'),'base64'));},close};
 }catch(error){await close();throw error;}
}
