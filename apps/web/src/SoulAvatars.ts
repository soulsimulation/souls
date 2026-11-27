import * as THREE from 'three';
import {clone} from 'three/addons/utils/SkeletonUtils.js';
import {floaterModel} from '../../../mars/viewer/engine/bodies/models.ts';
export const soulAvatars={images:new Map<string,string>(),sources:new Map<string,{entityId:string;model:string;bodyRoot:string}>(),events:new EventTarget(),wanted:new Map<string,number>()};
/** A portrait shown on the page (a SoulAvatar mounted): the world draws portraits only for these. → its release */
export function wantPortrait(id:string){soulAvatars.wanted.set(id,(soulAvatars.wanted.get(id)??0)+1);return()=>{const n=(soulAvatars.wanted.get(id)??1)-1;if(n>0)soulAvatars.wanted.set(id,n);else soulAvatars.wanted.delete(id);};}
/** Pale backgrounds for portraits, one per Soul from its id (#5039), so neighbouring avatars stand apart. Each is light
 * (about L* 85-90) but well off white, in hues away from skin tones; the page's avatars and the server's portraits share it. */
export const PORTRAIT_TINTS=['#c4dcf2','#c4e6cf','#d6cdef','#bfe3e6','#d6e6bd','#c9d1f3','#ebcbe5','#efe6b8','#f2cdd6'] as const;
/** The Soul's portrait background: FNV-1a of its id, mixed, into PORTRAIT_TINTS (stable across renders, browsers and the server). */
export function portraitTint(id:string):string{let h=0x811c9dc5;for(let i=0;i<id.length;i++){h^=id.charCodeAt(i);h=Math.imul(h,0x01000193);}h=Math.imul(h^h>>>16,0x85ebca6b);h=Math.imul(h^h>>>13,0xc2b2ae35);h^=h>>>16;/* a final mix: ids that differ only at the end spread too */return PORTRAIT_TINTS[(h>>>0)%PORTRAIT_TINTS.length];}
/** Where a portrait's camera looks from, relative to its target: in front of the body (+X) and a little to its side. */
const PORTRAIT_VIEW=new THREE.Vector3(1,.08,.45).normalize(),PORTRAIT_FOV=28;
/** How much of the round crop's diameter the face fills (#5039). Hair, hats, horns, stalks and shoulders may be cut off
 * by the crop; the face is never sized from them. The server's portrait uses it too. Gene found 0.85 "a bit too big":
 * 0.64 is halfway to the first large framing he liked (Bo, Chiron, Cy, Eli: faces 0.40 to 0.54 of the crop, mean 0.43). */
export const FACE_FILL=.64;
/** A look's face from its Head joint, in kit metres (kit.json face landmarks; the rig's neck to head joint is 0.0767):
 * the chin 0.02 under the joint, the forehead 0.20 over it, the ears 0.107 to each side, the nose 0.13 in front. */
