import {opSchema,type Entity,type Op,type WorldModel} from '@souls/world-compiler';
import type {EdgeReceipt,EdgeSoul} from '../edge/contract.ts';
import {ACT_REACH} from './actuators.ts';
type No={code:string;reason:string};
type Soul=Pick<EdgeSoul,'soulId'|'entityId'|'name'>;
type Body={pose?:{p:number[]};human?:{activity?:string;holding?:unknown;hands?:unknown;handActuator?:unknown};support?:{kind?:string;by?:string}};
export type ChairRiseHost={model:WorldModel;worldId:string;engine:{world:{tick:number;entities:Record<string,Body>}};levelAt(x:number,z:number,y:number):number;seatUse(id:string):{body:string;how:string}|null;soul(id:string):{id:string;entity_id:string;name:string}|undefined;denied(id:string,s:Soul):No|null;commit(ops:Op[],note:string):{accepted:boolean};log(message:string):void};
type Work={id:string;body:string;soul:string;name:string;world:string;tick:number;stamp:string;repetitions:number;rises:number;seated:boolean;invalid:boolean};
export function createChairRise(h:ChairRiseHost){
 const requested=new Map<string,Work>(),pending=new Map<string,Work>();
 const fail=(reason:string):No=>({code:'object.state',reason});
 const chair=(id:string)=>{const e=h.model.entities.get(id),d=e&&h.model.resolvedDef(e.def);return e&&d?.name==='core-chair-rise'&&d.version===1?e:null;};
 const stamp=(e:Entity)=>JSON.stringify([e.def,e.owner,e.access,e.by,e.params,e.state,e.in,h.model.worldPose(e),h.engine.world.entities[e.id]?.support]);
 const held=(body:string)=>Object.values(h.engine.world.entities).some(e=>e.support?.kind==='in-hand'&&e.support.by===body);
 function check(s:Soul,id:string,text:unknown){
  const e=chair(id);if(!e)return fail('The selected exercise chair is no longer there.');
  const denied=h.denied(id,s);if(denied)return denied;
  const body=h.engine.world.entities[s.entityId],p=body?.pose?.p;if(!body?.human||!p)return fail('Your native body is unavailable.');
  if(body.human.holding||body.human.hands||body.human.handActuator||held(s.entityId))return fail('Empty your hands before chair-rise practice.');
  if(text!=='3'&&text!=='5')return fail('Choose 3 or 5 chair rises in text.');
  if(e.in.parent!=='world'||!h.engine.world.entities[id])return fail('Keep the exercise chair on its supported floor before practice.');
  const use=h.seatUse(id);if(use)return fail('Stand up and leave this exercise chair empty before beginning a set.');
  const at=h.model.worldPose(e),level=h.levelAt(at.x,at.z,at.y);return {e,at,level,repetitions:Number(text)};
 }
 function plan(s:EdgeSoul,id:string,action:string,params?:Record<string,unknown>){if(!chair(id)||action!=='practice-rises')return null;const c=check(s,id,params?.text);if('code'in c)return c;
  return {summary:'Complete '+c.repetitions+' native sit-to-stand repetitions on this same exercise chair.',steps:[{verb:'stand',params:{}},...Array.from({length:c.repetitions},()=>[{verb:'sit',params:{on:id,seconds:1}},{verb:'stand',params:{}},{verb:'mars:pose_v1',params:{activity:'nod',seconds:.5,base:'idle',release:true,clear:true}},{verb:'stand',params:{}}]).flat()]};
 }
 function begin(s:EdgeSoul,id:string,action:string,params:Record<string,unknown>){if(!chair(id)||action!=='practice-rises')return;const c=check(s,id,params.text);if('code'in c)return;requested.set(s.soulId,{id,body:s.entityId,soul:s.soulId,name:s.name.slice(0,80),world:h.worldId,tick:h.engine.world.tick,stamp:stamp(c.e),repetitions:c.repetitions,rises:0,seated:false,invalid:false});}
 function valid(q:Work){const s=h.soul(q.soul),e=chair(q.id),b=h.engine.world.entities[q.body];return !!s&&s.entity_id===q.body&&q.world===h.worldId&&!!b?.human&&!!e&&stamp(e)===q.stamp&&!held(q.body)&&!h.denied(e.id,{soulId:s.id,entityId:s.entity_id,name:s.name});}
 function observe(q:Work){if(!valid(q)){q.invalid=true;return;}const use=h.seatUse(q.id),b=h.engine.world.entities[q.body];if(use&&use.body!==q.body){q.invalid=true;return;}if(use?.body===q.body&&use.how==='occupied'&&b.human?.activity==='sit')q.seated=true;else if(q.seated&&b.human?.activity==='stand-up'){q.rises++;q.seated=false;}}
 function tick(){for(const q of pending.values())observe(q);}
 function onReceipt(r:EdgeReceipt){const m=/^object:(.+):practice-rises$/.exec(r.capability);if(r.phase==='started'){const q=requested.get(r.soulId);requested.delete(r.soulId);if(q&&m&&q.id===m[1]&&q.tick===r.acceptedTick)pending.set(r.id,q);return;}if(!['completed','failed','replaced'].includes(r.phase))return;const q=pending.get(r.id);pending.delete(r.id);if(!q||!m||r.phase!=='completed'||q.id!==m[1]||q.soul!==r.soulId)return;observe(q);const e=chair(q.id),b=h.engine.world.entities[q.body],p=b?.pose?.p,at=e&&h.model.worldPose(e),st=e?.state??{};
  if(q.invalid||q.rises!==q.repetitions||q.seated||!valid(q)||!e||!p||!at||h.seatUse(q.id)||b.human?.activity!=='idle'||h.levelAt(p[0],p[2],p[1])!==h.levelAt(at.x,at.z,at.y)||Math.hypot(p[0]-at.x,p[2]-at.z)>ACT_REACH||!Number.isSafeInteger(r.endedTick)||r.endedTick!-q.tick<q.repetitions*20||st.lastReceipt===r.id||r.endedTick!<Number(st.lastCompletedTick??-1))return;
  if(!h.commit([opSchema.parse({op:'set',id:q.id,state:{completedSets:Number(st.completedSets??0)+1,completedRepetitions:Number(st.completedRepetitions??0)+q.repetitions,lastRepetitions:q.repetitions,lastBy:q.name,lastReceipt:r.id,lastCompletedTick:r.endedTick}})],'Completed native chair-rise set').accepted)h.log('chair-rise: completion refused');
 }
 return {plan,begin,onReceipt,tick,facts(id:string){const e=chair(id);if(!e)return null;const st=e.state??{};return {chairRise:'Real same-chair practice: choose text 3 or 5. Completed sets '+(st.completedSets??0)+'; completed repetitions '+(st.completedRepetitions??0)+'; last set '+(st.lastRepetitions??0)+'. Latest participant '+(st.lastBy||'none')+' (completed snapshot). Empty hands, supported floor and empty seat required. Native sitting and rising must finish every repetition; interrupted sets earn no credit. No health or strength claim.'};}};
}
export type ChairRise=ReturnType<typeof createChairRise>;
