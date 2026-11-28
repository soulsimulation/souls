/** Experimental camera policy and bounded rendered-geometry queries. No actor or scene writes. */
import {Box3,Matrix4,Mesh,PerspectiveCamera,Quaternion,Ray,Triangle,Vector3} from 'three';
import type {Object3D,BufferGeometry,InstancedMesh} from 'three';
import {cameraGroundSampler} from '../WorldCameraGround.ts';
import type {SceneInfo} from '../WorldGeometry.ts';
import {composeVisibleViewport,visibleViewport} from '../WorldViewport.ts';
import {fitNearPlane} from '../../../../mars/viewer/lib/depth-fit.ts';
import type {ViewportInsets} from '../WorldViewport.ts';
export type FollowProjection={width:number;height:number;insets?:ViewportInsets;fov:number};
export type FollowViewport={width:number;height:number;insets?:ViewportInsets};
import type {EnclosureResult} from './enclosure.ts';
import {InteriorView,type InteriorDiagnostic} from './interior.ts';
import {CutAuthority,CUT_LIMITS,prepareCutFrame,type CutDiagnostic} from './transitions.ts';
import type {CameraSubject} from '../../../../packages/camera/src/observation.ts';
export type PresentSubject=Extract<CameraSubject,{state:'present'}>;
export function publishedFollowGround(info:Pick<SceneInfo,'scene'|'shore'>|null){return !info||(info.scene?.surfaces.length??0)>256?undefined:cameraGroundSampler(info);}
export type Sight='clear'|'blocked'|'unknown';
export const FOLLOW_LIMITS=Object.freeze({visits:256,objects:4096,meshes:2048,depth:64,vertices:4096,triangles:12000,blocks:4096,blockVisits:4096,blockTriangles:64,instances:512,candidates:7,speed:5,acceleration:5,aimSpeed:4,aimAcceleration:8,previewSeconds:1.5,previewDistance:2,previewStableSeconds:.3,previewMaxSpeed:4});
/** Orientation-independent envelope of the actual near plane, including a pending
 * final viewport projection. Its capsule covers every intermediate eye rotation.
 * Surface clearance is NOT proof that an arbitrary closed solid does not contain it. */
export function followClearanceRadius(camera:PerspectiveCamera,projection?:FollowProjection,proposedEye?:Vector3):number|null{
 if(camera.parent||!Number.isFinite(camera.near)||camera.near<=0||!Number.isFinite(camera.far)||camera.far<=camera.near)return null;
 let radius=0;const point=new Vector3(),matrices=[camera.projectionMatrixInverse],next=new PerspectiveCamera().copy(camera,false),currentEye=camera.position.clone();
 if(![...currentEye,...(proposedEye??currentEye)].every(Number.isFinite))return null;
 if(projection&&!composeVisibleViewport(next,projection.width,projection.height,projection.insets,projection.fov))return null;
 matrices.push(next.projectionMatrixInverse.clone());
 // The renderer fits near AFTER camera control. Reuse that exact latched fitter
 // on a private camera at both possible final eyes: rejected and accepted motion.
 // Optional passages pass their own endpoint too; no shared camera/ground writes.
 for(const eye of [currentEye,proposedEye??currentEye]){next.near=camera.near;next.updateProjectionMatrix();next.position.copy(eye);next.updateMatrixWorld(true);fitNearPlane(next);matrices.push(next.projectionMatrixInverse.clone());}
 for(const matrix of matrices){if(!matrix.elements.every(Number.isFinite))return null;for(let i=0;i<4;i++){point.set(i&1?1:-1,i&2?1:-1,-1).applyMatrix4(matrix);if(![point.x,point.y,point.z].every(Number.isFinite)||point.z>=0)return null;radius=Math.max(radius,point.length());}}
 return Number.isFinite(radius)&&radius>0?radius:null;
}
function segmentDistanceSq(p:Vector3,q:Vector3,a:Vector3,b:Vector3){
 const d=q.clone().sub(p),e=b.clone().sub(a),r=p.clone().sub(a),dd=d.dot(d),ee=e.dot(e),de=d.dot(e),dr=d.dot(r),er=e.dot(r);let t=0,u=0;
 if(dd<=1e-24){u=ee>1e-24?Math.max(0,Math.min(1,er/ee)):0;}
 else if(ee<=1e-24)t=Math.max(0,Math.min(1,-dr/dd));
 else{const denominator=dd*ee-de*de;t=denominator>1e-24?Math.max(0,Math.min(1,(de*er-dr*ee)/denominator)):0;u=(de*t+er)/ee;if(u<0){u=0;t=Math.max(0,Math.min(1,-dr/dd));}else if(u>1){u=1;t=Math.max(0,Math.min(1,(de-dr)/dd));}}
 return r.addScaledVector(d,t).addScaledVector(e,-u).lengthSq();
}
type Scan={node:Object3D;child:number;entered:boolean};
type Bounds={position:unknown;version:number;count:number;next:number;box:Box3;invalid:boolean};
type Blocks={bounds:Bounds;index:unknown;version:number;count:number;start:number;end:number;next:number;boxes:Box3[];pending:Box3;complete:boolean;invalid:boolean};
const visible=(o:Object3D)=>{let depth=0;for(let p:Object3D|null=o;p;p=p.parent){if(++depth>64||!p.visible)return false;}return true;};
/** Incremental collection over actual rendered roots. Each incomplete pass remains explicitly unknown.
 * Bounds belong to this reader; it never asks Three to compute or update shared geometry/matrices. */
