/** Default-off single-subject Follow adapter. The next control step consumes only a completed draw. */
import {Vector3} from 'three';
import type {PerspectiveCamera,Object3D} from 'three';
import type {CameraVersion} from '../../../../packages/camera/src/observation.ts';
import {DisplayedCameraObserver} from './observation.ts';
import type {DrawnSubject,ObservationResult} from './observation.ts';
import {FollowCamera,FollowGeometry} from './follow-camera.ts';
export const FOLLOW_DIAGNOSTIC_CAP=8192;
export type FollowInput={key:string;tick:number;seconds:number;at:number;mode:string;id:string|null;camera:PerspectiveCamera;aim:Vector3};
export class FollowController{
 readonly enabled:boolean;
 private observer=new DisplayedCameraObserver();private policy=new FollowCamera();private geometry=new FollowGeometry();
 private prior:{key:string;at:number;tick:number;seconds:number;result:ObservationResult}|null=null;
 private activeKey='';private controlMs=0;private preparationMs=0;private candidates=0;private reason='inactive';private sequence=0;private dropped=0;
 private rows:Record<string,unknown>[]=[];
 constructor(enabled:boolean){this.enabled=enabled;}
 reset(eye?:Vector3,aim?:Vector3){this.prior=null;this.activeKey='';this.policy.reset(eye,aim);this.geometry.reset();this.reason='reset';}
 gesture(before:Vector3,after:Vector3){if(this.enabled)this.policy.gesture(before,after);}
 control(input:FollowInput,step:number,source:()=>{roots:readonly Object3D[];revision:string},ground:(x:number,z:number)=>number|null){
  this.controlMs=this.preparationMs=this.candidates=0;if(!this.enabled)return;
  const start=performance.now();try{
   if(input.mode!=='follow'||!input.id){if(this.activeKey)this.reset();this.reason='inactive';return;}
   if(this.activeKey!==input.key){this.activeKey=input.key;this.policy.reset(input.camera.position,input.aim);this.geometry.reset();}
   const p=this.prior,age=p?input.at-p.at:Infinity,gap=p?input.seconds-p.seconds:Infinity;
   if(!p||p.key!==input.key||p.result.status!=='observed'||age<0||age>250||gap<0||gap>.25||p.tick>input.tick){this.reason='depicted-input-stale';return;}
   const subject=p.result.value.subjects.find(s=>s.id===input.id);if(!subject||subject.state!=='present'){this.reason='subject-unavailable';return;}
   const preparing=performance.now();const {roots,revision}=source();this.geometry.prepare(roots,revision);this.preparationMs=performance.now()-preparing;
   const pose=this.policy.step(subject,input.camera,input.aim,step,this.geometry,ground);this.reason=pose.reason;this.candidates=pose.candidates;
   input.camera.position.copy(pose.eye);input.aim.copy(pose.aim);input.camera.lookAt(pose.aim);
  }finally{this.controlMs=performance.now()-start;}
 }
 /** Called immediately after successful render, before transient drawn poses are restored. */
 completed(input:FollowInput,version:CameraVersion,subject:DrawnSubject|null,legacyMs=0,setupMs=0){
  const start=performance.now();let observationMs=0;
  if(input.mode==='follow'&&subject){const result=this.observer.capture({version,tick:input.tick,seconds:input.seconds,subjects:[subject],geometryWork:4096});this.prior={key:input.key,at:input.at,tick:input.tick,seconds:input.seconds,result};observationMs=performance.now()-start;}
  else{this.prior=null;if(this.activeKey)this.reset();this.controlMs=0;}
  const rowStart=performance.now();const s=this.prior?.result.status==='observed'?this.prior.result.value.subjects.find(s=>s.state==='present'):null;
  const row={sequence:++this.sequence,at:input.at,tick:input.tick,seconds:input.seconds,key:input.key,mode:input.mode,enabled:this.enabled,reason:this.enabled?this.reason:'legacy',controlMs:this.enabled?this.controlMs:legacyMs,observationMs,setupMs,totalMs:(this.enabled?this.controlMs:legacyMs)+observationMs,diagnosticMs:0,preparationMs:this.enabled?this.preparationMs:0,candidates:this.candidates,geometry:this.enabled?{...this.geometry.stats}:null,eye:input.camera.position.toArray(),aim:input.aim.toArray(),cameraWorld:input.camera.matrixWorld.toArray(),projection:input.camera.projectionMatrix.toArray(),subject:s??null};
  if(this.rows.length<FOLLOW_DIAGNOSTIC_CAP)this.rows.push(row);else this.dropped++;row.diagnosticMs=performance.now()-rowStart;row.totalMs+=setupMs+row.diagnosticMs;
 }
 read(){return{schema:'follow-experiment/1',enabled:this.enabled,total:this.sequence,dropped:this.dropped,capacity:FOLLOW_DIAGNOSTIC_CAP,rows:this.rows.slice(),scope:'Raw completed-draw rows; controller, caller setup, subject observation and raw row construction synchronous spans. Geometry preparation included; exports measured separately by reader. Page frame spacing is not presented FPS; deferred GC/resident memory unknown.'};}
}
