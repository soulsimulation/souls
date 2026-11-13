import {opSchema,type Entity,type Op,type WorldModel} from '@souls/world-compiler';
import type {EdgeReceipt,EdgeSoul} from '../edge/contract.ts';
import {ACT_REACH} from './actuators.ts';
import {supportY} from './nav.ts';
type No={code:string;reason:string};type Soul=Pick<EdgeSoul,'soulId'|'entityId'|'name'>;
type Body={pose?:{p:number[]};human?:{holding?:unknown;hands?:unknown;handActuator?:unknown};support?:{kind?:string;by?:string;on?:string}};
export type DamperHost={model:WorldModel;engine:{world:{tick:number;entities:Record<string,Body>}};levelAt(x:number,z:number,y:number):number;soul(id:string):{id:string;entity_id:string;name:string}|undefined;denied(id:string,s:Soul):No|null;commit(ops:Op[],note:string):{accepted:boolean};log(message:string):void};
export function createBellDamper(h:DamperHost){
 type Work={id:string;action:string;body:string;soul:string;name:string;tick:number;stamp:string};const requested=new Map<string,Work>(),pending=new Map<string,Work>();
 const fail=(reason:string):No=>({code:'object.state',reason});
 const bell=(id:string)=>{const e=h.model.entities.get(id),d=e&&h.model.resolvedDef(e.def);return e&&d?.name==='core-bell'&&d.version===4?e:null;};
 const stamp=(e:Entity)=>JSON.stringify([e.def,e.owner,e.access,e.by,e.params,e.state,e.in,h.model.worldPose(e),h.engine.world.entities[e.id]?.support]);
 function check(s:Soul,id:string,action:string,finish=false){const e=bell(id);if(!e)return fail('The selected felt-damper bell is no longer there.');const no=h.denied(id,s);if(no)return no;
  const covered=e.state?.covered??false,stored=Number(e.state?.stored??1);if(typeof covered!=='boolean'||![0,1].includes(stored)||stored+Number(covered)!==1)return fail('The one felt damper must be either stored or fitted, never duplicated.');
  if(action==='ring')return covered?fail('Remove the fitted felt damper before pulling this SAME bell rope.'):null;
  if(action==='fit-damper'&&covered)return fail('The SAME felt damper is already fitted; remove it to restore ringing.');if(action==='remove-damper'&&!covered)return fail('The felt damper is already stored; fit it before removing it.');
  const b=h.engine.world.entities[s.entityId],at=b?.pose?.p;if(!b?.human||!at)return fail('Your native body is unavailable.');if(b.human.holding||b.human.hands||b.human.handActuator||Object.values(h.engine.world.entities).some(x=>x.support?.kind==='in-hand'&&x.support.by===s.entityId))return fail('Empty your hands before fitting or removing the felt damper.');
  if(e.in.parent!=='world')return fail('Work at the SAME fixed bell resting on its ordinary ground.');const p=h.model.worldPose(e),level=h.levelAt(p.x,p.z,supportY(h.model,e)),front=[p.x+Math.sin(p.yaw)*1.05,p.z+Math.cos(p.yaw)*1.05];
  if(finish&&(h.levelAt(at[0],at[2],at[1])!==level||Math.hypot(at[0]-p.x,at[2]-p.z)>ACT_REACH))return fail('Complete the native work beside the SAME bell on its floor.');
  return{e,p,level,front,covered,stored};
 }
 function plan(s:EdgeSoul,id:string,action:string){if(!bell(id)||!['fit-damper','remove-damper','ring'].includes(action))return null;const c=check(s,id,action);if(!c||'code'in c)return c;return{summary:'Transfer the ONE integral felt damper on the SAME bell after completed native work.',steps:[{verb:'stand',params:{}},{verb:'mars:walk_to',params:{x:c.front[0],z:c.front[1],level:c.level}},{verb:'mars:pose_v1',params:{activity:'operate',seconds:3,face:[c.p.x,c.p.z]}},{verb:'mars:pose_v1',params:{activity:'nod',seconds:.5,base:'idle',release:true,clear:true,face:[c.p.x,c.p.z]}},{verb:'stand',params:{}}]};}
 function begin(s:EdgeSoul,id:string,action:string){if(!['fit-damper','remove-damper'].includes(action))return;const c=check(s,id,action);if(!c||'code'in c)return;requested.set(s.soulId,{id,action,body:s.entityId,soul:s.soulId,name:s.name.slice(0,80),tick:h.engine.world.tick,stamp:stamp(c.e)});}
 function onReceipt(r:EdgeReceipt){const m=/^object:(.+):(fit-damper|remove-damper)$/.exec(r.capability);if(!m)return;if(r.phase==='started'){const q=requested.get(r.soulId);requested.delete(r.soulId);if(q&&q.id===m[1]&&q.action===m[2]&&q.tick===r.acceptedTick&&r.startedTick===q.tick)pending.set(r.id,q);return;}if(!['completed','failed','replaced','aborted','cancelled'].includes(r.phase))return;const q=pending.get(r.id);pending.delete(r.id);const e=q&&bell(q.id);
  if(!q||!e||r.phase!=='completed'||q.id!==m[1]||q.action!==m[2]||q.soul!==r.soulId||r.acceptedTick!==q.tick||r.startedTick!==q.tick||!Number.isSafeInteger(r.endedTick)||r.endedTick!-q.tick<60||stamp(e)!==q.stamp)return;const s=h.soul(q.soul);if(!s||s.entity_id!==q.body)return;const c=check({soulId:s.id,entityId:s.entity_id,name:s.name},q.id,q.action,true);if(!c||'code'in c||c.e.state?.lastReceipt===r.id||r.endedTick!<Number(c.e.state?.lastCompletedTick??-1))return;
  const covered=q.action==='fit-damper',state={covered,stored:covered?0:1,fittings:Number(e.state?.fittings??0)+(covered?1:0),recoveries:Number(e.state?.recoveries??0)+(covered?0:1),lastBy:q.name,lastReceipt:r.id,lastCompletedTick:r.endedTick};if(!h.commit([opSchema.parse({op:'set',id:q.id,state})],'Completed native bell damper work').accepted)h.log('bell-damper: atomic completion refused; one felt damper unchanged');
 }
 return{plan,begin,onReceipt,facts(id:string){const e=bell(id);return e?{bellDamper:`ONE felt damper: ${e.state?.covered?'fitted; remove it before a NEW ring':'stored; ordinary rope ringing available'}. Stored ${e.state?.stored??1}/1; fitted ${Number(e.state?.covered??false)}/1. Rings ${e.state?.rings??0}; completed fittings ${e.state?.fittings??0}, recoveries ${e.state?.recoveries??0}. Latest participant ${e.state?.lastBy||'none'} (completion snapshot). Does not silence a tail already ringing.`}:null;}};
}
export type BellDamper=ReturnType<typeof createBellDamper>;
