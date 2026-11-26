import * as THREE from 'three';
import {clone} from 'three/addons/utils/SkeletonUtils.js';
export const soulAvatars={images:new Map<string,string>(),sources:new Map<string,{entityId:string;model:string;bodyRoot:string}>(),events:new EventTarget(),wanted:new Map<string,number>()};
/** A portrait shown on the page (a SoulAvatar mounted): the world draws portraits only for these. → its release */
export function wantPortrait(id:string){soulAvatars.wanted.set(id,(soulAvatars.wanted.get(id)??0)+1);return()=>{const n=(soulAvatars.wanted.get(id)??1)-1;if(n>0)soulAvatars.wanted.set(id,n);else soulAvatars.wanted.delete(id);};}
/** Pale backgrounds for portraits, one per Soul from its id (#5039), so neighbouring avatars stand apart. Each is light
 * (about L* 85-90) but well off white, in hues away from skin tones; the page's avatars and the server's portraits share it. */
export const PORTRAIT_TINTS=['#c4dcf2','#c4e6cf','#d6cdef','#bfe3e6','#d6e6bd','#c9d1f3','#ebcbe5','#efe6b8','#f2cdd6'] as const;
/** The Soul's portrait background: FNV-1a of its id, mixed, into PORTRAIT_TINTS (stable across renders, browsers and the server). */
export function portraitTint(id:string):string{let h=0x811c9dc5;for(let i=0;i<id.length;i++){h^=id.charCodeAt(i);h=Math.imul(h,0x01000193);}h=Math.imul(h^h>>>16,0x85ebca6b);h=Math.imul(h^h>>>13,0xc2b2ae35);h^=h>>>16;/* a final mix: ids that differ only at the end spread too */return PORTRAIT_TINTS[(h>>>0)%PORTRAIT_TINTS.length];}
const activityProp=(o:THREE.Object3D)=>{for(let p:THREE.Object3D|null=o;p;p=p.parent)if(p.name.startsWith('activity prop:'))return true;return false;};
/** Fit visible portrait geometry and aim at its actual head, independent of world pose/hidden helpers. */
export function soulPortraitView(root:THREE.Object3D,rigid:boolean){
 root.position.set(0,0,0);root.rotation.set(0,0,0);root.visible=true;root.updateMatrixWorld(true);const box=new THREE.Box3();let head:THREE.Object3D|null=null;
 root.traverse(o=>{for(let p:THREE.Object3D|null=o;p;p=p.parent)if(!p.visible)return;if((o as THREE.Bone).isBone&&/head$/i.test(o.name))head??=o;if((o as THREE.Mesh).isMesh){const mesh=o as THREE.Mesh;let local:THREE.Box3|null;if((o as THREE.SkinnedMesh).isSkinnedMesh){const skin=o as THREE.SkinnedMesh;skin.skeleton.update();skin.computeBoundingBox();local=skin.boundingBox;}else if((o as THREE.InstancedMesh).isInstancedMesh){const instances=o as THREE.InstancedMesh;instances.computeBoundingBox();local=instances.boundingBox;}else{if(!mesh.geometry.boundingBox)mesh.geometry.computeBoundingBox();local=mesh.geometry.boundingBox;}if(local)box.union(local.clone().applyMatrix4(o.matrixWorld));}});
 if(box.isEmpty()||![...box.min.toArray(),...box.max.toArray()].every(Number.isFinite))return null;const size=box.getSize(new THREE.Vector3()),target=box.getCenter(new THREE.Vector3());
 // #5039: frame the head and the top of the shoulders. h is the head's height above its joint (crown, hair, a low hat),
 // bounded by the body's size so a tall hat or a short neck cannot zoom far out or in; the frame runs from 0.75 h under
 // the joint to 0.12 h over the crown, so the face fills most of a round crop.
 let height=rigid?Math.max(size.x,size.y,size.z):Math.max(size.y*.42,size.x*.85);
 if(!rigid){if(head){const y=(head as THREE.Object3D).getWorldPosition(target).y,h=Math.min(Math.max(box.max.y-y,size.y*.06),size.y*.18);target.y=y+h*.185;height=h*1.87;}else target.y=box.max.y-size.y*.17;}
 return{box,target,height};
}
/** Main-thread milliseconds a frame (one `now`) may spend drawing portraits: the rest wait for the next frame. */
const PORTRAIT_FRAME_MS=4;
/** Bounded portraits use the world renderer and one reusable offscreen target, at most PORTRAIT_FRAME_MS of a frame.
 * The pixels come back without waiting for the GPU (a pixel buffer and a fence, readRenderTargetPixelsAsync): the copy
 * is queued before the target is drawn again, so several may be in flight. */
export class WorldSoulAvatars{
 private target:THREE.WebGLRenderTarget|null=null;private failed=false;private frame=-1;private spent=0;private pending=new Map<string,Promise<void>>();private latest=new Map<string,[string,THREE.Object3D,boolean]>();private keys=new Map<string,string>();
 private scene=new THREE.Scene();private camera=new THREE.PerspectiveCamera(28,1,.01,100);
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
   this.scene.add(portrait);const view=soulPortraitView(portrait,rigid);if(!view){this.keys.set(id,key);return;}/* nothing to frame: again only once the body changes */const {target,height}=view;
   // the frame's height is `height` at the target (5 % slack for a rigid body's whole outline), seen from a three-quarter view
   const distance=height*(rigid?1.05:1)/(2*Math.tan(this.camera.fov*Math.PI/360));
   // Both rigs and canonical ceramic heads face local +X after their model adapter.
   this.camera.position.copy(target).add(new THREE.Vector3(1,.08,.45).normalize().multiplyScalar(distance));this.camera.lookAt(target);this.scene.background=new THREE.Color(portraitTint(id));
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
