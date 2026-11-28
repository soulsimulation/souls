import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {fileURLToPath} from 'node:url';
import * as THREE from 'three';
import {GLTFLoader} from 'three/addons/loaders/GLTFLoader.js';
import {templateFromGltf} from './people.ts';
import {CHARACTER_WIRE} from './character-wire.ts';
import {HumanViews, setHumanGround} from './humans.ts';

// Real production skeletons and clips: the seated loops carry no track for the whole-body bone.
const rigDir = process.env.HUMAN_RIG_DIR ?? fileURLToPath(new URL('../../public/modular/environment/', import.meta.url));
async function template(name: string) {
  const loader = new GLTFLoader();
  loader.register(() => ({name:'seated-facing-test-material', loadMaterial:async()=>new THREE.MeshStandardMaterial()}));
  const read = async (file:string) => {const b=await readFile(rigDir+'/'+file);return loader.parseAsync(b.buffer.slice(b.byteOffset,b.byteOffset+b.byteLength),'');};
  const wire=CHARACTER_WIRE[name as keyof typeof CHARACTER_WIRE];
  const mesh=await read(wire.mesh), clips=await read(wire.clips);
  mesh.animations=clips.animations;
  return templateFromGltf(name,mesh);
}
const degrees=(radians:number)=>radians*180/Math.PI;
/** Signed horizontal angle from the seat's forward (engine yaw: 0 faces +X) to a drawn direction. */
const off=(yaw:number,x:number,z:number)=>{const a=Math.atan2(z,x)-yaw;return degrees(Math.atan2(Math.sin(a),Math.cos(a)));};

test('a seated body draws its chest and head along the seat it was given', async t => {
  setHumanGround(()=>0);
  try {
    for (const name of ['casual','punk','woman']) await t.test(name, async () => {
      const source=await template(name);
      for (const yaw of [Math.PI/2,-.7]) for (const activity of ['sit','listen']) {
        const views=new HumanViews(),id='seated-facing-'+name+'-'+activity;views.setTemplates([source]);
        for (let i=0;i<=40;i++) {
          const age=i*.05;
          views.setFrame([{id,p:[0,0,0],yaw,walk:0,walkDist:0,activity,baseActivity:'sit',seatHeight:.465,activityAge:age}],age);views.render(1);
          if (i%10) continue;
          const holder=views.bodyObject(id)!;holder.updateMatrixWorld(true);
          // Chest: the horizontal normal of the drawn shoulder line. Head: the drawn head bone's model-forward axis.
          const [left,right]=views.bones(id)[id].arms.map(arm=>arm.shoulder),line=[left[0]-right[0],left[2]-right[2]];
          const forward=[Math.cos(yaw),Math.sin(yaw)],normal=[-line[1],line[0]],sign=normal[0]*forward[0]+normal[1]*forward[1]<0?-1:1;
          const chest=off(yaw,sign*normal[0],sign*normal[1]);
          const head=new THREE.Vector3(0,0,source.forward).transformDirection(holder.getObjectByName('Head')!.matrixWorld);
          const headOff=off(yaw,head.x,head.z);
          // The old fallback added 27 degrees to both. The seated clips themselves look about 11 degrees aside, and the
          // look-around variant some ids draw for plain 'sit' swings the head further, so the head is held to the
          // steady nodding loop.
          assert(Math.abs(chest)<5,`${name} ${activity} chest ${chest.toFixed(1)} degrees off the seat at ${age.toFixed(2)} s`);
          if(activity==='listen')assert(Math.abs(headOff)<15,`${name} ${activity} head ${headOff.toFixed(1)} degrees off the seat at ${age.toFixed(2)} s`);
        }
      }
    });
  } finally { setHumanGround(null); }
});
