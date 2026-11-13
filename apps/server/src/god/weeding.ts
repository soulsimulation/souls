// #1635: native garden activity owns timing; its completed receipt alone may consume weeds and make an item.
import {opSchema,type Op,type StoredDef,type WorldModel} from '@souls/world-compiler';
import type {EdgeReceipt,EdgeSoul} from '../edge/contract.ts';
import {ACT_REACH} from './actuators.ts';

type Refusal={code:string;reason:string};
type Body={pose?:{p:number[]};human?:{holding?:unknown;hands?:unknown;handActuator?:unknown}};
export type WeedingHost={
 model:WorldModel;
 engine:{world:{entities:Record<string,Body>};clearanceAtV1?(x:number,z:number,level?:number):number};
 levelAt(x:number,z:number,y:number):number;
 soul(id:string):{id:string;entity_id:string;name:string}|undefined;
 denied(id:string,soul:{soulId:string;entityId:string;name:string}):Refusal|null;
 commit(ops:Op[],note:string,clientRef:string):{accepted:boolean};
 log(message:string):void;
};
const isBed=(d:StoredDef|undefined)=>d?.name==='core-garden-planter'&&d.version===4;
export function createWeeding(h:WeedingHost){
 const bed=(id:string)=>{const e=h.model.entities.get(id);return e&&isBed(h.model.resolvedDef(e.def))?e:null;};
 const occupied=(id:string)=>[...(h.model.children.get(id)??[])].some(child=>h.model.entities.get(child)?.in.slot==='out');
 function ready(soul:Pick<EdgeSoul,'soulId'|'entityId'|'name'>,id:string):Refusal|null{
  const e=bed(id);if(!e)return{code:'object.gone',reason:'The garden bed is no longer there.'};
  const denied=h.denied(id,soul);if(denied)return denied;
  if(e.state?.weeds!==1)return{code:'object.state',reason:'This bed has no authored weeds left to remove.'};
  if(occupied(id))return{code:'object.state',reason:'Take the item off the output surface before weeding.'};
  return null;
 }
 function plan(soul:EdgeSoul,id:string,action:string){
  if(action!=='weed-bed'||!bed(id))return null;
  const no=ready(soul,id);if(no)return no;
  const b=h.engine.world.entities[soul.entityId];if(!b?.human)return{code:'body.unavailable',reason:'Your body is unavailable.'};
  if(b.human.holding||b.human.hands||b.human.handActuator||Object.values(h.engine.world.entities).some(x=>(x as {support?:{kind?:string;by?:string}}).support?.kind==='in-hand'&&(x as {support?:{by?:string}}).support?.by===soul.entityId))return{code:'object.state',reason:'Put down what you are holding before weeding.'};
  const e=bed(id)!,p=h.model.worldPose(e),d=h.model.resolvedDef(e.def)!,slot=d.slots.find(s=>s.id==='worker')!;
  const c=Math.cos(p.yaw),s=Math.sin(p.yaw),x=p.x+(slot.p[0]*c+slot.p[2]*s)*p.s,z=p.z+(-slot.p[0]*s+slot.p[2]*c)*p.s,level=h.levelAt(x,z,p.y);
  if(h.engine.clearanceAtV1&&h.engine.clearanceAtV1(x,z,level)<.4)return{code:'object.state',reason:'There is no clear standing room at this garden bed.'};
  return{summary:'Completed ten seconds of weeding; inspect the bed and collect its removed weeds.',steps:[
   {verb:'stand',params:{}},{verb:'mars:walk_to',params:{x,z,level}},
   {verb:'mars:pose_v1',params:{activity:'garden',prop:'tool',seconds:10,face:[p.x,p.z]}},{verb:'stand',params:{}},
  ]};
 }
 function onReceipt(r:EdgeReceipt){
  if(r.phase!=='completed'||!Number.isSafeInteger(r.endedTick)||r.endedTick!<0)return;
  const match=/^object:(.+):weed-bed$/.exec(r.capability);if(!match)return;
  const e=bed(match[1]),soul=h.soul(r.soulId);if(!e||!soul||e.state?.lastReceipt===r.id||ready({soulId:soul.id,entityId:soul.entity_id,name:soul.name},e.id))return;
  if(r.endedTick!<Number(e.state?.lastCompletedTick??-1))return;
  const body=h.engine.world.entities[soul.entity_id],p=h.model.worldPose(e),at=body?.pose?.p;
  if(!at||Math.hypot(at[0]-p.x,at[2]-p.z)>ACT_REACH||h.levelAt(at[0],at[2],at[1])!==h.levelAt(p.x,p.z,p.y))return;
  const done=h.commit([
   opSchema.parse({op:'set',id:e.id,state:{weeds:0,text:`Garden bed weeded by ${soul.name.slice(0,100)}. Removed weeds were collected into one real bundle.`,lastBy:soul.name.slice(0,100),lastReceipt:r.id,lastCompletedTick:r.endedTick}}),
   opSchema.parse({op:'place',def:'core/weed-bundle@1',name:'weeds',in:{parent:e.id,slot:'out'},p:[0,0],...(e.owner?{owner:e.owner}:{}),...(e.access?{access:e.access}:{})}),
  ],`${r.soulId} weeded a garden bed`,`weeding:${r.id}`);
  if(!done.accepted)h.log('weeding: world refused consume/create; weeds and output remain unchanged');
 }
 return{plan,onReceipt};
}
export type Weeding=ReturnType<typeof createWeeding>;
