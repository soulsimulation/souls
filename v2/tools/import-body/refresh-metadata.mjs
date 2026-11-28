// Metadata-only upgrade of an already admitted body asset directory. No model/diag generation or native build.
// node refresh-metadata.mjs --input <approved-assets> --out <new-staging> --manifest-sha <sha256>
//   --replica <vectors-pkg> --replica-sha <js-sha256> --wasm-sha <wasm-sha256>
import {createHash} from 'node:crypto';
import {existsSync,lstatSync,mkdirSync,readFileSync,writeFileSync} from 'node:fs';
import {dirname,join,resolve,sep} from 'node:path';
import {fileURLToPath,pathToFileURL} from 'node:url';
import {decode} from '../../web/node_modules/cborg/cborg.js';
import {BODY_METADATA_SOURCES,checkBodySources} from '../../web/body-assets.ts';
import {isMain} from '../../../tools/lib/is-main.mjs';
const sha=bytes=>createHash('sha256').update(bytes).digest('hex');
const hashOK=value=>typeof value==='string'&&/^[a-f0-9]{64}$/.test(value);
const map=value=>{if(!(value instanceof Map))throw Error('body.metadata-map');return value;};
const fail=()=>{throw Error('body.metadata-invalid');};

/** The native KindSource loader strips # comments per line before its canonical diagnostic decoder. */
export function metadataOf(kindBytes,expectedHash,encodeDiagnostic){
  if(!hashOK(expectedHash)||sha(kindBytes)!==expectedHash)throw Error('body.metadata-kind-hash');
  const text=Buffer.from(kindBytes).toString('utf8').split('\n').map(line=>line.split('#')[0]).join('\n');
  const kind=map(decode(encodeDiagnostic(text),{useMaps:true})),family=map(kind.get(13));
  const rows=family.get(1);if(typeof kind.get(1)!=='string'||kind.get(2)!=='family'||!Array.isArray(rows))fail();
  const resources=rows.map(value=>{
    const row=map(value),name=row.get(1),cls=row.get(2),slot=row.get(3);
    if(row.size!==(slot===undefined?2:3)||typeof name!=='string'||!Number.isSafeInteger(cls)||slot!==undefined&&(!Number.isSafeInteger(slot)||slot<1))fail();
    return slot===undefined?[name,cls]:[name,cls,slot];
  });
  if(new Set(resources.map(r=>r[0])).size!==resources.length)fail();
  const slots=resources.filter(r=>r[1]===2&&r.length===3).map(r=>r[2]);if(new Set(slots).size!==slots.length)fail();
  for(const field of [3,4])if(typeof family.get(field)!=='string'||!/^sha256:[a-f0-9]{64}$/.test(family.get(field)))fail();
  return {kind:kind.get(1),kindHash:expectedHash,resources,full:family.get(3),simple:family.get(4)};
}

export async function verifiedDecoder({replica,replicaSha,wasmSha}){
  if(!hashOK(replicaSha)||!hashOK(wasmSha))throw Error('body.metadata-decoder-pin');
  const js=join(resolve(replica),'replica.js'),wasm=join(resolve(replica),'replica_bg.wasm');
  if(sha(readFileSync(js))!==replicaSha||sha(readFileSync(wasm))!==wasmSha)throw Error('body.metadata-decoder-pin');
  const module=await import(pathToFileURL(js).href);if(typeof module.encode_diagnostic!=='function')throw Error('body.metadata-vectors-required');
  module.initSync({module:readFileSync(wasm)});return module.encode_diagnostic;
}

