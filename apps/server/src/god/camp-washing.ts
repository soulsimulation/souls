// Existing native work owns time; one ordinary batch cleans the bound bowl and uses its supplied water.
import {opSchema,type Op,type StoredDef,type WorldModel} from '@souls/world-compiler';
import type {EdgeReceipt,EdgeSoul} from '../edge/contract.ts';
import {ACT_REACH} from './actuators.ts';
type Refusal={code:string;reason:string};
type Body={pose?:{p:number[]};support?:{kind?:string;on?:string;by?:string};human?:{holding?:unknown;hands?:unknown;handActuator?:unknown}};
export type CampWashingHost={model:WorldModel;engine:{world:{entities:Record<string,Body>};clearanceAtV1?(x:number,z:number,level?:number):number};levelAt(x:number,z:number,y:number):number;soul(id:string):{id:string;entity_id:string;name:string}|undefined;denied(id:string,soul:{soulId:string;entityId:string;name:string}):Refusal|null;commit(ops:Op[],note:string,clientRef:string):{accepted:boolean};log(message:string):void};
const isStation=(d:StoredDef|undefined)=>d?.name==='core-camp-wash-station'&&d.version===1;
const isBowl=(d:StoredDef|undefined)=>d?.name==='core-camp-mess-kit'&&d.version===1;
export function createCampWashing(h:CampWashingHost){
 const pending=new Map<string,{bowl:string;station:string}>();
 const station=(id:string)=>{const e=h.model.entities.get(id);return e&&isStation(h.model.resolvedDef(e.def))?e:null;};
 function ready(soul:Pick<EdgeSoul,'soulId'|'entityId'|'name'>,id:string){
  const st=station(id);if(!st)return{no:{code:'object.gone',reason:'The camp wash station is no longer there.'}};
  const no=h.denied(id,soul);if(no)return{no};
  if(st.state?.water!==1)return{no:{code:'object.state',reason:'This wash station has no unused clean-water charge left.'}};
  const children=[...(h.model.children.get(id)??[])].map(i=>h.model.entities.get(i)!).filter(e=>e?.in.slot==='wash');
  const bowl=children.length===1&&isBowl(h.model.resolvedDef(children[0].def))?children[0]:null;
  if(!bowl||bowl.state?.clean!==false)return{no:{code:'object.state',reason:'Put one dirty camp mess-kit bowl on the wash board first.'}};
  const denied=h.denied(bowl.id,soul);if(denied)return{no:denied};
  const support=h.engine.world.entities[bowl.id]?.support;
  if(support?.kind!=='resting-on'||support.on!==id)return{no:{code:'object.state',reason:'The dirty bowl must actually rest on this wash board.'}};
  return{st,bowl};
 }
 function plan(soul:EdgeSoul,id:string,action:string){
  if(action!=='wash-messkit'||!station(id))return null;
  const r=ready(soul,id);if(r.no)return r.no;
  const b=h.engine.world.entities[soul.entityId];if(!b?.human)return{code:'body.unavailable',reason:'Your body is unavailable.'};
  if(b.human.holding||b.human.hands||b.human.handActuator||Object.values(h.engine.world.entities).some(x=>x.support?.kind==='in-hand'&&x.support.by===soul.entityId))return{code:'object.state',reason:'Put down what you are holding before washing.'};
  const p=h.model.worldPose(r.st!),d=h.model.resolvedDef(r.st!.def)!,worker=d.slots.find(s=>s.id==='worker')!,wash=d.slots.find(s=>s.id==='wash')!,c=Math.cos(p.yaw),s=Math.sin(p.yaw);
  const point=(v:number[])=>({x:p.x+(v[0]*c+v[2]*s)*p.s,z:p.z+(-v[0]*s+v[2]*c)*p.s}),stand=point(worker.p),face=point(wash.p),level=h.levelAt(stand.x,stand.z,p.y);
  if(h.engine.clearanceAtV1&&h.engine.clearanceAtV1(stand.x,stand.z,level)<.4)return{code:'object.state',reason:'There is no clear standing room at this wash board.'};
  return{summary:'Completed ten seconds washing the camp bowl; inspect the clean bowl and used water.',steps:[{verb:'stand',params:{}},{verb:'mars:walk_to',params:{x:stand.x,z:stand.z,level}},{verb:'mars:pose_v1',params:{activity:'craft',seconds:10,prop:'brush',face:[face.x,face.z]}},{verb:'stand',params:{}}]};
 }
 function onReceipt(r:EdgeReceipt){
  const match=/^object:(.+):wash-messkit$/.exec(r.capability);if(!match)return;
  const soul=h.soul(r.soulId),id=match[1];
  if(r.phase==='started'){
   if(!soul||pending.has(r.id))return;const at=ready({soulId:soul.id,entityId:soul.entity_id,name:soul.name},id);
   if(at.bowl)pending.set(r.id,{bowl:at.bowl.id,station:id});return;
  }
  if(!['completed','failed','replaced','aborted','cancelled'].includes(r.phase))return;
  const bound=pending.get(r.id);pending.delete(r.id);
  if(r.phase!=='completed'||!bound||bound.station!==id||!soul||!Number.isSafeInteger(r.endedTick)||r.endedTick!<0)return;
  const at=ready({soulId:soul.id,entityId:soul.entity_id,name:soul.name},id);
  if(at.no||at.bowl!.id!==bound.bowl||at.st!.state?.lastReceipt===r.id||r.endedTick!<Number(at.st!.state?.lastCompletedTick??-1))return;
  const pos=h.engine.world.entities[soul.entity_id]?.pose?.p,p=h.model.worldPose(at.st!);
  if(!pos||Math.hypot(pos[0]-p.x,pos[2]-p.z)>ACT_REACH||h.levelAt(pos[0],pos[2],pos[1])!==h.levelAt(p.x,p.z,p.y))return;
  const name=soul.name.slice(0,100),text=`Camp bowl washed by ${name}.`.slice(0,120);
  const done=h.commit([
   opSchema.parse({op:'set',id,state:{water:0,text:`Water used. Bowl washed by ${name}.`.slice(0,120),lastReceipt:r.id,lastCompletedTick:r.endedTick}}),
   opSchema.parse({op:'set',id:bound.bowl,state:{clean:true,text},about:{title:'Clean camp bowl',what:text}}),
  ],`${r.soulId} washed a camp bowl`,`camp-washing:${r.id}`);
  if(!done.accepted)h.log('camp-washing: world refused the washing batch; bowl and water unchanged');
 }
 return{plan,onReceipt,facts(id:string){const e=h.model.entities.get(id);if(!e)return null;const d=h.model.resolvedDef(e.def);
  if(isBowl(d))return{campMessKit:e.state?.clean===true?String(e.state?.text||'Clean camp bowl.'):'Dirty camp bowl: wash on a supplied camp wash board with empty hands.'};
  if(isStation(d))return{campWashing:`${e.state?.water===1?'One unused clean-water charge':'Water used'}. ${e.state?.text||'Put a dirty camp bowl on the wash board; scrub ten seconds with empty hands.'}`};
  return null;}};
}
export type CampWashing=ReturnType<typeof createCampWashing>;
