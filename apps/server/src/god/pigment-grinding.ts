// #1669: native craft owns timing; its completed receipt alone may transform supplied chalk.
import {opSchema,type Op,type StoredDef,type WorldModel} from '@souls/world-compiler';
import type {EdgeReceipt,EdgeSoul} from '../edge/contract.ts';
import {ACT_REACH} from './actuators.ts';

type Refusal={code:string;reason:string};
type Body={pose?:{p:number[]};human?:{holding?:unknown;hands?:unknown;handActuator?:unknown}};
export type PigmentGrindingHost={
 model:WorldModel;
 engine:{world:{entities:Record<string,Body>};clearanceAtV1?(x:number,z:number,level?:number):number};
 levelAt(x:number,z:number,y:number):number;
 soul(id:string):{id:string;entity_id:string;name:string}|undefined;
 denied(id:string,soul:{soulId:string;entityId:string;name:string}):Refusal|null;
 commit(ops:Op[],note:string,clientRef:string):{accepted:boolean};
 log(message:string):void;
};
const actions=new Set(['crush','grind']);
const isTray=(d:StoredDef|undefined)=>d?.name==='core-pigment-tray'&&d.version===1;
export function createPigmentGrinding(h:PigmentGrindingHost){
 const tray=(id:string)=>{const e=h.model.entities.get(id);return e&&isTray(h.model.resolvedDef(e.def))?e:null;};
 function ready(soul:Pick<EdgeSoul,'soulId'|'entityId'|'name'>,id:string,action:string):Refusal|null{
  const e=tray(id);if(!e)return{code:'object.gone',reason:'The pigment tray is no longer there.'};
  const denied=h.denied(id,soul);if(denied)return denied;
  if(e.state?.stage!==(action==='crush'?0:1))return{code:'object.state',reason:'This material is not at the stage for that work.'};
  return null;
 }
 function plan(soul:EdgeSoul,id:string,action:string){
  if(!actions.has(action)||!tray(id))return null;
  const no=ready(soul,id,action);if(no)return no;
  const b=h.engine.world.entities[soul.entityId];if(!b?.human)return{code:'body.unavailable',reason:'Your body is unavailable.'};
  if(b.human.holding||b.human.hands||b.human.handActuator||Object.values(h.engine.world.entities).some(x=>(x as {support?:{kind?:string;by?:string}}).support?.kind==='in-hand'&&(x as {support?:{by?:string}}).support?.by===soul.entityId))return{code:'object.state',reason:'Put down what you are holding before grinding pigment.'};
  const e=tray(id)!,p=h.model.worldPose(e),d=h.model.resolvedDef(e.def)!,slot=d.slots.find(s=>s.id==='worker')!;
  const c=Math.cos(p.yaw),s=Math.sin(p.yaw),x=p.x+(slot.p[0]*c+slot.p[2]*s)*p.s,z=p.z+(-slot.p[0]*s+slot.p[2]*c)*p.s,level=h.levelAt(x,z,p.y);
  if(h.engine.clearanceAtV1&&h.engine.clearanceAtV1(x,z,level)<.4)return{code:'object.state',reason:'There is no clear standing room at this pigment tray.'};
  return{summary:'Completed ten seconds of pigment work; read the tray for its actual material stage and worker.',steps:[
   {verb:'stand',params:{}},{verb:'mars:walk_to',params:{x,z,level}},
   {verb:'mars:pose_v1',params:{activity:'craft',seconds:10,prop:'tool',face:[p.x,p.z]}},{verb:'stand',params:{}},
  ]};
 }
 function onReceipt(r:EdgeReceipt){
  if(r.phase!=='completed'||!Number.isSafeInteger(r.endedTick)||r.endedTick!<0)return;
  const match=/^object:(.+):(crush|grind)$/.exec(r.capability);if(!match)return;
  const e=tray(match[1]),soul=h.soul(r.soulId);if(!e||!soul||e.state?.lastReceipt===r.id||ready({soulId:soul.id,entityId:soul.entity_id,name:soul.name},e.id,match[2]))return;
  if(r.endedTick!<Number(e.state?.lastCompletedTick??-1))return;
  const body=h.engine.world.entities[soul.entity_id],p=h.model.worldPose(e),at=body?.pose?.p;
  if(!at||Math.hypot(at[0]-p.x,at[2]-p.z)>ACT_REACH||h.levelAt(at[0],at[2],at[1])!==h.levelAt(p.x,p.z,p.y))return;
  const stage=match[2]==='crush'?1:2,by=soul.name.slice(0,80);
  const done=h.commit([opSchema.parse({op:'set',id:e.id,state:{stage,lastBy:by,lastReceipt:r.id,lastCompletedTick:r.endedTick,text:stage===1?`Coarse pigment: supplied soft artist chalk crushed by ${by}. Grind it once more for fine powder.`:`Fine pigment powder, ground by ${by}. All supplied chalk remains in this tray; no further grinding is needed.`}})],`${r.soulId} worked supplied artist chalk`,`pigment-grinding:${r.id}`);
  if(!done.accepted)h.log('pigment-grinding: world refused material change; previous stage remains unchanged');
 }
 return{plan,onReceipt};
}
export type PigmentGrinding=ReturnType<typeof createPigmentGrinding>;
