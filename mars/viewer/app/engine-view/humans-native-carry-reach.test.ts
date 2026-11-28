// A held beam's far hand through a lift, on the production rigs. The carried load's two contacts lie along it, one
// near the carrier and one 0.4 m further (the world's holds: 0.2 m either side of a grip the carrier stands 0.35 m
// beyond). Seen on the served page (carry proof, attempts 8 and 9): the near palm on its contact, the far palm up to
// 3.8 cm short and changing every frame as the beam rose.
import test from'node:test';import assert from'node:assert/strict';import{readFile}from'node:fs/promises';import{fileURLToPath}from'node:url';import{createHash}from'node:crypto';import*as THREE from'three';import{GLTFLoader}from'three/addons/loaders/GLTFLoader.js';
import{CHARACTER_WIRE,CHARACTER_CLIPS}from'./character-wire.ts';import{templateFromGltf}from'./people.ts';import{HumanViews,setHumanGround}from'./humans.ts';
const dir=process.env.HUMAN_RIG_DIR??fileURLToPath(new URL('../../public/modular/environment/',import.meta.url));
async function template(name:'woman'|'casual'){const loader=new GLTFLoader(),wire=CHARACTER_WIRE[name];const load=async(file:string,hash:string)=>{const b=await readFile(dir+'/'+file);assert.equal(createHash('sha256').update(b).digest('hex'),hash);return loader.parseAsync(b.buffer.slice(b.byteOffset,b.byteOffset+b.byteLength),'');};const mesh=await load(wire.mesh,wire.meshSHA256);mesh.animations=(await load(wire.clips,CHARACTER_CLIPS[wire.clips].sha256)).animations;return templateFromGltf(name,mesh);}
test('both palms stay on a rising beam\'s two contacts from the ground to carry height, either hand the far one',async ctx=>{
 setHumanGround(()=>0);try{for(const model of ['woman','casual']as const){const t=await template(model),v=new HumanViews();v.setTemplates([t]);v.setBodyTemplates(new Map([[model,t]]));
  for(const far of ['left','right']as const){let worst=0,at=0,time=100;
   for(let y=.06;y<=.92;y+=.01){const near:[number,number,number]=[.15,y,0],beyond:[number,number,number]=[.55,y,0],hands=far==='right'?{left:near,right:beyond}:{left:beyond,right:near};
    time+=1/60;v.setFrame([{id:'beam-end',bodyModel:model,p:[0,0,0],yaw:0,walk:0,walkDist:0,activity:'idle',restAge:10,hands,carryWeight:1}],time);v.render(1);
    assert.deepEqual(v.bodyObject('beam-end')!.position.toArray(),[0,0,0],'the body stays where the world has it');
    for(const side of ['left','right']as const){const p=new THREE.Vector3();assert(v.palmOf('beam-end',side,p));const e=p.distanceTo(new THREE.Vector3(...hands[side]));if(e>worst){worst=e;at=y;}}}
   ctx.diagnostic(JSON.stringify({model,far,worstM:+worst.toFixed(4),atHeightM:+at.toFixed(2)}));
   assert(worst<=.01,`${model}, far hand ${far}: a palm ${worst.toFixed(4)} m from its contact with the beam at ${at.toFixed(2)} m`);}
  v.clear();}}finally{setHumanGround(null);}});
test('a walking carrier keeps both palms on the beam at carry height, the load ahead of it or behind',async ctx=>{
 setHumanGround(()=>0);try{for(const model of ['woman','casual']as const){const t=await template(model),v=new HumanViews();v.setTemplates([t]);v.setBodyTemplates(new Map([[model,t]]));
  // the body faces +x (its hold) and walks at 1.4 m/s: toward the load (the back carrier) or away from it (the front)
  for(const dir of [1,-1]){let worst=0,time=200,x=0;
   for(let k=0;k<180;k++){time+=1/60;x+=dir*1.4/60;const hands={left:[x+.15,.9,0]as[number,number,number],right:[x+.55,.9,0]as[number,number,number]};
    v.setFrame([{id:'walker'+dir,bodyModel:model,p:[x,0,0],yaw:0,walk:1,walkDist:Math.abs(x),speed:1.4,activity:'walk',restAge:0,hands,carryWeight:1}],time);v.render(1);
    if(k<30)continue; // the stand-to-walk blend
    for(const side of ['left','right']as const){const p=new THREE.Vector3();assert(v.palmOf('walker'+dir,side,p));worst=Math.max(worst,p.distanceTo(new THREE.Vector3(...hands[side])));}}
   ctx.diagnostic(JSON.stringify({model,dir,worstM:+worst.toFixed(4)}));
   assert(worst<=.02,`${model}, walking ${dir>0?'toward':'away from'} its hold: a palm ${worst.toFixed(4)} m from its contact`);}
  v.clear();}}finally{setHumanGround(null);}});

