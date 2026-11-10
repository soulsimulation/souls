// Completed native work atomically redistributes finite soil; ordinary geometry admission remains authoritative.
import {opSchema,type Op,type StoredDef,type WorldModel} from '@souls/world-compiler';
import type {EdgeReceipt,EdgeSoul} from '../edge/contract.ts';
import{earthLevel}from'../../../../packages/world-compiler/src/core-kit/earthwork.ts';
import {ACT_REACH} from './actuators.ts';
type Refusal={code:string;reason:string};
type Body={pose?:{p:number[]};support?:{kind?:string;on?:string;by?:string};human?:{holding?:unknown;hands?:unknown;handActuator?:unknown}};
type Approach=(id:string,soul:EdgeSoul,front:[number,number]|null,radius?:number)=>{p:[number,number];level:number}|null;
export type EarthworkHost={model:WorldModel;engine:{world:{entities:Record<string,Body>}};levelAt(x:number,z:number,y:number):number;soul(id:string):{id:string;entity_id:string;name:string}|undefined;denied(id:string,soul:{soulId:string;entityId:string;name:string}):Refusal|null;commit(ops:Op[],note:string):{accepted:boolean};log(message:string):void};

const exact=(d:StoredDef|undefined)=>d?.name==='core-earthwork-tray'&&d.version===1;
const identity=(e:{def:unknown;params?:unknown;owner?:unknown;access?:unknown;by?:unknown})=>[e.def,e.params,e.owner,e.access,e.by];
export function createEarthwork(h:EarthworkHost){
 const pending=new Map<string,{id:string;body:string;action:string;state:string;support:string;pose:string;identity:string;startedTick:number;pail:string}>(),seen=new Set<string>();
 const tile=(id:string)=>{const e=h.model.entities.get(id);return e&&exact(h.model.resolvedDef(e.def))?e:null;};
 function ready(soul:Pick<EdgeSoul,'soulId'|'entityId'|'name'>,id:string,action:string){
  const e=tile(id);if(!e)return{no:{code:'object.gone',reason:'The earthwork is no longer there.'}};
  const denied=h.denied(id,soul);if(denied)return{no:denied};
  const column=Number(e.state?.column);if(!/^[0-5]$/.test(String(e.state?.column)))return{no:{code:'object.state',reason:'Choose a column from0 through5 before moving soil.'}};
  if(!Array.from({length:6},(_,i)=>i).every(i=>earthLevel(e.state?.['l'+i])&&e.params?.['h'+i]===e.state?.['l'+i]))return{no:{code:'object.state',reason:'The authored soil levels and physical columns disagree; restore matching levels before work.'}};
  const pail=h.model.entities.get(String(e.state?.pailId));if(!pail)return{no:{code:'object.state',reason:'Find a real soil pail and choose its actual ID at this tray.'}};
  const pdn=h.denied(pail.id,soul);if(pdn)return{no:pdn};
  const pd=h.model.resolvedDef(pail.def);if(pd?.name!=='core-earthwork-soil-pail'||pd.version!==1)return{no:{code:'object.state',reason:'Choose the actual ID of a real soil pail.'}};
  if(![0,1].includes(Number(pail.state?.portions))||pail.params?.fill!==pail.state?.portions)return{no:{code:'object.state',reason:'The pail contents and physical fill disagree; restore the actual pail before work.'}};
  if(action==='dig'&&(Number(e.state?.['l'+column])<1||pail.state?.portions!==0))return{no:{code:'object.state',reason:'Dig from a nonempty column into an empty soil pail; fill a column first or empty this pail.'}};
  if(action==='fill'&&(Number(e.state?.['l'+column])>=2||pail.state?.portions!==1))return{no:{code:'object.state',reason:'Fill a column below two portions from a loaded soil pail; dig soil first or choose a lower column.'}};
  if(Number(e.state?.transfers)>=100000)return{no:{code:'object.state',reason:'This earthwork record is full; use another tray.'}};
  const support=h.engine.world.entities[id]?.support,parent=h.model.entities.get(e.in.parent);
  if(!parent||h.model.resolvedDef(parent.def)?.components.carryable||!h.model.resolvedDef(parent.def)?.components.surface||!e.in.slot||!h.model.slotsOf(parent).some(s=>s.id===e.in.slot&&s.kind==='surface')||!h.engine.world.entities[id]?.pose||!h.engine.world.entities[parent.id]?.pose||support?.kind==='in-hand')return{no:{code:'object.state',reason:'Put this tray on a fixed work surface before earthwork.'}};
  const ps=h.engine.world.entities[pail.id]?.support;if(pail.in.parent!==parent.id||ps?.kind!=='resting-on'||ps.on!==parent.id||!pail.in.slot||!h.model.slotsOf(parent).some(s=>s.id===pail.in.slot&&s.kind==='surface'))return{no:{code:'object.state',reason:'Put the real soil pail beside this tray on the same fixed surface; keep both supported and your hands empty.'}};
  if([...h.model.entities.values()].some(x=>x.in.parent===e.id||x.in.parent===pail.id)||Object.values(h.engine.world.entities).some(x=>x.support?.on===e.id||x.support?.on===pail.id))return{no:{code:'object.state',reason:'Remove anything supported on the tray or pail before changing soil; no supported actor or item may be moved.'}};
  const parentDenied=h.denied(parent.id,soul);if(parentDenied)return{no:parentDenied};
  const body=h.engine.world.entities[soul.entityId],pos=body?.pose?.p;
  if(!body?.human||!pos)return{no:{code:'body.unavailable',reason:'Your body is unavailable.'}};
  if(body.human.holding||(body.human.hands&&Object.values(body.human.hands as Record<string,unknown>).some(Boolean))||body.human.handActuator||Object.values(h.engine.world.entities).some(x=>x.support?.kind==='in-hand'&&x.support.by===soul.entityId))return{no:{code:'object.state',reason:'Put down held items before digging or filling.'}};
  return{e,parent,support,pail,ps,column};
 }
 function plan(soul:EdgeSoul,id:string,action:string,approach:Approach){
  if(!['dig','fill'].includes(action)||!tile(id))return null;const a=ready(soul,id,action);if(a.no)return a.no;
  const p=h.model.worldPose(a.e!),front:[number,number]=[p.x+Math.sin(p.yaw),p.z+Math.cos(p.yaw)],stand=approach(id,soul,front,1.5);if(!stand)return{code:'object.state',reason:'No ordinary reachable standing point is available beside this earthwork.'};
  return{summary:'Completed three seconds of conserved cut/fill work; inspect actual column levels and pail contents.',steps:[{verb:'stand',params:{}},{verb:'mars:walk_to',params:{x:stand.p[0],z:stand.p[1],level:stand.level}},{verb:'mars:pose_v1',params:{activity:'operate',seconds:3,face:[p.x,p.z]}},{verb:'mars:pose_v1',params:{activity:'nod',seconds:.5,base:'idle',release:true,clear:true,face:[p.x,p.z]}},{verb:'stand',params:{}}]};
 }
 function onReceipt(r:EdgeReceipt){
  const m=/^object:(.+):(dig|fill)$/.exec(r.capability);if(!m)return;const soul=h.soul(r.soulId),id=m[1],action=m[2];
  if(r.phase==='started'){if(!soul||pending.has(r.id)||seen.has(r.id))return;const a=ready({soulId:soul.id,entityId:soul.entity_id,name:soul.name},id,action);if(a.e&&Number.isSafeInteger(r.startedTick))pending.set(r.id,{id,body:soul.entity_id,action,state:JSON.stringify([a.e.state,a.pail!.state,a.pail!.params]),support:JSON.stringify([a.e.in,a.support,a.pail!.in,a.ps]),pose:JSON.stringify([h.model.worldPose(a.e),h.model.worldPose(a.parent!),h.model.worldPose(a.pail!),h.engine.world.entities[a.e.id]?.pose,h.engine.world.entities[a.parent!.id]?.pose,h.engine.world.entities[a.pail!.id]?.pose]),identity:JSON.stringify([identity(a.e),identity(a.parent!),identity(a.pail!)]),startedTick:r.startedTick!,pail:a.pail!.id});return;}
  if(!['completed','failed','replaced','aborted','cancelled'].includes(r.phase))return;const bound=pending.get(r.id);pending.delete(r.id);
  if(r.phase!=='completed'||!bound||bound.id!==id||bound.action!==action||!soul||bound.body!==soul.entity_id||seen.has(r.id)||!Number.isSafeInteger(r.endedTick)||r.startedTick!==bound.startedTick||r.endedTick!-bound.startedTick<60)return;
  const a=ready({soulId:soul.id,entityId:soul.entity_id,name:soul.name},id,action);if(a.no||a.pail!.id!==bound.pail||JSON.stringify([identity(a.e!),identity(a.parent!),identity(a.pail!)])!==bound.identity||JSON.stringify([a.e!.state,a.pail!.state,a.pail!.params])!==bound.state||JSON.stringify([a.e!.in,a.support,a.pail!.in,a.ps])!==bound.support||JSON.stringify([h.model.worldPose(a.e!),h.model.worldPose(a.parent!),h.model.worldPose(a.pail!),h.engine.world.entities[a.e!.id]?.pose,h.engine.world.entities[a.parent!.id]?.pose,h.engine.world.entities[a.pail!.id]?.pose])!==bound.pose||a.e!.state?.lastReceipt===r.id||r.endedTick!<Number(a.e!.state?.lastCompletedTick??-1))return;
  const pos=h.engine.world.entities[soul.entity_id]?.pose?.p,p=h.model.worldPose(a.e!);if(!pos||Math.hypot(pos[0]-p.x,pos[2]-p.z)>ACT_REACH||h.levelAt(pos[0],pos[2],pos[1])!==h.levelAt(p.x,p.z,p.y))return;
  const pp=h.model.worldPose(a.pail!);if(Math.hypot(pos[0]-pp.x,pos[2]-pp.z)>ACT_REACH||h.levelAt(pos[0],pos[2],pos[1])!==h.levelAt(pp.x,pp.z,pp.y))return;
  const delta=action==='dig'?-1:1,level=Number(a.e!.state?.['l'+a.column])+delta,portion=action==='dig'?1:0,maker=soul.name.slice(0,80),state={['l'+a.column]:level,transfers:Number(a.e!.state?.transfers)+1,lastReceipt:r.id,lastCompletedTick:r.endedTick,maker};
  const done=h.commit([opSchema.parse({op:'set',id,state,params:{['h'+a.column]:level},about:{title:'Conserved earthwork tray',what:`Cut-and-fill composition last worked by ${maker}. Six columns plus the actual soil pail conserve supplied material; inspect actual levels.`}}),opSchema.parse({op:'set',id:a.pail!.id,state:{portions:portion,maker},params:{fill:portion},about:{title:'Reusable soil pail',what:`Same real pail, ${portion} measured soil portion; last transfer by ${maker}. No separate supported child or density simulation.`}})],`${r.soulId} transferred earthwork soil`);if(done.accepted)seen.add(r.id);else h.log('earthwork: world refused atomic transfer; tray and pail unchanged');
 }
 return{plan,onReceipt,facts(id:string){const e=h.model.entities.get(id),d=e&&h.model.resolvedDef(e.def);if(!e||d?.version!==1)return null;if(d.name==='core-earthwork-soil-pail')return{earthworkPail:`Real soil pail: ${e.state?.portions}/1 measured portion, last worker ${e.state?.maker}. Put it beside the tray and choose this actual catalogue ID; ordinary carrying preserves this same pail.`};if(d.name!=='core-earthwork-tray')return null;return{earthwork:`Columns0–5: ${Array.from({length:6},(_,i)=>e.state?.['l'+i]).join(',')}; chosen ${e.state?.column}; own recorded pail selection ${e.state?.pailId||'none'} (inspect that pail separately), transfers ${e.state?.transfers}, maker ${e.state?.maker}.`,earthworkRequirements:'Same fixed work surface for tray and real pail, empty hands, no supported child/actor on either edited object. Three seconds native work; dig one portion into empty pail, fill a lower chosen column from loaded pail. Six supplied portions conserved between columns and actual pail; zero through two per column. No terrain/soil-flow simulation.'};}};
}
export type Earthwork=ReturnType<typeof createEarthwork>;