/** Writes only a fresh directory after every input validates. Existing artifacts remain untouched. */
export async function refreshMetadata({input,out,manifestSha,replica,replicaSha,wasmSha},encodeDiagnostic){
  input=resolve(input);out=resolve(out);
  if(existsSync(out)||out===input||out.startsWith(input+sep)||!hashOK(manifestSha))throw Error('body.metadata-fresh-output');
  const read=name=>{
    if(typeof name!=='string'||name.startsWith('/')||name.split('/').some(p=>!p||p==='.'||p==='..'))throw Error('body.metadata-path');
    let path=input;for(const part of name.split('/')){path=join(path,part);if(lstatSync(path).isSymbolicLink())throw Error('body.metadata-symlink');}
    if(!lstatSync(path).isFile())throw Error('body.metadata-file');return readFileSync(path);
  };
  const originalManifest=read('body-assets.json');if(sha(originalManifest)!==manifestSha)throw Error('body.metadata-manifest-pin');
  const manifest=JSON.parse(originalManifest),files=new Map();
  if(manifest.format!=='souls/body-assets/1'||!Array.isArray(manifest.files)||manifest.files.length>256)fail();
  for(const file of manifest.files){const bytes=read(file.path);if(files.has(file.path)||bytes.length!==file.bytes||sha(bytes)!==file.sha256)throw Error('body.metadata-file-pin');files.set(file.path,bytes);}
  const catalogue=JSON.parse(files.get('bodies.json')??fail());
  if(catalogue.format!=='souls/bodies/1'||!Array.isArray(catalogue.bodies)||!catalogue.bodies.length)fail();
  const encode=encodeDiagnostic??await verifiedDecoder({replica,replicaSha,wasmSha});
  const originalCatalogue=files.get('bodies.json').toString('utf8'),originalEntries={};
  const changed=new Set(['bodies.json']),kinds=new Set();
  for(const row of catalogue.bodies){
    if(typeof row.entry!=='string'||!/^[a-z][a-z0-9_]*\.json$/.test(row.entry)||!hashOK(row.entryHash)||!hashOK(row.hash)||kinds.has(row.hash))fail();kinds.add(row.hash);
    const before=files.get(row.entry);if(!before||sha(before)!==row.entryHash)throw Error('body.metadata-entry-pin');
    originalEntries[row.entry]=before.toString('utf8');
    const entry=JSON.parse(before),kind=files.get(row.entry.replace(/\.json$/,'.diag'));if(!kind)fail();
    const metadata=metadataOf(kind,row.hash,encode);
    if(entry.kind!==metadata.kind)throw Error('body.metadata-kind-mismatch');
    for(const [key,expected] of [['full',metadata.full],['simple',metadata.simple]]){
      const match=/^models\/([a-f0-9]{64})\.(glb|json|mesh)$/.exec(entry[key]??'');
      if(!match||expected!=='sha256:'+match[1]||!files.has(entry[key])||sha(files.get(entry[key]))!==match[1])throw Error('body.metadata-model-pin');
    }
    const next=Buffer.from(JSON.stringify({...entry,kindHash:metadata.kindHash,resources:metadata.resources},null,1)+'\n');
    files.set(row.entry,next);row.entryHash=sha(next);changed.add(row.entry);
  }
  files.set('bodies.json',Buffer.from(JSON.stringify(catalogue)+'\n'));
  const repo=resolve(dirname(fileURLToPath(import.meta.url)),'../../..');
  const next={...manifest,
    files:manifest.files.map(file=>({...file,bytes:files.get(file.path).length,sha256:sha(files.get(file.path))})),
    metadata:{format:'souls/body-resource-metadata/1',sourceManifest:manifestSha,originalManifest:originalManifest.toString('utf8'),originalCatalogue,originalEntries,sources:BODY_METADATA_SOURCES.map(path=>({path,sha256:sha(readFileSync(join(repo,path)))})),toolSha:sha(readFileSync(fileURLToPath(import.meta.url))),replicaSha,wasmSha}};
  for(const file of manifest.files)if(!changed.has(file.path)&&sha(files.get(file.path))!==file.sha256)throw Error('body.metadata-preservation');
  checkBodySources(next,files,repo);
  mkdirSync(out,{recursive:true});
  for(const [name,bytes]of files){mkdirSync(dirname(join(out,name)),{recursive:true});writeFileSync(join(out,name),bytes,{flag:'wx'});}
  writeFileSync(join(out,'body-assets.json'),JSON.stringify(next)+'\n',{flag:'wx'});
  return {format:'souls/body-resource-refresh/1',bodies:catalogue.bodies.length,changed:[...changed].sort(),preserved:manifest.files.length-changed.size,manifestHash:sha(Buffer.from(JSON.stringify(next)+'\n'))};
}

if(isMain(import.meta.url)){
  const args=process.argv.slice(2),get=name=>{const i=args.indexOf('--'+name);return i<0?undefined:args[i+1];};
  const options={input:get('input'),out:get('out'),manifestSha:get('manifest-sha'),replica:get('replica'),replicaSha:get('replica-sha'),wasmSha:get('wasm-sha')};
  if(Object.values(options).some(v=>!v))throw Error('usage: refresh-metadata.mjs --input <assets> --out <fresh-dir> --manifest-sha <hash> --replica <vectors-pkg> --replica-sha <hash> --wasm-sha <hash>');
  refreshMetadata(options).then(result=>console.log(JSON.stringify(result))).catch(error=>{console.error(error.message);process.exitCode=1;});
}
