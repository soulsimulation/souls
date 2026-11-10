// #1693: native completed work transfers one finite charge into the same supported lantern.
import {opSchema,type Op,type StoredDef,type WorldModel} from '@souls/world-compiler';
import type {EdgeReceipt,EdgeSoul} from '../edge/contract.ts';
import {ACT_REACH} from './actuators.ts';
type Refusal={code:string;reason:string};
type Body={pose?:{p:number[]};human?:{holding?:unknown;hands?:unknown;handActuator?:unknown};support?:{kind?:string;by?:string;on?:string}};
export type LanternOilHost={model:WorldModel;engine:{world:{entities:Record<string,Body>};clearanceAtV1?(x:number,z:number,level?:number):number};levelAt(x:number,z:number,y:number):number;soul(id:string):{id:string;entity_id:string;name:string}|undefined;denied(id:string,soul:{soulId:string;entityId:string;name:string}):Refusal|null;commit(ops:Op[],note:string,clientRef:string):{accepted:boolean};log(message:string):void;};
const isStation=(d:StoredDef|undefined)=>d?.name==='core-lantern-oil-station'&&d.version===1;
const isLantern=(d:StoredDef|undefined)=>d?.name==='core-lantern'&&d.version===4;
export function createLanternOil(h:LanternOilHost){
 const started=new Map<string,string|null>();
 const station=(id:string)=>{const e=h.model.entities.get(id);return e&&isStation(h.model.resolvedDef(e.def))?e:null;};
 const target=(id:string)=>{for(const child of h.model.children.get(id)??[]){const e=h.model.entities.get(child);if(e?.in.slot==='out'&&isLantern(h.model.resolvedDef(e.def)))return e;}return null;};
 const resting=(id:string,on:string)=>{const s=h.engine.world.entities[id]?.support;return s?.kind==='resting-on'&&s.on===on;};
 function ready(soul:Pick<EdgeSoul,'soulId'|'entityId'|'name'>,id:string):Refusal|null{
  const e=station(id);if(!e)return{code:'object.gone',reason:'The oil supply is no longer there.'};const no=h.denied(id,soul);if(no)return no;
  const lamp=target(id);if(!lamp||!resting(lamp.id,id))return{code:'object.state',reason:'Place an actual refillable lantern on the refill surface first.'};const denied=h.denied(lamp.id,soul);if(denied)return denied;
  if(lamp.state?.on===true)return{code:'object.state',reason:'Put out the lantern before refilling it.'};
  if(Number(lamp.state?.oilCharge)>0)return{code:'object.state',reason:'The lantern already has a full session charge.'};
  if(!(Number(e.state?.stock)>=1))return{code:'object.state',reason:'No measured oil charges remain.'};return null;
 }
 function plan(soul:EdgeSoul,id:string,action:string){
  const entity=h.model.entities.get(id),def=entity&&h.model.resolvedDef(entity.def);
  if(isLantern(def)&&['light','put-out'].includes(action)){
   if(h.engine.world.entities[id]?.support?.kind==='in-hand')return{code:'object.state',reason:'Place the lantern on a surface before working its wick.'};
   return null; // Existing native contact owns on/off, conditions and the put-out charge patch.
  }
  if(action!=='refill-lantern'||!station(id))return null;
  const no=ready(soul,id);if(no)return no;const b=h.engine.world.entities[soul.entityId];if(!b?.human)return{code:'body.unavailable',reason:'Your body is unavailable.'};
  if(b.human.holding||b.human.hands||b.human.handActuator||Object.values(h.engine.world.entities).some(x=>x.support?.kind==='in-hand'&&x.support.by===soul.entityId))return{code:'object.state',reason:'Put down what you are holding before refilling.'};
  const e=station(id)!,p=h.model.worldPose(e),slot=h.model.resolvedDef(e.def)!.slots.find(s=>s.id==='worker')!,c=Math.cos(p.yaw),s=Math.sin(p.yaw),x=p.x+(slot.p[0]*c+slot.p[2]*s)*p.s,z=p.z+(-slot.p[0]*s+slot.p[2]*c)*p.s,level=h.levelAt(x,z,p.y);
  if(h.engine.clearanceAtV1&&h.engine.clearanceAtV1(x,z,level)<.4)return{code:'object.state',reason:'There is no clear standing room at this oil supply.'};
  return{summary:'Ten seconds of refill work completed; inspect the current charge and oil supply.',steps:[{verb:'stand',params:{}},{verb:'mars:walk_to',params:{x,z,level}},{verb:'mars:pose_v1',params:{activity:'craft',seconds:10,face:[p.x,p.z]}},{verb:'stand',params:{}}]};
 }
 function onReceipt(r:EdgeReceipt){
  const match=/^object:(.+):refill-lantern$/.exec(r.capability);if(!match)return;
  if(r.phase==='started'){if(!started.has(r.id)){const lamp=target(match[1]);started.set(r.id,lamp&&resting(lamp.id,match[1])?lamp.id:null);}return;}
  if(!['completed','failed','replaced'].includes(r.phase))return;const chosen=started.get(r.id);started.delete(r.id);
  if(r.phase!=='completed'||!chosen||!Number.isSafeInteger(r.endedTick)||r.endedTick!<0)return;
  const e=station(match[1]),soul=h.soul(r.soulId);if(!e||!soul||e.state?.lastReceipt===r.id||ready({soulId:soul.id,entityId:soul.entity_id,name:soul.name},e.id)||r.endedTick!<Number(e.state?.lastCompletedTick??-1))return;
  const lamp=target(e.id)!;if(lamp.id!==chosen||!resting(lamp.id,e.id))return;const p=h.model.worldPose(e),at=h.engine.world.entities[soul.entity_id]?.pose?.p;if(!at||Math.hypot(at[0]-p.x,at[2]-p.z)>ACT_REACH||h.levelAt(at[0],at[2],at[1])!==h.levelAt(p.x,p.z,p.y))return;
  const worker=soul.name.slice(0,80),ops:Op[]=[opSchema.parse({op:'set',id:e.id,state:{stock:Number(e.state?.stock)-1,lastReceipt:r.id,lastCompletedTick:r.endedTick,lastWorker:worker,lastLantern:lamp.id}}),opSchema.parse({op:'set',id:lamp.id,state:{oilCharge:1,refilledBy:worker}})];
  if(!h.commit(ops,`${r.soulId} refilled a lantern`,`lantern-oil:${r.id}`).accepted)h.log('lantern-oil: world refused transfer; oil and charge unchanged');
 }
 function facts(id:string){const e=station(id);if(!e)return null;
  const detail=e.state?.lastLantern?`Last completed refill: ${e.state.lastLantern}; one charge transferred by ${e.state?.lastWorker||'none'} (historical).`:'No completed refill recorded.';
  return{lanternOil:`Oil supply: ${e.state?.stock} measured charges. ${detail} Place an empty unlit refillable lantern on this surface. Inspect the lantern's ordinary on/off and action availability for current requirements. One charge enables one manually ended lighting session; put-out empties it. No timed burn.`};
 }
 return{plan,onReceipt,facts};
}
export type LanternOil=ReturnType<typeof createLanternOil>;
