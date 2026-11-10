// Manual completed batches; no timer, idle scan or independent weather simulation.
import {opSchema,type Op,type WorldModel} from '@souls/world-compiler';
import type {EdgeReceipt,EdgeSoul} from '../edge/contract.ts';
import {ACT_REACH} from './actuators.ts';
type Refusal={code:string;reason:string};type Body={pose?:{p:number[]};human?:{holding?:unknown;hands?:unknown;handActuator?:unknown};support?:{kind?:string;by?:string}};
export type RainContext={rain:number;scheduled:boolean;clockMillis:number|null;key:string};
export type RainwaterHost={model:WorldModel;engine:{world:{tick:number;entities:Record<string,Body>}};rain():RainContext;levelAt(x:number,z:number,y:number):number;soul(id:string):{id:string;entity_id:string;name:string}|undefined;denied(id:string,soul:Pick<EdgeSoul,'soulId'|'entityId'|'name'>):Refusal|null;commit(ops:Op[],note:string,clientRef:string):{accepted:boolean};log(s:string):void};
type Capture={id:string;action:string;body:string;soul:string;stamp:string;tick:number;rain:RainContext;revision:number};
const valid=(a:string)=>['uncover','cover','collect-rain'].includes(a),fail=(reason:string):Refusal=>({code:'object.state',reason});
export function createRainwater(h:RainwaterHost){
 const started=new Map<string,Capture|null>();let revision=0,lastBasis=h.rain().key;
 const item=(id:string)=>{const e=h.model.entities.get(id),d=e&&h.model.resolvedDef(e.def);return e&&d?.name==='core-rainwater-collector'&&d.version===1?e:null;};
 const stamp=(id:string)=>{const e=item(id);return JSON.stringify([e?.def,e?.in,e&&h.model.worldPose(e),e?.state]);};
 function ready(soul:Pick<EdgeSoul,'soulId'|'entityId'|'name'>,id:string,action:string):Refusal|null{
  const e=item(id);if(!e)return{code:'object.gone',reason:'The collector is no longer there.'};const denied=h.denied(id,soul);if(denied)return denied;
  const b=h.engine.world.entities[soul.entityId];if(!b?.human||!b.pose?.p)return{code:'body.unavailable',reason:'Your body is unavailable.'};
  if(b.human.holding||b.human.hands||b.human.handActuator||Object.values(h.engine.world.entities).some(x=>x.support?.kind==='in-hand'&&x.support.by===soul.entityId))return fail('Put down what you hold before working on the rain inlet.');
  if(typeof e.state?.level!=='number'||!Number.isFinite(e.state.level)||e.state.level<0||e.state.level>1||typeof e.state.covered!=='boolean')return fail('The collector has unsupported water state.');
  if(action==='uncover'&&!e.state.covered)return fail('The inlet is already uncovered.');if(action==='cover'&&e.state.covered)return fail('The inlet is already covered.');
  if(action==='collect-rain'){if(e.state.covered)return fail('Uncover the rain inlet first.');if(e.state.level>.75)return fail('The collector has less than one litre of room; draw some water first.');const r=h.rain();if(!Number.isFinite(r.rain)||r.rain<=.1)return fail('There is no collectable rain now; wait for authoritative rainy weather.');}
  return null;
 }
 function plan(soul:EdgeSoul,id:string,action:string,approach?:{p:[number,number];level:number}|null){
  if(!valid(action)||!item(id))return null;const no=ready(soul,id,action);if(no)return no;const e=item(id)!,p=h.model.worldPose(e),b=h.engine.world.entities[soul.entityId],at=b.pose!.p;
  if(!approach&&Math.hypot(at[0]-p.x,at[2]-p.z)>ACT_REACH)return fail('No reachable standing place beside this collector.');
  const to=approach??{p:[at[0],at[2]] as[number,number],level:h.levelAt(at[0],at[2],at[1])};
  return{summary:action==='collect-rain'?'Four completed seconds gather one litre from current rain; interrupted or changed conditions gather nothing.':'Four completed seconds change only the rain inlet cover.',steps:[{verb:'stand',params:{}},{verb:'mars:walk_to',params:{x:to.p[0],z:to.p[1],level:to.level}},{verb:'mars:pose_v1',params:{activity:'craft',seconds:4,face:[p.x,p.z]}},{verb:'stand',params:{}}]};
 }
 function onReceipt(r:EdgeReceipt){
  const m=/^object:(.+):(uncover|cover|collect-rain)$/.exec(r.capability);if(!m)return;
  if(r.phase==='started'){if(!started.has(r.id)){const s=h.soul(r.soulId);started.set(r.id,s&&!ready({soulId:s.id,entityId:s.entity_id,name:s.name},m[1],m[2])?{id:m[1],action:m[2],body:s.entity_id,soul:s.id,stamp:stamp(m[1]),tick:h.engine.world.tick,rain:{...h.rain()},revision}:null);}return;}
  if(!['completed','failed','replaced'].includes(r.phase))return;const q=started.get(r.id);started.delete(r.id);if(r.phase!=='completed'||!q||!Number.isSafeInteger(r.endedTick)||r.endedTick!<q.tick+80)return;
  const e=item(q.id),s=h.soul(r.soulId);if(!e||!s||s.id!==q.soul||s.entity_id!==q.body||stamp(q.id)!==q.stamp||e.state?.lastReceipt===r.id||r.endedTick!<Number(e.state?.lastCompletedTick??-1)||ready({soulId:s.id,entityId:s.entity_id,name:s.name},q.id,q.action))return;
  const at=h.engine.world.entities[s.entity_id]?.pose?.p,p=h.model.worldPose(e);if(!at||Math.hypot(at[0]-p.x,at[2]-p.z)>ACT_REACH||h.levelAt(at[0],at[2],at[1])!==h.levelAt(p.x,p.z,p.y))return;
  if(q.action==='collect-rain'){const now=h.rain();if(revision!==q.revision||now.key!==q.rain.key||now.scheduled!==q.rain.scheduled)return;
   // Scheduled weather changes only at two-hour boundaries. At most one may lie inside a qualified batch.
   if(now.scheduled&&(q.rain.clockMillis===null||now.clockMillis===null||now.clockMillis<q.rain.clockMillis||now.clockMillis-q.rain.clockMillis>=2*3600_000))return;
  }
  const patch=q.action==='collect-rain'?{level:Number(e.state!.level)+.25,batches:Number(e.state!.batches)+1,lastBy:s.name.slice(0,80)}:{covered:q.action==='cover'};
  if(!h.commit([opSchema.parse({op:'set',id:e.id,state:{...patch,lastReceipt:r.id,lastCompletedTick:r.endedTick}})],`${r.soulId} completed rainwater ${q.action}`,`rainwater:${r.id}`).accepted)h.log('rainwater: world refused completed batch; prior amount unchanged');
 }
 return{plan,onReceipt,environmentChanged(){const key=h.rain().key;if(key!==lastBasis){revision++;lastBasis=key;}},facts(id:string){const e=item(id);if(!e)return null;const r=h.rain();return{rainwater:`Stored rainwater: ${(Number(e.state?.level)*4).toFixed(2)} / 4 L. Inlet: ${e.state?.covered?'covered':'open'}. Current authoritative rain: ${Number.isFinite(r.rain)&&r.rain>.1?'collectable':'not collectable'}. Completed one-litre batches: ${e.state?.batches??0}; latest collector: ${e.state?.lastBy||'none'}. Uncover/cover or collect with empty hands (4 seconds). Collection needs rain throughout a stable qualified batch and one litre of room. Draw stored water into an ordinary held watering can; finite existing W5 transfer. No passive accumulation or water-purity claim.`};}};
}
export type Rainwater=ReturnType<typeof createRainwater>;
