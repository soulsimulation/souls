import {springStep} from './camera-spring.ts';
export type FollowPoint=readonly[number,number,number];
export type FollowResponse={positionSeconds:number;aimSeconds:number};
export const DEFAULT_FOLLOW_RESPONSE:Readonly<FollowResponse>=Object.freeze({positionSeconds:1.3,aimSeconds:.55});  // VF4: calmer than .7/.25; #1316: calmer again than 1.1/.45
const valid=(p:FollowPoint)=>p.length===3&&p.every(v=>Number.isFinite(v)&&Math.abs(v)<=1e6);
const sub=(a:FollowPoint,b:FollowPoint):[number,number,number]=>[a[0]-b[0],a[1]-b[1],a[2]-b[2]];
/** #2201 A2: a critically damped spring toward the goal (exact at any frame rate; the speed carries over, so the camera
 * eases into and out of a Soul's walk). The period π·tau keeps the old first-order lag behind a steady walk (2/ω = tau).
 * Separate anchors avoid translating the camera with every aim adjustment. */
function damp(value:FollowPoint,velocity:number[],next:FollowPoint,dt:number,tau:number):[number,number,number]{
 return value.map((v,i)=>{const s=springStep(v,velocity[i],next[i],Math.PI*tau,dt);velocity[i]=s.v;return s.x;}) as [number,number,number];
}
export class WorldFollowMotion{
 private position:[number,number,number]|null=null;
 private aim:[number,number,number]|null=null;
 private previousPosition:FollowPoint|null=null;
 private previousAim:FollowPoint|null=null;
 private response:FollowResponse;
 private speed=[0,0,0];
 private aimSpeed=[0,0,0];
 constructor(response:FollowResponse=DEFAULT_FOLLOW_RESPONSE){
  if(![response.positionSeconds,response.aimSeconds].every(v=>Number.isFinite(v)&&v>=.05&&v<=5))throw Error('Follow response must be between .05 and 5 seconds');
  this.response={...response};
 }
 reset(position?:FollowPoint,aim:FollowPoint|undefined=position){
  if(position&&aim&&valid(position)&&valid(aim)){
   this.position=[...position];this.aim=[...aim];this.previousPosition=[...position];this.previousAim=[...aim];this.speed=[0,0,0];this.aimSpeed=[0,0,0];
  }else this.position=this.aim=this.previousPosition=this.previousAim=null;
 }
 sample(positionGoal:FollowPoint,aimGoal:FollowPoint,seconds:number){
  if(!valid(positionGoal)||!valid(aimGoal)||!Number.isFinite(seconds)||seconds<0)return null;
  if(!this.position||!this.aim)this.reset(positionGoal,aimGoal);
  const oldPosition=this.position!,oldAim=this.aim!,dt=Math.min(.1,seconds);
  if(dt>0){
   this.position=damp(oldPosition,this.speed,positionGoal,dt,this.response.positionSeconds);
   this.aim=damp(oldAim,this.aimSpeed,aimGoal,dt,this.response.aimSeconds);
   this.previousPosition=[...positionGoal];this.previousAim=[...aimGoal];
  }
  const translation=sub(this.position!,oldPosition),aimTranslation=sub(this.aim!,oldAim);
  return {position:[...this.position!] as [number,number,number],aim:[...this.aim!] as [number,number,number],translation,offsetTranslation:sub(translation,aimTranslation)};
 }
}
