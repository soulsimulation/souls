// Native craft owns time; started receipts bind this same artwork and completed receipts move a single integral bead.
import {opSchema,type Op,type StoredDef,type WorldModel} from '@souls/world-compiler';
import type {EdgeReceipt,EdgeSoul} from '../edge/contract.ts';
import {ACT_REACH} from './actuators.ts';
import {supportY} from './nav.ts';
type Refusal={code:string;reason:string};
type Body={pose?:{p:number[]};support?:{kind?:string;on?:string;by?:string};human?:{holding?:unknown;hands?:unknown;handActuator?:unknown}};
export type BeadStrandHost={model:WorldModel;engine:{world:{entities:Record<string,Body>};clearanceAtV1?(x:number,z:number,level?:number):number};levelAt(x:number,z:number,y:number):number;soul(id:string):{id:string;entity_id:string;name:string}|undefined;denied(id:string,soul:{soulId:string;entityId:string;name:string}):Refusal|null;commit(ops:Op[],note:string,clientRef:string):{accepted:boolean};log(message:string):void};
const cells=Array.from({length:6},(_,i)=>`slot${i+1}`);
const choice=(a:string)=>{const m=/^(thread|unthread)-(slot[1-6])(?:-(red|blue|amber))?$/.exec(a);return m&&((m[1]==='thread'&&m[3])||(m[1]==='unthread'&&!m[3]))?{cell:m[2],value:m[3],undo:m[1]==='unthread'}:null;};
const isStrand=(d:StoredDef|undefined)=>d?.name==='core-bead-strand'&&d.version===1;
export function createBeadStrand(h:BeadStrandHost){
 const pending=new Map<string,{stamp:string;body:string;target:string;action:string}>();
 const strand=(id:string)=>{const e=h.model.entities.get(id);return e&&isStrand(h.model.resolvedDef(e.def))?e:null;};
 const stamp=(id:string)=>{const e=strand(id);return e?JSON.stringify([e.by,e.access,e.in,h.model.worldPose(e),...['red','blue','amber'].map(c=>e.state?.[c+'Stock']),...cells.map(c=>e.state?.[c]),h.engine.world.entities[id]?.support]):'';};
 function ready(soul:Pick<EdgeSoul,'soulId'|'entityId'|'name'>,id:string,action:string):Refusal|null{
  const e=strand(id),pick=choice(action);if(!e||!pick)return{code:'object.gone',reason:'The bead strand is no longer there.'};
  const no=h.denied(id,soul);if(no)return no;
  if(pick.undo?e.state?.[pick.cell]==='empty':e.state?.[pick.cell]!=='empty')return{code:'object.state',reason:pick.undo?'That strand position is empty.':'Unthread the bead already in this position first.'};
  if(!pick.undo&&Number(e.state?.[pick.value+'Stock'])<1)return{code:'object.state',reason:'That colour stock is empty; unthread a bead to recover it.'};
  const support=h.engine.world.entities[id]?.support;
  if(support?.kind!=='resting-on'||support.on!==e.in.parent)return{code:'object.state',reason:'Set the bead strand on a work surface first.'};
  const b=h.engine.world.entities[soul.entityId];if(!b?.human)return{code:'body.unavailable',reason:'Your body is unavailable.'};
  if(b.human.holding||b.human.hands||b.human.handActuator||Object.values(h.engine.world.entities).some(x=>x.support?.kind==='in-hand'&&x.support.by===soul.entityId))return{code:'object.state',reason:'Empty your hands before threading.'};
  return null;
 }
 function plan(soul:EdgeSoul,id:string,action:string){if(!strand(id)||!choice(action))return null;const no=ready(soul,id,action);if(no)return no;const e=strand(id)!,p=h.model.worldPose(e),x=p.x+Math.sin(p.yaw)*1.15*p.s,z=p.z+Math.cos(p.yaw)*1.15*p.s,level=h.levelAt(x,z,supportY(h.model,e));if(h.engine.clearanceAtV1&&h.engine.clearanceAtV1(x,z,level)<.4)return{code:'object.state',reason:'There is no clear standing room at this bead strand.'};return{summary:'Completed bead handwork; inspect the actual ordered strand and remaining stock.',steps:[{verb:'stand',params:{}},{verb:'mars:walk_to',params:{x,z,level}},{verb:'mars:pose_v1',params:{activity:'craft',prop:'brush',seconds:3,face:[p.x,p.z]}},{verb:'stand',params:{}}]};}
 function onReceipt(r:EdgeReceipt){const m=/^object:(.+):((?:thread-slot[1-6]-(?:red|blue|amber))|(?:unthread-slot[1-6]))$/.exec(r.capability);if(!m)return;const soul=h.soul(r.soulId),e=strand(m[1]);if(r.phase==='started'){if(soul&&e&&!pending.has(r.id)&&!ready({soulId:soul.id,entityId:soul.entity_id,name:soul.name},e.id,m[2]))pending.set(r.id,{stamp:stamp(e.id),body:soul.entity_id,target:e.id,action:m[2]});return;}if(!['completed','failed','replaced','aborted','cancelled'].includes(r.phase))return;const bound=pending.get(r.id);pending.delete(r.id);if(r.phase!=='completed'||!bound||!e||!soul||(bound.stamp!==stamp(e.id)||bound.body!==soul.entity_id||bound.target!==e.id||bound.action!==m[2])||!Number.isSafeInteger(r.endedTick)||r.endedTick!<0||r.endedTick!<Number(e.state?.lastCompletedTick??-1)||e.state?.lastReceipt===r.id||ready({soulId:soul.id,entityId:soul.entity_id,name:soul.name},e.id,m[2]))return;const at=h.engine.world.entities[soul.entity_id]?.pose?.p,p=h.model.worldPose(e);if(!at||Math.hypot(at[0]-p.x,at[2]-p.z)>ACT_REACH||h.levelAt(at[0],at[2],at[1])!==h.levelAt(p.x,p.z,supportY(h.model,e)))return;const pick=choice(m[2])!;const done=h.commit([opSchema.parse({op:'set',id:e.id,state:{[pick.cell]:pick.undo?'empty':pick.value,[(pick.undo?e.state?.[pick.cell]:pick.value)+'Stock']:Number(e.state?.[(pick.undo?e.state?.[pick.cell]:pick.value)+'Stock'])+(pick.undo?1:-1),maker:soul.name.slice(0,80),lastReceipt:r.id,lastCompletedTick:r.endedTick}})],`${r.soulId} worked the bead strand`,`bead-strand:${r.id}`);if(!done.accepted)h.log('bead-strand: refused bead batch; strand and stock unchanged');}
 return{plan,onReceipt,facts(id:string){const e=strand(id);return e?{beadStrand:`Ordered cord positions 1–6: ${cells.map(c=>e.state?.[c]).join(', ')}. Stock: ${['red','blue','amber'].map(c=>`${c} ${e.state?.[c+'Stock']}`).join(', ')}. Maker: ${e.state?.maker||'none'}. Two supplied beads per colour; six total. Thread an empty position or unthread to recover one bead. Three completed seconds on a fixed work table, empty hands, same floor. Interrupted work preserves the composition.`}:null;}};
}
export type BeadStrand=ReturnType<typeof createBeadStrand>;
