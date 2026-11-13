import { opSchema, type Op, type WorldModel, type Entity } from '@souls/world-compiler';
import type { EdgeReceipt, EdgeSoul } from '../edge/contract.ts';
import { ACT_REACH } from './actuators.ts';
type Refusal={code:string;reason:string};
type Actor=Pick<EdgeSoul,'soulId'|'entityId'|'name'>;
type Body={pose?:{p:number[]};support?:{kind?:string;on?:string;by?:string};human?:{holding?:unknown;hands?:unknown;handActuator?:unknown}};
export type CampSoupHost={model:WorldModel;engine:{world:{entities:Record<string,Body>};clearanceAtV1?(x:number,z:number,level?:number):number};levelAt(x:number,z:number,y:number):number;soul(id:string):{id:string;entity_id:string;name:string}|undefined;denied(id:string,soul:Actor):Refusal|null;commit(ops:Op[],note:string):{accepted:boolean};log(message:string):void};
const no=(reason:string):Refusal=>({code:'object.state',reason});
export function createCampSoup(h:CampSoupHost){
 const pending=new Map<string,{id:string;action:string;body:string;stamp:string}>();
 const exact=(e:Entity|undefined,name:string)=>!!e&&h.model.resolvedDef(e.def)?.name===name&&h.model.resolvedDef(e.def)?.version===1;
 const pot=(id:string)=>{const e=h.model.entities.get(id);return exact(e,'core-camp-soup-pot')?e:undefined;};
 function ready(soul:Actor,id:string,action:string){
  const e=pot(id);if(!e)return{no:no('The camp soup pot is no longer present.')};
  const denied=h.denied(id,soul);if(denied)return{no:denied};
  const body=h.engine.world.entities[soul.entityId];if(!body?.human||!body.pose)return{no:{code:'body.unavailable',reason:'Your body is unavailable.'}};
  if(body.human.holding||body.human.hands||body.human.handActuator||Object.values(h.engine.world.entities).some(b=>b.support?.kind==='in-hand'&&b.support.by===soul.entityId))return{no:no('Put down held items before cooking or ladling soup.')};
  if(action==='cook-soup'){
   if(e.state?.cooked!==false||e.state?.ingredients!==3||e.state?.water!==3||e.state?.fuel!==1||e.state?.on!==true||e.state?.servings!==0)return{no:no('Cooking requires the three supplied raw vegetable and water portions and unused hot fuel charge; this pot cooks once.')};
   return{e};
  }
  if(e.state?.cooked!==true||Number(e.state?.servings??0)<1)return{no:no('Cook the supplied soup first; at least one cooked serving must remain.')};
  const children=[...(h.model.children.get(id)??[])].map(id=>h.model.entities.get(id)).filter(e=>e?.in.slot==='bowl');
  const bowl=children.length===1&&exact(children[0],'core-camp-soup-bowl')?children[0]:undefined;
  if(!bowl||bowl.state?.left!==0)return{no:no('Put one empty camp soup bowl on this pot serving shelf before ladling.')};
  const deniedBowl=h.denied(bowl.id,soul);if(deniedBowl)return{no:deniedBowl};
  const support=h.engine.world.entities[bowl.id]?.support;if(support?.kind!=='resting-on'||support.on!==id)return{no:no('The receiving bowl must actually rest on this pot serving shelf.')};
  return{e,bowl};
 }
 const stamp=(e:Entity,bowl?:Entity)=>JSON.stringify([e.state,e.params,e.owner,e.access,e.in,h.model.worldPose(e),bowl&&[bowl.id,bowl.state,bowl.params,bowl.owner,bowl.access,bowl.in,h.model.worldPose(bowl),h.engine.world.entities[bowl.id]?.support]]);
 function plan(soul:EdgeSoul,id:string,action:string){
  const item=h.model.entities.get(id);if(exact(item,'core-camp-soup-bowl')&&['eat','bite'].includes(action)){const denied=h.denied(id,soul);if(denied)return denied;if(Number(item!.state?.left??0)<=.05)return{code:'food.eaten',reason:'This soup bowl is empty. Place it on a cooked pot serving shelf and ladle another remaining serving.'};return null;}
  if(!pot(id)||!['cook-soup','ladle-soup'].includes(action))return null;
  const a=ready(soul,id,action);if(a.no)return a.no;
  const p=h.model.worldPose(a.e!),x=p.x+Math.sin(p.yaw)*p.s,z=p.z+Math.cos(p.yaw)*p.s,level=h.levelAt(x,z,p.y);
  if(h.engine.clearanceAtV1&&h.engine.clearanceAtV1(x,z,level)<.4)return no('The authored standing place in front of this soup pot is obstructed.');
  return{summary:action==='cook-soup'?'Cooked three finite soup servings.':'Ladled one serving into the same supported bowl.',steps:[{verb:'stand',params:{}},{verb:'mars:walk_to',params:{x,z,level}},{verb:'mars:pose_v1',params:{activity:action==='cook-soup'?'cook':'operate',seconds:action==='cook-soup'?10:4,prop:'spoon',face:[p.x,p.z]}},{verb:'stand',params:{}}]};
 }
 function onReceipt(r:EdgeReceipt){
  const m=/^object:(.+):(cook-soup|ladle-soup)$/.exec(r.capability);if(!m)return;const [,id,action]=m,s=h.soul(r.soulId),soul=s&&{soulId:s.id,entityId:s.entity_id,name:s.name};
  if(r.phase==='started'){if(!soul||pending.has(r.id))return;const a=ready(soul,id,action);if(a.e)pending.set(r.id,{id,action,body:soul.entityId,stamp:stamp(a.e,a.bowl)});return;}
  if(!['completed','failed','replaced','aborted','cancelled'].includes(r.phase))return;const b=pending.get(r.id);pending.delete(r.id);
  if(r.phase!=='completed'||!b||b.id!==id||b.action!==action||!soul||b.body!==soul.entityId||!Number.isSafeInteger(r.endedTick)||r.endedTick!<0)return;
  const a=ready(soul,id,action);if(a.no||stamp(a.e!,a.bowl)!==b.stamp||a.e!.state?.lastReceipt===r.id||r.endedTick!<Number(a.e!.state?.lastCompletedTick??-1))return;
  const p=h.model.worldPose(a.e!),pos=h.engine.world.entities[soul.entityId]?.pose?.p;if(!pos||Math.hypot(pos[0]-p.x,pos[2]-p.z)>ACT_REACH||h.levelAt(pos[0],pos[2],pos[1])!==h.levelAt(p.x,p.z,p.y))return;
  const state=action==='cook-soup'?{ingredients:0,water:0,fuel:0,on:false,cooked:true,servings:3,madeBy:soul.name.slice(0,80)}:{servings:Number(a.e!.state?.servings)-1};
  const ops=[opSchema.parse({op:'set',id,state:{...state,lastReceipt:r.id,lastCompletedTick:r.endedTick}})];
  if(a.bowl)ops.push(opSchema.parse({op:'set',id:a.bowl.id,state:{left:1,servedBy:soul.name.slice(0,80)},about:{title:'Camp soup bowl',what:`Soup ladled by ${soul.name.slice(0,80)} from a finite shared camp pot.`}}));
  if(!h.commit(ops,`${r.soulId} ${action}`).accepted)h.log('camp soup: atomic completion refused; supplies and receiving bowl unchanged');
 }
 return{plan,onReceipt,facts(id:string){const e=h.model.entities.get(id);if(pot(id))return{campSoup:`${e!.state?.cooked?'Cooked':'Raw'}; ${e!.state?.ingredients} vegetable portions, ${e!.state?.water} water portions, ${e!.state?.servings} cooked servings. Cook ten seconds once, then support an empty soup bowl and ladle four seconds with empty hands. Cooked by ${e!.state?.madeBy||'nobody yet'}.`};if(exact(e,'core-camp-soup-bowl'))return{campSoupBowl:`${Number(e!.state?.left)>0?Math.round(Number(e!.state?.left)*2)+' bites of soup':'Empty reusable bowl'}. Served by ${e!.state?.servedBy||'nobody yet'}. Pick up/eat normally; return the same empty bowl to the serving shelf to refill.`};return null;}};
}
export type CampSoup=ReturnType<typeof createCampSoup>;
