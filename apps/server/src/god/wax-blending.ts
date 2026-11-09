// #1661: native craft owns timing; its completed receipt alone may consume stock and make an item.
import {opSchema,type Op,type StoredDef,type WorldModel} from '@souls/world-compiler';
import type {EdgeReceipt,EdgeSoul} from '../edge/contract.ts';
import {ACT_REACH} from './actuators.ts';

type Refusal={code:string;reason:string};
type Body={pose?:{p:number[]};human?:{holding?:unknown;hands?:unknown;handActuator?:unknown}};
export type WaxBlendingHost={
 model:WorldModel;
 engine:{world:{entities:Record<string,Body>};clearanceAtV1?(x:number,z:number,level?:number):number};
 levelAt(x:number,z:number,y:number):number;
 soul(id:string):{id:string;entity_id:string;name:string}|undefined;
 denied(id:string,soul:{soulId:string;entityId:string;name:string}):Refusal|null;
 commit(ops:Op[],note:string,clientRef:string):{accepted:boolean};
 log(message:string):void;
};
const colors=['red','yellow','blue'] as const;
const rgb={red:[220,55,65],yellow:[245,205,60],blue:[50,95,210]};
export function waxColor(counts:Record<string,number>){const n=colors.reduce((a,c)=>a+counts[c],0);return n?'#'+[0,1,2].map(i=>Math.round(colors.reduce((a,c)=>a+rgb[c][i]*counts[c],0)/n).toString(16).padStart(2,'0')).join(''):'#ddd3b6';}
const actions=new Set(['mix-red','mix-yellow','mix-blue','mold']);
const count=(state:Record<string,unknown>|undefined,c:string)=>Number(state?.[c]??0);
const isBlock=(d:StoredDef|undefined)=>d?.name==='core-wax-bench'&&d.version===1;
export function createWaxBlending(h:WaxBlendingHost){
 const block=(id:string)=>{const e=h.model.entities.get(id);return e&&isBlock(h.model.resolvedDef(e.def))?e:null;};
 const occupied=(id:string)=>[...(h.model.children.get(id)??[])].some(child=>h.model.entities.get(child)?.in.slot==='out');
 function ready(soul:Pick<EdgeSoul,'soulId'|'entityId'|'name'>,id:string,action:string):Refusal|null{
  const e=block(id);if(!e)return{code:'object.gone',reason:'The wax bench is no longer there.'};
  const denied=h.denied(id,soul);if(denied)return denied;
  if(action==='mold'&&!(Number(e.state?.units)>0))return{code:'object.state',reason:'Knead at least one colored wax portion before molding.'};
  const color=action.slice(4);if(action.startsWith('mix-')&&!(Number(e.state?.[color+'Stock'])>=1))return{code:'object.state',reason:'No supplied '+color+' wax portion remains.'};
  if(action==='mold'&&occupied(id))return{code:'object.state',reason:'Take the item off the output surface before working wax.'};
  return null;
 }
 function plan(soul:EdgeSoul,id:string,action:string){
  if(!actions.has(action)||!block(id))return null;
  const no=ready(soul,id,action);if(no)return no;
  const b=h.engine.world.entities[soul.entityId];if(!b?.human)return{code:'body.unavailable',reason:'Your body is unavailable.'};
  if(b.human.holding||b.human.hands||b.human.handActuator||Object.values(h.engine.world.entities).some(x=>(x as {support?:{kind?:string;by?:string}}).support?.kind==='in-hand'&&(x as {support?:{by?:string}}).support?.by===soul.entityId))return{code:'object.state',reason:'Put down what you are holding before working wax.'};
  const e=block(id)!,p=h.model.worldPose(e),d=h.model.resolvedDef(e.def)!,slot=d.slots.find(s=>s.id==='worker')!;
  const c=Math.cos(p.yaw),s=Math.sin(p.yaw),x=p.x+(slot.p[0]*c+slot.p[2]*s)*p.s,z=p.z+(-slot.p[0]*s+slot.p[2]*c)*p.s,level=h.levelAt(x,z,p.y);
  if(h.engine.clearanceAtV1&&h.engine.clearanceAtV1(x,z,level)<.4)return{code:'object.state',reason:'There is no clear standing room at this wax bench.'};
  return{summary:'Completed ten seconds of wax work; read the bench for its actual mixture and result.',steps:[
   {verb:'stand',params:{}},{verb:'mars:walk_to',params:{x,z,level}},
   {verb:'mars:pose_v1',params:{activity:'craft',seconds:10,prop:'spoon',face:[p.x,p.z]}},{verb:'stand',params:{}},
  ]};
 }
 function onReceipt(r:EdgeReceipt){
  if(r.phase!=='completed'||!Number.isSafeInteger(r.endedTick)||r.endedTick!<0)return;
  const match=/^object:(.+):(mix-red|mix-yellow|mix-blue|mold)$/.exec(r.capability);if(!match)return;
  const e=block(match[1]),soul=h.soul(r.soulId);if(!e||!soul||e.state?.lastReceipt===r.id||ready({soulId:soul.id,entityId:soul.entity_id,name:soul.name},e.id,match[2]))return;
  if(r.endedTick!<Number(e.state?.lastCompletedTick??-1))return;
  const body=h.engine.world.entities[soul.entity_id],p=h.model.worldPose(e),at=body?.pose?.p;
  if(!at||Math.hypot(at[0]-p.x,at[2]-p.z)>ACT_REACH||h.levelAt(at[0],at[2],at[1])!==h.levelAt(p.x,p.z,p.y))return;
  const action=match[2],counts=Object.fromEntries(colors.map(c=>[c,count(e.state,c)]));
  const state:Record<string,unknown>={lastBy:soul.name.slice(0,80),lastReceipt:r.id,lastCompletedTick:r.endedTick};
  const ops:Op[]=[];
  if(action==='mold'){
   const recipe=colors.map(c=>`${counts[c]} ${c}`).join(', '),color=waxColor(counts);
   Object.assign(state,{red:0,yellow:0,blue:0,units:0,text:`Molded ${recipe} medallion by ${soul.name.slice(0,80)}. Mixture empty. Stock: ${colors.map(c=>`${e.state?.[c+'Stock']} ${c}`).join(', ')}.`});
   ops.push(opSchema.parse({op:'place',def:'core/wax-medallion@1',name:'wax-artwork',params:{wax:color},about:{title:'Blended wax medallion',what:`Molded by ${soul.name.slice(0,80)}; recipe ${recipe}; color ${color}.`},state:{maker:soul.name.slice(0,80),recipe,color},in:{parent:e.id,slot:'out'},p:[0,0],...(e.owner?{owner:e.owner}:{}),...(e.access?{access:e.access}:{})}));
  }else{
   const c=action.slice(4);counts[c]++;Object.assign(state,{[c]:counts[c],[c+'Stock']:Number(e.state?.[c+'Stock'])-1,units:Number(e.state?.units??0)+1});
   state.text=`Mixture: ${colors.map(k=>`${counts[k]} ${k}`).join(', ')}; color ${waxColor(counts)}. Stock: ${colors.map(k=>`${k===c?state[k+'Stock']:e.state?.[k+'Stock']} ${k}`).join(', ')}.`;
  }
  ops.unshift(opSchema.parse({op:'set',id:e.id,state,params:{blend:action==='mold'?'#ddd3b6':waxColor(counts)}}));
  const done=h.commit(ops,`${r.soulId} worked modelling wax`,`wax-blending:${r.id}`);
  if(!done.accepted)h.log('wax-blending: world refused consume/create; materials and output remain unchanged');
 }
 function facts(id:string){
  const e=block(id);if(!e)return null;
  return{waxMixture:`${colors.map(c=>`${count(e.state,c)} ${c}`).join(', ')}; ${Number(e.state?.units??0)} portions; color ${waxColor(Object.fromEntries(colors.map(c=>[c,count(e.state,c)])))}.`,waxStock:colors.map(c=>`${Number(e.state?.[c+'Stock']??0)} ${c}`).join(', '),waxLastWork:String(e.state?.text??''),waxWorker:String(e.state?.lastBy||'none')};
 }
 return{plan,onReceipt,facts};
}
export type WaxBlending=ReturnType<typeof createWaxBlending>;
