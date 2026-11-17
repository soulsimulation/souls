// The shared accounts file: binding an existing account takes no write lock; two processes binding one new
// subject at once agree on its id. Temporary registry files only.
import test from 'node:test';
import assert from 'node:assert/strict';
import {spawn} from 'node:child_process';
import {mkdtempSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {DatabaseSync} from 'node:sqlite';
import {AccountRegistry} from './account-registry.ts';

const ISSUER='https://clerk.example.test';
const tempDir=(t:{after(fn:()=>void):void})=>{const dir=mkdtempSync(join(tmpdir(),'account-registry-'));t.after(()=>rmSync(dir,{recursive:true,force:true}));return dir;};

test('A1 a second bind for the same subject opens no write transaction',t=>{
 const path=join(tempDir(t),'registry.db'),registry=new AccountRegistry(path);t.after(()=>registry.close());
 const id=registry.bind(ISSUER,'user_alice');
 const statements:string[]=[],exec=registry.db.exec.bind(registry.db);registry.db.exec=(sql:string)=>{statements.push(sql);return exec(sql);};
 // another world process holds the write lock; a bind that wanted it would fail at once with no wait
 registry.db.exec('PRAGMA busy_timeout=0');statements.length=0;
 const other=new DatabaseSync(path);t.after(()=>other.close());other.exec('BEGIN IMMEDIATE');
 try{assert.equal(registry.bind(ISSUER,'user_alice'),id);}finally{other.exec('ROLLBACK');}
 assert.equal(statements.join(';'),'','no BEGIN, COMMIT or ROLLBACK for an existing account');
 assert.notEqual(registry.bind(ISSUER,'user_bob'),id,'a new subject still gets its own account');
 assert.ok(statements.includes('BEGIN IMMEDIATE'),'a new account is written under the lock');
});

const child=(path:string,subject:string)=>{
 const code="import {AccountRegistry} from "+JSON.stringify(new URL('./account-registry.ts',import.meta.url).href)+";const r=new AccountRegistry(process.argv[1]);console.log('ready');process.stdin.once('data',()=>{console.log(JSON.stringify({pid:process.pid,id:r.bind(process.argv[2],process.argv[3])}));r.close();});";
 const p=spawn(process.execPath,['--input-type=module','-e',code,path,ISSUER,subject],{stdio:['pipe','pipe','inherit']});
 let out='';const ready=new Promise<void>(ok=>p.stdout.on('data',d=>{out+=d;if(out.includes('ready\n'))ok();}));
 const done=new Promise<{pid:number;id:string}>((ok,fail)=>p.on('exit',status=>status===0?ok(JSON.parse(out.split('\n')[1])):fail(Error('child exited '+status))));
 return {ready,done,go(){p.stdin.end('go\n');}};
};

test('A2 two processes binding the same new subject at once get the same account id',async t=>{
 const path=join(tempDir(t),'registry.db');new AccountRegistry(path).close();
 const a=child(path,'user_new'),b=child(path,'user_new');await Promise.all([a.ready,b.ready]);
 // hold the write lock so both find no account and queue on it together, then let them race
 const gate=new DatabaseSync(path);gate.exec('PRAGMA busy_timeout=5000');gate.exec('BEGIN IMMEDIATE');
 a.go();b.go();await new Promise(ok=>setTimeout(ok,300));gate.exec('COMMIT');gate.close();
 const [ra,rb]=await Promise.all([a.done,b.done]);
 assert.notEqual(ra.pid,rb.pid);assert.match(ra.id,/^acct_/);assert.equal(ra.id,rb.id);
 const check=new AccountRegistry(path);t.after(()=>check.close());
 assert.equal((check.db.prepare('SELECT count(*) AS n FROM provider_accounts_v1').get() as {n:number}).n,1);
 assert.equal(check.bind(ISSUER,'user_new'),ra.id);
});
