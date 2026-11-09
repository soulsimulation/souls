// #1675: native craft/brush owns timing; completed work alone reshapes the same sand.
import {opSchema,type Op,type StoredDef,type WorldModel} from '@souls/world-compiler';
import type {EdgeReceipt,EdgeSoul} from '../edge/contract.ts';
import {ACT_REACH} from './actuators.ts';

type Refusal={code:string;reason:string};
type Body={pose?:{p:number[]};human?:{holding?:unknown;hands?:unknown;handActuator?:unknown}};
export type SandGardenHost={
 model:WorldModel;
 engine:{world:{entities:Record<string,Body>};clearanceAtV1?(x:number,z:number,level?:number):number};
 levelAt(x:number,z:number,y:number):number;
 soul(id:string):{id:string;entity_id:string;name:string}|undefined;
 denied(id:string,soul:{soulId:string;entityId:string;name:string}):Refusal|null;
 commit(ops:Op[],note:string,clientRef:string):{accepted:boolean};
 log(message:string):void;
};
export const SAND_CELLS=['bl','br','fl','fr'] as const;
const names={bl:'back-left',br:'back-right',fl:'front-left',fr:'front-right'};
const actionOf=(action:string)=>{const m=/^brush-(bl|br|fl|fr)-(along|across)$/.exec(action);return m?{cell:m[1] as typeof SAND_CELLS[number],value:m[2]==='along'?1:2}:null;};
const isGarden=(d:StoredDef|undefined)=>d?.name==='core-sand-garden'&&d.version===1;
export function sandStatus(state:Record<string,unknown>,by:string){return 'Sand: '+SAND_CELLS.map(c=>names[c]+' '+(['smooth','lengthwise','across'][Number(state[c])])).join(', ')+'. Last worked by '+by+'.';}
export function createSandGarden(h:SandGardenHost){
 const garden=(id:string)=>{const e=h.model.entities.get(id);return e&&isGarden(h.model.resolvedDef(e.def))?e:null;};
 function ready(soul:Pick<EdgeSoul,'soulId'|'entityId'|'name'>,id:string,action:string):Refusal|null{
  const e=garden(id);if(!e)return{code:'object.gone',reason:'The sand garden is no longer there.'};
  const denied=h.denied(id,soul);if(denied)return denied;
  const choice=actionOf(action);
  if(action==='smooth'?!SAND_CELLS.some(c=>Number(e.state?.[c])>0):!choice||e.state?.[choice.cell]===choice.value)return{code:'object.state',reason:action==='smooth'?'The sand is already smooth.':'That cell already has this furrow direction.'};
  return null;
 }
 function plan(soul:EdgeSoul,id:string,action:string){
  if((action!=='smooth'&&!actionOf(action))||!garden(id))return null;
  const no=ready(soul,id,action);if(no)return no;
  const b=h.engine.world.entities[soul.entityId];if(!b?.human)return{code:'body.unavailable',reason:'Your body is unavailable.'};
  if(b.human.holding||b.human.hands||b.human.handActuator||Object.values(h.engine.world.entities).some(x=>(x as {support?:{kind?:string;by?:string}}).support?.kind==='in-hand'&&(x as {support?:{by?:string}}).support?.by===soul.entityId))return{code:'object.state',reason:'Put down what you are holding before brushing the sand.'};
  const e=garden(id)!,p=h.model.worldPose(e),d=h.model.resolvedDef(e.def)!,slot=d.slots.find(s=>s.id==='worker')!;
  const c=Math.cos(p.yaw),s=Math.sin(p.yaw),x=p.x+(slot.p[0]*c+slot.p[2]*s)*p.s,z=p.z+(-slot.p[0]*s+slot.p[2]*c)*p.s,level=h.levelAt(x,z,p.y);
  if(h.engine.clearanceAtV1&&h.engine.clearanceAtV1(x,z,level)<.4)return{code:'object.state',reason:'There is no clear standing room at this sand garden.'};
  return{summary:'Completed ten seconds of sand work; read the garden for its actual cell pattern and worker.',steps:[
   {verb:'stand',params:{}},{verb:'mars:walk_to',params:{x,z,level}},
   {verb:'mars:pose_v1',params:{activity:'craft',seconds:10,prop:'brush',face:[p.x,p.z]}},{verb:'stand',params:{}},
  ]};
 }
 function onReceipt(r:EdgeReceipt){
  if(r.phase!=='completed'||!Number.isSafeInteger(r.endedTick)||r.endedTick!<0)return;
  const match=/^object:(.+):(smooth|brush-(?:bl|br|fl|fr)-(?:along|across))$/.exec(r.capability);if(!match)return;
  const e=garden(match[1]),soul=h.soul(r.soulId);if(!e||!soul||e.state?.lastReceipt===r.id||ready({soulId:soul.id,entityId:soul.entity_id,name:soul.name},e.id,match[2]))return;
  if(r.endedTick!<Number(e.state?.lastCompletedTick??-1))return;
  const body=h.engine.world.entities[soul.entity_id],p=h.model.worldPose(e),at=body?.pose?.p;
  if(!at||Math.hypot(at[0]-p.x,at[2]-p.z)>ACT_REACH||h.levelAt(at[0],at[2],at[1])!==h.levelAt(p.x,p.z,p.y))return;
  const by=soul.name.slice(0,80),choice=actionOf(match[2]),cells=Object.fromEntries(SAND_CELLS.map(c=>[c,match[2]==='smooth'?0:Number(e.state?.[c]??0)]));
  if(choice)cells[choice.cell]=choice.value;
  const state={...cells,marked:SAND_CELLS.filter(c=>cells[c]>0).length,lastBy:by,lastReceipt:r.id,lastCompletedTick:r.endedTick,text:sandStatus(cells,by)};
  const done=h.commit([opSchema.parse({op:'set',id:e.id,state})],`${r.soulId} brushed the sand garden`,`sand-garden:${r.id}`);
  if(!done.accepted)h.log('sand-garden: world refused material change; previous cell pattern remains unchanged');
 }
 return{plan,onReceipt};
}
export type SandGarden=ReturnType<typeof createSandGarden>;