export const KIT_FACE={neckToHead:.07673,chin:-.02,forehead:.2,ear:.107,nose:.13} as const;
const activityProp=(o:THREE.Object3D)=>{for(let p:THREE.Object3D|null=o;p;p=p.parent)if(p.name.startsWith('activity prop:'))return true;return false;};
/** Fit visible portrait geometry and aim at its actual face, independent of world pose/hidden helpers. */
export function soulPortraitView(root:THREE.Object3D,rigid:boolean){
 root.position.set(0,0,0);root.rotation.set(0,0,0);root.visible=true;root.updateMatrixWorld(true);const box=new THREE.Box3(),skins:THREE.SkinnedMesh[]=[],hiddenBones=new Set<THREE.Object3D>(),marked:THREE.Object3D[]=[];let head:THREE.Object3D|null=null,neck:THREE.Object3D|null=null,headSize=0;
 root.traverse(o=>{for(let p:THREE.Object3D|null=o;p;p=p.parent)if(!p.visible){if((o as THREE.SkinnedMesh).isSkinnedMesh)for(const b of (o as THREE.SkinnedMesh).skeleton.bones)hiddenBones.add(b);return;}const look=o.userData.humanoid?.look;if(look)headSize=Number(look.headSize)||1;if((o as THREE.Bone).isBone&&/head$/i.test(o.name))head??=o;if((o as THREE.Bone).isBone&&/neck$/i.test(o.name))neck??=o;if(o.userData.portraitFace)marked.push(o);if((o as THREE.Mesh).isMesh){const mesh=o as THREE.Mesh;let local:THREE.Box3|null;if((o as THREE.SkinnedMesh).isSkinnedMesh){const skin=o as THREE.SkinnedMesh;skin.skeleton.update();skin.computeBoundingBox();local=skin.boundingBox;skins.push(skin);}else if((o as THREE.InstancedMesh).isInstancedMesh){const instances=o as THREE.InstancedMesh;instances.computeBoundingBox();local=instances.boundingBox;}else{if(!mesh.geometry.boundingBox)mesh.geometry.computeBoundingBox();local=mesh.geometry.boundingBox;}if(local)box.union(local.clone().applyMatrix4(o.matrixWorld));}});
 // a head bone only a hidden skin follows (a rigid mesh such as the ghost, carried by a hidden rig) is not this body's head:
 // such a body is all head, framed from its top, below
 const carried=!!head&&hiddenBones.has(head)&&!skins.some(s=>s.skeleton.bones.includes(head as THREE.Bone));if(carried)head=null;
 if(box.isEmpty()||![...box.min.toArray(),...box.max.toArray()].every(Number.isFinite))return null;const size=box.getSize(new THREE.Vector3()),target=box.getCenter(new THREE.Vector3());
 // #5039: the face fills FACE_FILL of the round crop, as the portrait's camera sees it. What the face is, by body:
 // a creature's marked face (the duck's and dog's head, the snail's head and eye stalks); a look's face from its Head
 // joint (kit landmarks: no hair, hat or mohawk); another skinned head's vertices less the highest 4 % (a horn, an ear
 // tip, an antenna); a Little Martian's ceramic head whole; another whole body (the ghost, an uploaded floater) from its
 // top down, as tall as it is wide (what is taller is its sheet or its body).
 let face:ReturnType<typeof viewRect>=null;
 if(marked.length)face=viewRect(meshPoints(marked));
 else if(!rigid&&head&&skins.length){const points=skinnedTo(head,skins);
  if(headSize){const joint=(head as THREE.Object3D).getWorldPosition(new THREE.Vector3()),k=(neck?joint.distanceTo((neck as THREE.Object3D).getWorldPosition(new THREE.Vector3()))/KIT_FACE.neckToHead:1)*headSize,F=KIT_FACE;
   // the rig faces +X; the face is the head's vertices inside its landmark box (long hair at the cheeks stays, a mohawk goes)
   const zone=new THREE.Box3(new THREE.Vector3(joint.x-.02*k,joint.y+F.chin*k,joint.z-F.ear*k),new THREE.Vector3(joint.x+F.nose*k,joint.y+F.forehead*k,joint.z+F.ear*k)),inside=points.filter(p=>zone.containsPoint(p));
   face=viewRect(inside.length>=24?inside:corners(zone));}
  else face=viewRect(points,.04);}
 else if(rigid||carried)face=viewRect(meshPoints([root]),0,floaterModel(String(root.userData.bodyModel))&&!carried?undefined:'top');
 if(face){target.copy(face.center);return{box,target,height:2*Math.max(face.w,face.h)/FACE_FILL,slack:1};}
 // a head bone and no vertices on it: h is the height above the head joint, bounded by the body's size, the frame from
 // 0.75 h under the joint to 0.12 h over the crown; with no head bone, the top of the body
 let height=Math.max(size.y*.42,size.x*.85),slack=1.4;
 if(!rigid&&head){const y=(head as THREE.Object3D).getWorldPosition(target).y,h=Math.min(Math.max(box.max.y-y,size.y*.06),size.y*.18);target.y=y+h*.185;height=h*1.87;slack=1;}
 else if(!rigid)target.y=box.max.y-size.y*.17;
 return{box,target,height,slack};
}
/** The portrait camera's view of `points`: its centre and half width and height across the view, leaving out the
 * highest `topTrim` of the points. `square`: only its top, as tall as it is wide. */
