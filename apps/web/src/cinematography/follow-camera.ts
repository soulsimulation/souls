/** Experimental camera policy and bounded rendered-geometry queries. No actor or scene writes. */
import {Box3,Matrix4,Mesh,Quaternion,Ray,Vector3} from 'three';
import type {Object3D,BufferGeometry,InstancedMesh,PerspectiveCamera} from 'three';
import {cameraGroundSampler} from '../WorldCameraGround.ts';
import type {SceneInfo} from '../WorldGeometry.ts';
import type {CameraSubject} from '../../../../packages/camera/src/observation.ts';
export type PresentSubject=Extract<CameraSubject,{state:'present'}>;
export function publishedFollowGround(info:Pick<SceneInfo,'scene'|'shore'>|null){return !info||(info.scene?.surfaces.length??0)>256?undefined:cameraGroundSampler(info);}
export type Sight='clear'|'blocked'|'unknown';
export const FOLLOW_LIMITS=Object.freeze({visits:256,objects:4096,meshes:2048,depth:64,vertices:4096,triangles:12000,blocks:4096,blockVisits:4096,blockTriangles:64,instances:512,candidates:7,speed:5,acceleration:5,aimSpeed:4,aimAcceleration:8});
type Scan={node:Object3D;child:number;entered:boolean};
type Bounds={position:unknown;version:number;count:number;next:number;box:Box3;invalid:boolean};
type Blocks={bounds:Bounds;index:unknown;version:number;count:number;start:number;end:number;next:number;boxes:Box3[];pending:Box3;complete:boolean;invalid:boolean};
const visible=(o:Object3D)=>{let depth=0;for(let p:Object3D|null=o;p;p=p.parent){if(++depth>64||!p.visible)return false;}return true;};
/** Incremental collection over actual rendered roots. Each incomplete pass remains explicitly unknown.
 * Bounds belong to this reader; it never asks Three to compute or update shared geometry/matrices. */
