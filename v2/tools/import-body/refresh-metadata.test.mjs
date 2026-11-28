import {test} from 'node:test';
import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {existsSync,mkdirSync,mkdtempSync,readFileSync,rmSync,writeFileSync} from 'node:fs';
import {join,resolve} from 'node:path';
import {BODY_SOURCE_FILES,BODY_METADATA_PREDECESSORS,checkBodySources} from '../../web/body-assets.ts';
import {metadataOf,verifiedDecoder,refreshMetadata} from './refresh-metadata.mjs';
const sha=b=>createHash('sha256').update(b).digest('hex');
const options={replica:process.env.BODY_METADATA_REPLICA,replicaSha:process.env.BODY_METADATA_REPLICA_SHA,wasmSha:process.env.BODY_METADATA_WASM_SHA};
const hasDecoder=Object.values(options).every(Boolean);
// Unit injection is bound to the captured decoder provenance, without requiring that package in CI.
const fixtureOptions={replicaSha:'8eb35cb09ebfff3a6ac44764652624141ab7c3665a0a6f6269508f0fed6c5e94',wasmSha:'837328068257869c6cc689650663d4b3f87de3eb799998246d329c0ec750a7ab'};
const model=Buffer.from('unchanged full body model'),simple=Buffer.from('unchanged simple body model');
const full='models/'+sha(model)+'.glb',low='models/'+sha(simple)+'.mesh';
const diag=Buffer.from('# admitted body header\n# measured immutable model references\n{1: "body:declared", 2: "family", 13: {1: [{1: "souls:hand-left", 2: 2, 3: 7}, {1: "souls:hand-right", 2: 2, 3: 4}], 2: ["stand"], 3: "sha256:'+sha(model)+'", 4: "sha256:'+sha(simple)+'"}}\n');

// Captured from the verified main24 vectors decoder (WASM 837328068257869c6cc689650663d4b3f87de3eb799998246d329c0ec750a7ab).
// This immutable fixture exercises the metadata boundary; the separate integration checks the actual parser.
const nativeCbor='a3016d626f64793a6465636c61726564026666616d696c790da40182a3016f736f756c733a68616e642d6c65667402020307a30170736f756c733a68616e642d7269676874020203040281657374616e640378477368613235363a633433663232323132336531366162326666636230333439313132653962363664663262323336373139333461353062616132613062663038623330373434650478477368613235363a37383364343764656338643338333665643838653535653563326337323064623962633662306333643736376637366565366237386234316463323837313935';
assert.equal(sha(diag),'c4b240a2afd238da12b4005555057f569ce465f401c5247b0e762dbf6d6a1486');
const encode=text=>{assert.equal(sha(text),'47c97f9af6352c3a5d1984ded0ff551dbbaf731c3fbf569f5c185d04d4e194f6');return Buffer.from(nativeCbor,'hex');};
test('pinned real native diagnostic decoder matches the immutable fixture', {skip:hasDecoder?false:'Provide existing vectors WASM and exact package hashes; unit fixture does not prove parser compatibility.'},async()=>{
  const actual=await verifiedDecoder(options),bare=diag.toString().split('\n').map(l=>l.split('#')[0]).join('\n');
  assert.equal(Buffer.from(actual(bare)).toString('hex'),nativeCbor);
  const bad=Buffer.from(diag.toString().replace('souls:hand-left','souls:hand#left'));
  assert.throws(()=>metadataOf(bad,sha(bad),actual),'native source grammar rejects # inside a Name');
  await assert.rejects(verifiedDecoder({...options,replicaSha:'00'.repeat(32)}),/decoder-pin/);
});

test('native-encoded fixture supplies exact body resources with imported headers',()=>{
  const metadata=metadataOf(diag,sha(diag),encode);
  assert.deepEqual(metadata.resources,[['souls:hand-left',2,7],['souls:hand-right',2,4]]);
  assert.equal(metadata.kind,'body:declared');assert.equal(metadata.kindHash,sha(diag));
  assert.throws(()=>metadataOf(diag,'00'.repeat(32),encode),/kind-hash/);
  const bad=Buffer.from(diag.toString().replace('souls:hand-left','souls:hand#left'));
  assert.throws(()=>metadataOf(bad,sha(bad),encode),'unsupported input is never substituted with the valid fixture');
});

function fixture(t){
  const scratch=resolve(import.meta.dirname,'../../../.local/body-metadata-tests');mkdirSync(scratch,{recursive:true});
  const dir=mkdtempSync(join(scratch,'stage-'));t.after(()=>rmSync(dir,{recursive:true,force:true}));
  const input=join(dir,'input');mkdirSync(join(input,'models'),{recursive:true});
  const entry=Buffer.from(JSON.stringify({kind:'body:declared',full,simple:low,clips:['Idle'],motion:{contract:'body-motion/1'}}));
  const catalogue=Buffer.from(JSON.stringify({format:'souls/bodies/1',bodies:[{hash:sha(diag),entry:'declared.json',entryHash:sha(entry),legacy:[{family:'humanoid'}]}]}));
  const files=new Map([[full,model],[low,simple],['declared.diag',diag],['declared.json',entry],['bodies.json',catalogue],['decoder/pinned.wasm',Buffer.from('unchanged decoder')]]);
  for(const [name,bytes]of files){mkdirSync(join(input,name.includes('/')?name.slice(0,name.lastIndexOf('/')):''),{recursive:true});writeFileSync(join(input,name),bytes);}
  const manifest=Buffer.from(JSON.stringify({format:'souls/body-assets/1',sources:BODY_SOURCE_FILES.map(path=>({path,sha256:BODY_METADATA_PREDECESSORS[path]??sha(readFileSync(resolve(import.meta.dirname,'../../..',path)))})),files:[...files].map(([path,bytes])=>({path,bytes:bytes.length,sha256:sha(bytes)}))}));writeFileSync(join(input,'body-assets.json'),manifest);
  return {input,out:join(dir,'output'),manifestSha:sha(manifest),files,manifest};
}

