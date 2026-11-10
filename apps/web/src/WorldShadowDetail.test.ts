import {test} from 'node:test';
import assert from 'node:assert/strict';
import * as THREE from 'three';
import {WorldShadowDetail} from './WorldShadowDetail.ts';

test('shadow detail: far small casters skip the shadow pass for one frame; restore undoes it and holds no mesh (P2 churn)', () => {
  const root=new THREE.Group(),caster=(r:number,z:number)=>{const m=new THREE.Mesh(new THREE.SphereGeometry(r,6,4),new THREE.MeshBasicMaterial());m.position.set(0,0,z);m.castShadow=true;root.add(m);return m;};
  const near=caster(0.5,-10),far=caster(0.5,-200),big=caster(20,-200);
  const detail=new WorldShadowDetail(root),off=(detail as unknown as {off:unknown[]}),camera=new THREE.Vector3();
  for(let frame=0;frame<4;frame++){
    detail.apply(camera);
    assert.deepEqual([near.castShadow,far.castShadow,big.castShadow,detail.skipped],[true,false,true,1],'frame '+frame);
    detail.restore();
    assert.equal(far.castShadow,true);assert.ok(off.off.every(m=>m===null));
  }
  detail.dispose();assert.equal(off.off.length,0);
});
