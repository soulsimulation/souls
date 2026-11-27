import test from 'node:test';
import assert from 'node:assert/strict';
import { Group, Mesh, BoxGeometry, MeshBasicMaterial, BufferGeometry, Float32BufferAttribute, Uint16BufferAttribute, Bone, Skeleton, SkinnedMesh, Vector3, Quaternion, Matrix4 } from 'three';
import { DisplayedCameraObserver, drawnActivity, drawnTakeActivity, drawnRepresentation, DrawGeometry } from './observation.ts';
import { validateCameraObservation } from '../../../../packages/camera/src/observation.ts';
const version={world:'fixture',epoch:'live-1',revision:'draw-1'};
const root=()=>{const o=new Group();o.updateMatrixWorld(true);return o;};
test('final nested drawn transform and fractional depicted time win over sampled or restored positions',()=>{
 const parent=root(),body=root();parent.position.set(10,2,3);parent.rotation.y=Math.PI/2;parent.add(body);body.position.set(2,1,0);parent.updateMatrixWorld(true);
 const before=body.matrixWorld.toArray(), observer=new DisplayedCameraObserver();
 const result=observer.capture({version,tick:10.25,seconds:.5125,subjects:[{id:'walker',root:body,forwardLocal:[1,0,0]}]});
 assert.equal(result.status,'observed');if(result.status!=='observed')throw Error('fixture');const subject=result.value.subjects[0];if(subject.state!=='present')throw Error('fixture');
 assert.deepEqual(subject.transform.positionM,[10,3,1]);assert.ok(Math.abs(subject.facing!.value[2]+1)<1e-9);assert.equal(result.value.depicted.tick,10.25);
 assert.notEqual(validateCameraObservation(result.value).status,'rejected');assert.deepEqual(body.matrixWorld.toArray(),before);
 body.position.set(200,0,0);assert.deepEqual(subject.transform.positionM,[10,3,1]); // restoration/newest sample cannot rewrite the captured draw
});
test('held pose is read without forcing matrices or borrowing travel yaw; fallback metadata stays unknown',()=>{
 const body=root();body.position.x=100;body.updateMatrixWorld=()=>{throw Error('must not update held rig')};body.updateWorldMatrix=()=>{throw Error('must not update held rig')};
 const observer=new DisplayedCameraObserver(),result=observer.capture({version,tick:1,seconds:1,subjects:[{id:'floater',root:body,bounds:{min:[-.4,-.4,-.4],max:[.4,.4,.4]}}]});
 assert.equal(result.status,'observed');if(result.status!=='observed')throw Error('fixture');const s=result.value.subjects[0];if(s.state!=='present')throw Error('fixture');assert.deepEqual(s.transform.positionM,[0,0,0]);assert.equal(s.facing,null);assert.equal(s.carrier,null);assert.deepEqual(s.anchors.map(a=>a.role),['root']);
});
test('travel, stationary paired activity and stale activity stay distinct; seek/epoch drops movement history',()=>{
 const observer=new DisplayedCameraObserver(),a=root(),b=root();
 const subjects=()=>[{id:'actor',root:a,forwardLocal:[1,0,0] as const,activity:{kind:'dance',partner:'partner',validThroughSeconds:3}},{id:'partner',root:b,activity:{kind:'dance',partner:'actor'}}];
 observer.capture({version,tick:1,seconds:1,subjects:subjects()});observer.capture({version,tick:2,seconds:2,subjects:subjects()});assert.equal(observer.movement.get('actor')?.state,'activity');
 a.position.z=2;a.updateMatrixWorld(true);const moved=observer.capture({version,tick:3,seconds:3,subjects:subjects()});assert.equal(observer.movement.get('actor')?.state,'travel');
 if(moved.status!=='observed')throw Error('fixture');const s=moved.value.subjects[0];if(s.state!=='present')throw Error('fixture');assert.deepEqual(s.facing?.value,[1,0,0]);assert.deepEqual(s.travelMps?.value,[0,0,2]);assert.equal(s.activity?.roles[1].subject,'partner');
 observer.capture({version,tick:4,seconds:4,subjects:subjects()});assert.equal(observer.movement.get('actor')?.state,'stationary');assert.equal(observer.movement.get('actor')?.activity,null);
 assert.deepEqual(observer.capture({version,tick:2,seconds:2,subjects:subjects()}),{status:'rejected',reason:'camera.frame-out-of-order'});
 observer.capture({version:{...version,epoch:'history-seek-2'},tick:.25,seconds:.0125,subjects:subjects()});assert.equal(observer.movement.get('actor')?.state,'unknown');
 observer.capture({version:{...version,epoch:'history-seek-2'},tick:.5,seconds:.025,subjects:[]});assert.equal(observer.movement.size,0);
});
test('public role mapping never infers semantic roles from labels or proximity',()=>{
 assert.deepEqual(drawnActivity('wave',{partner:'other',label:'carrier',near:'boat'}),{kind:'wave',partner:'other'});
 assert.equal(drawnActivity(undefined,{label:'dancing'}),null);
});