export class FollowGeometry{
 private rootOf=new WeakMap<Mesh,Object3D>();private structure=new Map<Object3D,Object3D[]>();private roots:readonly Object3D[]=[];private revision='';private stack:Scan[]=[];private seen=new Set<Object3D>();private meshes:Mesh[]=[];private bounds=new Map<BufferGeometry,Bounds>();private blocks=new Map<BufferGeometry,Blocks>();private retainedBlocks=0;private requested=new Set<BufferGeometry>();private edges=0;private nextRoot=0;private failed=false;
 private ray=new Ray();private inverse=new Matrix4();private matrix=new Matrix4();private instance=new Matrix4();private a=new Vector3();private b=new Vector3();private c=new Vector3();private hit=new Vector3();
 stats={structure:0,visits:0,vertices:0,triangles:0,blockVisits:0,retainedBlocks:0,instances:0,queries:0,complete:false,meshes:0,unknown:null as string|null,unknownMesh:null as Record<string,unknown>|null};
 reset(keepGeometry=false){this.rootOf=new WeakMap();this.roots=[];this.stack=[];this.seen.clear();this.structure.clear();this.meshes=[];if(!keepGeometry){this.bounds.clear();this.blocks.clear();this.requested.clear();this.retainedBlocks=0;}this.nextRoot=0;this.edges=0;this.failed=false;}
 prepare(roots:readonly Object3D[],revision:string){
  let structureChanged=false,structureWork=0;for(const [node,children]of this.structure){structureWork++;if(node.children.length!==children.length){structureChanged=true;break;}for(let i=0;i<children.length;i++){structureWork++;if(node.children[i]!==children[i]){structureChanged=true;break;}}if(structureChanged)break;}
  if(structureChanged||revision!==this.revision||roots.length!==this.roots.length||roots.some((r,i)=>r!==this.roots[i])){this.reset(true);this.roots=[...roots];this.revision=revision;}
  this.stats={structure:structureWork,visits:0,vertices:0,triangles:0,blockVisits:0,retainedBlocks:this.retainedBlocks,instances:0,queries:0,complete:false,meshes:this.meshes.length,unknown:null,unknownMesh:null};
  if(!roots.length||roots.length>32||this.failed){this.stats.unknown='geometry-unavailable';return;}
  while(this.stats.visits<FOLLOW_LIMITS.visits&&(this.stack.length||this.nextRoot<this.roots.length)){
   if(!this.stack.length)this.stack.push({node:this.roots[this.nextRoot++],child:0,entered:false});
   const top=this.stack.at(-1)!;this.stats.visits++;
   if(!top.entered){top.entered=true;if(this.seen.has(top.node)){this.stack.pop();continue;}this.seen.add(top.node);if((this.edges+=top.node.children.length)>FOLLOW_LIMITS.objects){this.failed=true;break;}this.structure.set(top.node,[...top.node.children]);if(this.seen.size>FOLLOW_LIMITS.objects){this.failed=true;break;}
    const m=top.node as Mesh;if(m.isMesh&&m.userData.cameraTransparent!==true){if(this.meshes.length>=FOLLOW_LIMITS.meshes){this.failed=true;break;}this.meshes.push(m);this.rootOf.set(m,this.roots[this.nextRoot-1]);}}
   if(top.child<top.node.children.length){if(this.stack.length>=FOLLOW_LIMITS.depth){this.failed=true;break;}this.stack.push({node:top.node.children[top.child++],child:0,entered:false});}else this.stack.pop();
  }
  // Cold geometry is admitted incrementally, with a shared vertex budget across this frame.
  let incomplete=false;
  for(const mesh of this.meshes){const g=mesh.geometry,p=g?.attributes.position;if(!p){incomplete=true;continue;}const version='version'in p?p.version:p.data.version;
   let cache=this.bounds.get(g);if(!cache||cache.position!==p||cache.version!==version||cache.count!==p.count){if(!cache&&this.bounds.size>=FOLLOW_LIMITS.meshes){incomplete=true;continue;}cache={position:p,version,count:p.count,next:0,box:new Box3(),invalid:false};this.bounds.set(g,cache);}
   while(cache.next<p.count&&this.stats.vertices<FOLLOW_LIMITS.vertices){this.a.fromBufferAttribute(p,cache.next++);if(!Number.isFinite(this.a.x)||!Number.isFinite(this.a.y)||!Number.isFinite(this.a.z))cache.invalid=true;else cache.box.expandByPoint(this.a);this.stats.vertices++;}
   if(cache.next<p.count||cache.invalid)incomplete=true;
  }
  // Retain immutable local geometry work across collection changes, but not dead meshes.
  // Acceleration is prepared only for geometry actually intersected by prior query bounds.
  // Both maps are bounded by collected meshes; blocks additionally have a global cap.
  if(!this.stack.length&&this.nextRoot===this.roots.length){const used=new Set(this.meshes.map(m=>m.geometry));for(const g of this.bounds.keys())if(!used.has(g)){this.bounds.delete(g);const old=this.blocks.get(g);if(old)this.retainedBlocks-=old.boxes.length;this.blocks.delete(g);this.requested.delete(g);}}
  for(const mesh of this.meshes){const g=mesh.geometry,p=g?.attributes.position,cache=this.bounds.get(g);if(!p||!cache||cache.next<p.count||cache.invalid||!this.requested.has(g))continue;
   const ix=g.index,start=Math.max(0,g.drawRange.start),end=Math.min(ix?.count??p.count,start+g.drawRange.count),version=ix?.version??0,count=ix?.count??p.count;
   let blocks=this.blocks.get(g);if(blocks&&(blocks.bounds!==cache||blocks.index!==ix||blocks.version!==version||blocks.count!==count||blocks.start!==start||blocks.end!==end)){this.retainedBlocks-=blocks.boxes.length;this.blocks.delete(g);blocks=undefined;}
   if(!blocks){blocks={bounds:cache,index:ix,version,count,start,end,next:start,boxes:[],pending:new Box3(),complete:false,invalid:false};this.blocks.set(g,blocks);}
   while(!blocks.complete&&!blocks.invalid&&blocks.next+2<end&&this.stats.vertices+3<=FOLLOW_LIMITS.vertices){
    // A partially built block reserves one slot too. Never grow past the retained cap.
    if(blocks.pending.isEmpty()){if(this.retainedBlocks>=FOLLOW_LIMITS.blocks)break;blocks.boxes.push(blocks.pending);this.retainedBlocks++;}
    for(let j=0;j<3;j++){const at=blocks.next+j,index=ix?ix.getX(at):at;this.stats.vertices++;if(!Number.isSafeInteger(index)||index<0||index>=p.count){blocks.invalid=true;break;}this.a.fromBufferAttribute(p,index);blocks.pending.expandByPoint(this.a);}blocks.next+=3;
    if((blocks.next-start)%(FOLLOW_LIMITS.blockTriangles*3)===0)blocks.pending=new Box3();
   }
   blocks.complete=!blocks.invalid&&blocks.next+2>=end;
  }
  this.stats.retainedBlocks=this.retainedBlocks;
  this.stats.meshes=this.meshes.length;this.stats.complete=!this.failed&&!this.stack.length&&this.nextRoot===this.roots.length&&!incomplete;this.stats.unknown=this.stats.complete?null:this.failed?'geometry-cap':'geometry-warming';
 }
 segment(from:Vector3,to:Vector3):Sight{
  const unknown=(reason:string,mesh?:Mesh):Sight=>{this.stats.unknown=reason;if(mesh){const materials=Array.isArray(mesh.material)?mesh.material:[mesh.material];this.stats.unknownMesh={name:mesh.name.slice(0,128),type:mesh.type.slice(0,64),constructor:mesh.constructor.name.slice(0,64),root:this.rootOf.get(mesh)?.name.slice(0,128)??null,geometry:mesh.geometry.type.slice(0,64),blockComplete:this.blocks.get(mesh.geometry)?.complete??false,builtBlocks:this.blocks.get(mesh.geometry)?.boxes.length??0,blockNext:this.blocks.get(mesh.geometry)?.next??null,retainedBlocks:this.retainedBlocks,vertices:mesh.geometry.attributes.position?.count??null,skinned:!!(mesh as Mesh&{isSkinnedMesh?:boolean}).isSkinnedMesh,morphCount:mesh.geometry.morphAttributes.position?.length??0,customRaycast:mesh.raycast!==Mesh.prototype.raycast,shadowProxy:mesh.userData.shadowProxy===true,materialCount:materials.length,materials:materials.slice(0,4).map(m=>({name:m.name.slice(0,64),type:m.type.slice(0,64),visible:m.visible,colorWrite:m.colorWrite,depthWrite:m.depthWrite,transparent:m.transparent,opacity:m.opacity}))};}return'unknown';};this.stats.queries++;if(!this.stats.complete)return'unknown';const length=from.distanceTo(to);if(length===0)return'clear';let invalidMatrix=false;
  for(const mesh of this.meshes){if(!visible(mesh))continue;const materials=Array.isArray(mesh.material)?mesh.material:[mesh.material];if(materials.length>64)return unknown('material-cap',mesh);
   // The renderer's explicit shadow proxy clips every vertex in the colour pass.
   // Its disabled picking hook is not unsupported visible geometry.
   if(mesh.userData.shadowProxy===true&&materials.length===1&&materials[0].name==='shadow-proxy'&&materials[0].type==='ShaderMaterial'&&!materials[0].colorWrite&&!materials[0].depthWrite)continue;
   if(materials.every(m=>!m.visible||m.transparent&&m.opacity<.5))continue;
   const g=mesh.geometry,bounds=this.bounds.get(g),p=g.attributes.position;if(!bounds||bounds.next<p.count||bounds.invalid)return unknown('bounds-incomplete',mesh);if(!Number.isSafeInteger(g.drawRange.start)||g.drawRange.start<0||g.drawRange.count!==Infinity&&(!Number.isSafeInteger(g.drawRange.count)||g.drawRange.count<0)||this.blocks.get(g)?.invalid)return unknown('invalid-drawn-geometry',mesh);
   // Unsupported deformation has no proven conservative bounds. Refuse before culling.
   if((mesh as Mesh&{isSkinnedMesh?:boolean}).isSkinnedMesh||g.morphAttributes.position?.length||mesh.raycast!==Mesh.prototype.raycast&&!(mesh as InstancedMesh).isInstancedMesh)return unknown('unsupported-deformation-or-raycast',mesh);
   const instances=(mesh as InstancedMesh).isInstancedMesh?(mesh as InstancedMesh).count:1;
   for(let n=0;n<instances;n++){
    if((mesh as InstancedMesh).isInstancedMesh&&++this.stats.instances>FOLLOW_LIMITS.instances)return unknown('instance-cap',mesh);this.matrix.copy(mesh.matrixWorld);if((mesh as InstancedMesh).isInstancedMesh){(mesh as InstancedMesh).getMatrixAt(n,this.instance);this.matrix.multiply(this.instance);}
    if(!this.matrix.elements.every(Number.isFinite)||Math.abs(this.matrix.determinant())<1e-12){invalidMatrix=true;continue;}
    this.inverse.copy(this.matrix).invert();this.a.copy(from).applyMatrix4(this.inverse);this.b.copy(to).applyMatrix4(this.inverse);const localLength=this.a.distanceTo(this.b);this.ray.set(this.a,this.c.copy(this.b).sub(this.a).normalize());
    const entry=this.ray.intersectBox(bounds.box,this.hit);if(!entry||!bounds.box.containsPoint(this.ray.origin)&&entry.distanceTo(this.ray.origin)>localLength)continue;
    if(this.requested.size<FOLLOW_LIMITS.meshes)this.requested.add(g);
    const ix=g.index,start=Math.max(0,g.drawRange.start),end=Math.min(ix?.count??p.count,start+g.drawRange.count);
    const blocks=this.blocks.get(g),accelerated=blocks?.complete===true,step=FOLLOW_LIMITS.blockTriangles*3;
    for(let first=start;first+2<end;first+=step){
     if(accelerated){if(this.stats.blockVisits>=FOLLOW_LIMITS.blockVisits)return unknown('block-query-cap',mesh);this.stats.blockVisits++;const box=blocks.boxes[Math.floor((first-start)/step)],entry=this.ray.intersectBox(box,this.hit);if(!entry||!box.containsPoint(this.ray.origin)&&entry.distanceTo(this.ray.origin)>localLength)continue;}
     // Incomplete acceleration falls back to the original bounded exact scan, never an empty block.
     for(let i=first;i+2<Math.min(end,first+step);i+=3){if(++this.stats.triangles>FOLLOW_LIMITS.triangles)return unknown('triangle-cap',mesh);const ia=ix?ix.getX(i):i,ib=ix?ix.getX(i+1):i+1,ic=ix?ix.getX(i+2):i+2;if(![ia,ib,ic].every(n=>Number.isSafeInteger(n)&&n>=0&&n<p.count))return unknown('invalid-drawn-geometry',mesh);this.a.fromBufferAttribute(p,ia);this.b.fromBufferAttribute(p,ib);this.c.fromBufferAttribute(p,ic);const h=this.ray.intersectTriangle(this.a,this.b,this.c,false,this.hit);if(h){const d=h.distanceTo(this.ray.origin);if(d<=localLength+1e-9*Math.max(1,localLength))return'blocked';}}
    }
   }
  }
  return invalidMatrix?unknown('invalid-transform'):'clear';
 }
}
function approach(value:Vector3,velocity:Vector3,goal:Vector3,dt:number,speed:number,acceleration:number,tau:number){
 const desired=goal.clone().sub(value).multiplyScalar(1/tau).clampLength(0,speed),change=desired.sub(velocity).clampLength(0,acceleration*dt);velocity.add(change);value.addScaledVector(velocity,dt);
}
export type FollowResult={eye:Vector3;aim:Vector3;reason:string;candidate:number;screen:[number,number];candidates:number;motion:{groundY:number|null;sweep:Sight|null;unknown:string|null;unknownMesh:Record<string,unknown>|null}|null};
/** Persistent world-space viewpoints let the subject turn inside a portrait dead/soft zone. */
export class FollowCamera{
 private eye=new Vector3();private aim=new Vector3();private velocity=new Vector3();private aimVelocity=new Vector3();private offset=new Vector3();private anchor:Vector3|null=null;private initialized=false;private clock=0;private nextSearch=0;private heldUntil=0;private gestureUntil=0;private index=0;private probe=0;
 reset(eye?:Vector3,aim?:Vector3){this.anchor=null;this.initialized=!!eye&&!!aim;if(eye&&aim){this.eye.copy(eye);this.aim.copy(aim);}this.velocity.set(0,0,0);this.aimVelocity.set(0,0,0);this.clock=this.nextSearch=this.heldUntil=this.gestureUntil=0;this.index=0;}
 gesture(eye:Vector3,aim:Vector3){if(!this.initialized)this.reset(eye,aim);this.eye.copy(eye);this.aim.copy(aim);if(this.anchor)this.offset.copy(eye).sub(this.anchor);this.aimVelocity.set(0,0,0);this.gestureUntil=this.clock+2;}
 step(subject:PresentSubject,camera:PerspectiveCamera,aim:Vector3,dt:number,geometry:FollowGeometry,ground:(x:number,z:number)=>number|null):FollowResult{
  if(!this.initialized)this.reset(camera.position,aim);const invalidStep=!Number.isFinite(dt)||dt<0;dt=invalidStep?0:Math.min(.05,dt);this.clock+=dt;const manual=this.clock<this.gestureUntil;if(manual||invalidStep){this.eye.copy(camera.position);this.aim.copy(aim);}
  const q=new Quaternion().fromArray(subject.transform.rotationXyzw),bounds=subject.bounds,root=new Vector3().fromArray(subject.transform.positionM);
  const centre=bounds?new Vector3().fromArray(bounds.min).add(new Vector3().fromArray(bounds.max)).multiplyScalar(.5).applyQuaternion(q).add(root):null;
  let motion:FollowResult['motion']=null;const result=(reason:string,screen:[number,number]=[0,0],candidates=0)=>({eye:this.eye.clone(),aim:this.aim.clone(),reason,candidate:this.index,screen,candidates,motion});
  if(invalidStep){this.velocity.set(0,0,0);this.aimVelocity.set(0,0,0);return result('invalid-timestep');}
  if(!centre||!geometry.stats.complete){this.velocity.set(0,0,0);this.aimVelocity.set(0,0,0);return result((manual?'user-hold:':'')+(!centre?'subject-bounds-unknown':geometry.stats.unknown??'geometry-unknown'));}
  // Reset and gestures preserve the actual eye. Translation is relative to the
  // depicted root, independently of framing aim and animated bounds centre.
  if(!this.anchor){this.anchor=root.clone();this.offset.copy(this.eye).sub(root);}else this.anchor.copy(root);
  const projected=centre.clone().project(camera);if(!Number.isFinite(projected.x)||!Number.isFinite(projected.y))return result('projection-unavailable');
  if(!manual&&centre.clone().sub(camera.position).dot(new Vector3(0,0,-1).applyQuaternion(camera.quaternion))<=camera.near)return result('subject-behind-view');
  if(!manual&&projected.z>1)return result('projection-unavailable');
  const screen:[number,number]=[projected.x,projected.y];
  const manualEye=manual?this.eye.clone():null;
  const top=new Vector3(0,bounds!.max[1],0).applyQuaternion(q).add(root);
  const points=[centre,top.clone().lerp(centre,.25)];let tested=0;
  const query=(eye:Vector3):number|null=>{const y=ground(eye.x,eye.z);if(y===null||!Number.isFinite(y))return null;if(eye.y<y+1.2)return-1;let clear=0;for(const p of points){const s=geometry.segment(eye,p);if(s==='unknown')return null;clear+=s==='clear'?1:0;}return clear/points.length;};
  let reason='tracking';
  const goal=root.clone().add(this.offset),next=this.eye.clone(),nextVelocity=this.velocity.clone();approach(next,nextVelocity,goal,dt,FOLLOW_LIMITS.speed,FOLLOW_LIMITS.acceleration,.8);
  const groundY=ground(next.x,next.z),sweep=geometry.segment(this.eye,next);motion={groundY,sweep,unknown:sweep==='unknown'?geometry.stats.unknown:null,unknownMesh:sweep==='unknown'?geometry.stats.unknownMesh:null};if(groundY!==null&&Number.isFinite(groundY)&&next.y>=groundY+1.2&&sweep==='clear'){this.eye.copy(next);this.velocity.copy(nextVelocity);}else{this.velocity.set(0,0,0);reason=groundY===null||!Number.isFinite(groundY)?'ground-unavailable':next.y<groundY+1.2?'below-ground-margin':sweep==='blocked'?'motion-obstructed':'motion-unknown';}
  // A Follow gesture changes its orbit/zoom, not the subject's world translation.
  // Carry eye and aim together so orientation stays exactly the user's, while the
  // normal bounded safety sweep continues. Search/framing wait until input settles.
  if(manualEye){this.aim.add(this.eye.clone().sub(manualEye));return result(reason==='tracking'?'user-hold':'user-hold:'+reason,screen);}
  // Movement gets the first query budget. Probe one alternative per search tick, never
  // consume a whole candidate fan before the safety sweep has run.
  if(dt>0&&this.clock>=this.nextSearch){this.nextSearch=this.clock+.25;const angles=[Math.PI/6,-Math.PI/6,Math.PI/3,-Math.PI/3,Math.PI/2,-Math.PI/2],i=this.probe++%angles.length;
   const current=query(root.clone().add(this.offset)),offset=this.offset.clone().applyAxisAngle(new Vector3(0,1,0),angles[i]),eye=root.clone().add(offset);tested=2;
   const alternative=query(eye),passage=geometry.segment(this.eye,eye);
   if(current!==null&&alternative!==null&&alternative>current+.25&&passage==='clear'&&this.clock>=this.heldUntil){this.offset.copy(offset);this.index=i+1;this.heldUntil=this.clock+2;reason='viewpoint-change';}
  }
  // Rebase from the previous drawn eye along its actual viewing ray onto the
  // subject-depth plane. Subsequent eye translation then compensates around that
  // nearby world aim instead of also demanding a second pan to follow the eye.
  // This changes only its representation, not orientation. A persistent world aim
  // otherwise recedes behind a walking subject and makes the same pan ever slower.
  const forward=new Vector3(0,0,-1).applyQuaternion(camera.quaternion),right=new Vector3(1,0,0).applyQuaternion(camera.quaternion),up=new Vector3(0,1,0).applyQuaternion(camera.quaternion),relative=centre.clone().sub(camera.position),depth=relative.dot(forward);
  if(depth<=camera.near)return result('subject-behind-view',screen,tested);
  const previousDepth=Math.max(.5,this.aim.distanceTo(camera.position)),vertical=depth*Math.tan(camera.fov*Math.PI/360);
  this.aim.copy(camera.position).addScaledVector(forward,depth);
  this.aimVelocity.addScaledVector(forward,-this.aimVelocity.dot(forward)).multiplyScalar(depth/previousDepth).clampLength(0,FOLLOW_LIMITS.aimSpeed);
  const x=relative.dot(right)/(vertical*camera.aspect),y=relative.dot(up)/vertical;
  const aimGoal=centre.clone().addScaledVector(right,-Math.max(-.14,Math.min(.14,x))*vertical*camera.aspect).addScaledVector(up,-Math.max(-.10,Math.min(.10,y))*vertical);
  approach(this.aim,this.aimVelocity,aimGoal,dt,FOLLOW_LIMITS.aimSpeed,FOLLOW_LIMITS.aimAcceleration,.3);
  return result(reason,screen,tested);
 }
}
