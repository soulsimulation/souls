import {test} from 'node:test';
import assert from 'node:assert/strict';
import {spawn} from 'node:child_process';
import {mkdtempSync,mkdirSync,writeFileSync,symlinkSync,linkSync,chmodSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {readPrivate,writePrivate} from './controller-ownership.mjs';

// #2126: another process atomically replaces the ledger (temp file + rename) while this one reads it.
test('a ledger atomically replaced during reads is never reported unsafe',{timeout:20000},async()=>{
 const directory=mkdtempSync(join(tmpdir(),'souls-ledger-read-')),path=join(directory,'controller-ownership.json');
 try{
  writePrivate(path,{version:1,i:-1});
  const writer=spawn(process.execPath,['--input-type=module','-e',`const {writePrivate}=await import(${JSON.stringify(new URL('./controller-ownership.mjs',import.meta.url).href)});const end=Date.now()+2000;let i=0;while(Date.now()<end)writePrivate(${JSON.stringify(path)},{version:1,i:i++,pad:'x'.repeat(200)});`],{stdio:'ignore'});
  const exited=new Promise(resolve=>writer.once('exit',resolve));
  let reads=0,unsafe=0,running=true;exited.then(()=>{running=false;});
  await new Promise(resolve=>setTimeout(resolve,200));
  while(running){const end=Date.now()+50;while(Date.now()<end){try{assert.equal(readPrivate(path).version,1);reads++;}catch(e){if(e.code!=='CONTROLLER_INVENTORY_UNSAFE')throw e;unsafe++;}}await new Promise(resolve=>setImmediate(resolve));}
  assert.equal(await exited,0);assert.ok(reads>1000,`reads ${reads}`);assert.equal(unsafe,0);
 }finally{rmSync(directory,{recursive:true,force:true});}
});

test('a link, a non-file, a wrong mode and an oversize ledger are still refused',()=>{
 const directory=mkdtempSync(join(tmpdir(),'souls-ledger-unsafe-'));
 try{
  const good=join(directory,'good.json');writePrivate(good,{version:1});assert.deepEqual(readPrivate(good),{version:1});
  const symlink=join(directory,'symlink.json');symlinkSync(good,symlink);
  const hardlink=join(directory,'hardlink.json');const linked=join(directory,'linked.json');writePrivate(linked,{version:1});linkSync(linked,hardlink);
  const folder=join(directory,'folder.json');mkdirSync(folder,{mode:0o700});
  const open=join(directory,'open.json');writeFileSync(open,'{}',{mode:0o600});chmodSync(open,0o644);
  const big=join(directory,'big.json');writeFileSync(big,'x'.repeat(262145),{mode:0o600});
  for(const path of [symlink,hardlink,linked,folder,open,big])assert.throws(()=>readPrivate(path),{code:'CONTROLLER_INVENTORY_UNSAFE'},path);
 }finally{rmSync(directory,{recursive:true,force:true});}
});