test('held prop kinds are not object identities and hidden ancestors select the visible stand-in',()=>{
 assert.deepEqual(drawnActivity('read',{prop:'book',partner:'other'}),{kind:'read',partner:'other'});
 const hidden=root(),human=root(),standIn=root();hidden.visible=false;hidden.add(human);
 assert.equal(drawnRepresentation(human,standIn),standIn);
});
test('geometry envelopes include nested scale while unsupported shear is rejected explicitly',()=>{
 const body=root(),mesh=new Mesh(new BoxGeometry(2,4,2),new MeshBasicMaterial());body.add(mesh);body.scale.set(2,3,4);body.updateMatrixWorld(true);
 const observer=new DisplayedCameraObserver(),r=observer.capture({version,tick:1,seconds:1,subjects:[{id:'body',root:body}]});if(r.status!=='observed')throw Error('fixture');const s=r.value.subjects[0];if(s.state!=='present')throw Error('fixture');assert.deepEqual(s.bounds,{min:[-2,-6,-4],max:[2,6,4]});
 mesh.geometry.dispose();mesh.material.dispose();const parent=root();parent.scale.set(2,1,1);parent.add(body);body.rotation.y=.5;parent.updateMatrixWorld(true);const good=root();const mixed=observer.capture({version,tick:2,seconds:2,subjects:[{id:'good',root:good},{id:'body',root:body}]});if(mixed.status!=='observed')throw Error('fixture');assert.deepEqual(mixed.value.subjects.map(s=>s.id),['good']);assert.equal(observer.unsupported.get('body'),'camera.subject-transform-unsupported');assert.equal(observer.movement.has('body'),false);
});

test('skinned envelopes contain Three actual animated vertices with nonidentity bind and root; replacement invalidates',()=>{
 const body=root();body.position.set(4,2,-3);body.rotation.y=.7;
 const geometry=new BufferGeometry();geometry.setAttribute('position',new Float32BufferAttribute([0,0,0,1,2,0,-1,1,1],3));geometry.setAttribute('skinIndex',new Uint16BufferAttribute([0,1,0,0,0,1,0,0,0,1,0,0],4));geometry.setAttribute('skinWeight',new Float32BufferAttribute([.3,.7,0,0,.5,.5,0,0,.8,.2,0,0],4));
 const a=new Bone(),b=new Bone();a.add(b);b.position.y=1;const mesh=new SkinnedMesh(geometry,new MeshBasicMaterial());mesh.add(a);body.add(mesh);body.updateMatrixWorld(true);mesh.bind(new Skeleton([a,b]),new Matrix4().makeTranslation(.4,.2,-.1));b.rotation.z=.6;a.rotation.x=.2;body.updateMatrixWorld(true);mesh.skeleton.update();
 const observer=new DisplayedCameraObserver(),capture=()=>observer.capture({version,tick:1,seconds:1,subjects:[{id:'skin',root:body}],geometryWork:65536});const result=capture();if(result.status!=='observed'||result.value.subjects[0].state!=='present')throw Error('fixture');const bounds=result.value.subjects[0].bounds!;
 const inverse=new Matrix4().compose(body.position,body.quaternion,new Vector3(1,1,1)).invert();
 for(let i=0;i<3;i++){const p=mesh.getVertexPosition(i,new Vector3()).applyMatrix4(mesh.matrixWorld).applyMatrix4(inverse).toArray();for(let j=0;j<3;j++)assert.ok(p[j]>=bounds.min[j]-1e-6&&p[j]<=bounds.max[j]+1e-6,`vertex ${i} axis ${j}`);}
 body.remove(mesh);const replacement=new Mesh(new BoxGeometry(20,20,20),new MeshBasicMaterial());body.add(replacement);body.updateMatrixWorld(true);const replaced=capture();if(replaced.status!=='observed'||replaced.value.subjects[0].state!=='present')throw Error('fixture');assert.ok(replaced.value.subjects[0].bounds!.max[0]>9);
});
test('geometry construction obeys shared explicit work grants and eventually publishes complete detail',()=>{
 const body=root();body.add(new Mesh(new BoxGeometry(2,2,2),new MeshBasicMaterial()));body.updateMatrixWorld(true);const geometry=new DrawGeometry();
 const grant={remaining:1};assert.equal(geometry.inspect(body,new Vector3(),new Quaternion(),false,grant).bounds,null);assert.equal(grant.remaining,0);
 assert.ok(geometry.inspect(body,new Vector3(),new Quaternion(),false,{remaining:1000}).bounds);
});

