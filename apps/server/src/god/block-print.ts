// Native craft owns time; started receipts bind this existing sheet and completed receipts consume its ink.
import {opSchema,type Op,type StoredDef,type WorldModel} from '@souls/world-compiler';
import type {EdgeReceipt,EdgeSoul} from '../edge/contract.ts';
import {ACT_REACH} from './actuators.ts';
import {supportY} from './nav.ts';
type Refusal={code:string;reason:string};
type Body={pose?:{p:number[]};support?:{kind?:string;on?:string;by?:string};human?:{holding?:unknown;hands?:unknown;handActuator?:unknown}};
export type BlockPrintHost={model:WorldModel;engine:{world:{entities:Record<string,Body>};clearanceAtV1?(x:number,z:number,level?:number):number};levelAt(x:number,z:number,y:number):number;soul(id:string):{id:string;entity_id:string;name:string}|undefined;denied(id:string,soul:{soulId:string;entityId:string;name:string}):Refusal|null;commit(ops:Op[],note:string,clientRef:string):{accepted:boolean};log(message:string):void};
const cells=['bl','br','fl','fr'] as const;
const choice=(a:string)=>{const m=/^print-(bl|br|fl|fr)-(disc|bar)-(red|blue)$/.exec(a);return m?{cell:m[1],value:`${m[2]}-${m[3]}`}:null;};
const isPaper=(d:StoredDef|undefined)=>d?.name==='core-block-print-paper'&&d.version===1;
export function createBlockPrint(h:BlockPrintHost){
 const pending=new Map<string,string>();
 const paper=(id:string)=>{const e=h.model.entities.get(id);return e&&isPaper(h.model.resolvedDef(e.def))?e:null;};
 const stamp=(id:string)=>{const e=paper(id);return e?JSON.stringify([e.in,h.model.worldPose(e),e.state?.ink,...cells.map(c=>e.state?.[c]),h.engine.world.entities[id]?.support]):'';};
 function ready(soul:Pick<EdgeSoul,'soulId'|'entityId'|'name'>,id:string,action:string):Refusal|null{
  const e=paper(id),pick=choice(action);if(!e||!pick)return{code:'object.gone',reason:'The printing sheet is no longer there.'};
  const no=h.denied(id,soul);if(no)return no;
  if(Number(e.state?.ink)<1)return{code:'object.state',reason:'The supplied ink is exhausted.'};
  if(e.state?.[pick.cell]===pick.value)return{code:'object.state',reason:'That cell already has the chosen motif and color.'};
  const support=h.engine.world.entities[id]?.support;
  if(support?.kind!=='resting-on'||support.on!==e.in.parent)return{code:'object.state',reason:'Set the printing sheet on a work surface first.'};
  const b=h.engine.world.entities[soul.entityId];if(!b?.human)return{code:'body.unavailable',reason:'Your body is unavailable.'};
  if(b.human.holding||b.human.hands||b.human.handActuator||Object.values(h.engine.world.entities).some(x=>x.support?.kind==='in-hand'&&x.support.by===soul.entityId))return{code:'object.state',reason:'Empty your hands before printing.'};
  return null;
 }
 function plan(soul:EdgeSoul,id:string,action:string){if(!paper(id)||!choice(action))return null;const no=ready(soul,id,action);if(no)return no;const e=paper(id)!,p=h.model.worldPose(e),x=p.x+Math.sin(p.yaw)*1.15*p.s,z=p.z+Math.cos(p.yaw)*1.15*p.s,level=h.levelAt(x,z,supportY(h.model,e));if(h.engine.clearanceAtV1&&h.engine.clearanceAtV1(x,z,level)<.4)return{code:'object.state',reason:'There is no clear standing room at this printing sheet.'};return{summary:'Completed six seconds of block printing; inspect the actual pattern and remaining ink.',steps:[{verb:'stand',params:{}},{verb:'mars:walk_to',params:{x,z,level}},{verb:'mars:pose_v1',params:{activity:'craft',prop:'brush',seconds:6,face:[p.x,p.z]}},{verb:'stand',params:{}}]};}
 function onReceipt(r:EdgeReceipt){const m=/^object:(.+):(print-(?:bl|br|fl|fr)-(?:disc|bar)-(?:red|blue))$/.exec(r.capability);if(!m)return;const soul=h.soul(r.soulId),e=paper(m[1]);if(r.phase==='started'){if(soul&&e&&!pending.has(r.id)&&!ready({soulId:soul.id,entityId:soul.entity_id,name:soul.name},e.id,m[2]))pending.set(r.id,stamp(e.id));return;}if(!['completed','failed','replaced'].includes(r.phase))return;const bound=pending.get(r.id);pending.delete(r.id);if(r.phase!=='completed'||!bound||!e||!soul||bound!==stamp(e.id)||!Number.isSafeInteger(r.endedTick)||r.endedTick!<0||r.endedTick!<Number(e.state?.lastCompletedTick??-1)||e.state?.lastReceipt===r.id||ready({soulId:soul.id,entityId:soul.entity_id,name:soul.name},e.id,m[2]))return;const at=h.engine.world.entities[soul.entity_id]?.pose?.p,p=h.model.worldPose(e);if(!at||Math.hypot(at[0]-p.x,at[2]-p.z)>ACT_REACH||h.levelAt(at[0],at[2],at[1])!==h.levelAt(p.x,p.z,supportY(h.model,e)))return;const pick=choice(m[2])!;const done=h.commit([opSchema.parse({op:'set',id:e.id,state:{[pick.cell]:pick.value,ink:Number(e.state?.ink)-1,lastBy:soul.name.slice(0,80),lastReceipt:r.id,lastCompletedTick:r.endedTick}})],`${r.soulId} made a block print`,`block-print:${r.id}`);if(!done.accepted)h.log('block-print: refused print batch; pattern and ink unchanged');}
 return{plan,onReceipt,facts(id:string){const e=paper(id);return e?{blockPrint:`Pattern: ${cells.map(c=>`${c} ${e.state?.[c]}`).join(', ')}. Ink remaining: ${e.state?.ink}/4. Last maker: ${e.state?.lastBy||'none'}. Choose disc/bar and red/blue independently in each cell. Six completed seconds and one ink per print; set on a work surface, empty hands, same floor. Interrupted work preserves the prior composition.`}:null;}};
}
export type BlockPrint=ReturnType<typeof createBlockPrint>;
