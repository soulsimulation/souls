// Native completion reworks one finite portable spatial wire sculpture.
import {opSchema,type Op,type StoredDef,type WorldModel} from '@souls/world-compiler';
import type {EdgeReceipt,EdgeSoul} from '../edge/contract.ts';
import {direction,wirePoints,withinWireEnvelope} from '../../../../packages/world-compiler/src/core-kit/wire-sculpture.ts';
import {ACT_REACH} from './actuators.ts';
type Refusal={code:string;reason:string};
type Body={pose?:{p:number[]};support?:{kind?:string;on?:string;by?:string};human?:{holding?:unknown;hands?:unknown;handActuator?:unknown}};
type Approach=(id:string,soul:EdgeSoul,front:[number,number]|null,radius?:number)=>{p:[number,number];level:number}|null;
export type WireSculptureHost={model:WorldModel;engine:{world:{entities:Record<string,Body>}};levelAt(x:number,z:number,y:number):number;soul(id:string):{id:string;entity_id:string;name:string}|undefined;denied(id:string,soul:{soulId:string;entityId:string;name:string}):Refusal|null;commit(ops:Op[],note:string):{accepted:boolean};log(message:string):void};

const exact=(d:StoredDef|undefined)=>d?.name==='core-spatial-wire-sculpture'&&d.version===1;
const identity=(e:{def:unknown;params?:unknown;owner?:unknown;access?:unknown;by?:unknown})=>[e.def,e.params,e.owner,e.access,e.by];
const stamp=(s:Record<string,unknown>|undefined)=>JSON.stringify(s);
export function createWireSculpture(h:WireSculptureHost){
 const pending=new Map<string,{id:string;body:string;action:string;state:string;support:string;pose:string;identity:string;startedTick:number}>(),seen=new Set<string>();
 const tile=(id:string)=>{const e=h.model.entities.get(id);return e&&exact(h.model.resolvedDef(e.def))?e:null;};
 function ready(soul:Pick<EdgeSoul,'soulId'|'entityId'|'name'>,id:string,action:string){
  const e=tile(id);if(!e)return{no:{code:'object.gone',reason:'The wire sculpture is no longer there.'}};
  const denied=h.denied(id,soul);if(denied)return{no:denied};
  const joint=Number(e.state?.joint),chosen=direction(e.state?.direction),next:Record<string,unknown>={...e.state};
  if(action==='bend'&&(!/^[0-3]$/.test(String(e.state?.joint))||!chosen))return{no:{code:'object.state',reason:'Choose link 0..3 and yaw,pitch degrees: yaw -180..180, pitch 0..70 from vertical.'}};
  if(action==='bend'){next[`yaw${joint}`]=chosen!.yaw;next[`pitch${joint}`]=chosen!.pitch;}else for(let i=0;i<4;i++){next[`yaw${i}`]=0;next[`pitch${i}`]=0;}
  if(!withinWireEnvelope(next)||Number(e.state?.bends)>=100000)return{no:{code:'object.state',reason:'Choose a direction that keeps the connected wire inside x/z±0.25m and height 0.5m, with a free work record.'}};
  const support=h.engine.world.entities[id]?.support,parent=h.model.entities.get(e.in.parent);
  if(!h.engine.world.entities[id]?.pose||!parent||!h.engine.world.entities[parent.id]?.pose||support?.kind!=='resting-on'||support.on!==parent.id||!e.in.slot||!h.model.slotsOf(parent).some(s=>s.id===e.in.slot&&s.kind==='surface')||h.model.resolvedDef(parent.def)?.components.carryable)return{no:{code:'object.state',reason:'Put the sculpture on a real fixed work surface before wire work.'}};
  const parentDenied=h.denied(parent.id,soul);if(parentDenied)return{no:parentDenied};
  const body=h.engine.world.entities[soul.entityId],pos=body?.pose?.p;
  if(!body?.human||!pos)return{no:{code:'body.unavailable',reason:'Your body is unavailable.'}};
  if(body.human.holding||(body.human.hands&&Object.values(body.human.hands as Record<string,unknown>).some(Boolean))||body.human.handActuator||Object.values(h.engine.world.entities).some(x=>x.support?.kind==='in-hand'&&x.support.by===soul.entityId))return{no:{code:'object.state',reason:'Put down held items before wire work.'}};
  return{e,parent,support,next};
 }
 function plan(soul:EdgeSoul,id:string,action:string,approach:Approach){
  if(!['bend','straighten'].includes(action)||!tile(id))return null;const a=ready(soul,id,action);if(a.no)return a.no;
  const p=h.model.worldPose(a.e!),front:[number,number]=[p.x+Math.sin(p.yaw),p.z+Math.cos(p.yaw)],stand=approach(id,soul,front,1.5);if(!stand)return{code:'object.state',reason:'No ordinary reachable standing point is available beside this sculpture.'};
  return{summary:'Completed three seconds of wire work; inspect the same finite spatial sculpture.',steps:[{verb:'stand',params:{}},{verb:'mars:walk_to',params:{x:stand.p[0],z:stand.p[1],level:stand.level}},{verb:'mars:pose_v1',params:{activity:'operate',seconds:3,face:[p.x,p.z]}},{verb:'mars:pose_v1',params:{activity:'nod',seconds:.5,base:'idle',release:true,clear:true,face:[p.x,p.z]}},{verb:'stand',params:{}}]};
 }
 function onReceipt(r:EdgeReceipt){
  const m=/^object:(.+):(bend|straighten)$/.exec(r.capability);if(!m)return;const soul=h.soul(r.soulId),id=m[1],action=m[2];
  if(r.phase==='started'){if(!soul||pending.has(r.id)||seen.has(r.id))return;const a=ready({soulId:soul.id,entityId:soul.entity_id,name:soul.name},id,action);if(a.e&&Number.isSafeInteger(r.startedTick))pending.set(r.id,{id,body:soul.entity_id,action,state:stamp(a.e.state),support:JSON.stringify([a.e.in,a.support]),pose:JSON.stringify([h.model.worldPose(a.e),h.model.worldPose(a.parent!),h.engine.world.entities[id]?.pose,h.engine.world.entities[a.parent!.id]?.pose]),identity:JSON.stringify([identity(a.e),identity(a.parent!)]),startedTick:r.startedTick!});return;}
  if(!['completed','failed','replaced','aborted','cancelled'].includes(r.phase))return;const bound=pending.get(r.id);pending.delete(r.id);
  if(r.phase!=='completed'||!bound||bound.id!==id||bound.action!==action||!soul||bound.body!==soul.entity_id||seen.has(r.id)||!Number.isSafeInteger(r.endedTick)||r.startedTick!==bound.startedTick||r.endedTick!-bound.startedTick<60)return;
  const a=ready({soulId:soul.id,entityId:soul.entity_id,name:soul.name},id,action);if(a.no||JSON.stringify([identity(a.e!),identity(a.parent!)])!==bound.identity||stamp(a.e!.state)!==bound.state||JSON.stringify([a.e!.in,a.support])!==bound.support||JSON.stringify([h.model.worldPose(a.e!),h.model.worldPose(a.parent!),h.engine.world.entities[id]?.pose,h.engine.world.entities[a.parent!.id]?.pose])!==bound.pose||a.e!.state?.lastReceipt===r.id||r.endedTick!<Number(a.e!.state?.lastCompletedTick??-1))return;
  const pos=h.engine.world.entities[soul.entity_id]?.pose?.p,p=h.model.worldPose(a.e!);if(!pos||Math.hypot(pos[0]-p.x,pos[2]-p.z)>ACT_REACH||h.levelAt(pos[0],pos[2],pos[1])!==h.levelAt(p.x,p.z,p.y))return;
  const state:Record<string,unknown>={...a.next,lastReceipt:r.id,lastCompletedTick:r.endedTick,maker:soul.name.slice(0,80),bends:Number(a.e!.state?.bends)+1};
  const done=h.commit([opSchema.parse({op:'set',id,state,about:{title:'Spatial wire sculpture',what:`Same portable finite wire and retained plinth; ${action} by ${soul.name.slice(0,80)}. Inspect committed link directions and connected points.`}})],`${r.soulId} worked wire sculpture`);if(done.accepted)seen.add(r.id);else h.log('wire-sculpture: world refused batch; sculpture unchanged');
 }
 return{plan,onReceipt,facts(id:string){const e=tile(id);if(!e)return null;return{wireSculpture:`Same 0.44m wire, four 0.11m links; bends ${e.state?.bends}; maker ${e.state?.maker}. Directions: ${JSON.stringify(Array.from({length:4},(_,i)=>[e.state?.[`yaw${i}`],e.state?.[`pitch${i}`]]))}. Connected points: ${JSON.stringify(wirePoints(e.state))}`,wireRequirements:'Fixed admitted work surface and empty hands; three seconds native work. Choose link 0..3 and direction yaw,pitch degrees. All four fixed-length links remain connected inside the fixed conservative envelope; straighten restores vertical.'};}};
}
export type WireSculpture=ReturnType<typeof createWireSculpture>;
