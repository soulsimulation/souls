// The old page samples this public recording at its depicted body clock, once per render (never at wall time).
import type {CarriedParts} from './take-parts.ts';
import {entityId} from './creator-kinds.ts';
import {layerDraws} from './layer-draws.ts';
import {worldPoint,type NativePose} from './recorded-carry.ts';
import type {CarryObservation} from './recorded-carry.ts';
import type {CarryGrips} from './source/carry-record.ts';
export type CarryHands={left:[number,number,number];right:[number,number,number]};
export type NativeCarryBody={body:string;crew:string;load:string;grip:string;phase:string;sinceUs:number;untilUs?:number;hands:CarryHands;order:[number,number];weight:number};
export type CarryPageFrame={at:number;loads:Record<string,NativePose>;bodies:Record<string,NativeCarryBody>;observations:CarryObservation[];contactStates:ReturnType<CarriedParts['recorded']['contactStates']>;phaseHistory:Record<string,CarryGrips[]>;evidence:Record<string,ReturnType<CarriedParts['recorded']['evidence']>>;errors:string[]};
let current:CarriedParts|null=null;
let bodies:ReadonlyMap<string,string>=new Map();
export const setNativeBodyEntities=(map:ReadonlyMap<string,string>)=>{bodies=map;};
export const nativeBodyEntities=()=>bodies;
export const setCarryPage=(parts:CarriedParts|null)=>{current=parts;};
export function carryPageAt(at:number,byBody:ReadonlyMap<string,string>,source:CarriedParts|null=current):CarryPageFrame|null{
 if(!source)return null;const records=source.recorded,loads:Record<string,NativePose>={},bodies:Record<string,NativeCarryBody>={},observations=records.observations(at),errors:string[]=[],evidence:CarryPageFrame['evidence']={},ambiguous=new Set<string>();
 if(records.error)errors.push('carry-record:'+records.error);
 // Static construction parts keep their recorded quaternion too; the actual furnished piece path stays untouched.
 for(const n of records.nodesAt(at)){const id=n.id;if(!source.isLoadKind(n.kind)&&!observations.some(o=>o.grips.load===id))continue;
  if(n.soul||/:(body|humanoid)(@|$)/.test(n.kind))continue;
  const pose=records.pose(id,at);if(pose){loads[layerDraws(n)&&n.origin?n.origin:entityId(id)]=pose;evidence[id]=records.evidence(id,at);}
 }
 const depicted=[...observations,...records.retiring(at).map(grips=>({grips,members:null,pose:records.pose(grips.load,at),at}))];
 for(const o of depicted){const g=o.grips;if(!o.pose){errors.push('load-frame:'+g.load);continue;}
  const n=records.nodeAt(g.load,at);if(!n){errors.push('load-node:'+g.load);continue;}loads[layerDraws(n)&&n.origin?n.origin:entityId(g.load)]=o.pose;
  const released=g.phase==='souls:released';
  if(!released&&!o.members){errors.push('crew-members:'+g.crew);continue;}
  if(!released&&(o.members!.length!==g.holds.length||o.members!.some(m=>!g.holds.some(h=>h.body===m.body))))errors.push('crew-contacts:'+g.crew);
  if(!released&&g.untilUs!==undefined&&at>=g.untilUs){errors.push('expired-phase:'+g.crew);continue;}
  const weight=released?Math.max(0,1-(at-g.sinceUs)/300000):1;
  evidence[g.load]=records.evidence(g.load,at);
  if(!weight)continue;
  for(const h of g.holds){const entity=byBody.get(h.body),order=records.anatomical(g,h.body);if(!entity||!order){errors.push('carrier-frame:'+h.body);continue;}
   if(!released&&!o.members?.some(m=>m.body===h.body)){errors.push('carrier-membership:'+h.body);continue;}
   const points=h.handsUm.map(p=>worldPoint(o.pose!,p));
   if(ambiguous.has(entity))continue;
   if(bodies[entity]){errors.push('ambiguous-carrier:'+h.body);delete bodies[entity];ambiguous.add(entity);continue;}
   bodies[entity]={body:h.body,crew:g.crew,load:g.load,grip:h.grip,phase:g.phase,sinceUs:g.sinceUs,...(g.untilUs!==undefined?{untilUs:g.untilUs}:{}),hands:{left:points[order[0]],right:points[order[1]]},order,weight};
  }
 }
 const contactStates=records.contactStates(at);return{at,loads,bodies,observations,contactStates,phaseHistory:Object.fromEntries(contactStates.map(o=>[o.crew,records.phaseHistory(o.crew,at)])),evidence,errors};
}

export function carryOwnerBetween(entity:string,fromSeconds:number,toSeconds:number,byBody:ReadonlyMap<string,string>,source:CarriedParts|null=current){if(!source)return false;for(const[body,id]of byBody)if(id===entity)return source.recorded.ownedBetween(body,Math.round(fromSeconds*1e6),Math.round(toSeconds*1e6));return false;}
