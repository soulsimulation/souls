// Local boot's public appearance half. The native decoder names kinds; no current-build/plain-name alias.
import {createHash} from 'node:crypto';
import {readFileSync,readdirSync,lstatSync,writeFileSync,mkdirSync} from 'node:fs';
import {join,resolve} from 'node:path';
import {pathToFileURL} from 'node:url';
import {defSchema,hashOf,coreLibrary} from '@souls/world-compiler';
const sha=bytes=>createHash('sha256').update(bytes).digest('hex');
const fail=why=>{throw Error('canonical-appearance.'+why);};
const read=file=>{const s=lstatSync(file);if(!s.isFile()||s.isSymbolicLink()||s.size>8*1024*1024)fail('source');return readFileSync(file);};
const plain=full=>full.split('@')[0];
const native=/^[a-z][a-z0-9-]*:[a-z][a-z0-9_]*@1220[a-f0-9]{64}$/;
/** Pure projection used by ordinary boot and source controls. editKinds is the existing pinned replica export. */
export function canonicalAppearance({world,stream,facts,kinds,entries,editKinds}) {
  if(!/^[a-z0-9][a-z0-9-]{0,62}$/.test(world)||!/^\/s\/[A-Za-z0-9._/-]+\/$/.test(stream)||stream.split('/').some(p=>p==='.'||p==='..'))fail('world');
  const f=JSON.parse(facts),named=JSON.parse(editKinds(kinds)),rows=[];
  const definitions=new Map((f.ground?.defs??[]).map(row=>[row.ref,JSON.parse(row.body)]));
  const byEntry=new Map();
  for(const bytes of entries){const entry=JSON.parse(bytes);if(entry?.format!=='souls-entry/1'||typeof entry.kind!=='string')continue;const old=byEntry.get(entry.kind);if(old)fail('entry-ambiguous');byEntry.set(entry.kind,{entry,sha256:sha(bytes)});}
  for(const [name,{entry,sha256}]of byEntry){
    const grips=Object.values(entry.points??{}).filter(p=>p?.role==='grip');
    if(grips.length!==1||!entry.looks?.shape?.shapes?.length)continue;
    const candidates=Object.entries(named).filter(([full])=>plain(full)===name&&native.test(full));
    if(candidates.length!==1)continue; // Two native revisions cannot be bound by a plain entry.
    const [kind,rules]=candidates[0],matches=[];
    for(const source of f.kinds??[]){
      const stored=definitions.get(source.ref)??coreLibrary().get(source.ref);if(!stored)continue;
      const parsed=defSchema.parse(stored),{budget,...hashable}=parsed;
      if(stored.hash!==source.hash||hashOf(hashable)!==source.hash||stored.ref!==source.ref)fail('stored-def');
      // This is import-eden's record, admitted/named by the SAME native decoder. Never infer core/name aliases.
      const slots=Object.entries(rules.slots??{}).map(([n,allowed])=>{if(!/^[1-9][0-9]*$/.test(n)||!Array.isArray(allowed)||allowed.some(x=>typeof x!=='string'))fail('slots');return `${n}: ${JSON.stringify(allowed)}`;}).join(',');
      if(!Array.isArray(rules.admits)||rules.admits.some(x=>typeof x!=='string'))fail('admission');
      const line=`{1: ${JSON.stringify(name)}, 2: "thing", 6: {${slots}}, 11: ${JSON.stringify(rules.admits)}, 19: ${JSON.stringify(source.hash)}}`;
      if(!Object.hasOwn(JSON.parse(editKinds(line)),kind))continue;
      const origins=(f.things??[]).filter(t=>t.ref===source.ref&&t.def===source.ref).map(t=>t.id);
      if(!origins.length||origins.some(x=>typeof x!=='string'||!x))continue;
      const projection={format:'souls-entry/1',kind:name,owner:'thing',state:entry.state??{},points:entry.points,geometry:entry.geometry??{},looks:{shape:entry.looks.shape,...(entry.looks.table?{table:entry.looks.table}:{})}};
      const entryText=JSON.stringify(projection);
      matches.push({kind,sourceEntry:{kind:name,sha256},sourceDef:{ref:source.ref,sha256:source.hash},origins,entry:projection,entrySHA256:sha(entryText)});
    }
    if(matches.length>1)fail('definition-ambiguous');if(matches.length)rows.push(matches[0]);
  }
  if(rows.length>1024)fail('limit');
  return {format:'souls-canonical-appearance/1',world,stream,sources:{facts:sha(facts),kinds:sha(kinds)},rows};
}
/** Reads only the run's actual boot facts/kinds/entries. No auth, world command, or model generation. */
export async function publishCanonicalAppearance({world,stream,directory,pkg,out,factsFile=join(directory,'genesis.facts.json')}) {
  const wire=await import(pathToFileURL(join(pkg,'replica.js')).href);
  wire.initSync({module:readFileSync(join(pkg,'replica_bg.wasm'))});
  const files=[];const walk=dir=>{for(const name of readdirSync(dir).sort()){const p=join(dir,name),s=lstatSync(p);if(s.isSymbolicLink())fail('source');if(s.isDirectory())walk(p);else if(name.endsWith('.json')){if(files.length>=2048)fail('limit');files.push(read(p));}}};walk(join(directory,'world','entries'));
  const data=canonicalAppearance({world,stream,facts:read(factsFile).toString(),kinds:read(join(directory,'world','world.kinds')).toString(),entries:files,editKinds:wire.editKinds});
  const bytes=Buffer.from(JSON.stringify(data)),sha256=sha(bytes);if(bytes.length>8*1024*1024)fail('limit');mkdirSync(out,{recursive:true});const file=resolve(out,`${sha256}.json`);writeFileSync(file,bytes,{flag:'wx'});
  return {file,sha256,world,stream};
}
