// #1714: completed counting rearranges the same actual supported abacus.
import {opSchema,type Op,type StoredDef,type WorldModel} from '@souls/world-compiler';
import type {EdgeReceipt,EdgeSoul} from '../edge/contract.ts';
import {ACT_REACH} from './actuators.ts';
type Refusal={code:string;reason:string};
type Body={pose?:{p:number[]};human?:{holding?:unknown;hands?:unknown;handActuator?:unknown};support?:{kind?:string;by?:string;on?:string}};
export type AbacusHost={model:WorldModel;engine:{world:{entities:Record<string,Body>};clearanceAtV1?(x:number,z:number,level?:number):number};levelAt(x:number,z:number,y:number):number;soul(id:string):{id:string;entity_id:string;name:string}|undefined;denied(id:string,soul:{soulId:string;entityId:string;name:string}):Refusal|null;commit(ops:Op[],note:string,clientRef:string):{accepted:boolean};log(message:string):void;};
const isBench=(d:StoredDef|undefined)=>d?.name==='core-counting-desk'&&d.version===1;
const isAbacus=(d:StoredDef|undefined)=>d?.name==='core-abacus'&&d.version===1;
const changes:Record<string,number>={'add-one':1,'add-ten':10,'subtract-one':-1,'subtract-ten':-10,clear:0};
const next=(value:number,action:string)=>action==='clear'?0:value+changes[action];
export function createAbacus(h:AbacusHost){
 const started=new Map<string,{id:string;value:number}|null>();
 const bench=(id:string)=>{const e=h.model.entities.get(id);return e&&isBench(h.model.resolvedDef(e.def))?e:null;};
 const target=(id:string)=>{for(const child of h.model.children.get(id)??[]){const e=h.model.entities.get(child);if(e?.in.slot==='out'&&isAbacus(h.model.resolvedDef(e.def)))return e;}return null;};
 const resting=(id:string,on:string)=>{const s=h.engine.world.entities[id]?.support;return s?.kind==='resting-on'&&s.on===on;};
 function ready(soul:Pick<EdgeSoul,'soulId'|'entityId'|'name'>,id:string):Refusal|null{
  if(!bench(id))return{code:'object.gone',reason:'The counting desk is no longer there.'};const no=h.denied(id,soul);if(no)return no;
  const abacus=target(id);if(!abacus||!resting(abacus.id,id))return{code:'object.state',reason:'Place an actual abacus on the counting surface first.'};const denied=h.denied(abacus.id,soul);if(denied)return denied;
  if(!Number.isSafeInteger(abacus.state?.value)||Number(abacus.state?.value)<0||Number(abacus.state?.value)>99)return{code:'object.state',reason:'This abacus has an unsupported count.'};return null;
 }
 function plan(soul:EdgeSoul,id:string,action:string){
  const form=action.startsWith('count-')?action.slice(6):'';if(!(form in changes)||!bench(id))return null;
  const no=ready(soul,id);if(no)return no;const value=next(Number(target(id)!.state?.value),form);if(value<0||value>99)return{code:'object.state',reason:'That change would exceed the abacus range 0–99.'};const b=h.engine.world.entities[soul.entityId];if(!b?.human)return{code:'body.unavailable',reason:'Your body is unavailable.'};
  if(b.human.holding||b.human.hands||b.human.handActuator||Object.values(h.engine.world.entities).some(x=>x.support?.kind==='in-hand'&&x.support.by===soul.entityId))return{code:'object.state',reason:'Put down what you are holding before counting.'};
  const e=bench(id)!,p=h.model.worldPose(e),slot=h.model.resolvedDef(e.def)!.slots.find(s=>s.id==='worker')!,c=Math.cos(p.yaw),s=Math.sin(p.yaw),x=p.x+(slot.p[0]*c+slot.p[2]*s)*p.s,z=p.z+(-slot.p[0]*s+slot.p[2]*c)*p.s,level=h.levelAt(x,z,p.y);
  if(h.engine.clearanceAtV1&&h.engine.clearanceAtV1(x,z,level)<.4)return{code:'object.state',reason:'There is no clear standing room at this counting desk.'};
  return{summary:'Three seconds of counting completed; inspect the same abacus for its current count and last worker.',steps:[{verb:'stand',params:{}},{verb:'mars:walk_to',params:{x,z,level}},{verb:'mars:pose_v1',params:{activity:'craft',seconds:3,face:[p.x,p.z]}},{verb:'stand',params:{}}]};
 }
 function onReceipt(r:EdgeReceipt){
  const match=/^object:(.+):count-(add-one|add-ten|subtract-one|subtract-ten|clear)$/.exec(r.capability);if(!match)return;
  if(r.phase==='started'){if(!started.has(r.id)){const abacus=target(match[1]);started.set(r.id,abacus&&resting(abacus.id,match[1])?{id:abacus.id,value:Number(abacus.state?.value)}:null);}return;}
  if(!['completed','failed','replaced'].includes(r.phase))return;const chosen=started.get(r.id);started.delete(r.id);
  if(r.phase!=='completed'||!chosen||!Number.isSafeInteger(r.endedTick)||r.endedTick!<0)return;
  const e=bench(match[1]),soul=h.soul(r.soulId);if(!e||!soul||e.state?.lastReceipt===r.id||ready({soulId:soul.id,entityId:soul.entity_id,name:soul.name},e.id)||r.endedTick!<Number(e.state?.lastCompletedTick??-1))return;
  const abacus=target(e.id)!;if(abacus.id!==chosen.id||abacus.state?.value!==chosen.value||!resting(abacus.id,e.id))return;const p=h.model.worldPose(e),at=h.engine.world.entities[soul.entity_id]?.pose?.p;if(!at||Math.hypot(at[0]-p.x,at[2]-p.z)>ACT_REACH||h.levelAt(at[0],at[2],at[1])!==h.levelAt(p.x,p.z,p.y))return;
  const worker=soul.name.slice(0,80),value=next(chosen.value,match[2]);if(!Number.isSafeInteger(value)||value<0||value>99)return;
  const ones=value%10,tens=Math.floor(value/10),ops:Op[]=[opSchema.parse({op:'set',id:e.id,state:{operations:Number(e.state?.operations)+1,lastReceipt:r.id,lastCompletedTick:r.endedTick,lastWorker:worker,lastArtifact:abacus.id,lastValue:value}}),opSchema.parse({op:'set',id:abacus.id,state:{value,onesLower:ones%5,onesFive:ones>=5,tensLower:tens%5,tensFive:tens>=5,countedBy:worker}})];
  if(!h.commit(ops,`${r.soulId} counted to ${value}`,`abacus:${r.id}`).accepted)h.log('abacus: world refused counting; count and history unchanged');
 }
 function facts(id:string){const e=h.model.entities.get(id);if(!e)return null;const d=h.model.resolvedDef(e.def);
  if(isBench(d))return{abacus:`Counting desk: ${e.state?.operations} completed operations. ${e.state?.lastArtifact?`Last completed count ${e.state.lastValue}; worker ${e.state.lastWorker}; item ${e.state.lastArtifact} (historical).`:'No completed counting recorded.'} Place an abacus here with free hands; add/subtract one or ten, or clear. Three seconds; valid counts 0–99. Inspect the abacus for its current count.`};
  if(isAbacus(d))return{abacus:`Abacus count ${e.state?.value}; tens ${Math.floor(Number(e.state?.value)/10)}, ones ${Number(e.state?.value)%10}; last worker ${e.state?.countedBy||'none'}. Left rod tens, right rod ones; upper bead counts five, lower beads one. Place on a counting desk to add/subtract one or ten, or clear. Portable count persists.`};return null;
 }
 return{plan,onReceipt,facts};
}
export type Abacus=ReturnType<typeof createAbacus>;