function viewRect(points:THREE.Vector3[],topTrim=0,square?:'top'){
 if(!points.length)return null;const R=new THREE.Vector3(-PORTRAIT_VIEW.z,0,PORTRAIT_VIEW.x).normalize(),U=new THREE.Vector3().crossVectors(R,PORTRAIT_VIEW);
 const sorted=(axis:THREE.Vector3)=>Float64Array.from(points,p=>p.dot(axis)).sort(),at=(a:Float64Array,q:number)=>a[Math.round(q*(a.length-1))];
 const r=sorted(R),u=sorted(U),d=sorted(PORTRAIT_VIEW),r0=r[0],r1=r[r.length-1],w=(r1-r0)/2;let u0=u[0],u1=at(u,1-topTrim);
 if(square==='top')u0=Math.max(u0,u1-2*w);
 return{center:new THREE.Vector3().addScaledVector(R,(r0+r1)/2).addScaledVector(U,(u0+u1)/2).addScaledVector(PORTRAIT_VIEW,at(d,.5)),w,h:(u1-u0)/2};
}
const corners=(b:THREE.Box3)=>Array.from({length:8},(_,i)=>new THREE.Vector3(i&1?b.max.x:b.min.x,i&2?b.max.y:b.min.y,i&4?b.max.z:b.min.z));
/** World positions of the visible plain-mesh vertices under `roots`. */
function meshPoints(roots:THREE.Object3D[]){
 const out:THREE.Vector3[]=[];for(const root of roots)root.traverse(o=>{if(!(o as THREE.Mesh).isMesh||(o as THREE.SkinnedMesh).isSkinnedMesh||(o as THREE.InstancedMesh).isInstancedMesh)return;for(let p:THREE.Object3D|null=o;p;p=p.parent)if(!p.visible)return;const P=(o as THREE.Mesh).geometry.attributes.position;if(!P)return;
  for(let i=0;i<P.count;i++)out.push(new THREE.Vector3().fromBufferAttribute(P,i).applyMatrix4(o.matrixWorld));});
 return out;
}
/** World positions of the skinned vertices that follow `head` or a bone under it most (their largest skin weight). */
function skinnedTo(head:THREE.Object3D,skins:THREE.SkinnedMesh[]){
 const under=new Set<THREE.Object3D>();head.traverse(o=>{under.add(o);});const out:THREE.Vector3[]=[];
 for(const skin of skins){const g=skin.geometry,J=g.attributes.skinIndex,W=g.attributes.skinWeight,P=g.attributes.position;if(!J||!W||!P)continue;const bones=skin.skeleton.bones;
  for(let i=0;i<P.count;i++){let best=0,most=-1;for(let k=0;k<4;k++){const w=W.getComponent(i,k);if(w>most){most=w;best=J.getComponent(i,k);}}if(!under.has(bones[best]))continue;out.push(skin.getVertexPosition(i,new THREE.Vector3()).applyMatrix4(skin.matrixWorld));}}
 return out;
}
/** Main-thread milliseconds a frame (one `now`) may spend drawing portraits: the rest wait for the next frame. */
const PORTRAIT_FRAME_MS=4;
/** Bounded portraits use the world renderer and one reusable offscreen target, at most PORTRAIT_FRAME_MS of a frame.
 * The pixels come back without waiting for the GPU (a pixel buffer and a fence, readRenderTargetPixelsAsync): the copy
 * is queued before the target is drawn again, so several may be in flight. */
