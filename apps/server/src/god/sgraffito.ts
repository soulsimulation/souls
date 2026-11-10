// Native completed subtractive work changes one portable coated ceramic tile.
import {opSchema,type Op,type StoredDef,type WorldModel} from '@souls/world-compiler';
import type {EdgeReceipt,EdgeSoul} from '../edge/contract.ts';
import {tileCuts,scratchSelection,coatingRects,COAT_COLOURS} from '../../../../packages/world-compiler/src/core-kit/sgraffito.ts';
import {ACT_REACH} from './actuators.ts';
type Refusal={code:string;reason:string};
type Body={pose?:{p:number[]};support?:{kind?:string;on?:string;by?:string};human?:{holding?:unknown;hands?:unknown;handActuator?:unknown}};
type Approach=(id:string,soul:EdgeSoul,front:[number,number]|null,radius?:number)=>{p:[number,number];level:number}|null;
export type SgraffitoHost={model:WorldModel;engine:{world:{entities:Record<string,Body>}};levelAt(x:number,z:number,y:number):number;soul(id:string):{id:string;entity_id:string;name:string}|undefined;denied(id:string,soul:{soulId:string;entityId:string;name:string}):Refusal|null;commit(ops:Op[],note:string):{accepted:boolean};log(message:string):void};