test('real take coverage bounds activity freshness in live and history without a fabricated TTL',()=>{
 const activity=drawnTakeActivity('read',{prop:'book'},{startTick:20,ticks:10,dt:.05});assert.deepEqual(activity,{kind:'read',validThroughSeconds:1.5});assert.equal(drawnTakeActivity('read',{},null),null);
 const observer=new DisplayedCameraObserver(),body=root();observer.capture({version,tick:29.5,seconds:1.475,subjects:[{id:'reader',root:body,activity}]});const after=observer.capture({version,tick:30.5,seconds:1.525,subjects:[{id:'reader',root:body,activity}]});if(after.status!=='observed'||after.value.subjects[0].state!=='present')throw Error('fixture');assert.equal(after.value.subjects[0].activity,null);
});

test('wide hierarchies decline detail before enqueueing children or allocating bone envelopes',()=>{
 const body=root();for(let i=0;i<300;i++)body.add(root());const grant={remaining:1000};assert.equal(new DrawGeometry().inspect(body,new Vector3(),new Quaternion(),false,grant).bounds,null);assert.equal(grant.remaining,1000);
});

test('morph target geometry explicitly declines unsupported detailed envelopes',()=>{
 const body=root(),mesh=new Mesh(new BoxGeometry(2,2,2),new MeshBasicMaterial());body.add(mesh);body.updateMatrixWorld(true);mesh.geometry.morphAttributes.position=[mesh.geometry.attributes.position.clone()];assert.equal(new DrawGeometry().inspect(body,new Vector3(),new Quaternion(),false,{remaining:1000}).bounds,null);
});

test('rotated non-sphere has unknown cold bounds until actual drawn geometry is complete',()=>{
 const holder=root(),mesh=new Mesh(new BoxGeometry(2,2,2),new MeshBasicMaterial());mesh.rotation.z=Math.PI/4;holder.add(mesh);holder.updateMatrixWorld(true);
 const observer=new DisplayedCameraObserver();
 const cold=observer.capture({version,tick:1,seconds:1,geometryWork:0,subjects:[{id:'floater',root:holder}]});if(cold.status!=='observed'||cold.value.subjects[0].state!=='present')throw Error('fixture');assert.equal(cold.value.subjects[0].bounds,null,'radius alone cannot bound tilted model');
 const warm=observer.capture({version,tick:2,seconds:2,geometryWork:2048,subjects:[{id:'floater',root:holder}]});if(warm.status!=='observed'||warm.value.subjects[0].state!=='present')throw Error('fixture');assert.ok(warm.value.subjects[0].bounds!.max[0]>1.4,'actual rotated model exceeds unit-radius axes');
});
