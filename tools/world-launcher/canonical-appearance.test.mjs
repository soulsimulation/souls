import {test} from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {createHash} from 'node:crypto';
import {pathToFileURL} from 'node:url';
import {join} from 'node:path';
import {defSchema,hashOf} from '@souls/world-compiler';
import {canonicalAppearance} from './canonical-appearance.mjs';
const sha=b=>createHash('sha256').update(b).digest('hex');
export const KIND='eden:soup_bowl@12207564419b011f4ce981686d39b826d5d31c2efb240185c0fead65f515f3cd162f';
export function appearanceFixture(){
 const entry=JSON.parse(readFileSync(new URL('../../content/kinds/food/soup_bowl.json',import.meta.url),'utf8'));
 const template=JSON.parse(readFileSync(new URL('../../worlds/templates/shared-camp-meal.json',import.meta.url),'utf8'));
 const source=template.batches.flatMap(b=>b.ops).find(op=>op.op==='define'&&op.def.name==='core-soup_bowl').def;
 const parsed=defSchema.parse(source),{budget,...body}=parsed;
 const stored={...parsed,hash:hashOf(body),ref:'core-soup_bowl@1',by:'test',born:0};
 assert.equal(stored.hash,'559a63921da3d3856ccc070141f13cbcdde5caaa3aa4dbb5fbcc97b47ec7e14d');
 const line=`{1: "eden:soup_bowl", 2: "thing", 6: {}, 11: ["thing"], 19: "${stored.hash}"}`;
 // Independent, exact retained native decoder answer. Never accepts a reconstructed different source/record.
 const editKinds=text=>JSON.stringify(text===line?{[KIND]:{admits:['thing'],slots:{}}}:{});
 const facts=JSON.stringify({ground:{defs:[{ref:stored.ref,body:JSON.stringify(stored)}]},kinds:[{ref:stored.ref,hash:stored.hash}],things:[{id:'e_bowl0001',ref:stored.ref,def:stored.ref}]});
 return {input:{world:'meal',stream:'/s/meal/',facts,kinds:line,entries:[JSON.stringify(entry)],editKinds},entry,stored,line};
}
test('actual boot entry and exact import record project only appearance, state fields and grip',()=>{
 const f=appearanceFixture(),p=canonicalAppearance(f.input);assert.equal(p.rows.length,1);const row=p.rows[0];
 assert.equal(row.kind,KIND);assert.deepEqual(row.entry.points,f.entry.points);assert.deepEqual(row.entry.state,f.entry.state);
 assert.equal(row.sourceEntry.sha256,sha(f.input.entries[0]));assert.equal(row.sourceDef.sha256,f.stored.hash);
 assert.equal(row.entry.forms,undefined);assert.equal(row.entry.text,undefined);assert.equal(row.entrySHA256,sha(JSON.stringify(row.entry)));
 const bad=structuredClone(JSON.parse(f.input.facts));bad.kinds[0].hash='a'.repeat(64);
 assert.throws(()=>canonicalAppearance({...f.input,facts:JSON.stringify(bad)}),/stored-def/);
 const changed=appearanceFixture();changed.input.editKinds=text=>text===changed.line?JSON.stringify({[KIND]:{admits:['thing'],slots:{}}}):'{}';
 const unrelated=JSON.parse(changed.input.facts);const def=JSON.parse(unrelated.ground.defs[0].body);def.description='unrelated';const {hash,ref,by,born,budget,...part}=def;def.hash=hashOf(part);unrelated.ground.defs[0].body=JSON.stringify(def);unrelated.kinds[0].hash=def.hash;
 assert.equal(canonicalAppearance({...changed.input,facts:JSON.stringify(unrelated)}).rows.length,0,'same ref/name with a different StoredDef never aliases the actual native revision');
});
test('ambiguous native revisions/entries and malformed world stay unsupported',()=>{
 const f=appearanceFixture();assert.throws(()=>canonicalAppearance({...f.input,world:'../meal'}),/world/);
 assert.throws(()=>canonicalAppearance({...f.input,entries:[...f.input.entries,...f.input.entries]}),/entry-ambiguous/);
 const editKinds=()=>JSON.stringify({[KIND]:{admits:['thing']},[KIND.replace(/.$/,'e')]:{admits:['thing']}});
 assert.equal(canonicalAppearance({...f.input,editKinds}).rows.length,0);
});
test('existing pinned native editKinds accepts the exact import identity (optional decoder integration)',{skip:!process.env.SOULS_REPLICA_PKG?'Native decoder package absent; pure recorded-answer controls still run. Set SOULS_REPLICA_PKG for actual decoder integration.':false},async()=>{
 const pkg=process.env.SOULS_REPLICA_PKG,wire=await import(pathToFileURL(join(pkg,'replica.js')).href);wire.initSync({module:readFileSync(join(pkg,'replica_bg.wasm'))});
 const f=appearanceFixture();assert.equal(canonicalAppearance({...f.input,editKinds:wire.editKinds}).rows[0].kind,KIND);
});