const exact=(d:StoredDef|undefined)=>d?.name==='core-sgraffito-tile'&&d.version===1;
const identity=(e:{def:unknown;params?:unknown;owner?:unknown;access?:unknown;by?:unknown})=>[e.def,e.params,e.owner,e.access,e.by];
const stamp=(s:Record<string,unknown>|undefined)=>JSON.stringify(s);
export function createSgraffito(h:SgraffitoHost){
 const pending=new Map<string,{id:string;body:string;action:string;state:string;support:string;pose:string;identity:string;startedTick:number}>(),seen=new Set<string>();
 const tile=(id:string)=>{const e=h.model.entities.get(id);return e&&exact(h.model.resolvedDef(e.def))?e:null;};
 function ready(soul:Pick<EdgeSoul,'soulId'|'entityId'|'name'>,id:string,action:string){
  const e=tile(id);if(!e)return{no:{code:'object.gone',reason:'The scratch tile is no longer there.'}};
  const denied=h.denied(id,soul);if(denied)return{no:denied};
  const cuts=tileCuts(e.state),selected=scratchSelection(e.state?.window),colour=String(e.state?.colour);
  if(action==='coat'&&(!COAT_COLOURS.includes(colour as never)||Number(e.state?.portions)<1))return{no:{code:'object.state',reason:'Choose red, blue or gold and keep an unspent supplied coating portion. Used coating is not recovered.'}};
  if(action==='scratch'&&(e.state?.coat==='none'||!selected||cuts.length>=6))return{no:{code:'object.state',reason:'Coat this tile first, choose a valid free window, and keep a free scratch slot. Recoating uses another portion and resets all cuts.'}};
  if(action==='scratch'&&selected&&!coatingRects(cuts).some(c=>Math.min(c.x2,selected.x2)>Math.max(c.x1,selected.x1)&&Math.min(c.z2,selected.z2)>Math.max(c.z1,selected.z1)))return{no:{code:'object.state',reason:'That window is already fully exposed. Choose some remaining coating, or spend another portion to recoat.'}};
  const support=h.engine.world.entities[id]?.support,parent=h.model.entities.get(e.in.parent);
  if(!parent||support?.kind!=='resting-on'||support.on!==parent.id||!e.in.slot||!h.model.slotsOf(parent).some(s=>s.id===e.in.slot&&s.kind==='surface')||h.model.resolvedDef(parent.def)?.components.carryable)return{no:{code:'object.state',reason:'Put the tile on a real fixed work surface before coating or scratching.'}};
  const parentDenied=h.denied(parent.id,soul);if(parentDenied)return{no:parentDenied};
  const body=h.engine.world.entities[soul.entityId],pos=body?.pose?.p;
  if(!body?.human||!pos)return{no:{code:'body.unavailable',reason:'Your body is unavailable.'}};
  if(body.human.holding||(body.human.hands&&Object.values(body.human.hands as Record<string,unknown>).some(Boolean))||body.human.handActuator||Object.values(h.engine.world.entities).some(x=>x.support?.kind==='in-hand'&&x.support.by===soul.entityId))return{no:{code:'object.state',reason:'Put down held items before tile work.'}};
  return{e,parent,support,selected,cuts,colour};
 }
 function plan(soul:EdgeSoul,id:string,action:string,approach:Approach){
  if(!['coat','scratch'].includes(action)||!tile(id))return null;const a=ready(soul,id,action);if(a.no)return a.no;
  const p=h.model.worldPose(a.e!),front:[number,number]=[p.x+Math.sin(p.yaw),p.z+Math.cos(p.yaw)],stand=approach(id,soul,front,1.5);if(!stand)return{code:'object.state',reason:'No ordinary reachable standing point is available beside this tile.'};
  return{summary:'Completed four seconds of tile work; inspect actual coating, cuts and finite supplies.',steps:[{verb:'stand',params:{}},{verb:'mars:walk_to',params:{x:stand.p[0],z:stand.p[1],level:stand.level}},{verb:'mars:pose_v1',params:{activity:'craft',seconds:4,prop:'brush',face:[p.x,p.z]}},{verb:'mars:pose_v1',params:{activity:'stretch',seconds:.5,base:'idle',release:true,face:[p.x,p.z]}},{verb:'stand',params:{}}]};
 }
 function onReceipt(r:EdgeReceipt){
  const m=/^object:(.+):(coat|scratch)$/.exec(r.capability);if(!m)return;const soul=h.soul(r.soulId),id=m[1],action=m[2];
  if(r.phase==='started'){if(!soul||pending.has(r.id)||seen.has(r.id))return;const a=ready({soulId:soul.id,entityId:soul.entity_id,name:soul.name},id,action);if(a.e&&Number.isSafeInteger(r.startedTick))pending.set(r.id,{id,body:soul.entity_id,action,state:stamp(a.e.state),support:JSON.stringify([a.e.in,a.support]),pose:JSON.stringify([h.model.worldPose(a.e),h.model.worldPose(a.parent!)]),identity:JSON.stringify([identity(a.e),identity(a.parent!)]),startedTick:r.startedTick!});return;}
  if(!['completed','failed','replaced','aborted','cancelled'].includes(r.phase))return;const bound=pending.get(r.id);pending.delete(r.id);
  if(r.phase!=='completed'||!bound||bound.id!==id||bound.action!==action||!soul||bound.body!==soul.entity_id||seen.has(r.id)||!Number.isSafeInteger(r.endedTick)||r.startedTick!==bound.startedTick||r.endedTick!-bound.startedTick<80)return;
  const a=ready({soulId:soul.id,entityId:soul.entity_id,name:soul.name},id,action);if(a.no||JSON.stringify([identity(a.e!),identity(a.parent!)])!==bound.identity||stamp(a.e!.state)!==bound.state||JSON.stringify([a.e!.in,a.support])!==bound.support||JSON.stringify([h.model.worldPose(a.e!),h.model.worldPose(a.parent!)])!==bound.pose||a.e!.state?.lastReceipt===r.id||r.endedTick!<Number(a.e!.state?.lastCompletedTick??-1))return;
  const pos=h.engine.world.entities[soul.entity_id]?.pose?.p,p=h.model.worldPose(a.e!);if(!pos||Math.hypot(pos[0]-p.x,pos[2]-p.z)>ACT_REACH||h.levelAt(pos[0],pos[2],pos[1])!==h.levelAt(p.x,p.z,p.y))return;
  const coating=action==='coat',slot=Array.from({length:6},(_,i)=>i).find(i=>a.e!.state?.[`c${i}active`]!==true)!,state:Record<string,unknown>={lastReceipt:r.id,lastCompletedTick:r.endedTick,maker:soul.name.slice(0,80)};
  if(coating){state.coat=a.colour;state.portions=Number(a.e!.state?.portions)-1;for(let i=0;i<6;i++){state[`c${i}active`]=false;for(const k of['x1','z1','x2','z2'])state[`c${i}${k}`]=0;}}
  else{state[`c${slot}active`]=true;for(const k of['x1','z1','x2','z2']as const)state[`c${slot}${k}`]=a.selected![k];}
  const done=h.commit([opSchema.parse({op:'set',id,state,about:{title:'Sgraffito tile',what:`Same portable layered ceramic artwork; ${coating?'coated':'scratched'} by ${soul.name.slice(0,80)}. Inspect committed cut coordinates, coating and remaining portions. Removed coating is discarded, not recovered.`}})],`${r.soulId} worked sgraffito`);if(done.accepted)seen.add(r.id);else h.log('sgraffito: world refused batch; tile and supplies unchanged');
 }
 return{plan,onReceipt,facts(id:string){const e=tile(id);if(!e)return null;return{sgraffito:`Coat ${e.state?.coat}, remaining portions ${e.state?.portions}, maker ${e.state?.maker}. Cuts: ${JSON.stringify(tileCuts(e.state))}`,sgraffitoRequirements:'Fixed admitted work surface, empty hands; four seconds native work. Choose red/blue/gold and free rectangular windows inside x±0.27,z±0.17m, minimum side0.015m. Six windows. Recoat consumes another portion and resets cuts; removed coating is discarded.'};}};
}
export type Sgraffito=ReturnType<typeof createSgraffito>;