export class FollowGeometry{
 generation=0;
 private authored=new WeakSet<Mesh>();
 private enclosureNodes:Object3D[]=[];private enclosureOverflow=false;
 enclosureSources(){return{nodes:this.enclosureNodes,complete:!this.failed&&!this.stack.length&&this.nextRoot===this.roots.length&&!this.enclosureOverflow,revision:this.revision};}
 private rootOf=new WeakMap<Mesh,Object3D>();private structure=new Map<Object3D,Object3D[]>();private roots:readonly Object3D[]=[];private revision='';private stack:Scan[]=[];private seen=new Set<Object3D>();private meshes:Mesh[]=[];private bounds=new Map<BufferGeometry,Bounds>();private blocks=new Map<BufferGeometry,Blocks>();private retainedBlocks=0;private requested=new Set<BufferGeometry>();private edges=0;private nextRoot=0;private failed=false;
 private ray=new Ray();private inverse=new Matrix4();private matrix=new Matrix4();private instance=new Matrix4();private a=new Vector3();private b=new Vector3();private c=new Vector3();private hit=new Vector3();private expanded=new Box3();private inflation=new Vector3();private triangle=new Triangle();private worldRay=new Ray();private closest=new Vector3();
 stats={surfaceStartOverlap:false,structure:0,visits:0,vertices:0,triangles:0,blockVisits:0,retainedBlocks:0,instances:0,queries:0,complete:false,meshes:0,unknown:null as string|null,unknownMesh:null as Record<string,unknown>|null};
 reset(keepGeometry=false){this.generation++;this.authored=new WeakSet();this.enclosureNodes=[];this.enclosureOverflow=false;this.rootOf=new WeakMap();this.roots=[];this.stack=[];this.seen.clear();this.structure.clear();this.meshes=[];if(!keepGeometry){this.bounds.clear();this.blocks.clear();this.requested.clear();this.retainedBlocks=0;}this.nextRoot=0;this.edges=0;this.failed=false;}
 prepare(roots:readonly Object3D[],revision:string){
  let structureChanged=false,structureWork=0;for(const [node,children]of this.structure){structureWork++;if(node.children.length!==children.length){structureChanged=true;break;}for(let i=0;i<children.length;i++){structureWork++;if(node.children[i]!==children[i]){structureChanged=true;break;}}if(structureChanged)break;}
  if(structureChanged||revision!==this.revision||roots.length!==this.roots.length||roots.some((r,i)=>r!==this.roots[i])){this.reset(true);this.roots=[...roots];this.revision=revision;}
  this.stats={surfaceStartOverlap:false,structure:structureWork,visits:0,vertices:0,triangles:0,blockVisits:0,retainedBlocks:this.retainedBlocks,instances:0,queries:0,complete:false,meshes:this.meshes.length,unknown:null,unknownMesh:null};
  if(!roots.length||roots.length>32||this.failed){this.stats.unknown='geometry-unavailable';return;}
  while(this.stats.visits<FOLLOW_LIMITS.visits&&(this.stack.length||this.nextRoot<this.roots.length)){
   if(!this.stack.length)this.stack.push({node:this.roots[this.nextRoot++],child:0,entered:false});
   const top=this.stack.at(-1)!;this.stats.visits++;
   if(!top.entered){top.entered=true;if(this.seen.has(top.node)){this.stack.pop();continue;}this.seen.add(top.node);if((this.edges+=top.node.children.length)>FOLLOW_LIMITS.objects){this.failed=true;break;}this.structure.set(top.node,[...top.node.children]);if(this.seen.size>FOLLOW_LIMITS.objects){this.failed=true;break;}
    if(top.node.userData.cameraEnclosure){if(this.enclosureNodes.length<64)this.enclosureNodes.push(top.node);else this.enclosureOverflow=true;}
    const m=top.node as Mesh;let authored=false;for(let n:Object3D|null=m,d=0;n&&d++<64;n=n.parent)if(n.userData.cameraEnclosure){authored=true;break;}if(m.isMesh){if(authored)this.authored.add(m);if(this.meshes.length>=FOLLOW_LIMITS.meshes){this.failed=true;break;}this.meshes.push(m);this.rootOf.set(m,this.roots[this.nextRoot-1]);}}
   if(top.child<top.node.children.length){if(this.stack.length>=FOLLOW_LIMITS.depth){this.failed=true;break;}this.stack.push({node:top.node.children[top.child++],child:0,entered:false});}else this.stack.pop();
  }
  // Cold geometry is admitted incrementally, with a shared vertex budget across this frame.
  let incomplete=false;
  for(const mesh of this.meshes){const g=mesh.geometry,p=g?.attributes.position;if(!p){incomplete=true;continue;}const version='version'in p?p.version:p.data.version;
   let cache=this.bounds.get(g);if(!cache||cache.position!==p||cache.version!==version||cache.count!==p.count){if(!cache&&this.bounds.size>=FOLLOW_LIMITS.meshes){incomplete=true;continue;}if(cache)this.generation++;cache={position:p,version,count:p.count,next:0,box:new Box3(),invalid:false};this.bounds.set(g,cache);}
   while(cache.next<p.count&&this.stats.vertices<FOLLOW_LIMITS.vertices){this.a.fromBufferAttribute(p,cache.next++);if(!Number.isFinite(this.a.x)||!Number.isFinite(this.a.y)||!Number.isFinite(this.a.z))cache.invalid=true;else cache.box.expandByPoint(this.a);this.stats.vertices++;}
   if(cache.next<p.count||cache.invalid)incomplete=true;
  }
  // Retain immutable local geometry work across collection changes, but not dead meshes.
  // Acceleration is prepared only for geometry actually intersected by prior query bounds.
  // Both maps are bounded by collected meshes; blocks additionally have a global cap.
  if(!this.stack.length&&this.nextRoot===this.roots.length){const used=new Set(this.meshes.map(m=>m.geometry));for(const g of this.bounds.keys())if(!used.has(g)){this.bounds.delete(g);const old=this.blocks.get(g);if(old)this.retainedBlocks-=old.boxes.length;this.blocks.delete(g);this.requested.delete(g);}}
  for(const mesh of this.meshes){const g=mesh.geometry,p=g?.attributes.position,cache=this.bounds.get(g);if(!p||!cache||cache.next<p.count||cache.invalid||!this.requested.has(g))continue;
   const ix=g.index,start=this.authored.has(mesh)?0:Math.max(0,g.drawRange.start),end=this.authored.has(mesh)?ix?.count??p.count:Math.min(ix?.count??p.count,start+g.drawRange.count),version=ix?.version??0,count=ix?.count??p.count;
   let blocks=this.blocks.get(g);if(blocks&&(blocks.bounds!==cache||blocks.index!==ix||blocks.version!==version||blocks.count!==count||blocks.start!==start||blocks.end!==end)){if(blocks.index!==ix||blocks.version!==version||blocks.count!==count)this.generation++;this.retainedBlocks-=blocks.boxes.length;this.blocks.delete(g);blocks=undefined;}
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
 /** A finite exterior witness plus a full-surface capsule proves only the
  * represented geometry. Roofed eyes are conservatively refused by this rule. */
 exteriorWitness(eye:Vector3,radius:number):{status:Sight;reason:string;witness:number[]|null}{
  const unknown=(reason:string,mesh?:Mesh)=>{this.stats.unknown=reason;if(mesh)this.stats.unknownMesh={name:mesh.name.slice(0,128),type:mesh.type,root:this.rootOf.get(mesh)?.name.slice(0,128)??null};return{status:'unknown' as Sight,reason,witness:null};};
  if(!this.stats.complete||!this.meshes.length||!Number.isFinite(radius)||radius<=0)return unknown('coverage-incomplete');let maxY=-Infinity;
  for(const mesh of this.meshes){const materials=Array.isArray(mesh.material)?mesh.material:[mesh.material];if(materials.length>64)return unknown('material-cap',mesh);
   if(mesh.userData.shadowProxy===true&&materials.length===1&&materials[0].name==='shadow-proxy'&&materials[0].type==='ShaderMaterial'&&!materials[0].colorWrite&&!materials[0].depthWrite)continue;
   if(mesh.userData.edenWindMode||materials.some(m=>m.type==='ShaderMaterial'||m.type==='RawShaderMaterial'||/eden-atmos-(wind|motion)/.test(m.customProgramCacheKey())))return unknown('shader-deformed-or-unsupported',mesh);
   const g=mesh.geometry,b=this.bounds.get(g);if(!b||b.invalid||b.next!==g.attributes.position?.count)return unknown('bounds-incomplete');
   if((mesh as Mesh&{isSkinnedMesh?:boolean}).isSkinnedMesh||g.morphAttributes.position?.length||mesh.raycast!==Mesh.prototype.raycast&&!(mesh as InstancedMesh).isInstancedMesh)return unknown('unsupported-bounds',mesh);
   const instances=(mesh as InstancedMesh).isInstancedMesh?(mesh as InstancedMesh).count:1;
   for(let i=0;i<instances;i++){if(this.stats.blockVisits>=FOLLOW_LIMITS.blockVisits)return unknown('witness-bound-cap');this.stats.blockVisits++;if((mesh as InstancedMesh).isInstancedMesh&&++this.stats.instances>FOLLOW_LIMITS.instances)return unknown('instance-cap');this.matrix.copy(mesh.matrixWorld);if((mesh as InstancedMesh).isInstancedMesh){(mesh as InstancedMesh).getMatrixAt(i,this.instance);this.matrix.multiply(this.instance);}if(!this.matrix.elements.every(Number.isFinite)||Math.abs(this.matrix.determinant())<1e-12)return unknown('invalid-transform');this.expanded.copy(b.box).applyMatrix4(this.matrix);if(!Number.isFinite(this.expanded.max.y))return unknown('bounds-invalid');maxY=Math.max(maxY,this.expanded.max.y);}
  }
  if(!Number.isFinite(maxY)||![...eye].every(Number.isFinite))return unknown('bounds-invalid');const witness=eye.clone();witness.y=Math.max(eye.y,maxY+radius+.01);const status=this.segment(eye,witness,radius,true,true,true);return{status,reason:status==='clear'?'represented-exterior-witness':status==='blocked'?'witness-path-blocked':this.stats.unknown??'witness-unknown',witness:witness.toArray()};
 }
 segmentAuthored(from:Vector3,to:Vector3,radius=0,glassOccludes=false):Sight{return this.segment(from,to,radius,true,glassOccludes);}
 segment(from:Vector3,to:Vector3,radius=0,fullAuthored=false,glassOccludes=false,fullScene=false):Sight{
  const unknown=(reason:string,mesh?:Mesh):Sight=>{this.stats.unknown=reason;if(mesh){const materials=Array.isArray(mesh.material)?mesh.material:[mesh.material];this.stats.unknownMesh={name:mesh.name.slice(0,128),type:mesh.type.slice(0,64),constructor:mesh.constructor.name.slice(0,64),root:this.rootOf.get(mesh)?.name.slice(0,128)??null,geometry:mesh.geometry.type.slice(0,64),blockComplete:this.blocks.get(mesh.geometry)?.complete??false,builtBlocks:this.blocks.get(mesh.geometry)?.boxes.length??0,blockNext:this.blocks.get(mesh.geometry)?.next??null,retainedBlocks:this.retainedBlocks,vertices:mesh.geometry.attributes.position?.count??null,skinned:!!(mesh as Mesh&{isSkinnedMesh?:boolean}).isSkinnedMesh,morphCount:mesh.geometry.morphAttributes.position?.length??0,customRaycast:mesh.raycast!==Mesh.prototype.raycast,shadowProxy:mesh.userData.shadowProxy===true,materialCount:materials.length,materials:materials.slice(0,4).map(m=>({name:m.name.slice(0,64),type:m.type.slice(0,64),visible:m.visible,colorWrite:m.colorWrite,depthWrite:m.depthWrite,transparent:m.transparent,opacity:m.opacity}))};}return'unknown';};this.stats.queries++;this.stats.surfaceStartOverlap=false;if(!this.stats.complete)return'unknown';if(![from.x,from.y,from.z,to.x,to.y,to.z,radius].every(Number.isFinite)||radius<0)return unknown('invalid-clearance-input');const length=from.distanceTo(to);if(length===0&&radius===0)return'clear';this.worldRay.set(from,to.clone().sub(from).normalize());let invalidMatrix=false;
  for(const mesh of this.meshes){const authored=fullScene||fullAuthored&&this.authored.has(mesh);if(!fullScene&&mesh.userData.cameraTransparent===true&&!this.authored.has(mesh))continue;if(!authored&&!visible(mesh))continue;const materials=Array.isArray(mesh.material)?mesh.material:[mesh.material];if(materials.length>64)return unknown('material-cap',mesh);
   // The renderer's explicit shadow proxy clips every vertex in the colour pass.
   // Its disabled picking hook is not unsupported visible geometry.
   if(mesh.userData.shadowProxy===true&&materials.length===1&&materials[0].name==='shadow-proxy'&&materials[0].type==='ShaderMaterial'&&!materials[0].colorWrite&&!materials[0].depthWrite)continue;
   if(materials.every(m=>(!authored&&!m.visible)||(!(authored&&(radius>0||glassOccludes))&&m.transparent&&m.opacity<.5)))continue;
   const g=mesh.geometry,bounds=this.bounds.get(g),p=g.attributes.position;if(!bounds||bounds.next<p.count||bounds.invalid)return unknown('bounds-incomplete',mesh);if(!Number.isSafeInteger(g.drawRange.start)||g.drawRange.start<0||g.drawRange.count!==Infinity&&(!Number.isSafeInteger(g.drawRange.count)||g.drawRange.count<0)||this.blocks.get(g)?.invalid)return unknown('invalid-drawn-geometry',mesh);
   // Unsupported deformation has no proven conservative bounds. Refuse before culling.
   if((mesh as Mesh&{isSkinnedMesh?:boolean}).isSkinnedMesh||g.morphAttributes.position?.length||mesh.raycast!==Mesh.prototype.raycast&&!(mesh as InstancedMesh).isInstancedMesh)return unknown('unsupported-deformation-or-raycast',mesh);
   const instances=(mesh as InstancedMesh).isInstancedMesh?(mesh as InstancedMesh).count:1;
   for(let n=0;n<instances;n++){
    if((mesh as InstancedMesh).isInstancedMesh&&++this.stats.instances>FOLLOW_LIMITS.instances)return unknown('instance-cap',mesh);this.matrix.copy(mesh.matrixWorld);if((mesh as InstancedMesh).isInstancedMesh){(mesh as InstancedMesh).getMatrixAt(n,this.instance);this.matrix.multiply(this.instance);}
    const determinant=this.matrix.determinant();if(!this.matrix.elements.every(Number.isFinite)||!Number.isFinite(determinant)||Math.abs(determinant)<1e-12){invalidMatrix=true;continue;}
    this.inverse.copy(this.matrix).invert();this.a.copy(from).applyMatrix4(this.inverse);this.b.copy(to).applyMatrix4(this.inverse);const localLength=this.a.distanceTo(this.b);if(!Number.isFinite(localLength))return unknown('invalid-transform',mesh);this.ray.set(this.a,this.c.copy(this.b).sub(this.a).normalize());
    const ie=this.inverse.elements;this.inflation.set(Math.hypot(ie[0],ie[4],ie[8]),Math.hypot(ie[1],ie[5],ie[9]),Math.hypot(ie[2],ie[6],ie[10])).multiplyScalar(radius);if(![...this.inflation].every(Number.isFinite))return unknown('invalid-transform',mesh);
    const intersects=(box:Box3)=>{this.expanded.copy(box);this.expanded.min.sub(this.inflation);this.expanded.max.add(this.inflation);if(this.expanded.containsPoint(this.ray.origin))return true;if(localLength===0)return false;const entry=this.ray.intersectBox(this.expanded,this.hit);return!!entry&&entry.distanceTo(this.ray.origin)<=localLength;};
    if(!intersects(bounds.box))continue;
    if(this.requested.size<FOLLOW_LIMITS.meshes)this.requested.add(g);
    const ix=g.index,start=authored?0:Math.max(0,g.drawRange.start),end=authored?ix?.count??p.count:Math.min(ix?.count??p.count,start+g.drawRange.count);
    const blocks=this.blocks.get(g),accelerated=blocks?.complete===true&&blocks.start===start&&blocks.end===end,step=FOLLOW_LIMITS.blockTriangles*3;
    for(let first=start;first+2<end;first+=step){
     if(accelerated){if(this.stats.blockVisits>=FOLLOW_LIMITS.blockVisits)return unknown('block-query-cap',mesh);this.stats.blockVisits++;const box=blocks.boxes[Math.floor((first-start)/step)];if(!intersects(box))continue;}
     // Incomplete acceleration falls back to the original bounded exact scan, never an empty block.
     for(let i=first;i+2<Math.min(end,first+step);i+=3){if(++this.stats.triangles>FOLLOW_LIMITS.triangles)return unknown('triangle-cap',mesh);const ia=ix?ix.getX(i):i,ib=ix?ix.getX(i+1):i+1,ic=ix?ix.getX(i+2):i+2;if(![ia,ib,ic].every(n=>Number.isSafeInteger(n)&&n>=0&&n<p.count))return unknown('invalid-drawn-geometry',mesh);this.a.fromBufferAttribute(p,ia);this.b.fromBufferAttribute(p,ib);this.c.fromBufferAttribute(p,ic);if(radius>0){
      this.a.applyMatrix4(this.matrix);this.b.applyMatrix4(this.matrix);this.c.applyMatrix4(this.matrix);if(![...this.a,...this.b,...this.c].every(Number.isFinite))return unknown('invalid-drawn-geometry',mesh);
      this.triangle.set(this.a,this.b,this.c);let start=Infinity,end=Infinity;
      if(this.triangle.getArea()>1e-20){start=this.triangle.closestPointToPoint(from,this.closest).distanceToSquared(from);end=this.triangle.closestPointToPoint(to,this.closest).distanceToSquared(to);}
      else{for(const [a,b]of[[this.a,this.b],[this.b,this.c],[this.c,this.a]]){start=Math.min(start,segmentDistanceSq(from,from,a,b));end=Math.min(end,segmentDistanceSq(to,to,a,b));}}
      const tolerance=radius*radius+1e-12;if(start<=tolerance){this.stats.surfaceStartOverlap=true;return'blocked';}
      const h=length>0?this.worldRay.intersectTriangle(this.a,this.b,this.c,false,this.hit):null;
      if(end<=tolerance||h&&h.distanceTo(from)<=length||Math.min(segmentDistanceSq(from,to,this.a,this.b),segmentDistanceSq(from,to,this.b,this.c),segmentDistanceSq(from,to,this.c,this.a))<=tolerance)return'blocked';
     }else{const h=this.ray.intersectTriangle(this.a,this.b,this.c,false,this.hit);if(h){const d=h.distanceTo(this.ray.origin);if(d<=localLength+1e-9*Math.max(1,localLength))return'blocked';}}}
    }
   }
  }
  return invalidMatrix?unknown('invalid-transform'):'clear';
 }
}
function approach(value:Vector3,velocity:Vector3,goal:Vector3,dt:number,speed:number,acceleration:number,tau:number){
 const desired=goal.clone().sub(value).multiplyScalar(1/tau).clampLength(0,speed),change=desired.sub(velocity).clampLength(0,acceleration*dt);velocity.add(change);value.addScaledVector(velocity,dt);
}
export type FollowPreview={status:string;shift:number[];current:number|null;alternative:number|null;selected:boolean};
export type FollowResult={cut:CutDiagnostic;interior:InteriorDiagnostic;preview:FollowPreview;eye:Vector3;aim:Vector3;reason:string;candidate:number;screen:[number,number];candidates:number;motion:{groundY:number|null;sweep:Sight|null;unknown:string|null;unknownMesh:Record<string,unknown>|null;radius:number|null;surfaceStartOverlap:boolean;containment:'unproved'}|null};
/** Persistent world-space viewpoints let the subject turn inside a portrait dead/soft zone. */
export class FollowCamera{
 private cuts=new CutAuthority();private nextCutCheck=0;
 private interior=new InteriorView();private wasInterior=false;
 private eye=new Vector3();private aim=new Vector3();private velocity=new Vector3();private aimVelocity=new Vector3();private offset=new Vector3();private anchor:Vector3|null=null;private initialized=false;private clock=0;private nextSearch=0;private heldUntil=0;private gestureUntil=0;private index=0;private probe=0;private travel=new Vector3();private travelAge=0;
 reset(eye?:Vector3,aim?:Vector3){this.cuts.clear();this.nextCutCheck=0;this.interior.reset();this.wasInterior=false;this.travel.set(0,0,0);this.travelAge=0;this.anchor=null;this.initialized=!!eye&&!!aim;if(eye&&aim){this.eye.copy(eye);this.aim.copy(aim);}this.velocity.set(0,0,0);this.aimVelocity.set(0,0,0);this.clock=this.nextSearch=this.heldUntil=this.gestureUntil=0;this.index=0;}
 gesture(eye:Vector3,aim:Vector3){this.cuts.refuse('cut-manual');if(this.wasInterior)this.velocity.set(0,0,0);this.interior.reset();this.travel.set(0,0,0);this.travelAge=0;if(!this.initialized)this.reset(eye,aim);if(this.anchor)this.offset.add(eye.clone().sub(this.eye));this.eye.copy(eye);this.aim.copy(aim);this.aimVelocity.set(0,0,0);this.gestureUntil=this.clock+2;}
 step(subject:PresentSubject,camera:PerspectiveCamera,aim:Vector3,dt:number,geometry:FollowGeometry,ground:(x:number,z:number)=>number|null,viewport?:FollowViewport,projection?:FollowProjection,context?:EnclosureResult|null,now=performance.now()/1000,cutReadiness?:{ready:boolean;reason:string;revision:string}):FollowResult{
  this.cuts.begin();if(!cutReadiness?.ready)this.cuts.refuse(cutReadiness?.reason??'cut-source-readiness-unknown');
  if(!this.initialized)this.reset(camera.position,aim);const invalidStep=!Number.isFinite(dt)||dt<0;dt=invalidStep?0:Math.min(.05,dt);this.clock+=dt;const manual=this.clock<this.gestureUntil;if(manual||invalidStep){this.eye.copy(camera.position);this.aim.copy(aim);}
  const q=new Quaternion().fromArray(subject.transform.rotationXyzw),bounds=subject.bounds,root=new Vector3().fromArray(subject.transform.positionM);
  const centre=bounds?new Vector3().fromArray(bounds.min).add(new Vector3().fromArray(bounds.max)).multiplyScalar(.5).applyQuaternion(q).add(root):null;
  const preview:FollowPreview={status:'unavailable',shift:[0,0,0],current:null,alternative:null,selected:false};let motion:FollowResult['motion']=null;const result=(reason:string,screen:[number,number]=[0,0],candidates=0)=>({cut:{...this.cuts.diagnostic,history:[...this.cuts.diagnostic.history]},interior:{...this.interior.diagnostic},preview,eye:this.eye.clone(),aim:this.aim.clone(),reason,candidate:this.index,screen,candidates,motion});
  if(invalidStep){this.cuts.refuse('cut-invalid-input');this.travel.set(0,0,0);this.travelAge=0;this.velocity.set(0,0,0);this.aimVelocity.set(0,0,0);return result('invalid-timestep');}
  if(!centre||(!geometry.stats.complete&&manual)){this.cuts.refuse('cut-input-unavailable');this.travel.set(0,0,0);this.travelAge=0;this.velocity.set(0,0,0);this.aimVelocity.set(0,0,0);return result((manual?'user-hold:':'')+(!centre?'subject-bounds-unknown':geometry.stats.unknown??'geometry-unknown'));}
  // Reset and gestures preserve the actual eye. Translation is relative to the
  // depicted root, independently of framing aim and animated bounds centre.
  if(!this.anchor){this.anchor=root.clone();this.offset.copy(this.eye).sub(root);}else this.anchor.copy(root);
  // A small visibility cue from stable past depicted travel, never a promised
  // future actor pose. Stops, reversals and implausible steps disable it at once.
  const travel=subject.travelMps,observed=travel?.value,valid=!!travel&&Number.isFinite(travel.confidence)&&travel.confidence>=.5&&observed?.length===3&&observed.every(Number.isFinite),direction=valid?new Vector3(observed![0],0,observed![2]):null,speed=direction?.length()??0;
  if(manual||!direction||speed<.1||speed>FOLLOW_LIMITS.previewMaxSpeed){this.travel.set(0,0,0);this.travelAge=0;preview.status=manual?'manual':!direction?'unavailable':speed<.1?'stopped':'discontinuity';}
  else{if(this.travelAge===0||this.travel.clone().normalize().dot(direction.clone().normalize())<.8){this.travel.copy(direction);this.travelAge=0;}else this.travel.lerp(direction,1-Math.exp(-dt/.3));this.travelAge+=dt;preview.status=this.travelAge>=FOLLOW_LIMITS.previewStableSeconds?'stable':'stabilizing';if(preview.status==='stable')preview.shift=this.travel.clone().multiplyScalar(FOLLOW_LIMITS.previewSeconds).clampLength(0,FOLLOW_LIMITS.previewDistance).toArray();}
  const projected=centre.clone().project(camera);if(!Number.isFinite(projected.x)||!Number.isFinite(projected.y)){this.cuts.refuse('cut-projection-invalid');return result('projection-unavailable');}
  if(!manual&&centre.clone().sub(camera.position).dot(new Vector3(0,0,-1).applyQuaternion(camera.quaternion))<=camera.near){this.cuts.refuse('cut-subject-behind');return result('subject-behind-view');}
  if(!manual&&projected.z>1){this.cuts.refuse('cut-far-clipped');return result('projection-unavailable');}
  const screen:[number,number]=[projected.x,projected.y];
  const manualEye=manual?this.eye.clone():null;
  const top=new Vector3(0,bounds!.max[1],0).applyQuaternion(q).add(root);
  const points=[centre,top.clone().lerp(centre,.25)];let tested=0;
  const query=(eye:Vector3,shift?:Vector3,coreOnly=false):number|null=>{const y=ground(eye.x,eye.z);if(y===null||!Number.isFinite(y))return null;if(eye.y<y+1.2)return-1;let clear=0;for(const p of coreOnly?[centre]:points){const s=geometry.segment(eye,shift?p.clone().add(shift):p);if(s==='unknown')return null;clear+=s==='clear'?1:0;}return clear/(coreOnly?1:points.length);};
  const interiorGoal=this.interior.sync(context,manual,geometry.generation),interiorActive=!manual&&context?.status==='enclosed';
  // Ordinary exit resumes the retained outdoor desired offset through the same
  // bounded sweep. Manual cancellation instead adopts the actual user view.
  if(this.wasInterior&&!interiorActive&&manual)this.offset.copy(this.eye).sub(root);this.wasInterior=interiorActive;
  const segment=(from:Vector3,to:Vector3,radius=0)=>geometry.segmentAuthored(from,to,radius);
  let reason='tracking';
  if(geometry.stats.complete){
  const goal=interiorActive?(interiorGoal??this.eye):root.clone().add(this.offset),next=this.eye.clone(),nextVelocity=this.velocity.clone();approach(next,nextVelocity,goal,dt,FOLLOW_LIMITS.speed,FOLLOW_LIMITS.acceleration,.8);
  const radius=followClearanceRadius(camera,projection,next);if(radius===null){this.cuts.refuse('cut-projection-invalid');this.velocity.set(0,0,0);return result('clearance-projection-unavailable');}
  const groundY=ground(next.x,next.z),sweep=segment(this.eye,next,radius);motion={groundY,sweep,radius,surfaceStartOverlap:geometry.stats.surfaceStartOverlap,containment:'unproved',unknown:sweep==='unknown'?geometry.stats.unknown:null,unknownMesh:sweep==='unknown'?geometry.stats.unknownMesh:null};if(groundY!==null&&Number.isFinite(groundY)&&next.y>=groundY+1.2&&sweep==='clear'){this.eye.copy(next);this.velocity.copy(nextVelocity);}else{this.velocity.set(0,0,0);reason=groundY===null||!Number.isFinite(groundY)?'ground-unavailable':next.y<groundY+1.2?'below-ground-margin':sweep==='blocked'?(geometry.stats.surfaceStartOverlap?'camera-envelope-overlap':'motion-obstructed'):'motion-unknown';}
  if(motion.surfaceStartOverlap){this.cuts.refuse('cut-envelope-overlap');this.aimVelocity.set(0,0,0);return result(manual?'user-hold:camera-envelope-overlap':'camera-envelope-overlap',screen);}
  // A Follow gesture changes its orbit/zoom, not the subject's world translation.
  // Carry eye and aim together so orientation stays exactly the user's, while the
  // normal bounded safety sweep continues. Search/framing wait until input settles.
  if(manualEye){this.cuts.refuse('cut-manual');this.aim.add(this.eye.clone().sub(manualEye));return result(reason==='tracking'?'user-hold':'user-hold:'+reason,screen);}
  // Movement gets the first query budget. Probe one alternative per search tick, never
  // consume a whole candidate fan before the safety sweep has run.
  const cutDue=!!cutReadiness?.ready&&interiorActive&&!!this.interior.destination()&&this.clock>=this.nextCutCheck;
  if(interiorActive&&!cutDue){this.interior.search(this.clock,this.eye,points,geometry,eye=>{const value=followClearanceRadius(camera,projection,eye);return value===null?null:Math.max(radius,value);},ground);}
  const destination=this.interior.destination();
  if(!cutReadiness?.ready)this.cuts.refuse(cutReadiness?.reason??'cut-source-readiness-unknown');
  else if(!interiorActive||manual||!destination)this.cuts.refuse('cut-no-preparation');
  else if(this.interior.diagnostic.tested===0&&this.clock>=this.nextCutCheck){this.nextCutCheck=this.clock+CUT_LIMITS.checkInterval;
   const frame=prepareCutFrame(subject,camera,destination.eye,viewport,projection),r=followClearanceRadius(camera,projection,destination.eye);
   const current=geometry.segmentAuthored(this.eye,points[0],0,true);
   if(!frame||r===null||current!=='blocked')this.cuts.refuse(current==='unknown'?'cut-current-unknown':'cut-no-benefit-or-framing');
   else{const y=ground(destination.eye.x,destination.eye.z),sight=points.every(p=>geometry.segmentAuthored(destination.eye,p,0,true)==='clear'),occupancy=sight?geometry.exteriorWitness(destination.eye,r):{status:'unknown',reason:'destination-sight-unready'};
    const key=JSON.stringify([destination.key,destination.eye.toArray(),geometry.generation,cutReadiness.revision,projection]);
    if(this.cuts.consider(now,key,sight&&occupancy.status==='clear'&&y!==null&&Number.isFinite(y)&&destination.eye.y>=y+1.2,frame.usefulDwell,destination.eye.toArray(),occupancy.reason)){
     this.cuts.direction(this.aim.clone().sub(this.eye).normalize().toArray(),frame.aim.clone().sub(frame.eye).normalize().toArray());this.eye.copy(frame.eye);this.aim.copy(frame.aim);this.velocity.set(0,0,0);this.aimVelocity.set(0,0,0);return result('deliberate-cut',screen,tested);
    }
   }
  }
  if(!interiorActive&&!motion?.surfaceStartOverlap&&dt>0&&this.clock>=this.nextSearch){this.nextSearch=this.clock+.25;const angles=[Math.PI/6,-Math.PI/6,Math.PI/3,-Math.PI/3,Math.PI/2,-Math.PI/2],i=this.probe++%angles.length;
   const current=query(root.clone().add(this.offset)),offset=this.offset.clone().applyAxisAngle(new Vector3(0,1,0),angles[i]),eye=root.clone().add(offset);tested=2;
   const alternative=query(eye),passageRadius=followClearanceRadius(camera,projection,eye),passage=passageRadius===null?'unknown':geometry.segmentAuthored(this.eye,eye,Math.max(radius,passageRadius));
   if(preview.status==='stable'&&current!==null&&alternative!==null&&alternative>=current&&passage==='clear'){
    // Future centre visibility is only a cue; both present-time anchors remain required.
    // A maximal or unknown incumbent cannot justify extra alternative preview work.
    const shift=new Vector3().fromArray(preview.shift);preview.current=query(root.clone().add(this.offset).add(shift),shift,true);if(preview.current!==null&&preview.current<1)preview.alternative=query(eye.clone().add(shift),shift,true);if(preview.current===null||preview.current<1&&preview.alternative===null)preview.status='query-unknown';
   }
   const anticipated=preview.current===0&&preview.alternative===1;
   if(current!==null&&alternative!==null&&alternative>=current&&(alternative>current+.25||anticipated)&&passage==='clear'&&this.clock>=this.heldUntil){this.offset.copy(offset);this.index=i+1;this.heldUntil=this.clock+2;reason='viewpoint-change';preview.selected=anticipated&&alternative<=current+.25;}
  }
  }else{this.cuts.refuse('cut-geometry-unready');this.velocity.set(0,0,0);reason=geometry.stats.unknown??'geometry-unknown';}
  // Unavailable obstruction geometry forbids eye movement/search, not a bounded
  // turn toward a fresh depicted subject. Manual input still owns its whole pose.
  // Rebase from the previous drawn eye along its actual viewing ray onto the
  // subject-depth plane. Subsequent eye translation then compensates around that
  // nearby world aim instead of also demanding a second pan to follow the eye.
  // This changes only its representation, not orientation. A persistent world aim
  // otherwise recedes behind a walking subject and makes the same pan ever slower.
  const forward=new Vector3(0,0,-1).applyQuaternion(camera.quaternion),right=new Vector3(1,0,0).applyQuaternion(camera.quaternion),up=new Vector3(0,1,0).applyQuaternion(camera.quaternion),relative=centre.clone().sub(camera.position),depth=relative.dot(forward);
  if(depth<=camera.near){this.cuts.refuse('cut-subject-behind');return result('subject-behind-view',screen,tested);}
  const previousDepth=Math.max(.5,this.aim.distanceTo(camera.position)),vertical=depth*Math.tan(camera.fov*Math.PI/360);
  this.aim.copy(camera.position).addScaledVector(forward,depth);
  this.aimVelocity.addScaledVector(forward,-this.aimVelocity.dot(forward)).multiplyScalar(depth/previousDepth).clampLength(0,FOLLOW_LIMITS.aimSpeed);
  const x=relative.dot(right)/(vertical*camera.aspect),y=relative.dot(up)/vertical;
  let targetX=Math.max(-.14,Math.min(.14,x)),targetY=Math.max(-.10,Math.min(.10,y));
  if(viewport){
   // Native rendering uses the ordinary full-canvas projection. Existing measured
   // edge insets constrain framing, never the projection or manual orbit pivot.
   const area=visibleViewport(viewport.width,viewport.height,viewport.insets);
   const view=camera.view,shifted=view?.enabled&&(view.offsetX!==0||view.offsetY!==0||view.width!==view.fullWidth||view.height!==view.fullHeight);
   if(!area||shifted){this.cuts.refuse('cut-framing-unavailable');return result('framing-unavailable',screen,tested);}
   const safe={left:2*area.left/viewport.width-1,right:2*(area.left+area.width)/viewport.width-1,bottom:1-2*(area.top+area.height)/viewport.height,top:1-2*area.top/viewport.height};
   let minX=Infinity,maxX=-Infinity,minY=Infinity,maxY=-Infinity,whole=true;
   for(let i=0;i<8;i++){
    const corner=new Vector3();
    corner.set(i&1?bounds!.max[0]:bounds!.min[0],i&2?bounds!.max[1]:bounds!.min[1],i&4?bounds!.max[2]:bounds!.min[2]).applyQuaternion(q).add(root);
    if(corner.clone().sub(camera.position).dot(forward)<=camera.near){whole=false;break;}
    corner.project(camera);if(![corner.x,corner.y,corner.z].every(Number.isFinite)||corner.z>1){whole=false;break;}
    minX=Math.min(minX,corner.x);maxX=Math.max(maxX,corner.x);minY=Math.min(minY,corner.y);maxY=Math.max(maxY,corner.y);
   }
   const choose=(current:number,low:number,high:number,centre:number,slack:number)=>{
    if(low>high)return null;
    const a=Math.max(low,centre-slack),b=Math.min(high,centre+slack);
    return a<=b?Math.max(a,Math.min(b,current)):Math.max(low,Math.min(high,centre));
   };
   let desiredX=whole?choose(x,safe.left+x-minX,safe.right+x-maxX,(safe.left+safe.right)/2,.14):null;
   let desiredY=whole?choose(y,safe.bottom+y-minY,safe.top+y-maxY,(safe.bottom+safe.top)/2,.10):null;
   if(desiredX===null||desiredY===null){
    // An infeasible full-body rectangle must not cancel useful reacquisition.
    // These are observed head and bounds-centre targets, not anatomical volumes.
    const head=subject.anchors.slice(0,8).find(a=>a.role==='head'),focus=[centre];if(head)focus.push(new Vector3().fromArray(head.localM).applyQuaternion(q).add(root));
    minX=Infinity;maxX=-Infinity;minY=Infinity;maxY=-Infinity;
    for(const point of focus){const corner=point.clone();if(corner.clone().sub(camera.position).dot(forward)<=camera.near){this.cuts.refuse('cut-framing-unavailable');return result('framing-unavailable',screen,tested);}corner.project(camera);if(![corner.x,corner.y,corner.z].every(Number.isFinite)||corner.z>1){this.cuts.refuse('cut-framing-unavailable');return result('framing-unavailable',screen,tested);}minX=Math.min(minX,corner.x);maxX=Math.max(maxX,corner.x);minY=Math.min(minY,corner.y);maxY=Math.max(maxY,corner.y);}
    desiredX=choose(x,safe.left+x-minX,safe.right+x-maxX,(safe.left+safe.right)/2,.14)??(safe.left+safe.right)/2;
    desiredY=choose(y,safe.bottom+y-minY,safe.top+y-maxY,(safe.bottom+safe.top)/2,.10)??(safe.bottom+safe.top)/2;
    reason=reason==='tracking'?'framing-core-fallback':reason+':framing-core-fallback';
   }
   targetX=desiredX;targetY=desiredY;
  }
  const aimGoal=centre.clone().addScaledVector(right,-targetX*vertical*camera.aspect).addScaledVector(up,-targetY*vertical);
  approach(this.aim,this.aimVelocity,aimGoal,dt,FOLLOW_LIMITS.aimSpeed,FOLLOW_LIMITS.aimAcceleration,.3);
  return result(reason,screen,tested);
 }
}
