// Native craft owns duration. Only completed, exactly bound work can unpack one harvested fruit.
import {opSchema,type Op,type StoredDef,type WorldModel} from '@souls/world-compiler';
import type {EdgeReceipt,EdgeSoul} from '../edge/contract.ts';
import {ACT_REACH} from './actuators.ts';
type Refusal={code:string;reason:string};
type Body={pose?:{p:number[]};support?:{kind?:string;on?:string;by?:string};human?:{holding?:unknown;hands?:unknown;handActuator?:unknown}};
type Approach=(id:string,soul:EdgeSoul,front:[number,number]|null,radius?:number)=>{p:[number,number];level:number}|null;
export type ProduceHost={model:WorldModel;engine:{world:{entities:Record<string,Body>}};levelAt(x:number,z:number,y:number):number;soul(id:string):{id:string;entity_id:string;name:string}|undefined;denied(id:string,soul:{soulId:string;entityId:string;name:string}):Refusal|null;commit(ops:Op[],note:string,clientRef:string):{accepted:boolean};log(message:string):void};
const exact=(d:StoredDef|undefined)=>d?.name==='core-harvest-basket'&&d.version===2;
export function createGardenProduce(h:ProduceHost){
 const pending=new Map<string,{id:string;body:string;fruit:number;support:string;pose:string}>();
 const basket=(id:string)=>{const e=h.model.entities.get(id);return e&&exact(h.model.resolvedDef(e.def))?e:null;};
 function ready(soul:Pick<EdgeSoul,'soulId'|'entityId'|'name'>,id:string){
  const e=basket(id);if(!e)return{no:{code:'object.gone',reason:'The harvest basket is no longer there.'}};
  const denied=h.denied(id,soul);if(denied)return{no:denied};
  const fruit=Number(e.state?.fruit);if(!Number.isSafeInteger(fruit)||fruit<1||fruit>6)return{no:{code:'object.state',reason:'Harvest ripe tomatoes into this basket first.'}};
  const support=h.engine.world.entities[id]?.support,parent=h.model.entities.get(e.in.parent),pd=parent&&h.model.resolvedDef(parent.def);
  if(!parent||pd?.components?.carryable||support?.kind!=='resting-on'||support.on!==parent.id||!e.in.slot||!pd?.slots.some(s=>s.id===e.in.slot&&s.kind==='surface'))return{no:{code:'object.state',reason:'Put the basket on an admitted fixed work surface with room beside it.'}};
  const parentDenied=h.denied(parent.id,soul);if(parentDenied)return{no:parentDenied};
  const body=h.engine.world.entities[soul.entityId],pos=body?.pose?.p,p=h.model.worldPose(e),pp=h.model.worldPose(parent);
  if(!body?.human||!pos)return{no:{code:'body.unavailable',reason:'Your body is unavailable.'}};
  if(body.human.holding||body.human.hands||body.human.handActuator||Object.values(h.engine.world.entities).some(x=>x.support?.kind==='in-hand'&&x.support.by===soul.entityId))return{no:{code:'object.state',reason:'Put down what you are holding before preparing a tomato.'}};
  if(h.levelAt(pos[0],pos[2],pos[1])!==h.levelAt(p.x,p.z,p.y))return{no:{code:'object.state',reason:'Reach the same floor as the basket first.'}};
  // World offset along the basket's right; convert once to the actual fixed parent's local surface coordinates.
  const wx=p.x+.30*p.s*Math.cos(p.yaw),wz=p.z-.30*p.s*Math.sin(p.yaw),dx=(wx-pp.x)/pp.s,dz=(wz-pp.z)/pp.s;
  const slot=pd.slots.find(s=>s.id===e.in.slot)!,out:[number,number]=[dx*Math.cos(pp.yaw)-dz*Math.sin(pp.yaw)-slot.p[0],dx*Math.sin(pp.yaw)+dz*Math.cos(pp.yaw)-slot.p[2]];
  if([...(h.model.children.get(parent.id)??[])].some(child=>{if(child===id)return false;const e=h.model.entities.get(child);if(!e||e.in.slot!==basket(id)?.in.slot)return false;const q=h.model.worldPose(e);return Math.hypot(q.x-wx,q.z-wz)<.14;}))return{no:{code:'object.state',reason:'Clear the output room 30 cm to the right of the basket first.'}};
  return{e,parent,support,fruit,out};
 }
 function plan(soul:EdgeSoul,id:string,action:string,approach:Approach){
  if(action!=='take-tomato'||!basket(id))return null;const a=ready(soul,id);if(a.no)return a.no;
  const p=h.model.worldPose(a.e!),stand=approach(id,soul,[p.x+Math.sin(p.yaw)*.7,p.z+Math.cos(p.yaw)*.7],1.5);
  if(!stand)return{code:'object.state',reason:'No ordinary reachable standing point is available beside the basket.'};
  return{summary:'Completed preparing one tomato; inspect the basket and the actual food beside it.',steps:[{verb:'stand',params:{}},{verb:'mars:walk_to',params:{x:stand.p[0],z:stand.p[1],level:stand.level}},{verb:'mars:pose_v1',params:{activity:'craft',seconds:3,prop:'tool',face:[p.x,p.z]}},{verb:'stand',params:{}}]};
 }
 function onReceipt(r:EdgeReceipt){
  const m=/^object:(.+):take-tomato$/.exec(r.capability);if(!m)return;const soul=h.soul(r.soulId),id=m[1];
  if(r.phase==='started'){if(!soul||pending.has(r.id))return;const a=ready({soulId:soul.id,entityId:soul.entity_id,name:soul.name},id);if(a.e)pending.set(r.id,{id,body:soul.entity_id,fruit:a.fruit!,support:JSON.stringify([a.e.in,a.support]),pose:JSON.stringify([h.model.worldPose(a.e),h.model.worldPose(a.parent!)])});return;}
  if(!['completed','failed','replaced','aborted','cancelled'].includes(r.phase))return;const b=pending.get(r.id);pending.delete(r.id);
  if(r.phase!=='completed'||!b||b.id!==id||!soul||b.body!==soul.entity_id||!Number.isSafeInteger(r.endedTick)||r.endedTick!<0)return;
  const a=ready({soulId:soul.id,entityId:soul.entity_id,name:soul.name},id);if(a.no||a.fruit!==b.fruit||JSON.stringify([a.e!.in,a.support])!==b.support||JSON.stringify([h.model.worldPose(a.e!),h.model.worldPose(a.parent!)])!==b.pose||a.e!.state?.lastReceipt===r.id||r.endedTick!<Number(a.e!.state?.lastCompletedTick??-1))return;
  const pos=h.engine.world.entities[soul.entity_id]?.pose?.p,p=h.model.worldPose(a.e!);if(!pos||Math.hypot(pos[0]-p.x,pos[2]-p.z)>ACT_REACH)return;
  const done=h.commit([opSchema.parse({op:'set',id,state:{fruit:a.fruit!-1,lastReceipt:r.id,lastCompletedTick:r.endedTick}}),opSchema.parse({op:'place',def:'core/tomato@1',name:'harvested-tomato',in:{parent:a.parent!.id,slot:a.e!.in.slot},p:a.out,mode:'strict',about:{title:'Harvested tomato',what:`Prepared by ${soul.name.slice(0,80)} from ${(a.e!.name??'harvest basket').slice(0,80)}. A real ripe garden tomato; carry and eat normally.`},...(a.e!.owner?{owner:a.e!.owner}:{}),...(a.e!.access?{access:a.e!.access}:{})})],`${r.soulId} prepared harvested produce`,`garden-produce:${r.id}`);
  if(!done.accepted)h.log('garden produce: world refused atomic stock/output batch; fruit remains unchanged');
 }
 return{plan,onReceipt,facts(id:string){const e=basket(id);if(!e)return null;return{gardenProduce:`${Number(e.state?.fruit??0)} ripe tomatoes stored. Harvest from a fruiting planter. Put basket on fixed admitted surface, empty hands, clear room 30 cm to its right; three seconds native craft prepares one real edible tomato on the same surface. Native pickup/eat use the new item; no output is carried by this basket.`};}};
}
export type GardenProduce=ReturnType<typeof createGardenProduce>;
