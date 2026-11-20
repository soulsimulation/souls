import test from 'node:test';
import assert from 'node:assert/strict';
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { accountCommand, accountList, accountPair, addressOf, connectedAccounts, login } from '../account/account.mjs';
const parent=resolve('.local/w15'); mkdirSync(parent,{recursive:true});
const home=()=>mkdtempSync(join(parent,'account-'));
const json=(root,name)=>JSON.parse(readFileSync(join(root,name),'utf8'));
const grant=`soul-${'01'.repeat(16)}-0`, other=`soul-${'02'.repeat(16)}-0`;
const url='https://example.invalid/preview/w/garden/';
const response=(b,status=200)=>({ok:status===200,status,json:async()=>b});
function server() {
  let ready=false, ended=false;const sent=[];
  const get=async(at)=>response({world:'garden',directory:'/',gateway:'/preview/w/garden/v2/ws'});
  const send=async(at,opts)=>{
    const b=JSON.parse(opts.body);sent.push({at:String(at),...opts,body:b});
    assert.equal(opts.redirect,'error');assert.equal(opts.credentials,'omit');
    switch(new URL(at).pathname){
      case '/v1/agent/account/login':return response({request:{id:'aq_test',confirm:'ABCD'},approvalURL:'https://example.invalid/pair?request=aq_test',intervalSeconds:3});
      case '/v1/agent/account/requests/poll':return response(ready?{request:{status:'ready'},token:`sacct_${'a'.repeat(43)}`,account:{id:'acct_owner'}}:{request:{status:'pending'}});
      case '/v1/agent/account':return ended?response({refused:'account.revoked'},401):response({account:{id:'acct_owner'},souls:[{id:grant,name:'Test Soul',world:'garden'},{id:other,name:'Second Soul',world:'garden'}]});
      case '/v1/agent/account/pair':return response({grant:b.new?other:b.soul,token:`${b.new?other:b.soul}.${'a'.repeat(64)}`});
      case '/v1/agent/account/logout':ended=true;return response({ok:true});
      case '/v1/agent/account/requests/cancel':return response({request:{status:'cancelled'}});
      default:throw new Error('unexpected path');
    }
  };
  return {get,send,sent,ready:()=>{ready=true;}};
}
async function connected(root,s,alias='main') {
  const first=await login(root,[url,'--as',alias],s);s.ready();await login(root,['--wait','--as',alias],s);return first;
}
test('login starts once, resumes without another code, keeps secrets private and separates aliases',async()=>{
  const root=home(),s=server();try{
    const ask=await login(root,[url,'--as','main'],s);assert.equal(ask.code,'ABCD');
    const again=await login(root,[url,'--as','main'],s);assert.equal(again.link,ask.link);
    assert.equal(s.sent.filter(r=>new URL(r.at).pathname.endsWith('/login')).length,1);
    s.ready();assert.equal((await login(root,['--wait','--as','main'],s)).connected,true);
    const creds=json(root,'credentials.json'),config=json(root,'config.json');
    assert.equal(statSync(join(root,'credentials.json')).mode&0o777,0o600);
    assert.equal(statSync(root).mode&0o777,0o700);
    assert.ok(creds.accounts.main.token.startsWith('sacct_'));
    assert.ok(!JSON.stringify(config).includes('sacct_'));assert.ok(!JSON.stringify(connectedAccounts(root)).includes('sacct_'));
    assert.deepEqual(Object.keys(creds.pendingLogins),[]);
    await connected(root,s,'second');assert.equal(connectedAccounts(root).accounts.length,2);
    await accountCommand(root,'accounts',['--use','main'],s);assert.equal(json(root,'config.json').activeAccount,'main');
    chmodSync(join(root,'credentials.json'),0o644);assert.throws(()=>connectedAccounts(root),{code:'credentials-too-open'});
  }finally{rmSync(root,{recursive:true,force:true});}
});
test('account adoption uses exact preview bootstrap and explicit move while preserving memory and account isolation',async()=>{
  const root=home(),s=server();try{
    await connected(root,s);const id=`s_${grant.slice(5)}`;mkdirSync(join(root,'souls',id,'memory'),{recursive:true});
    writeFileSync(join(root,'souls',id,'memory','journal.md'),'existing memory');
    const result=await accountPair(root,'Test Soul',url,{...s,move:true});assert.equal(result.memoryTransferred,false);
    assert.equal(readFileSync(join(root,'souls',id,'memory','journal.md'),'utf8'),'existing memory');
    assert.equal(json(root,'config.json').worlds.garden.gateway,'wss://example.invalid/preview/w/garden/v2/ws');
    assert.equal(s.sent.at(-1).body.move,true);assert.equal(s.sent.at(-1).body.soul,grant);
    assert.ok(!JSON.stringify(result).includes('sacct_'));assert.ok(!JSON.stringify(result).includes('.'+'a'.repeat(64)));
    await assert.rejects(accountPair(root,'Test Soul',url,{...s,as:'other'}),{code:'account-mismatch'});
    await assert.rejects(accountPair(root,'unknown',url,s),{code:'not-yours'});
    await assert.rejects(accountPair(root,'Test Soul','https://other.invalid/preview/w/garden/',s),{code:'account-origin-mismatch'});
    assert.equal((await accountPair(root,null,url,{...s,fresh:true})).paired,true);
    const before=json(root,'credentials.json').souls;
    await accountCommand(root,'logout',[],s);assert.deepEqual(json(root,'credentials.json').souls,before);
    assert.equal(readFileSync(join(root,'souls',id,'memory','journal.md'),'utf8'),'existing memory');
  }finally{rmSync(root,{recursive:true,force:true});}
});
test('account bearer is never sent through redirects or an untrusted public directory',async()=>{
  await assert.rejects(addressOf('http://public.invalid/w/garden'),{code:'account-not-https'});
  const root=home(),s=server();try{
    await connected(root,s);
    await assert.rejects(accountList(root,null,{get:s.get,send:async(_,opts)=>{assert.equal(opts.redirect,'error');throw new Error('redirect');}}),{code:'account-unavailable'});
    assert.ok(json(root,'credentials.json').accounts.main.token);
  }finally{rmSync(root,{recursive:true,force:true});}
});
test('a lost account-pair reply retries one private request key instead of creating another Soul',async()=>{
  const root=home(),s=server();try{
    await connected(root,s);let lose=true;
    const send=async(at,opts)=>{const answer=await s.send(at,opts);if(new URL(at).pathname==='/v1/agent/account/pair'&&lose){lose=false;throw new Error('lost response');}return answer;};
    await assert.rejects(accountPair(root,null,url,{...s,send,fresh:true}),{code:'account-unavailable'});
    const key=json(root,'credentials.json').pendingAccountPair.idempotencyKey;
    assert.equal((await accountPair(root,null,url,{...s,send,fresh:true})).paired,true);
    const requests=s.sent.filter(r=>new URL(r.at).pathname==='/v1/agent/account/pair');
    assert.equal(requests.length,2);assert.equal(requests[0].body.idempotencyKey,key);assert.equal(requests[1].body.idempotencyKey,key);
    assert.equal(json(root,'credentials.json').pendingAccountPair,undefined);
  }finally{rmSync(root,{recursive:true,force:true});}
});
