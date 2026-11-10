// Existing native craft owns time; one ordinary batch transforms the bound linen and consumes its supplies.
import{opSchema,type Op,type StoredDef,type WorldModel}from'@souls/world-compiler';
import type{EdgeReceipt,EdgeSoul}from'../edge/contract.ts';
import{ACT_REACH}from'./actuators.ts';
type Refusal={code:string;reason:string};
type Body={pose?:{p:number[]};support?:{kind?:string;on?:string;by?:string};human?:{holding?:unknown;hands?:unknown;handActuator?:unknown}};
export type LaundryHost={model:WorldModel;engine:{world:{entities:Record<string,Body>};clearanceAtV1?(x:number,z:number,level?:number):number};levelAt(x:number,z:number,y:number):number;soul(id:string):{id:string;entity_id:string;name:string}|undefined;denied(id:string,soul:{soulId:string;entityId:string;name:string}):Refusal|null;commit(ops:Op[],note:string,clientRef:string):{accepted:boolean};log(message:string):void};
const isBench=(d:StoredDef|undefined)=>d?.name==='core-laundry-board'&&d.version===1;
const isLinen=(d:StoredDef|undefined)=>d?.name==='core-camp-linen'&&d.version===1;
type Operation='wash'|'wring'|'fold';
export function createLaundry(h:LaundryHost){
 const pending=new Map<string,{linen:string;bench:string;body:string;operation:Operation;stage:unknown;text:unknown}>();
 const bench=(id:string)=>{const e=h.model.entities.get(id);return e&&isBench(h.model.resolvedDef(e.def))?e:null;};
 const choice=(action:string):Operation|null=>action==='wash-linen'?'wash':action==='wring-linen'?'wring':action==='fold-linen'?'fold':null;
 function ready(soul:Pick<EdgeSoul,'soulId'|'entityId'|'name'>,id:string,c:Operation){
  const at=bench(id);if(!at)return{no:{code:'object.gone',reason:'The laundry board is no longer there.'}};
  const no=h.denied(id,soul);if(no)return{no};
  const children=[...(h.model.children.get(id)??[])].map(i=>h.model.entities.get(i)!).filter(e=>e?.in.slot==='linen');
  const linen=children.length===1&&isLinen(h.model.resolvedDef(children[0].def))?children[0]:null;
  if(!linen)return{no:{code:'object.state',reason:'Put one camp linen on the linen board first.'}};
  const required=c==='wash'?0:c==='wring'?1:2;
  if(linen.state?.stage!==required)return{no:{code:'object.state',reason:c==='wash'?'This operation needs dirty linen.':c==='wring'?'Wash the dirty linen first; then wring the wet linen.':'Wring the wet linen first; then fold the damp linen.'}};
  if(c==='wash'&&(at.state?.soap!==1||at.state?.water!==1))return{no:{code:'object.state',reason:'Washing needs one unused soap charge and one water charge.'}};
  const denied=h.denied(linen.id,soul);if(denied)return{no:denied};
  const support=h.engine.world.entities[linen.id]?.support;
  if(support?.kind!=='resting-on'||support.on!==id)return{no:{code:'object.state',reason:'The linen must actually rest on this laundry board.'}};
  const body=h.engine.world.entities[soul.entityId],pos=body?.pose?.p,p=h.model.worldPose(at);
  if(!body?.human||!pos)return{no:{code:'body.unavailable',reason:'Your body is unavailable.'}};
  if(body.human.holding||body.human.hands||body.human.handActuator||Object.values(h.engine.world.entities).some(x=>x.support?.kind==='in-hand'&&x.support.by===soul.entityId))return{no:{code:'object.state',reason:'Put down what you are holding before laundry.'}};
  if(h.levelAt(pos[0],pos[2],pos[1])!==h.levelAt(p.x,p.z,p.y))return{no:{code:'object.state',reason:'Reach the same floor as the laundry board first.'}};
  return{at,linen};
 }
 function plan(soul:EdgeSoul,id:string,action:string){
  const c=choice(action);if(!c||!bench(id))return null;
  const r=ready(soul,id,c);if(r.no)return r.no;
  const p=h.model.worldPose(r.at!),d=h.model.resolvedDef(r.at!.def)!,worker=d.slots.find(s=>s.id==='worker')!,linen=d.slots.find(s=>s.id==='linen')!,cos=Math.cos(p.yaw),sin=Math.sin(p.yaw);
  const point=(v:number[])=>({x:p.x+(v[0]*cos+v[2]*sin)*p.s,z:p.z+(-v[0]*sin+v[2]*cos)*p.s}),stand=point(worker.p),face=point(linen.p),level=h.levelAt(stand.x,stand.z,p.y);
  if(h.engine.clearanceAtV1&&h.engine.clearanceAtV1(stand.x,stand.z,level)<.4)return{code:'object.state',reason:'There is no clear standing room at this laundry board.'};
  return{summary:`Completed ten seconds ${c==='wash'?'washing':c==='wring'?'wringing':'folding'} the linen; inspect its current damp stage and supplies.`,steps:[{verb:'stand',params:{}},{verb:'mars:walk_to',params:{x:stand.x,z:stand.z,level}},{verb:'mars:pose_v1',params:{activity:'craft',seconds:10,prop:'brush',face:[face.x,face.z]}},{verb:'stand',params:{}}]};
 }
 function onReceipt(r:EdgeReceipt){
  const m=/^object:(.+):(wash-linen|wring-linen|fold-linen)$/.exec(r.capability);if(!m)return;
  const soul=h.soul(r.soulId),id=m[1],c=choice(m[2])!;
  if(r.phase==='started'){
   if(!soul||pending.has(r.id))return;const at=ready({soulId:soul.id,entityId:soul.entity_id,name:soul.name},id,c);
   if(at.linen)pending.set(r.id,{linen:at.linen.id,bench:id,body:soul.entity_id,operation:c,stage:at.linen.state?.stage,text:at.linen.state?.text});return;
  }
  if(!['completed','failed','replaced','aborted','cancelled'].includes(r.phase))return;
  const bound=pending.get(r.id);pending.delete(r.id);
  if(r.phase!=='completed'||!bound||bound.bench!==id||bound.operation!==c||!soul||bound.body!==soul.entity_id||!Number.isSafeInteger(r.endedTick)||r.endedTick!<0)return;
  const at=ready({soulId:soul.id,entityId:soul.entity_id,name:soul.name},id,c);
  if(at.no||at.linen!.id!==bound.linen||at.linen!.state?.stage!==bound.stage||at.linen!.state?.text!==bound.text||at.at!.state?.lastReceipt===r.id||r.endedTick!<Number(at.at!.state?.lastCompletedTick??-1))return;
  const pos=h.engine.world.entities[soul.entity_id]?.pose?.p,p=h.model.worldPose(at.at!);
  if(!pos||Math.hypot(pos[0]-p.x,pos[2]-p.z)>ACT_REACH)return;
  const name=soul.name.slice(0,80),title=c==='wash'?'Clean wet linen':c==='wring'?'Wrung damp linen':'Folded damp linen',text=`${title}, ${c==='wash'?'washed':c==='wring'?'wrung':'folded'} by ${name}.`.slice(0,160);
  const done=h.commit([
   opSchema.parse({op:'set',id,state:{...(c==='wash'?{soap:0,water:0}:{}),text:`Last operation: ${c}, by ${name}.`.slice(0,160),lastReceipt:r.id,lastCompletedTick:r.endedTick}}),
   opSchema.parse({op:'set',id:bound.linen,state:{stage:c==='wash'?1:c==='wring'?2:3,text},about:{title,what:text}}),
  ],`${r.soulId} worked camp linen`,`laundry:${r.id}`);
  if(!done.accepted)h.log('laundry: world refused the laundry batch; linen and supplies unchanged');
 }
 return{plan,onReceipt,facts(id:string){const e=h.model.entities.get(id);if(!e)return null;const d=h.model.resolvedDef(e.def);
  if(isLinen(d))return{campLinen:`${['Dirty linen','Clean wet linen','Wrung damp linen','Folded damp linen'][Number(e.state?.stage??0)]}. ${String(e.state?.text||'Wash with soap/water, wring, then fold damp. This workflow never makes linen dry.')}`};
  if(isBench(d))return{laundry:`Water ${e.state?.water===1?'available':'used'}, soap ${e.state?.soap===1?'available':'used'}. ${e.state?.text||'Put one camp linen on the board: wash, wring, fold, ten seconds each with empty hands. Folded linen remains damp.'}`};
  return null;}};
}
export type Laundry=ReturnType<typeof createLaundry>;
