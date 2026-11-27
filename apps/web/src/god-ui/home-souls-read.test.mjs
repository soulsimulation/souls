// First day, 27 Nov: the home page's My Souls asks for the account's Souls only with a token (an unsigned ask is a 401
// in the console).
import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {createRequire} from 'node:module';
import {build} from 'esbuild';
const require=createRequire(import.meta.url);
const dir=await mkdtemp(join(tmpdir(),'souls-home-souls-read-'));
globalThis.location={origin:'https://soul.game',pathname:'/',search:'',hash:'',href:'https://soul.game/'};
const outfile=join(dir,'read.cjs');
await build({stdin:{contents:`export {readMySouls} from './HomeSouls.tsx';`,resolveDir:new URL('.',import.meta.url).pathname,loader:'tsx'},outfile,bundle:true,format:'cjs',platform:'node',jsx:'automatic',loader:{'.css':'empty'},logLevel:'silent'});
const {readMySouls}=require(outfile);
test.after(()=>rm(dir,{recursive:true,force:true}));

test('no token: nothing is asked and the list is not known (null)',async()=>{
  let asked=0;
  assert.equal(await readMySouls({},async()=>{asked++;return new Response('{}');}),null);
  assert.equal(asked,0);
});
test('a token: the list, with the token sent; a refusal reads as no Souls',async()=>{
  const seen=[];
  const get=async(url,init)=>{seen.push([url,init.headers.authorization]);return new Response(JSON.stringify({contract:'my-souls/1',souls:[{id:'s1',name:'Juniper'}]}),{status:200});};
  assert.deepEqual((await readMySouls({authorization:'Bearer t'},get)).map(s=>s.name),['Juniper']);
  assert.match(seen[0][0],/\/__sim\/my-souls\.json$/);assert.equal(seen[0][1],'Bearer t');
  assert.deepEqual(await readMySouls({authorization:'Bearer t'},async()=>new Response('{}',{status:401})),[]);
});
