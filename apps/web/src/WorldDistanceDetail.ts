import * as THREE from 'three';
import type {DistanceDetailOptions} from './quality-tier.ts';
/** Lane phones (V4): lower detail at a distance, for the phone quality tier.
 *
 * A phone shows the same world in a 390-pixel-wide window. Much of what the desktop view draws is, on that screen,
 * smaller than a pixel or two: cups on far tables, distant plants, fence posts across the lake. Each still costs a draw
 * call (and another in the shadow pass) on a GPU and CPU several times slower than a laptop's. Two render-time rules:
 *  - a mesh whose bounding sphere projects to less than `minRadiusPx` CSS pixels of radius is not drawn this frame;
 *  - a small shadow caster beyond `shadowNear + shadowPerMetre·radius` metres does not cast (as WorldShadowDetail does
 *    for the Eden expansion on every tier).
 * Like WorldShadowDetail it is render-time only: `apply` runs just before renderer.render and `restore` right after,
 * so scene state, picking, tests and the static batches' change checks never see a hidden mesh. Lines, points, sprites
 * and anything with frustum culling turned off (sky, horizon, overlays) are never touched. Skinned bodies (Souls, kin)
 * are never hidden; beyond `standInDistance` metres they stop casting shadows (release 0.6: a resident 100 m away is a
 * few pixels tall on a phone, yet each of its body parts cost a skinned draw in the shadow pass). The candidate list is rescanned every `rescanFrames` frames. */
/** PERF-PASSES: a mesh inside a frozen thing (WorldEntityLayer.freeze:
 *  `userData.frozenDrawn` on the thing, with its `frozen` list replaced at every freeze) keeps its world-space centre and
 *  radius in `w` until that list changes: ~5,000 of Eden 2026's 6,000 candidates read and decomposed a matrix a frame. */
