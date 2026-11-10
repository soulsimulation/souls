import {opSchema,type Op,type WorldModel} from '@souls/world-compiler';
import {CANDLE_FORMS,CANDLE_COLORS} from '../../../../packages/world-compiler/src/core-kit/candle-molding.ts';
import type {EdgeReceipt,EdgeSoul} from '../edge/contract.ts';
import {ACT_REACH} from './actuators.ts';
type No={code:string;reason:string};
type Body={pose?:{p:number[]};support?:{kind?:string;on?:string;by?:string};human?:{holding?:unknown;hands?:Record<string,unknown>;handActuator?:unknown}};
type Host={model:WorldModel;engine:{world:{entities:Record<string,Body>;tick:number}};levelAt(x:number,z:number,y:number):number;soul(id:string):{id:string;entity_id:string;name:string}|undefined;denied(id:string,soul:Pick<EdgeSoul,'soulId'|'entityId'|'name'>):No|null;commit(ops:Op[],note:string):{accepted:boolean};log(message:string):void};
export function createCandleMolding(h:Host){
 const verbs=['choose-form','choose-color','mold-candle'];
 const bench=(id:string)=>{const e=h.model.entities.get(id),d=e&&h.model.resolvedDef(e.def);return d?.name==='core-candle-mold-bench'&&d.version===1?e:null;};
 const parents=(id:string)=>{const out:string[]=[];let e=h.model.entities.get(id);for(let n=0;e&&e.in.parent!=='world'&&n<4;n++){out.push(e.in.parent);e=h.model.entities.get(e.in.parent);}return out;};
 const stamp=(id:string)=>JSON.stringify([id,...parents(id)].map(key=>{const e=h.model.entities.get(key);return[e?.id,e?.def,e?.in,e?.state,e?.params,e?.owner,e?.access,e&&h.model.worldPose(e),h.engine.world.entities[key]?.pose,h.engine.world.entities[key]?.support];}));
 const seconds=(verb:string)=>verb==='mold-candle'?4:.5;
 function ready(s:Pick<EdgeSoul,'soulId'|'entityId'|'name'>,id:string,verb:string,params?:Record<string,unknown>,completed=false){
  const e=bench(id);if(!e)return{no:{code:'object.gone',reason:'This candle mold bench is no longer here.'}};
  for(const key of[id,...parents(id)]){const no=h.denied(key,s);if(no)return{no};}
  const b=h.engine.world.entities[s.entityId],native=h.engine.world.entities[id],p=h.model.worldPose(e);
  if(e.in.parent!=='world'||!native?.pose||native.support?.kind==='in-hand')return{no:{code:'object.state',reason:'Use the fixed mold bench on its admitted ground.'}};
  if(!b?.pose||!b.human)return{no:{code:'body.unavailable',reason:'Your body is unavailable.'}};
  if(b.human.holding||b.human.handActuator||Object.values(b.human.hands??{}).some(Boolean)||Object.values(h.engine.world.entities).some(v=>v.support?.kind==='in-hand'&&v.support.by===s.entityId))return{no:{code:'object.state',reason:'Put down held objects before molding or selecting candle material.'}};
  const level=h.levelAt(p.x,p.z,p.y);
  if(completed&&(h.levelAt(b.pose.p[0],b.pose.p[2],b.pose.p[1])!==level||Math.hypot(b.pose.p[0]-p.x,b.pose.p[2]-p.z)>ACT_REACH))return{no:{code:'object.state',reason:'Stay beside the supported mold bench until work finishes.'}};
  let choice:string|undefined;
  if(verb==='choose-form'||verb==='choose-color'){
   if(params){choice=typeof params.text==='string'?params.text.trim().toLowerCase():'';const valid=verb==='choose-form'?(CANDLE_FORMS as readonly string[]):Object.keys(CANDLE_COLORS);if(!valid.includes(choice))return{no:{code:'object.state',reason:verb==='choose-form'?'Choose pillar or taper for this candle.':'Choose red, blue or ivory from this bench wax stocks.'}};}
  }
  if(verb==='mold-candle'){
   if(!Object.keys(CANDLE_COLORS).includes(String(e.state?.waxColor))||!(CANDLE_FORMS as readonly unknown[]).includes(e.state?.form))return{no:{code:'object.state',reason:'Choose a supported candle form and wax color first.'}};
   if(Number(e.state?.[String(e.state?.waxColor)])<1||Number(e.state?.wicks)<1||Number(e.state?.made)>=6)return{no:{code:'object.state',reason:'This selected wax stock or wick supply is exhausted; choose available wax or another supplied mold bench.'}};
   if([...h.model.entities.values()].some(v=>v.in.parent===id&&v.in.slot==='output'))return{no:{code:'object.state',reason:'Pick up the finished candle to clear the output slot before molding another.'}};
  }
  return{e,p,level,choice};
 }
 const prepared=new Map<string,{id:string;verb:string;body:string;tick:number;stamp:string;choice?:string}>(),pending=new Map<string,{id:string;verb:string;body:string;start:number;stamp:string;choice?:string}>();
 function plan(soul:EdgeSoul,id:string,verb:string,params?:Record<string,unknown>){if(!bench(id)||!verbs.includes(verb))return null;const a=ready(soul,id,verb,params);if(a.no)return a.no;const p=a.p!;return{summary:'Candle selection or native molding completed; inspect this bench and its real output.',steps:[{verb:'stand',params:{}},{verb:'mars:walk_to',params:{x:p.x+Math.sin(p.yaw)*1.1,z:p.z+Math.cos(p.yaw)*1.1,level:a.level}},{verb:'mars:pose_v1',params:{activity:'operate',seconds:seconds(verb),face:[p.x,p.z]}},{verb:'mars:pose_v1',params:{activity:'nod',seconds:.5,base:'idle',release:true,clear:true,face:[p.x,p.z]}},{verb:'stand',params:{}}]};}
 function expect(soul:EdgeSoul,id:string,verb:string,params?:Record<string,unknown>){const a=ready(soul,id,verb,params);if(a.e)prepared.set(soul.entityId,{id,verb,body:soul.entityId,tick:h.engine.world.tick,stamp:stamp(id),choice:a.choice});}
 function onReceipt(r:EdgeReceipt){
  const m=/^object:(.+):(choose-form|choose-color|mold-candle)$/.exec(r.capability);if(!m)return;const [,id,verb]=m,s=h.soul(r.soulId);
  if(r.phase==='started'){
   if(!s||pending.has(r.id))return;const q=prepared.get(s.entity_id);prepared.delete(s.entity_id);
   if(!q||q.id!==id||q.verb!==verb||q.body!==s.entity_id||q.tick!==h.engine.world.tick||r.acceptedTick!==q.tick||r.startedTick!==q.tick||stamp(id)!==q.stamp)return;
   const a=ready({soulId:s.id,entityId:s.entity_id,name:s.name},id,verb,q.choice?{text:q.choice}:undefined);
   if(a.e&&a.e.state?.lastReceipt!==r.id)pending.set(r.id,{id,verb,body:s.entity_id,start:q.tick,stamp:q.stamp,choice:q.choice});return;
  }
  if(!['completed','failed','replaced','cancelled','aborted'].includes(r.phase))return;
  const q=pending.get(r.id);pending.delete(r.id);
  if(r.phase!=='completed'||!q||!s||q.id!==id||q.verb!==verb||q.body!==s.entity_id||r.startedTick!==q.start||r.acceptedTick!==q.start||!Number.isSafeInteger(r.endedTick)||r.endedTick!-q.start<seconds(verb)*20)return;
  const a=ready({soulId:s.id,entityId:s.entity_id,name:s.name},id,verb,q.choice?{text:q.choice}:undefined,true);if(!a.e||stamp(id)!==q.stamp)return;
  const state:Record<string,unknown>={lastReceipt:r.id,lastCompletedTick:r.endedTick,maker:s.name.slice(0,80)},ops:Op[]=[];
  if(verb==='choose-form')state.form=q.choice;if(verb==='choose-color')state.waxColor=q.choice;
  if(verb==='mold-candle'){
   const color=String(a.e.state!.waxColor) as keyof typeof CANDLE_COLORS,form=String(a.e.state!.form),serial=Number(a.e.state!.made)+1,label=a.e.name.slice(0,32)+'-'+color+'-'+form+'-candle-'+serial;
   ops.push(opSchema.parse({op:'place',def:'core/molded-candle@1',name:label,in:{parent:id,slot:'output'},p:[0,0],params:{form,wax:CANDLE_COLORS[color]},state:{form,waxColor:color,waxUnits:1,wickUnits:1,maker:s.name.slice(0,80),sourceLabel:a.e.name.slice(0,60)},...(a.e.owner?{owner:a.e.owner}:{}),...(a.e.access?{access:a.e.access}:{})}));
   Object.assign(state,{[color]:Number(a.e.state![color])-1,wicks:Number(a.e.state!.wicks)-1,made:serial,lastOutput:label});
  }
  ops.push(opSchema.parse({op:'set',id,state}));if(!h.commit(ops,`${r.soulId} completed candle ${verb}`).accepted)h.log('candle molding: admitted batch refused; stock retained');
 }
 function facts(id:string){const e=h.model.entities.get(id),d=e&&h.model.resolvedDef(e.def);if(!e||!d)return null;if(bench(id))return{candleMolding:`${e.state?.form} / ${e.state?.waxColor}; wax red ${e.state?.red}, blue ${e.state?.blue}, ivory ${e.state?.ivory}; wicks ${e.state?.wicks}; made ${e.state?.made}; maker ${e.state?.maker||'none yet'}; latest ${e.state?.lastOutput||'none'}.`,candleRequirements:'Fixed supported bench, empty hands, clear output. One chosen wax portion and one wick per real portable candle.'};if(d.name==='core-molded-candle'&&d.version===1)return{candleRecipe:`${e.state?.waxColor} ${e.state?.form}; wax units ${e.state?.waxUnits}, wick units ${e.state?.wickUnits}; made by ${e.state?.maker||'unknown'} at ${e.state?.sourceLabel||'supplied mold'}.`,candleUse:'Place on a stable reachable surface; use light or put-out. No fuel depletion or loaded carry.'};return null;}
 return{plan,expect,onReceipt,facts};
}
export type CandleMolding=ReturnType<typeof createCandleMolding>;
