// #1684: existing native craft owns timing; completion transfers finite ingredients into the actual food.
import {opSchema,type Op,type StoredDef,type WorldModel} from '@souls/world-compiler';
import type {EdgeReceipt,EdgeSoul} from '../edge/contract.ts';
import {ACT_REACH} from './actuators.ts';
type Refusal={code:string;reason:string};
type Body={pose?:{p:number[]};human?:{holding?:unknown;hands?:unknown;handActuator?:unknown};support?:{kind?:string;by?:string;on?:string}};
export type ColdMealHost={model:WorldModel;engine:{world:{entities:Record<string,Body>};clearanceAtV1?(x:number,z:number,level?:number):number};levelAt(x:number,z:number,y:number):number;soul(id:string):{id:string;entity_id:string;name:string}|undefined;denied(id:string,soul:{soulId:string;entityId:string;name:string}):Refusal|null;commit(ops:Op[],note:string,clientRef:string):{accepted:boolean};log(message:string):void;};
const ingredients=['greens','tomato','beans'] as const;
const isBench=(d:StoredDef|undefined)=>d?.name==='core-cold-meal-bench'&&d.version===1;
const isWrap=(d:StoredDef|undefined)=>d?.name==='core-cold-wrap'&&d.version===1;
export function createColdMeal(h:ColdMealHost){
 const started=new Map<string,string|null>();
 const resting=(food:string,on:string)=>{const s=h.engine.world.entities[food]?.support;return s?.kind==='resting-on'&&s.on===on;};
 const bench=(id:string)=>{const e=h.model.entities.get(id);return e&&isBench(h.model.resolvedDef(e.def))?e:null;};
 const wrap=(id:string)=>{for(const child of h.model.children.get(id)??[]){const e=h.model.entities.get(child);if(e?.in.slot==='out'&&isWrap(h.model.resolvedDef(e.def)))return e;}return null;};
 function ready(soul:Pick<EdgeSoul,'soulId'|'entityId'|'name'>,id:string,ingredient:string):Refusal|null{
  const e=bench(id);if(!e)return{code:'object.gone',reason:'The cold-meal preparation bench is no longer there.'};const no=h.denied(id,soul);if(no)return no;
  const food=wrap(id);if(!food||!resting(food.id,id))return{code:'object.state',reason:'Put the serving wrap on this preparation surface first.'};const denied=h.denied(food.id,soul);if(denied)return denied;
  if(!(Number(e.state?.[ingredient+'Stock'])>=1))return{code:'object.state',reason:'No supplied '+ingredient+' portion remains.'};
  const left=Number(food.state?.left??0);if(left>0&&left<1)return{code:'object.state',reason:'Finish the partly eaten meal before preparing another.'};
  if(left>0&&Number(food.state?.units)>=9)return{code:'object.state',reason:'The wrap is full.'};return null;
 }
 function plan(soul:EdgeSoul,id:string,action:string){
  if(!action.startsWith('prepare-')||!ingredients.includes(action.slice(8) as typeof ingredients[number])||!bench(id))return null;
  const no=ready(soul,id,action.slice(8));if(no)return no;const b=h.engine.world.entities[soul.entityId];if(!b?.human)return{code:'body.unavailable',reason:'Your body is unavailable.'};
  if(b.human.holding||b.human.hands||b.human.handActuator||Object.values(h.engine.world.entities).some(x=>x.support?.kind==='in-hand'&&x.support.by===soul.entityId))return{code:'object.state',reason:'Put down what you are holding before preparing food.'};
  const e=bench(id)!,p=h.model.worldPose(e),slot=h.model.resolvedDef(e.def)!.slots.find(s=>s.id==='worker')!,c=Math.cos(p.yaw),s=Math.sin(p.yaw),x=p.x+(slot.p[0]*c+slot.p[2]*s)*p.s,z=p.z+(-slot.p[0]*s+slot.p[2]*c)*p.s,level=h.levelAt(x,z,p.y);
  if(h.engine.clearanceAtV1&&h.engine.clearanceAtV1(x,z,level)<.4)return{code:'object.state',reason:'There is no clear standing room at this preparation bench.'};
  return{summary:'Completed ten seconds of preparation; inspect the actual meal and remaining ingredients.',steps:[{verb:'stand',params:{}},{verb:'mars:walk_to',params:{x,z,level}},{verb:'mars:pose_v1',params:{activity:'craft',seconds:10,prop:'spoon',face:[p.x,p.z]}},{verb:'stand',params:{}}]};
 }
 function onReceipt(r:EdgeReceipt){
  const match=/^object:(.+):prepare-(greens|tomato|beans)$/.exec(r.capability);if(!match)return;
  if(r.phase==='started'){if(!started.has(r.id)){const food=wrap(match[1]);started.set(r.id,food&&resting(food.id,match[1])?food.id:null);}return;}
  if(!['completed','failed','replaced'].includes(r.phase))return;const chosen=started.get(r.id);started.delete(r.id);
  if(r.phase!=='completed'||!chosen||!Number.isSafeInteger(r.endedTick)||r.endedTick!<0)return;
  const e=bench(match[1]),soul=h.soul(r.soulId);if(!e||!soul||e.state?.lastReceipt===r.id||ready({soulId:soul.id,entityId:soul.entity_id,name:soul.name},e.id,match[2])||r.endedTick!<Number(e.state?.lastCompletedTick??-1))return;
  const food=wrap(e.id)!;if(food.id!==chosen||!resting(food.id,e.id))return;const p=h.model.worldPose(e),at=h.engine.world.entities[soul.entity_id]?.pose?.p;if(!at||Math.hypot(at[0]-p.x,at[2]-p.z)>ACT_REACH||h.levelAt(at[0],at[2],at[1])!==h.levelAt(p.x,p.z,p.y))return;
  const counts=Object.fromEntries(ingredients.map(k=>[k,Number(food.state?.left)>0?Number(food.state?.[k]??0):0]));counts[match[2]]++;const recipe=ingredients.map(k=>`${counts[k]} ${k}`).join(', '),maker=soul.name.slice(0,80);
  const ops:Op[]=[opSchema.parse({op:'set',id:e.id,state:{[match[2]+'Stock']:Number(e.state?.[match[2]+'Stock'])-1,lastReceipt:r.id,lastCompletedTick:r.endedTick}}),opSchema.parse({op:'set',id:food.id,state:{...counts,units:Object.values(counts).reduce((a,b)=>a+b,0),left:1,maker,recipe}})];
  if(!h.commit(ops,`${r.soulId} prepared a chosen cold meal`,`cold-meal:${r.id}`).accepted)h.log('cold-meal: world refused ingredient transfer; stock and meal unchanged');
 }
 function facts(id:string){const e=h.model.entities.get(id),d=e&&h.model.resolvedDef(e.def);if(!e)return null;if(isBench(d)){const candidate=wrap(id),food=candidate&&resting(candidate.id,id)?candidate:null;return{coldMeal:`Stock: ${ingredients.map(k=>`${e.state?.[k+'Stock']} ${k}`).join(', ')}. Serving wrap: ${food?'on preparation surface':'absent; return it before preparing'}.`};}if(isWrap(d))return{coldMeal:`${Number(e.state?.left)>0?'Prepared '+e.state?.recipe:Number(e.state?.units)>0?'Finished '+e.state?.recipe:'Empty wrap'}; food remaining ${Number(e.state?.left??0)}; preparer ${e.state?.maker||'none'}. Pick up to bite/eat; return empty wrap to prepare again.`};return null;}
 return{plan,onReceipt,facts};
}
export type ColdMeal=ReturnType<typeof createColdMeal>;
