import {test} from 'node:test';import assert from 'node:assert/strict';import{readFileSync}from'node:fs';import{GLTFLoader}from'three/addons/loaders/GLTFLoader.js';import{HumanViews,type SampledHuman}from'../../../mars/viewer/app/engine-view/humans.ts';import{templateFromGltf}from'../../../mars/viewer/app/engine-view/people.ts';
async function views(){
 const source=readFileSync(new URL('../../../mars/viewer/public/modular/environment/animated-casual.glb',import.meta.url));
 const jsonSize=source.readUInt32LE(12),json=JSON.parse(source.subarray(20,20+jsonSize).toString()),binHeader=20+jsonSize;
 json.materials=json.materials.map(()=>({pbrMetallicRoughness:{baseColorFactor:[.5,.5,.5,1],metallicFactor:0,roughnessFactor:.8}}));delete json.textures;delete json.images;delete json.samplers;
 let chunk=Buffer.from(JSON.stringify(json));chunk=Buffer.concat([chunk,Buffer.alloc((4-chunk.length%4)%4,32)]);const bin=source.subarray(binHeader);
 const header=Buffer.alloc(20);source.copy(header,0,0,12);header.writeUInt32LE(20+chunk.length+bin.length,8);header.writeUInt32LE(chunk.length,12);header.writeUInt32LE(0x4e4f534a,16);
 const bytes=Buffer.concat([header,chunk,bin]);const gltf=await new GLTFLoader().parseAsync(bytes.buffer.slice(bytes.byteOffset,bytes.byteOffset+bytes.byteLength),'');
 const v=new HumanViews();v.setTemplates([templateFromGltf('m04-canonical',gltf)]);return v;
}

test('actual rig flute prop returns, is reused on genuine next play and yields to native hand ownership',async()=>{
 const v=await views(),id='flute_fixture',show=(activity:string,age:number,extra:Partial<SampledHuman>={})=>{v.setFrame([{id,p:[0,0,0],yaw:0,walk:0,walkDist:0,activity,activityAge:age,baseActivity:'idle',...extra}],100+age);v.render(1);};
 show('play-music',2,{instrument:'flute'});const slot=(v as unknown as {views:Map<string,{prop:{kind:string;obj:import('three').Object3D}}>}).views.get(id)!,prop=slot.prop.obj;assert.equal(slot.prop.kind,'flute');assert.equal(prop.visible,true);assert.ok(prop.matrix.elements.every(Number.isFinite));const diag=v.bones(id)[id];assert.ok(diag.arms.every(a=>a.target&&a.palm.every(Number.isFinite)),'both genuine arm goals');
 show('idle',.4,{prevActivity:'play-music',prevInstrument:'flute',prevActivityDuration:2});assert.equal(prop.visible,true,'cosmetic release');show('idle',1.5,{prevActivity:'play-music',prevInstrument:'flute'});assert.equal(prop.visible,false,'no stranded prop');show('play-music',2,{instrument:'flute'});assert.equal(slot.prop.obj,prop);assert.equal(prop.visible,true,'reused prop visible on genuine second play');
 show('idle',.1,{prevActivity:'play-music',prevInstrument:'flute',hands:{left:[.3,1,0]}});assert.equal(prop.visible,false,'native hand owner wins');show('walk',.1,{prevActivity:'play-music',prevInstrument:'flute',walk:1});assert.equal(prop.visible,false,'walking does not inherit flute release');
});
