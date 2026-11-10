// #1727: completed knot work rearranges the same actual supported practice board.
import {opSchema,type Op,type StoredDef,type WorldModel} from '@souls/world-compiler';
import type {EdgeReceipt,EdgeSoul} from '../edge/contract.ts';
import {ACT_REACH} from './actuators.ts';
type Refusal={code:string;reason:string};
type Body={pose?:{p:number[]};human?:{holding?:unknown;hands?:unknown;handActuator?:unknown};support?:{kind?:string;by?:string;on?:string}};
export type KnotPracticeHost={model:WorldModel;engine:{world:{entities:Record<string,Body>};clearanceAtV1?(x:number,z:number,level?:number):number};levelAt(x:number,z:number,y:number):number;soul(id:string):{id:string;entity_id:string;name:string}|undefined;denied(id:string,soul:{soulId:string;entityId:string;name:string}):Refusal|null;commit(ops:Op[],note:string,clientRef:string):{accepted:boolean};log(message:string):void;};
const isBench=(d:StoredDef|undefined)=>d?.name==='core-knotting-desk'&&d.version===1;
const isBoard=(d:StoredDef|undefined)=>d?.name==='core-knot-board'&&d.version===1;
const operations:Record<string,{field:'overhand'|'eight';value:boolean}>={'tie-overhand':{field:'overhand',value:true},'untie-overhand':{field:'overhand',value:false},'tie-eight':{field:'eight',value:true},'untie-eight':{field:'eight',value:false}};
export function createKnotPractice(h:KnotPracticeHost){
 const started=new Map<string,{id:string;overhand:boolean;eight:boolean;soul:string;body:string}|null>();
 const bench=(id:string)=>{const e=h.model.entities.get(id);return e&&isBench(h.model.resolvedDef(e.def))?e:null;};
 const target=(id:string)=>{for(const child of h.model.children.get(id)??[]){const e=h.model.entities.get(child);if(e?.in.slot==='out'&&isBoard(h.model.resolvedDef(e.def)))return e;}return null;};
 const resting=(id:string,on:string)=>{const s=h.engine.world.entities[id]?.support;return s?.kind==='resting-on'&&s.on===on;};
 function ready(soul:Pick<EdgeSoul,'soulId'|'entityId'|'name'>,id:string):Refusal|null{
  if(!bench(id))return{code:'object.gone',reason:'The knot work desk is no longer there.'};const no=h.denied(id,soul);if(no)return no;
  const body=h.engine.world.entities[soul.entityId]?.human;if(body&&(body.holding||body.hands||body.handActuator||Object.values(h.engine.world.entities).some(x=>x.support?.kind==='in-hand'&&x.support.by===soul.entityId)))return{code:'object.state',reason:'Put down what you are holding before knot work.'};
  const knotPractice=target(id);if(!knotPractice||!resting(knotPractice.id,id))return{code:'object.state',reason:'Place an actual knot board on the knotting surface first.'};const denied=h.denied(knotPractice.id,soul);if(denied)return denied;
  if(typeof knotPractice.state?.overhand!=='boolean'||typeof knotPractice.state?.eight!=='boolean')return{code:'object.state',reason:'This board has an unsupported cord state.'};return null;
 }
 function plan(soul:EdgeSoul,id:string,action:string){
  if(!Object.hasOwn(operations,action)||!bench(id))return null;const op=operations[action];
  const no=ready(soul,id);if(no)return no;if(target(id)!.state?.[op.field]===op.value)return{code:'object.state',reason:op.value?'That cord is already tied; untie it first.':'That cord is already loose; tie it first.'};const b=h.engine.world.entities[soul.entityId];if(!b?.human)return{code:'body.unavailable',reason:'Your body is unavailable.'};
  if(b.human.holding||b.human.hands||b.human.handActuator||Object.values(h.engine.world.entities).some(x=>x.support?.kind==='in-hand'&&x.support.by===soul.entityId))return{code:'object.state',reason:'Put down what you are holding before knot work.'};
  const e=bench(id)!,p=h.model.worldPose(e),slot=h.model.resolvedDef(e.def)!.slots.find(s=>s.id==='worker')!,c=Math.cos(p.yaw),s=Math.sin(p.yaw),x=p.x+(slot.p[0]*c+slot.p[2]*s)*p.s,z=p.z+(-slot.p[0]*s+slot.p[2]*c)*p.s,level=h.levelAt(x,z,p.y);
  if(h.engine.clearanceAtV1&&h.engine.clearanceAtV1(x,z,level)<.4)return{code:'object.state',reason:'There is no clear standing room at this knot work desk.'};
  return{summary:'Six seconds of knot work completed; inspect the same board for its two cord states and last worker.',steps:[{verb:'stand',params:{}},{verb:'mars:walk_to',params:{x,z,level}},{verb:'mars:pose_v1',params:{activity:'craft',seconds:6,face:[p.x,p.z]}},{verb:'stand',params:{}}]};
 }
 function onReceipt(r:EdgeReceipt){
  const match=/^object:(.+):(tie-overhand|untie-overhand|tie-eight|untie-eight)$/.exec(r.capability);if(!match)return;
  if(r.phase==='started'){if(!started.has(r.id)){const knotPractice=target(match[1]),actor=h.soul(r.soulId);started.set(r.id,knotPractice&&actor&&resting(knotPractice.id,match[1])?{id:knotPractice.id,overhand:Boolean(knotPractice.state?.overhand),eight:Boolean(knotPractice.state?.eight),soul:r.soulId,body:actor.entity_id}:null);}return;}
  if(!['completed','failed','replaced'].includes(r.phase))return;const chosen=started.get(r.id);started.delete(r.id);
  if(r.phase!=='completed'||!chosen||!Number.isSafeInteger(r.endedTick)||r.endedTick!<0)return;
  const e=bench(match[1]),soul=h.soul(r.soulId);if(!e||!soul||chosen.soul!==r.soulId||chosen.body!==soul.entity_id||e.state?.lastReceipt===r.id||ready({soulId:soul.id,entityId:soul.entity_id,name:soul.name},e.id)||r.endedTick!<Number(e.state?.lastCompletedTick??-1))return;
  const knotPractice=target(e.id)!;if(knotPractice.id!==chosen.id||knotPractice.state?.overhand!==chosen.overhand||knotPractice.state?.eight!==chosen.eight||!resting(knotPractice.id,e.id))return;const p=h.model.worldPose(e),at=h.engine.world.entities[soul.entity_id]?.pose?.p;if(!at||Math.hypot(at[0]-p.x,at[2]-p.z)>ACT_REACH||h.levelAt(at[0],at[2],at[1])!==h.levelAt(p.x,p.z,p.y))return;
  const worker=soul.name.slice(0,80),op=operations[match[2]];if(knotPractice.state?.[op.field]===op.value)return;
  const ops:Op[]=[opSchema.parse({op:'set',id:e.id,state:{operations:Number(e.state?.operations)+1,lastReceipt:r.id,lastCompletedTick:r.endedTick,lastWorker:worker,lastArtifact:knotPractice.id,lastOperation:match[2]}}),opSchema.parse({op:'set',id:knotPractice.id,state:{[op.field]:op.value,workedBy:worker}})];
  if(!h.commit(ops,`${r.soulId} completed ${match[2]}`,`knot-practice:${r.id}`).accepted)h.log('knot-practice: world refused work; cords and history unchanged');
 }
 function facts(id:string){const e=h.model.entities.get(id);if(!e)return null;const d=h.model.resolvedDef(e.def);
  if(isBench(d))return{knotPractice:`Knotting desk: ${e.state?.operations} completed operations. ${e.state?.lastArtifact?`Last ${e.state.lastOperation}; worker ${e.state.lastWorker}; board ${e.state.lastArtifact} (historical).`:'No completed knot work.'} Place a knot board here with free hands. Left cord: tie/untie overhand. Right cord: tie/untie figure-eight. Six seconds each. Inspect the board for its current knots.`};
  if(isBoard(d))return{knotPractice:`Knot board: left overhand ${e.state?.overhand?'tied':'loose'}; right figure-eight ${e.state?.eight?'tied':'loose'}; last worker ${e.state?.workedBy||'none'}. The same two supplied cords persist. Place on a knotting desk to tie or undo either cord with free hands (six seconds). Not load-bearing rope or a knot-training certification.`};return null;
 }
 return{plan,onReceipt,facts};
}
export type KnotPractice=ReturnType<typeof createKnotPractice>;
