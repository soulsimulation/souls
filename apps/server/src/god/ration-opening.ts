// Native hand-work owns time; one atomic God state change exposes the packed ration.
import {opSchema,type Op,type StoredDef,type WorldModel} from '@souls/world-compiler';
import type {EdgeReceipt,EdgeSoul} from '../edge/contract.ts';
import {ACT_REACH} from './actuators.ts';
type Refusal={code:string;reason:string};
type Body={pose?:{p:number[]};support?:{kind?:string;on?:string;by?:string};human?:{holding?:unknown;hands?:unknown;handActuator?:unknown}};
type Approach=(id:string,soul:EdgeSoul,front:[number,number]|null,radius?:number)=>{p:[number,number];level:number}|null;
export type RationOpeningHost={model:WorldModel;engine:{world:{entities:Record<string,Body>}};levelAt(x:number,z:number,y:number):number;soul(id:string):{id:string;entity_id:string;name:string}|undefined;denied(id:string,soul:{soulId:string;entityId:string;name:string}):Refusal|null;commit(ops:Op[],note:string,clientRef:string):{accepted:boolean};log(message:string):void};
const exact=(d:StoredDef|undefined)=>d?.name==='core-sealed-ration-tin'&&d.version===1;
export function createRationOpening(h:RationOpeningHost){
 const pending=new Map<string,{id:string;body:string;stamp:string;support:string;pose:string}>();
 const tin=(id:string)=>{const e=h.model.entities.get(id);return e&&exact(h.model.resolvedDef(e.def))?e:null;};
 function ready(soul:Pick<EdgeSoul,'soulId'|'entityId'|'name'>,id:string){
  const e=tin(id);if(!e)return{no:{code:'object.gone',reason:'The ration tin is no longer there.'}};
  const denied=h.denied(id,soul);if(denied)return{no:denied};
  if(e.state?.open!==false||e.state?.packed!==true||e.state?.left!==0)return{no:{code:'object.state',reason:'This ration is already open or its sealed stock has changed.'}};
  const support=h.engine.world.entities[id]?.support,parent=h.model.entities.get(e.in.parent),pd=parent&&h.model.resolvedDef(parent.def);
  if(!parent||pd?.components?.carryable||support?.kind!=='resting-on'||support.on!==parent.id||!e.in.slot||!h.model.slotsOf(parent).some(s=>s.id===e.in.slot&&s.kind==='surface'))return{no:{code:'object.state',reason:'Put the tin on an admitted fixed work surface.'}};
  const parentDenied=h.denied(parent.id,soul);if(parentDenied)return{no:parentDenied};
  const body=h.engine.world.entities[soul.entityId],pos=body?.pose?.p,p=h.model.worldPose(e);
  if(!body?.human||!pos)return{no:{code:'body.unavailable',reason:'Your body is unavailable.'}};
  if(body.human.holding||body.human.hands||body.human.handActuator||Object.values(h.engine.world.entities).some(x=>x.support?.kind==='in-hand'&&x.support.by===soul.entityId))return{no:{code:'object.state',reason:'Put down what you are holding before opening the ration.'}};
  if(h.levelAt(pos[0],pos[2],pos[1])!==h.levelAt(p.x,p.z,p.y))return{no:{code:'object.state',reason:'Reach the same floor as the tin first.'}};
  return{e,parent,support};
 }
 function plan(soul:EdgeSoul,id:string,action:string,approach:Approach){
  if(action!=='open-ration'||!tin(id))return null;const a=ready(soul,id);if(a.no)return a.no;
  const p=h.model.worldPose(a.e!),stand=approach(id,soul,[p.x+Math.sin(p.yaw)*.7,p.z+Math.cos(p.yaw)*.7],1.5);
  if(!stand)return{code:'object.state',reason:'No ordinary reachable standing point is available beside the tin.'};
  return{summary:'Completed opening the ration; pick up and eat the finite contents, keeping the tin and lid.',steps:[{verb:'stand',params:{}},{verb:'mars:walk_to',params:{x:stand.p[0],z:stand.p[1],level:stand.level}},{verb:'mars:pose_v1',params:{activity:'operate',seconds:4,face:[p.x,p.z]}},{verb:'stand',params:{}}]};
 }
 function onReceipt(r:EdgeReceipt){
  const m=/^object:(.+):open-ration$/.exec(r.capability);if(!m)return;const soul=h.soul(r.soulId),id=m[1];
  if(r.phase==='started'){if(!soul||pending.has(r.id))return;const a=ready({soulId:soul.id,entityId:soul.entity_id,name:soul.name},id);if(a.e)pending.set(r.id,{id,body:soul.entity_id,stamp:JSON.stringify([a.e.state,a.e.params,a.e.owner,a.e.access]),support:JSON.stringify([a.e.in,a.support]),pose:JSON.stringify([h.model.worldPose(a.e),h.model.worldPose(a.parent!)])});return;}
  if(!['completed','failed','replaced','aborted','cancelled'].includes(r.phase))return;const b=pending.get(r.id);pending.delete(r.id);
  if(r.phase!=='completed'||!b||b.id!==id||!soul||b.body!==soul.entity_id||!Number.isSafeInteger(r.endedTick)||r.endedTick!<0)return;
  const a=ready({soulId:soul.id,entityId:soul.entity_id,name:soul.name},id);if(a.no||JSON.stringify([a.e!.state,a.e!.params,a.e!.owner,a.e!.access])!==b.stamp||JSON.stringify([a.e!.in,a.support])!==b.support||JSON.stringify([h.model.worldPose(a.e!),h.model.worldPose(a.parent!)])!==b.pose||a.e!.state?.lastReceipt===r.id||r.endedTick!<Number(a.e!.state?.lastCompletedTick??-1))return;
  const pos=h.engine.world.entities[soul.entity_id]?.pose?.p,p=h.model.worldPose(a.e!);if(!pos||Math.hypot(pos[0]-p.x,pos[2]-p.z)>ACT_REACH)return;
  const done=h.commit([opSchema.parse({op:'set',id,state:{open:true,packed:false,left:1,openedBy:soul.name.slice(0,80),lastReceipt:r.id,lastCompletedTick:r.endedTick}})],`${r.soulId} opened sealed ration`,`ration-opening:${r.id}`);
  if(!done.accepted)h.log('ration opening: world refused atomic sealed-to-accessible transfer; packed ration unchanged');
 }
 return{plan,onReceipt,facts(id:string){const e=tin(id);if(!e)return null;const st=e.state??{},left=Number(st.left??0);return{rationOpening:st.open===false?"Sealed pull-tab tin; one supplied packed ration, inaccessible to eating. Put on a fixed admitted surface, empty hands and same floor; four seconds native hand work opens it once. Tin and attached lid remain real.":`Open ration; ${left>.05?Math.max(1,Math.round(left*Number(st.bites??2)))+' native bites accessible':'empty tin; contents consumed'}. Opened by ${String(st.openedBy??'')}. Pick up/carry/place the same tin normally; attached lid remains present, no resealing/refilling.`};}};
}
export type RationOpening=ReturnType<typeof createRationOpening>;
