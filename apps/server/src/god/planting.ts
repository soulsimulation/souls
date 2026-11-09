// #1625: native craft owns timing; its completed receipt alone may plant the finite supplied seedlings.
import {opSchema,type Op,type StoredDef,type WorldModel} from '@souls/world-compiler';
import type {EdgeReceipt,EdgeSoul} from '../edge/contract.ts';
import {ACT_REACH} from './actuators.ts';

type Refusal={code:string;reason:string};
type Body={pose?:{p:number[]};human?:{holding?:unknown;hands?:unknown;handActuator?:unknown}};
export type PlantingHost={
 model:WorldModel;
 engine:{world:{entities:Record<string,Body>};clearanceAtV1?(x:number,z:number,level?:number):number};
 levelAt(x:number,z:number,y:number):number;
 soul(id:string):{id:string;entity_id:string;name:string}|undefined;
 denied(id:string,soul:{soulId:string;entityId:string;name:string}):Refusal|null;
 commit(ops:Op[],note:string,clientRef:string):{accepted:boolean};
 log(message:string):void;
};
const isBed=(d:StoredDef|undefined)=>d?.name==='core-garden-planter'&&d.version===3;
export function createPlanting(h:PlantingHost){
 const bed=(id:string)=>{const e=h.model.entities.get(id);return e&&isBed(h.model.resolvedDef(e.def))?e:null;};
 function ready(soul:Pick<EdgeSoul,'soulId'|'entityId'|'name'>,id:string):Refusal|null{
  const e=bed(id);if(!e)return{code:'object.gone',reason:'The planting bed is no longer there.'};
  const denied=h.denied(id,soul);if(denied)return denied;
  if(e.state?.stock!==1||e.state?.planted===true)return{code:'object.state',reason:'This bed has no supplied seedlings left to plant.'};
  return null;
 }
 function plan(soul:EdgeSoul,id:string,action:string){
  if(action!=='plant-seedlings'||!bed(id))return null;
  const no=ready(soul,id);if(no)return no;
  const b=h.engine.world.entities[soul.entityId];if(!b?.human)return{code:'body.unavailable',reason:'Your body is unavailable.'};
  if(b.human.holding||b.human.hands||b.human.handActuator||Object.values(h.engine.world.entities).some(x=>(x as {support?:{kind?:string;by?:string}}).support?.kind==='in-hand'&&(x as {support?:{by?:string}}).support?.by===soul.entityId))return{code:'object.state',reason:'Put down what you are holding before planting seedlings.'};
  const e=bed(id)!,p=h.model.worldPose(e),d=h.model.resolvedDef(e.def)!,slot=d.slots.find(s=>s.id==='worker')!;
  const c=Math.cos(p.yaw),s=Math.sin(p.yaw),x=p.x+(slot.p[0]*c+slot.p[2]*s)*p.s,z=p.z+(-slot.p[0]*s+slot.p[2]*c)*p.s,level=h.levelAt(x,z,p.y);
  if(h.engine.clearanceAtV1&&h.engine.clearanceAtV1(x,z,level)<.4)return{code:'object.state',reason:'There is no clear standing room at this planting bed.'};
  return{summary:'Completed ten seconds of planting work; inspect the bed for its planted seedlings.',steps:[
   {verb:'stand',params:{}},{verb:'mars:walk_to',params:{x,z,level}},
   {verb:'mars:pose_v1',params:{activity:'craft',prop:'tool',seconds:10,face:[p.x,p.z]}},{verb:'stand',params:{}},
  ]};
 }
 function onReceipt(r:EdgeReceipt){
  if(r.phase!=='completed'||!Number.isSafeInteger(r.endedTick)||r.endedTick!<0)return;
  const match=/^object:(.+):plant-seedlings$/.exec(r.capability);if(!match)return;
  const e=bed(match[1]),soul=h.soul(r.soulId);if(!e||!soul||e.state?.lastReceipt===r.id||ready({soulId:soul.id,entityId:soul.entity_id,name:soul.name},e.id))return;
  if(r.endedTick!<Number(e.state?.lastCompletedTick??-1))return;
  const body=h.engine.world.entities[soul.entity_id],p=h.model.worldPose(e),at=body?.pose?.p;
  if(!at||Math.hypot(at[0]-p.x,at[2]-p.z)>ACT_REACH||h.levelAt(at[0],at[2],at[1])!==h.levelAt(p.x,p.z,p.y))return;
  const done=h.commit([
   opSchema.parse({op:'set',id:e.id,state:{stock:0,planted:true,growth:1,thirst:0,text:`Seedlings planted by ${soul.name.slice(0,100)}. Water and tend this same growing bed.`,lastBy:soul.name.slice(0,100),lastReceipt:r.id,lastCompletedTick:r.endedTick}}),
  ],`${r.soulId} planted supplied seedlings`,`planting:${r.id}`);
  if(!done.accepted)h.log('planting: world refused planting; stock and bed remain unchanged');
 }
 return{plan,onReceipt};
}
export type Planting=ReturnType<typeof createPlanting>;
