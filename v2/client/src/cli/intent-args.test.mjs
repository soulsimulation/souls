// #3601: the actual thin-client encoder preserves the existing complete T0 argument representation.
import { strict as assert } from 'node:assert';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { test } from 'node:test';
import { decode } from '../brief/copy.mjs';
const pkg=process.env.SOULS_REPLICA_PKG??fileURLToPath(new URL('../../../target/wasm-load/pkg/',import.meta.url));
const wire=await import(pathToFileURL(join(pkg,'replica.js')).href);
wire.initSync({module:readFileSync(join(pkg,'replica_bg.wasm'))});
const scope=Buffer.alloc(16,7),target=`${scope.toString('hex')}-8`,other=`${'09'.repeat(16)}-3`;
const intent=(args,params)=>decode(wire.wireIntent(scope,1n,'eden:open',1n,new Uint8Array(),1000000000000000n,target,undefined,args,params));
const parameters=(args,params)=>intent(args,params).get(4);

test('named-args: ordinary drawer=top and existing thing IDs use canonical argument pairs',()=>{
  const [[key,value]]=parameters('drawer=top').get(1);
  assert.ok(key instanceof Uint8Array);assert.equal(Buffer.from(key).toString(),'drawer');assert.deepEqual(value,new Uint8Array(Buffer.from('top')));
  const [[,sixteen]]=parameters('drawer=abcdefghijklmnop').get(1);assert.deepEqual(sixteen,new Uint8Array(Buffer.from('abcdefghijklmnop')));
  const [[,id]]=parameters(`item=${other}`).get(1);assert.deepEqual(id,[new Uint8Array(Buffer.alloc(16,9)),3]);
  assert.throws(()=>intent('drawer'),/arg-not-name-and-id/);
  assert.throws(()=>intent(`item=${'09'.repeat(16)}-bad`),/arg-not-name-and-id/);
});

test('named-args: numbered part, slot and private text/reference wrappers keep the existing T0 forms',()=>{
  const pairs=parameters(undefined,JSON.stringify({'1':[['drawer','top'],['seat',2],['words',{'23':'a private sentence'}],['reference',{'21':other}]]})).get(1);
  for(const [key]of pairs)assert.ok(key instanceof Uint8Array);
  assert.deepEqual(pairs[0][1],new Uint8Array(Buffer.from('top')));assert.equal(pairs[1][1],2);
  assert.deepEqual(pairs[2][1].get(23),new Uint8Array(Buffer.from('a private sentence')));
  assert.deepEqual(pairs[3][1].get(21),[new Uint8Array(Buffer.alloc(16,9)),3]);
  assert.throws(()=>parameters('drawer=top drawer=bottom'),/arg-ambiguous/);
  assert.throws(()=>parameters('drawer=top','{"1":[["drawer","bottom"]]}'),/arg-ambiguous/);
  assert.throws(()=>parameters(undefined,'{"1":[["drawer","top"],["drawer",2]]}'),/arg-ambiguous/);
  assert.throws(()=>parameters(undefined,'{"1":[["words",{"23":9}]]}'),/param-unsupported/);
  assert.throws(()=>parameters(undefined,'{"1":{"unknown":"map"}}'),/param-unsupported/);
});

test('named-args: exact signed T0 integers survive nested coordinate arrays and both 64-bit boundaries',()=>{
  const p=parameters(undefined,'{"1":[-20000000,0,21000000],"2":[-1,[-18446744073709551616,18446744073709551615]]}');
  assert.deepEqual(p.get(1),[-20000000,0,21000000]);
  assert.deepEqual(p.get(2),[-1,[-18446744073709551616n,18446744073709551615n]]);
  for(const text of ['{"1":18446744073709551616}','{"1":-18446744073709551617}'])assert.throws(()=>parameters(undefined,text),/param-out-of-range/);
  for(const text of ['{"1":1.5}','{"1":true}'])assert.throws(()=>parameters(undefined,text),/param-unsupported/);
});