export class WorldSoulAvatars{
 private target:THREE.WebGLRenderTarget|null=null;private failed=false;private frame=-1;private spent=0;private pending=new Map<string,Promise<void>>();private latest=new Map<string,[string,THREE.Object3D,boolean]>();private keys=new Map<string,string>();
 private scene=new THREE.Scene();private camera=new THREE.PerspectiveCamera(PORTRAIT_FOV,1,.01,100);
 private renderer:THREE.WebGLRenderer;
 constructor(renderer:THREE.WebGLRenderer){this.renderer=renderer;this.scene.add(new THREE.HemisphereLight(0xffffff,0x67543f,3));const light=new THREE.DirectionalLight(0xffffff,3);light.position.set(2,4,3);this.scene.add(light);}
 async capture(id:string,key:string,body:THREE.Object3D|null,rigid:boolean,now:number):Promise<void>{
  if(!body||this.failed)return;
  // one readback a Soul at a time: a capture asked meanwhile is kept, the latest one only, and drawn when it ends
  const inFlight=this.pending.get(id);
  if(inFlight){this.latest.set(id,[key,body,rigid]);return inFlight.then(()=>{const next=this.latest.get(id);if(!next)return this.pending.get(id);/* another waiter drew the latest: wait for it */this.latest.delete(id);return this.capture(id,next[0],next[1],next[2],performance.now());});}
  if(now!==this.frame){this.frame=now;this.spent=0;}if(this.spent>=PORTRAIT_FRAME_MS)return;const surfaces:string[]=[];body.traverse(o=>{const m=o as THREE.Mesh;if(m.isMesh&&!activityProp(o))surfaces.push(m.geometry.uuid+':'+[m.material].flat().map(material=>material.uuid+':'+((material as THREE.MeshStandardMaterial).map?.uuid??'')).join(','));});key+='|'+surfaces.join(';');if(this.keys.get(id)===key)return;const started=performance.now();
  let portrait:THREE.Object3D|null=null,read:Promise<unknown>|null=null;const pixels=new Uint8Array(96*96*4);
  const fail=()=>{this.failed=true;this.target?.dispose();this.target=null;soulAvatars.images.delete(id);soulAvatars.sources.delete(id);soulAvatars.events.dispatchEvent(new Event('change'));};
  try{
   this.target??=new THREE.WebGLRenderTarget(96,96,{depthBuffer:true});this.target.texture.colorSpace=THREE.SRGBColorSpace;
   portrait=clone(body);if(!rigid&&body.userData.avatarIdleClip){const mixer=new THREE.AnimationMixer(portrait);mixer.clipAction(THREE.AnimationClip.parse(body.userData.avatarIdleClip)).play();mixer.update(.01);}
   const props:THREE.Object3D[]=[];portrait.traverse(o=>{if(o.name.startsWith('activity prop:'))props.push(o);});props.forEach(p=>p.removeFromParent());
   this.scene.add(portrait);const view=soulPortraitView(portrait,rigid);if(!view){this.keys.set(id,key);return;}/* nothing to frame: again only once the body changes */const {target,height,slack}=view;
   // the frame's height is `height` at the target, with the view's slack, seen from a three-quarter view
   const distance=height*slack/(2*Math.tan(this.camera.fov*Math.PI/360));
   // Both rigs and canonical ceramic heads face local +X after their model adapter.
   this.camera.position.copy(target).addScaledVector(PORTRAIT_VIEW,distance);this.camera.lookAt(target);this.scene.background=new THREE.Color(portraitTint(id));
   const renderer=this.renderer,previous=renderer.getRenderTarget(),viewport=renderer.getViewport(new THREE.Vector4()),scissor=renderer.getScissor(new THREE.Vector4()),scissorTest=renderer.getScissorTest(),autoClear=renderer.autoClear;
   // setRenderTarget uses physical96px even on a Retina world canvas; setViewport would multiply by its pixel ratio.
   // The copy into a pixel buffer is queued here, before the target is used again; only the wait for it is later.
   try{renderer.setRenderTarget(this.target);renderer.setScissorTest(false);renderer.autoClear=true;renderer.render(this.scene,this.camera);read=renderer.readRenderTargetPixelsAsync(this.target,0,0,96,96,pixels);}
   finally{renderer.setRenderTarget(previous);renderer.setViewport(viewport);renderer.setScissor(scissor);renderer.setScissorTest(scissorTest);renderer.autoClear=autoClear;}
  }catch{fail();read=null;}
  finally{portrait?.removeFromParent();portrait?.traverse(o=>{if((o as THREE.SkinnedMesh).isSkinnedMesh)(o as THREE.SkinnedMesh).skeleton.dispose();});}
  this.spent+=performance.now()-started;
  if(!read)return;
  const done=(async()=>{try{
   await read;
   const canvas=document.createElement('canvas');canvas.width=canvas.height=96;const ctx=canvas.getContext('2d');if(!ctx)throw Error('Portrait canvas unavailable');
   const image=ctx.createImageData(96,96);for(let y=0;y<96;y++)image.data.set(pixels.subarray((95-y)*96*4,(96-y)*96*4),y*96*4);ctx.putImageData(image,0,0);const url=canvas.toDataURL('image/png');
   this.keys.set(id,key);soulAvatars.images.set(id,url);soulAvatars.sources.set(id,{entityId:String(body.userData.entity??body.name),model:String(body.userData.bodyModel??'stand-in'),bodyRoot:body.uuid});soulAvatars.events.dispatchEvent(new Event('change'));
  }catch{fail();}
  finally{this.pending.delete(id);}})();
  this.pending.set(id,done);
  return done;
 }
 dispose(){this.target?.dispose();this.target=null;this.keys.clear();}
}
