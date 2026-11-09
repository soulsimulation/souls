// #1643: native craft owns timing; its completed receipt alone may consume stock and make an item.
import {opSchema,type Op,type StoredDef,type WorldModel} from '@souls/world-compiler';
import type {EdgeReceipt,EdgeSoul} from '../edge/contract.ts';
import {ACT_REACH} from './actuators.ts';

type Refusal={code:string;reason:string};
type Body={pose?:{p:number[]};human?:{holding?:unknown;hands?:unknown;handActuator?:unknown}};
export type FoldingHost={
 model:WorldModel;
 engine:{world:{entities:Record<string,Body>};clearanceAtV1?(x:number,z:number,level?:number):number};
 levelAt(x:number,z:number,y:number):number;
 soul(id:string):{id:string;entity_id:string;name:string}|undefined;
 denied(id:string,soul:{soulId:string;entityId:string;name:string}):Refusal|null;
 commit(ops:Op[],note:string,clientRef:string):{accepted:boolean};
 log(message:string):void;
};
const forms:Record<string,string>={'fold-boat':'boat','fold-bird':'bird'};
const isBlock=(d:StoredDef|undefined)=>d?.name==='core-folding-desk'&&d.version===1;
export function createFolding(h:FoldingHost){
 const block=(id:string)=>{const e=h.model.entities.get(id);return e&&isBlock(h.model.resolvedDef(e.def))?e:null;};
 const occupied=(id:string)=>[...(h.model.children.get(id)??[])].some(child=>h.model.entities.get(child)?.in.slot==='out');
 function ready(soul:Pick<EdgeSoul,'soulId'|'entityId'|'name'>,id:string):Refusal|null{
  const e=block(id);if(!e)return{code:'object.gone',reason:'The folding desk is no longer there.'};
  const denied=h.denied(id,soul);if(denied)return denied;
  if(!(Number(e.state?.stock)>=1))return{code:'object.state',reason:'This folding desk has no supplied paper sheet left.'};
  if(occupied(id))return{code:'object.state',reason:'Take the item off the output surface before folding paper.'};
  return null;
 }
 function plan(soul:EdgeSoul,id:string,action:string){
  if(!forms[action]||!block(id))return null;
  const no=ready(soul,id);if(no)return no;
  const b=h.engine.world.entities[soul.entityId];if(!b?.human)return{code:'body.unavailable',reason:'Your body is unavailable.'};
  if(b.human.holding||b.human.hands||b.human.handActuator||Object.values(h.engine.world.entities).some(x=>(x as {support?:{kind?:string;by?:string}}).support?.kind==='in-hand'&&(x as {support?:{by?:string}}).support?.by===soul.entityId))return{code:'object.state',reason:'Put down what you are holding before folding paper.'};
  const e=block(id)!,p=h.model.worldPose(e),d=h.model.resolvedDef(e.def)!,slot=d.slots.find(s=>s.id==='worker')!;
  const c=Math.cos(p.yaw),s=Math.sin(p.yaw),x=p.x+(slot.p[0]*c+slot.p[2]*s)*p.s,z=p.z+(-slot.p[0]*s+slot.p[2]*c)*p.s,level=h.levelAt(x,z,p.y);
  if(h.engine.clearanceAtV1&&h.engine.clearanceAtV1(x,z,level)<.4)return{code:'object.state',reason:'There is no clear standing room at this folding desk.'};
  return{summary:'Completed ten seconds of paper folding; read the folding desk for its result.',steps:[
   {verb:'stand',params:{}},{verb:'mars:walk_to',params:{x,z,level}},
   {verb:'mars:pose_v1',params:{activity:'craft',seconds:10,prop:'pen',face:[p.x,p.z]}},{verb:'stand',params:{}},
  ]};
 }
 function onReceipt(r:EdgeReceipt){
  if(r.phase!=='completed'||!Number.isSafeInteger(r.endedTick)||r.endedTick!<0)return;
  const match=/^object:(.+):(fold-boat|fold-bird)$/.exec(r.capability);if(!match)return;
  const e=block(match[1]),soul=h.soul(r.soulId);if(!e||!soul||e.state?.lastReceipt===r.id||ready({soulId:soul.id,entityId:soul.entity_id,name:soul.name},e.id))return;
  if(r.endedTick!<Number(e.state?.lastCompletedTick??-1))return;
  const body=h.engine.world.entities[soul.entity_id],p=h.model.worldPose(e),at=body?.pose?.p;
  if(!at||Math.hypot(at[0]-p.x,at[2]-p.z)>ACT_REACH||h.levelAt(at[0],at[2],at[1])!==h.levelAt(p.x,p.z,p.y))return;
  const done=h.commit([
   opSchema.parse({op:'set',id:e.id,state:{stock:Number(e.state?.stock)-1,text:`Folded ${forms[match[2]]} sculpture by ${soul.name.slice(0,100)}. ${Number(e.state?.stock)-1} paper sheets remain.`,lastBy:soul.name.slice(0,100),lastReceipt:r.id,lastCompletedTick:r.endedTick}}),
   opSchema.parse({op:'place',def:`core/paper-${forms[match[2]]}@1`,name:`${forms[match[2]]}-sculpture`,about:{title:`${forms[match[2]]} folded paper artwork`,what:`Folded by ${soul.name.slice(0,100)} from the folding desk's supplied paper.`},state:{form:forms[match[2]],maker:soul.name.slice(0,100),text:`${forms[match[2]]} folded paper artwork, made by ${soul.name.slice(0,100)}.`},in:{parent:e.id,slot:'out'},p:[0,0],...(e.owner?{owner:e.owner}:{}),...(e.access?{access:e.access}:{})}),
  ],`${r.soulId} folded paper`,`folding:${r.id}`);
  if(!done.accepted)h.log('folding: world refused consume/create; stock and output remain unchanged');
 }
 return{plan,onReceipt};
}
export type Folding=ReturnType<typeof createFolding>;