test('metadata-only staging preserves every native/model/decoder byte and updates normal catalogue hashes',async t=>{
  const f=fixture(t),result=await refreshMetadata({...fixtureOptions,...f},encode);
  assert.deepEqual(result.changed,['bodies.json','declared.json']);
  for(const [name,bytes]of f.files){assert.deepEqual(readFileSync(join(f.input,name)),bytes,'input unchanged');if(!result.changed.includes(name))assert.deepEqual(readFileSync(join(f.out,name)),bytes,'immutable payload unchanged');}
  assert.deepEqual(readFileSync(join(f.input,'body-assets.json')),f.manifest);
  const entry=JSON.parse(readFileSync(join(f.out,'declared.json'))),catalogue=JSON.parse(readFileSync(join(f.out,'bodies.json'))),manifest=JSON.parse(readFileSync(join(f.out,'body-assets.json')));
  assert.deepEqual(entry.resources,[['souls:hand-left',2,7],['souls:hand-right',2,4]]);assert.equal(entry.kindHash,sha(diag));assert.equal(entry.motion.contract,'body-motion/1');
  assert.equal(catalogue.bodies[0].hash,sha(diag));assert.equal(catalogue.bodies[0].entryHash,sha(readFileSync(join(f.out,'declared.json'))));
  for(const file of manifest.files)assert.equal(file.sha256,sha(readFileSync(join(f.out,file.path))));
  assert.deepEqual(manifest.sources,JSON.parse(f.manifest).sources,'original generation provenance is unchanged');
  const outputFiles=new Map(manifest.files.map(file=>[file.path,readFileSync(join(f.out,file.path))]));checkBodySources(manifest,outputFiles,resolve(import.meta.dirname,'../../..'));
  const drift=structuredClone(manifest);drift.sources.find(row=>row.path==='v2/web/src/crowd/bake.ts').sha256='00'.repeat(32);assert.throws(()=>checkBodySources(drift,outputFiles,resolve(import.meta.dirname,'../../..')),/assets-source/);
  const wrongOrigin=structuredClone(manifest);wrongOrigin.metadata.originalManifest+=' ';assert.throws(()=>checkBodySources(wrongOrigin,outputFiles,resolve(import.meta.dirname,'../../..')),/assets-metadata/);
  const forged=structuredClone(manifest);forged.metadata.toolSha='00'.repeat(32);assert.throws(()=>checkBodySources(forged,outputFiles,resolve(import.meta.dirname,'../../..')),/assets-metadata/);
  const rewritten=structuredClone(manifest);rewritten.files.find(file=>file.path===full).sha256='00'.repeat(32);assert.throws(()=>checkBodySources(rewritten,outputFiles,resolve(import.meta.dirname,'../../..')),/preservation/);
  assert.equal(manifest.metadata.sourceManifest,f.manifestSha);assert.equal(sha(readFileSync(join(f.out,'body-assets.json'))),result.manifestHash);
  await assert.rejects(refreshMetadata({...fixtureOptions,...f},encode),/fresh-output/);
});

test('wrong kind/model/manifest pins fail before creating an output directory',async t=>{
  for(const change of ['kind','model','manifest']){
    const f=fixture(t);
    if(change==='manifest')f.manifestSha='00'.repeat(32);
    else{
      const entry=JSON.parse(f.files.get('declared.json'));if(change==='kind')entry.kind='body:other';else entry.full=low;
      const bytes=Buffer.from(JSON.stringify(entry));writeFileSync(join(f.input,'declared.json'),bytes);
      const cat=JSON.parse(f.files.get('bodies.json'));cat.bodies[0].entryHash=sha(bytes);const catBytes=Buffer.from(JSON.stringify(cat));writeFileSync(join(f.input,'bodies.json'),catBytes);
      const manifest=JSON.parse(f.manifest);for(const file of manifest.files){const actual=readFileSync(join(f.input,file.path));file.sha256=sha(actual);file.bytes=actual.length;}
      const m=Buffer.from(JSON.stringify(manifest));writeFileSync(join(f.input,'body-assets.json'),m);f.manifestSha=sha(m);
    }
    await assert.rejects(refreshMetadata({...fixtureOptions,...f},encode),/kind-mismatch|model-pin|manifest-pin/);assert(!existsSync(f.out),'no partial staged artifact on validation failure');
  }
});

test('retained full stale catalog stays refused by the normal consumer source policy', {skip:process.env.BODY_METADATA_STALE_MANIFEST?false:'Retained stale package is an optional private regression input, not a current activation package.'},()=>{
  const bytes=readFileSync(process.env.BODY_METADATA_STALE_MANIFEST);assert.equal(sha(bytes),process.env.BODY_METADATA_STALE_SHA);
  assert.throws(()=>checkBodySources(JSON.parse(bytes),new Map(),resolve(import.meta.dirname,'../../..')),/body.assets-source/);
});