type Ancestor={object:THREE.Object3D;parent?:Ancestor;frame:number;shown:boolean;frozen:unknown};
type Candidate={mesh:THREE.Mesh;centre:THREE.Vector3;radius:number;ancestor?:Ancestor;w?:{list:unknown;x:number;y:number;z:number;r:number}};
type FrozenMark={frozen?:unknown};
const tmpBody=new THREE.Vector3();
export class WorldDistanceDetail{
 private candidates:Candidate[]=[];private bodies:THREE.SkinnedMesh[]=[];private frame=0;private hidden:(THREE.Mesh|null)[]=[];private noShadow:(THREE.Mesh|null)[]=[];private hiddenCount=0;private noShadowCount=0;
 private ancestorTrail:(Ancestor|null)[]=[];
 private world=new THREE.Vector3();private sphere=new THREE.Sphere();
 /** Last apply(): meshes not drawn, casters skipped, candidates considered, CPU ms. */
 readonly stats={culled:0,shadowSkipped:0,candidates:0,bodyShadowsSkipped:0,cpuMs:0};
 private o:DistanceDetailOptions;
 constructor(o:DistanceDetailOptions){this.o=o;}
 private scan(root:THREE.Object3D){
  this.candidates=[];this.bodies=[];
  // Keep the scan's ancestry, as before; share its suffixes between sibling meshes. The memo is owned by these
  // candidates and replaced at the next scan. Visibility and the nearest freeze marker are reread each apply.
  const ancestors=new Map<THREE.Object3D,Ancestor>(),trail:THREE.Object3D[]=[];
  const ancestor=(o:THREE.Object3D|null):Ancestor|undefined=>{
   while(o&&o!==root&&!ancestors.has(o)){trail.push(o);o=o.parent;}
   let parent=o&&o!==root?ancestors.get(o):undefined;
   while(trail.length){const object=trail.pop()!;parent={object,parent,frame:-1,shown:true,frozen:undefined};ancestors.set(object,parent);}return parent;
  };
  root.traverse(obj=>{
   const m=obj as THREE.Mesh;
   if(m.isMesh&&(m as THREE.SkinnedMesh).isSkinnedMesh&&!m.userData.keepDetail){this.bodies.push(m as THREE.SkinnedMesh);return;}
   if(!m.isMesh||(m as THREE.SkinnedMesh).isSkinnedMesh||!m.frustumCulled||m.userData.keepDetail)return;
   const im=m as THREE.InstancedMesh;
   if(im.isInstancedMesh){if(!im.boundingSphere)im.computeBoundingSphere();if(!im.boundingSphere)return;this.sphere.copy(im.boundingSphere);}
   else{const g=m.geometry;if(!g)return;if(!g.boundingSphere)g.computeBoundingSphere();if(!g.boundingSphere||!Number.isFinite(g.boundingSphere.radius))return;this.sphere.copy(g.boundingSphere);}
   this.candidates.push({mesh:m,centre:this.sphere.center.clone(),radius:this.sphere.radius,ancestor:ancestor(m.parent)});
  });
 }
 private ancestorState(a:Ancestor):Ancestor{
  if(a.frame===this.frame)return a;
  // An indexed stack that keeps its backing store: `length=0` after each walk freed it, and the next walk regrew it
  // (P2 phones: ~150 bytes per thing per frame, most of this pass's allocation).
  const trail=this.ancestorTrail;let n=0;
  for(let next:Ancestor|undefined=a;next&&next.frame!==this.frame;next=next.parent)trail[n++]=next;
  while(n>0){
   const next=trail[--n]!;trail[n]=null;next.frame=this.frame;
   if(!next.object.visible){next.shown=false;next.frozen=undefined;continue;}
   next.shown=next.parent?.shown??true;
   const own=(next.object.userData.frozenDrawn as FrozenMark|undefined)?.frozen;
   next.frozen=own||next.parent?.frozen;
  }
  return a;
 }
 /** Call right before renderer.render. `viewHeight` is the canvas height in CSS pixels. */
 apply(root:THREE.Object3D,camera:THREE.PerspectiveCamera,viewHeight:number){
  const t0=performance.now();
  if(this.frame++%this.o.rescanFrames===0)this.scan(root);
  let culled=0,skipped=0;const cam=camera.position,pxPerUnit=viewHeight/(2*Math.tan(camera.fov*Math.PI/360))*(camera.zoom||1);
  // Indexed loops: a for-of here allocated an iterator result per candidate until the optimizing tier took over.
  const candidates=this.candidates;
  for(let i=0;i<candidates.length;i++){
   const c=candidates[i],m=c.mesh;if(!m.visible)continue;
   const ancestor=c.ancestor&&this.ancestorState(c.ancestor);if(ancestor&&!ancestor.shown)continue;
   const frozen=ancestor?.frozen;
   let r:number,d:number;
   if(frozen!==undefined&&c.w&&c.w.list===frozen){const w=c.w;r=w.r;d=Math.sqrt((w.x-cam.x)**2+(w.y-cam.y)**2+(w.z-cam.z)**2)-r;}
   else{
    // An instanced pool's sphere moves and resizes between scans (EntityInstancer.updateBounds): its things move, and a pool
    // all at scale 0 (kept in a shut drawer, a cut interior) has radius 0. Read it now: a scan's copy of that radius would cull the pool until the next scan.
    const live=(m as THREE.InstancedMesh).isInstancedMesh?(m as THREE.InstancedMesh).boundingSphere:null;if(live){c.centre.copy(live.center);c.radius=live.radius;}
    const e=m.matrixWorld.elements,scale=Math.sqrt(Math.max(e[0]*e[0]+e[1]*e[1]+e[2]*e[2],e[4]*e[4]+e[5]*e[5]+e[6]*e[6],e[8]*e[8]+e[9]*e[9]+e[10]*e[10]));
    const w=this.world.copy(c.centre).applyMatrix4(m.matrixWorld);r=c.radius*scale;d=w.distanceTo(cam)-r;
    if(frozen!==undefined)c.w={list:frozen,x:w.x,y:w.y,z:w.z,r};else c.w=undefined;
   }
   if(d<=0)continue;
   if(r*pxPerUnit/d<this.o.minRadiusPx){m.visible=false;this.hidden[this.hiddenCount++]=m;culled++;continue;}
   if(m.castShadow&&r<this.o.shadowMaxRadius&&d>this.o.shadowNear+this.o.shadowPerMetre*r){m.castShadow=false;this.noShadow[this.noShadowCount++]=m;skipped++;}
  }
  let bodySkipped=0;const far2=this.o.standInDistance*this.o.standInDistance;
  if(Number.isFinite(far2))for(let i=0,bodies=this.bodies;i<bodies.length;i++){const b=bodies[i];if(!b.castShadow||!b.parent)continue;b.getWorldPosition(tmpBody);if(tmpBody.distanceToSquared(cam)>far2){b.castShadow=false;this.noShadow[this.noShadowCount++]=b;bodySkipped++;}}
  this.stats.bodyShadowsSkipped=bodySkipped;
  this.stats.culled=culled;this.stats.shadowSkipped=skipped;this.stats.candidates=this.candidates.length;this.stats.cpuMs=performance.now()-t0;
 }
 /** Call right after renderer.render. */
 /** The lists keep their length between frames: truncating them (`length=0`) freed V8's backing store, so the next frame
  *  regrew it push by push (P2 phones: ~160 KB a frame with a few thousand meshes culled or shadow-skipped). Slots are
  *  cleared, so a removed mesh is not held. */
 restore(){
  const hidden=this.hidden,noShadow=this.noShadow;
  for(let i=0;i<this.hiddenCount;i++){hidden[i]!.visible=true;hidden[i]=null;}
  for(let i=0;i<this.noShadowCount;i++){noShadow[i]!.castShadow=true;noShadow[i]=null;}
  this.hiddenCount=0;this.noShadowCount=0;
 }
 dispose(){this.restore();this.candidates=[];this.bodies=[];this.hidden=[];this.noShadow=[];}
}
