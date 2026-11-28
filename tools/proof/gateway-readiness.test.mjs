import {test} from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,mkdirSync,readFileSync,writeFileSync,rmSync} from 'node:fs';
import {spawnSync} from 'node:child_process';
import {fileURLToPath} from 'node:url';
import {join} from 'node:path';

const root=fileURLToPath(new URL('../../',import.meta.url));
const script=readFileSync(new URL('../../v2/tools/dev/run.sh',import.meta.url),'utf8');
const lines=script.split('\n').filter(line=>line.startsWith('until_ready gatewayd '));
assert.equal(lines.length,1,'one actual gateway readiness predicate');
const predicate=lines[0].slice('until_ready gatewayd '.length);
const expected='127.0.0.1:23086';

function ready(t,log){
  const parent=join(root,'.local/gateway-readiness-4935');mkdirSync(parent,{recursive:true});
  const dir=mkdtempSync(join(parent,'fixture-'));t.after(()=>rmSync(dir,{recursive:true,force:true}));
  mkdirSync(join(dir,'logs'));if(log!==undefined)writeFileSync(join(dir,'logs/gatewayd.log'),log);
  // Execute the real predicate only: no world, service, timeout loop or native binary.
  const result=spawnSync('bash',['-c',`GATEWAY=$1\n${predicate}`,'readiness-fixture',expected],{cwd:dir,encoding:'utf8',timeout:2000});
  assert.equal(result.error,undefined);return result.status===0;
}

test('actual gateway predicate accepts the bare expected bind line',t=>{
  assert.equal(ready(t,`gatewayd: entries ready\nlistening ${expected}\ngatewayd: the world is reachable\n`),true);
});
test('actual gateway predicate accepts the observed interleaved stderr prefix',t=>{
  assert.equal(ready(t,`gatewayd: listening ${expected}\nthe world is reachable; 0 unanswered intents sent again\n`),true);
});
test('actual gateway predicate refuses other hosts and ports',t=>{
  assert.equal(ready(t,'listening 127.0.0.2:23086\n'),false);
  assert.equal(ready(t,'gatewayd: listening 127.0.0.1:23087\n'),false);
});
test('actual gateway predicate refuses substrings, partial lines and errors',t=>{
  for(const line of [`prefix listening ${expected}`,`listening ${expected} extra`,`gatewayd: listening ${expected} extra`,'listening 127.0.0.1:2308',`gatewayd: failed listening ${expected}`])assert.equal(ready(t,line+'\n'),false,line);
});
test('actual gateway predicate refuses absent readiness and a missing log',t=>{
  assert.equal(ready(t,'gatewayd: uploads ready\n'),false);
  assert.equal(ready(t,undefined),false);
});
