// #1704: irreversible material removal from the same actual supported wooden blank.
import {opSchema,type Op,type StoredDef,type WorldModel} from '@souls/world-compiler';
import type {EdgeReceipt,EdgeSoul} from '../edge/contract.ts';
import {ACT_REACH} from './actuators.ts';
type Refusal={code:string;reason:string};
type Body={pose?:{p:number[]};human?:{holding?:unknown;hands?:unknown;handActuator?:unknown};support?:{kind?:string;by?:string;on?:string}};
export type WoodCarvingHost={model:WorldModel;engine:{world:{entities:Record<string,Body>};clearanceAtV1?(x:number,z:number,level?:number):number};levelAt(x:number,z:number,y:number):number;soul(id:string):{id:string;entity_id:string;name:string}|undefined;denied(id:string,soul:{soulId:string;entityId:string;name:string}):Refusal|null;commit(ops:Op[],note:string,clientRef:string):{accepted:boolean};log(message:string):void;};
const isBench=(d:StoredDef|undefined)=>d?.name==='core-wood-carving-bench'&&d.version===1;
const isBlank=(d:StoredDef|undefined)=>d?.name==='core-wooden-blank'&&d.version===1;
const forms=['leaf','bird','totem'];
export function createWoodCarving(h:WoodCarvingHost){
 const started=new Map<string,string|null>();
 const bench=(id:string)=>{const e=h.model.entities.get(id);return e&&isBench(h.model.resolvedDef(e.def))?e:null;};
 const target=(id:string)=>{for(const child of h.model.children.get(id)??[]){const e=h.model.entities.get(child);if(e?.in.slot==='out'&&isBlank(h.model.resolvedDef(e.def)))return e;}return null;};
 const resting=(id:string,on:string)=>{const s=h.engine.world.entities[id]?.support;return s?.kind==='resting-on'&&s.on===on;};
 function ready(soul:Pick<EdgeSoul,'soulId'|'entityId'|'name'>,id:string):Refusal|null{
  if(!bench(id))return{code:'object.gone',reason:'The carving bench is no longer there.'};const no=h.denied(id,soul);if(no)return no;
  const wood=target(id);if(!wood||!resting(wood.id,id))return{code:'object.state',reason:'Place an actual wooden blank on the carving surface first.'};const denied=h.denied(wood.id,soul);if(denied)return denied;
  if(wood.state?.carving!=='blank'||wood.state?.materialRemoved===true)return{code:'object.state',reason:'This wood is already carved; removed material cannot be restored or recarved.'};return null;
 }
 function plan(soul:EdgeSoul,id:string,action:string){
  const form=action.startsWith('carve-')?action.slice(6):'';if(!forms.includes(form)||!bench(id))return null;
  const no=ready(soul,id);if(no)return no;const b=h.engine.world.entities[soul.entityId];if(!b?.human)return{code:'body.unavailable',reason:'Your body is unavailable.'};
  if(b.human.holding||b.human.hands||b.human.handActuator||Object.values(h.engine.world.entities).some(x=>x.support?.kind==='in-hand'&&x.support.by===soul.entityId))return{code:'object.state',reason:'Put down what you are holding before carving.'};
  const e=bench(id)!,p=h.model.worldPose(e),slot=h.model.resolvedDef(e.def)!.slots.find(s=>s.id==='worker')!,c=Math.cos(p.yaw),s=Math.sin(p.yaw),x=p.x+(slot.p[0]*c+slot.p[2]*s)*p.s,z=p.z+(-slot.p[0]*s+slot.p[2]*c)*p.s,level=h.levelAt(x,z,p.y);
  if(h.engine.clearanceAtV1&&h.engine.clearanceAtV1(x,z,level)<.4)return{code:'object.state',reason:'There is no clear standing room at this carving bench.'};
  return{summary:'Ten seconds of carving completed; inspect the same artwork for its permanent form and maker.',steps:[{verb:'stand',params:{}},{verb:'mars:walk_to',params:{x,z,level}},{verb:'mars:pose_v1',params:{activity:'craft',seconds:10,prop:'tool',face:[p.x,p.z]}},{verb:'stand',params:{}}]};
 }
 function onReceipt(r:EdgeReceipt){
  const match=/^object:(.+):carve-(leaf|bird|totem)$/.exec(r.capability);if(!match)return;
  if(r.phase==='started'){if(!started.has(r.id)){const wood=target(match[1]);started.set(r.id,wood&&resting(wood.id,match[1])?wood.id:null);}return;}
  if(!['completed','failed','replaced'].includes(r.phase))return;const chosen=started.get(r.id);started.delete(r.id);
  if(r.phase!=='completed'||!chosen||!Number.isSafeInteger(r.endedTick)||r.endedTick!<0)return;
  const e=bench(match[1]),soul=h.soul(r.soulId);if(!e||!soul||e.state?.lastReceipt===r.id||ready({soulId:soul.id,entityId:soul.entity_id,name:soul.name},e.id)||r.endedTick!<Number(e.state?.lastCompletedTick??-1))return;
  const wood=target(e.id)!;if(wood.id!==chosen||!resting(wood.id,e.id))return;const p=h.model.worldPose(e),at=h.engine.world.entities[soul.entity_id]?.pose?.p;if(!at||Math.hypot(at[0]-p.x,at[2]-p.z)>ACT_REACH||h.levelAt(at[0],at[2],at[1])!==h.levelAt(p.x,p.z,p.y))return;
  const worker=soul.name.slice(0,80),form=match[2],ops:Op[]=[opSchema.parse({op:'set',id:e.id,state:{cuts:Number(e.state?.cuts)+1,lastReceipt:r.id,lastCompletedTick:r.endedTick,lastWorker:worker,lastArtifact:wood.id,lastForm:form}}),opSchema.parse({op:'set',id:wood.id,state:{carving:form,materialRemoved:true,carvedBy:worker}})];
  if(!h.commit(ops,`${r.soulId} carved a wooden ${form}`,`wood-carving:${r.id}`).accepted)h.log('wood-carving: world refused carving; blank and history unchanged');
 }
 function facts(id:string){const e=h.model.entities.get(id);if(!e)return null;const d=h.model.resolvedDef(e.def);
  if(isBench(d))return{woodCarving:`Carving bench: ${e.state?.cuts} completed artworks. ${e.state?.lastArtifact?`Last completed carving: ${e.state.lastForm}; maker ${e.state.lastWorker}; item ${e.state.lastArtifact} (historical).`:'No completed carving recorded.'} Place an uncarved wooden blank here; choose leaf, bird or totem. Completed ten-second work removes material permanently. Inspect the artwork itself for its current form.`};
  if(isBlank(d))return{woodCarving:e.state?.carving==='blank'?'Uncarved wooden blank; no material removed; no maker. Place on a carving bench and choose leaf, bird or totem.':`Carved wooden ${e.state?.carving}; material permanently removed; maker ${e.state?.carvedBy}. This same portable artwork cannot be restored or recarved. Pick up and place to display.`};return null;
 }
 return{plan,onReceipt,facts};
}
export type WoodCarving=ReturnType<typeof createWoodCarving>;
