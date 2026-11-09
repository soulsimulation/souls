// Cook existing food in place; the native receipt owns time, the ordinary batch owns durable state.
import {opSchema,type Op,type StoredDef,type WorldModel} from '@souls/world-compiler';
import type {EdgeReceipt,EdgeSoul} from '../edge/contract.ts';
import {ACT_REACH} from './actuators.ts';
type Refusal={code:string;reason:string};
type Body={pose?:{p:number[]};support?:{kind?:string;on?:string;by?:string};human?:{holding?:unknown;hands?:unknown;handActuator?:unknown}};
export type CampFishHost={model:WorldModel;engine:{world:{entities:Record<string,Body>};clearanceAtV1?(x:number,z:number,level?:number):number};levelAt(x:number,z:number,y:number):number;soul(id:string):{id:string;entity_id:string;name:string}|undefined;denied(id:string,soul:{soulId:string;entityId:string;name:string}):Refusal|null;commit(ops:Op[],note:string,clientRef:string):{accepted:boolean};log(message:string):void};
const isGrill=(d:StoredDef|undefined)=>d?.name==='core-camp-grill'&&d.version===1;
const isFish=(d:StoredDef|undefined)=>d?.name==='core-camp-fish'&&d.version===1;
export function createCampFish(h:CampFishHost){
 // A bounded active-receipt binding, never a timer or durable state. Terminal receipts always release it.
 const pending=new Map<string,{fish:string;grill:string}>();
 const grill=(id:string)=>{const e=h.model.entities.get(id);return e&&isGrill(h.model.resolvedDef(e.def))?e:null;};
 function ready(soul:Pick<EdgeSoul,'soulId'|'entityId'|'name'>,id:string){
  const g=grill(id);if(!g)return{no:{code:'object.gone',reason:'The camp grill is no longer there.'}};
  const denied=h.denied(id,soul);if(denied)return{no:denied};
  if(g.state?.fuel!==1)return{no:{code:'object.state',reason:'This grill has no unused charcoal charge left.'}};
  if(g.state?.on!==true)return{no:{code:'object.state',reason:'Light the grill before cooking the raw fish.'}};
  const children=[...(h.model.children.get(id)??[])].map(i=>h.model.entities.get(i)!).filter(e=>e?.in.slot==='food');
  const fish=children.length===1&&isFish(h.model.resolvedDef(children[0].def))?children[0]:null;
  if(!fish||fish.state?.cooked!==false)return{no:{code:'object.state',reason:'Put one raw camp fish on the grill cooking surface first.'}};
  const no=h.denied(fish.id,soul);if(no)return{no};
  const support=h.engine.world.entities[fish.id]?.support;
  if(support?.kind!=='resting-on'||support.on!==id)return{no:{code:'object.state',reason:'The raw fish must actually rest on this grill.'}};
  return{g,fish};
 }
 function plan(soul:EdgeSoul,id:string,action:string){
  const item=h.model.entities.get(id);if(item&&isFish(h.model.resolvedDef(item.def))&&['eat','bite'].includes(action)&&item.state?.cooked!==true)return{code:'object.state',reason:'This fish is raw. Cook it on a lit camp grill before eating.'};
  if(action!=='cook-fish'||!grill(id))return null;
  const r=ready(soul,id);if(r.no)return r.no;
  const b=h.engine.world.entities[soul.entityId];if(!b?.human)return{code:'body.unavailable',reason:'Your body is unavailable.'};
  if(b.human.holding||b.human.hands||b.human.handActuator||Object.values(h.engine.world.entities).some(x=>x.support?.kind==='in-hand'&&x.support.by===soul.entityId))return{code:'object.state',reason:'Put down what you are holding before cooking.'};
  const p=h.model.worldPose(r.g!),slot=h.model.resolvedDef(r.g!.def)!.slots.find(s=>s.id==='worker')!,c=Math.cos(p.yaw),s=Math.sin(p.yaw),x=p.x+(slot.p[0]*c+slot.p[2]*s)*p.s,z=p.z+(-slot.p[0]*s+slot.p[2]*c)*p.s,level=h.levelAt(x,z,p.y);
  if(h.engine.clearanceAtV1&&h.engine.clearanceAtV1(x,z,level)<.4)return{code:'object.state',reason:'There is no clear standing room at this camp grill.'};
  return{summary:'Completed ten seconds of camp cooking; inspect the grill and cooked fish.',steps:[{verb:'stand',params:{}},{verb:'mars:walk_to',params:{x,z,level}},{verb:'mars:pose_v1',params:{activity:'cook',seconds:10,face:[p.x,p.z]}},{verb:'stand',params:{}}]};
 }
 function onReceipt(r:EdgeReceipt){
  const match=/^object:(.+):cook-fish$/.exec(r.capability);if(!match)return;
  const soul=h.soul(r.soulId),id=match[1];
  if(r.phase==='started'){
   if(!soul||pending.has(r.id))return;const at=ready({soulId:soul.id,entityId:soul.entity_id,name:soul.name},id);
   if(at.fish)pending.set(r.id,{fish:at.fish.id,grill:id});return;
  }
  if(!['completed','failed','replaced','aborted','cancelled'].includes(r.phase))return;
  const bound=pending.get(r.id);pending.delete(r.id);
  if(r.phase!=='completed'||!bound||bound.grill!==id||!soul||!Number.isSafeInteger(r.endedTick)||r.endedTick!<0)return;
  const at=ready({soulId:soul.id,entityId:soul.entity_id,name:soul.name},id);
  if(at.no||at.fish!.id!==bound.fish||at.g!.state?.lastReceipt===r.id||r.endedTick!<Number(at.g!.state?.lastCompletedTick??-1))return;
  const body=h.engine.world.entities[soul.entity_id],p=h.model.worldPose(at.g!),pos=body?.pose?.p;
  if(!pos||Math.hypot(pos[0]-p.x,pos[2]-p.z)>ACT_REACH||h.levelAt(pos[0],pos[2],pos[1])!==h.levelAt(p.x,p.z,p.y))return;
  const name=soul.name.slice(0,100),text=`Cooked camp fish by ${name}.`.slice(0,120);
  const done=h.commit([
   opSchema.parse({op:'set',id,state:{fuel:0,on:false,text:`Charcoal used. Fish cooked by ${name}.`.slice(0,120),lastReceipt:r.id,lastCompletedTick:r.endedTick}}),
   opSchema.parse({op:'set',id:bound.fish,state:{cooked:true,left:1,text},about:{title:'Cooked camp fish',what:text}}),
  ],`${r.soulId} cooked camp fish`,`camp-fish:${r.id}`);
  if(!done.accepted)h.log('camp-fish: world refused the cooking batch; food and fuel unchanged');
 }
 return{plan,onReceipt,facts(id:string){
  const e=h.model.entities.get(id);if(!e)return null;const d=h.model.resolvedDef(e.def);
  if(isFish(d))return{campFish:e.state?.cooked===true?`${String(e.state?.text??'Cooked fish.')} ${Number(e.state?.left)<=.05?'Eaten; skin remains.':`${Math.round(Number(e.state?.left)*2)} bites left.`}`:'Raw fish: cook it on a lit camp grill before eating.'};
  if(isGrill(d))return{campGrill:`${e.state?.on===true?'Hot':'Cold'}; ${e.state?.fuel===1?'one unused charcoal charge':'charcoal used'}. ${e.state?.text||'Put a raw camp fish on its food surface; cook ten seconds with empty hands.'}`};
  return null;
 }};
}
export type CampFish=ReturnType<typeof createCampFish>;
