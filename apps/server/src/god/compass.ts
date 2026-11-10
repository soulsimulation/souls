// A completed native sight records the same placed instrument; the renderer observes this snapshot.
import {opSchema,type Op,type StoredDef,type WorldModel} from '@souls/world-compiler';
import type {EdgeReceipt,EdgeSoul} from '../edge/contract.ts';
import {headingOf,bearingError} from '../../../../packages/world-compiler/src/core-kit/compass.ts';
import {ACT_REACH} from './actuators.ts';
type Refusal={code:string;reason:string};
type Body={pose?:{p:number[]};support?:{kind?:string;on?:string;by?:string};human?:{holding?:unknown;hands?:unknown;handActuator?:unknown}};
type Approach=(id:string,soul:EdgeSoul,front:[number,number]|null,radius?:number)=>{p:[number,number];level:number}|null;
export type CompassHost={model:WorldModel;engine:{world:{entities:Record<string,Body>}};levelAt(x:number,z:number,y:number):number;soul(id:string):{id:string;entity_id:string;name:string}|undefined;denied(id:string,soul:{soulId:string;entityId:string;name:string}):Refusal|null;commit(ops:Op[],note:string):{accepted:boolean};log(message:string):void};

const exact=(d:StoredDef|undefined)=>d?.name==='core-camp-compass'&&d.version===1;
const identity=(e:{def:unknown;params?:unknown;owner?:unknown;access?:unknown;by?:unknown})=>[e.def,e.params,e.owner,e.access,e.by];
const stamp=(s:Record<string,unknown>|undefined)=>JSON.stringify(s);
export function createCompass(h:CompassHost){
 const pending=new Map<string,{id:string;body:string;action:string;state:string;support:string;pose:string;identity:string;startedTick:number}>(),seen=new Set<string>();
 const tile=(id:string)=>{const e=h.model.entities.get(id);return e&&exact(h.model.resolvedDef(e.def))?e:null;};
 function ready(soul:Pick<EdgeSoul,'soulId'|'entityId'|'name'>,id:string,action:string){
  const e=tile(id);if(!e)return{no:{code:'object.gone',reason:'The compass is no longer there.'}};
  const denied=h.denied(id,soul);if(denied)return{no:denied};
  if(typeof e.state?.selectedBearing!=='string'||!/^\d+(?:\.\d+)?$/.test(e.state.selectedBearing)||!Number.isFinite(Number(e.state.selectedBearing))||Number(e.state.selectedBearing)>=360)return{no:{code:'object.state',reason:'Choose a compass bearing from 0 up to 360 degrees (excluding 360).'}};
  if(Number(e.state?.sightings)>=100000)return{no:{code:'object.state',reason:'This compass record is full; use another instrument.'}};
  const support=h.engine.world.entities[id]?.support,parent=h.model.entities.get(e.in.parent);
  if(!parent||support?.kind!=='resting-on'||support.on!==parent.id||!e.in.slot||!h.model.slotsOf(parent).some(s=>s.id===e.in.slot&&s.kind==='surface')||h.model.resolvedDef(parent.def)?.components.carryable)return{no:{code:'object.state',reason:'Put the compass on a real fixed work surface before sighting.'}};
  const parentDenied=h.denied(parent.id,soul);if(parentDenied)return{no:parentDenied};
  const body=h.engine.world.entities[soul.entityId],pos=body?.pose?.p;
  if(!body?.human||!pos)return{no:{code:'body.unavailable',reason:'Your body is unavailable.'}};
  if(body.human.holding||(body.human.hands&&Object.values(body.human.hands as Record<string,unknown>).some(Boolean))||body.human.handActuator||Object.values(h.engine.world.entities).some(x=>x.support?.kind==='in-hand'&&x.support.by===soul.entityId))return{no:{code:'object.state',reason:'Put down held items before compass sighting.'}};
  return{e,parent,support};
 }
 function plan(soul:EdgeSoul,id:string,action:string,approach:Approach){
  if(action!=='sight'||!tile(id))return null;const a=ready(soul,id,action);if(a.no)return a.no;
  const p=h.model.worldPose(a.e!),front:[number,number]=[p.x+Math.sin(p.yaw),p.z+Math.cos(p.yaw)],stand=approach(id,soul,front,1.5);if(!stand)return{code:'object.state',reason:'No ordinary reachable standing point is available beside this compass.'};
  return{summary:'Completed three seconds of compass sighting; inspect the actual heading and signed bearing error.',steps:[{verb:'stand',params:{}},{verb:'mars:walk_to',params:{x:stand.p[0],z:stand.p[1],level:stand.level}},{verb:'mars:pose_v1',params:{activity:'operate',seconds:3,face:[p.x,p.z]}},{verb:'mars:pose_v1',params:{activity:'nod',seconds:.5,base:'idle',release:true,clear:true,face:[p.x,p.z]}},{verb:'stand',params:{}}]};
 }
 function onReceipt(r:EdgeReceipt){
  const m=/^object:(.+):(sight)$/.exec(r.capability);if(!m)return;const soul=h.soul(r.soulId),id=m[1],action=m[2];
  if(r.phase==='started'){if(!soul||pending.has(r.id)||seen.has(r.id))return;const a=ready({soulId:soul.id,entityId:soul.entity_id,name:soul.name},id,action);if(a.e&&Number.isSafeInteger(r.startedTick))pending.set(r.id,{id,body:soul.entity_id,action,state:stamp(a.e.state),support:JSON.stringify([a.e.in,a.support]),pose:JSON.stringify([h.model.worldPose(a.e),h.model.worldPose(a.parent!)]),identity:JSON.stringify([identity(a.e),identity(a.parent!)]),startedTick:r.startedTick!});return;}
  if(!['completed','failed','replaced','aborted','cancelled'].includes(r.phase))return;const bound=pending.get(r.id);pending.delete(r.id);
  if(r.phase!=='completed'||!bound||bound.id!==id||bound.action!==action||!soul||bound.body!==soul.entity_id||seen.has(r.id)||!Number.isSafeInteger(r.endedTick)||r.startedTick!==bound.startedTick||r.endedTick!-bound.startedTick<60)return;
  const a=ready({soulId:soul.id,entityId:soul.entity_id,name:soul.name},id,action);if(a.no||JSON.stringify([identity(a.e!),identity(a.parent!)])!==bound.identity||stamp(a.e!.state)!==bound.state||JSON.stringify([a.e!.in,a.support])!==bound.support||JSON.stringify([h.model.worldPose(a.e!),h.model.worldPose(a.parent!)])!==bound.pose||a.e!.state?.lastReceipt===r.id||r.endedTick!<Number(a.e!.state?.lastCompletedTick??-1))return;
  const pos=h.engine.world.entities[soul.entity_id]?.pose?.p,p=h.model.worldPose(a.e!);if(!pos||Math.hypot(pos[0]-p.x,pos[2]-p.z)>ACT_REACH||h.levelAt(pos[0],pos[2],pos[1])!==h.levelAt(p.x,p.z,p.y))return;
  const heading=headingOf(p.yaw),bearing=Number(a.e!.state?.selectedBearing),state={heading,sightedBearing:bearing,error:bearingError(heading,bearing),sighted:true,sightings:Number(a.e!.state?.sightings)+1,lastReceipt:r.id,lastCompletedTick:r.endedTick,maker:soul.name.slice(0,80)};
  const done=h.commit([opSchema.parse({op:'set',id,state,about:{title:'Camp sighting compass',what:`Last instrument sight by ${soul.name.slice(0,80)}: heading ${heading.toFixed(1)} degrees, selected ${bearing.toFixed(1)}, signed turn ${state.error.toFixed(1)}. Re-sight after moving; world north is -z.`}})],`${r.soulId} sighted compass`);if(done.accepted)seen.add(r.id);else h.log('compass: world refused sight record; instrument unchanged');
 }
 return{plan,onReceipt,facts(id:string){const e=tile(id);if(!e)return null;return{compass:`Selected bearing ${e.state?.selectedBearing} degrees. Last sight: ${e.state?.sighted===true?`heading ${e.state?.heading}, selected ${e.state?.sightedBearing}, signed turn ${e.state?.error}`:'none'}. Completed sights ${e.state?.sightings}; observer ${e.state?.maker}.`,compassRequirements:'Placed on a fixed surface, empty hands, three seconds native work. North is world -z; positive bearings turn clockwise. Needle/reference show the last sight snapshot; re-sight after relocation, rotation or a changed bezel selection. No continuously simulated magnetism or automatic route following.'};}};
}
export type Compass=ReturnType<typeof createCompass>;
