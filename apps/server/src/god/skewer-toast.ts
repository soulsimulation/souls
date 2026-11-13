import {opSchema,type Entity,type Op,type WorldModel} from '@souls/world-compiler';
import type {EdgeReceipt,EdgeSoul} from '../edge/contract.ts';
import {supportY} from './nav.ts';
type No={code:string;reason:string};type Soul=Pick<EdgeSoul,'soulId'|'entityId'|'name'>;
type Body={pose?:{p:number[]};human?:unknown;support?:{kind?:string;by?:string}};
export type SkewerToastHost={model:WorldModel;worldId:string;engine:{world:{tick:number;entities:Record<string,Body>}};levelAt(x:number,z:number,y:number):number;soul(id:string):{id:string;entity_id:string;name:string}|undefined;denied(id:string,s:Soul):No|null;commit(ops:Op[],note:string):{accepted:boolean};eatBegin(body:string):void;eat(s:Soul,id:string):{steps:{verb:string;params:Record<string,unknown>}[];summary:string}|No|null;log(s:string):void};
type Work={fire:string;item:string;action:string;body:string;soul:string;name:string;world:string;tick:number;fireStamp:string;itemStamp:string;invalid:boolean};
export function createSkewerToast(h:SkewerToastHost){
 const requested=new Map<string,Work>(),pending=new Map<string,Work>();
 const fail=(reason:string):No=>({code:'object.state',reason});
 const named=(id:string,name:string)=>{const e=h.model.entities.get(id),d=e&&h.model.resolvedDef(e.def);return e&&d?.name===name&&d.version===1?e:null;};
 const fire=(id:string)=>named(id,'core-marshmallow-fire');
 const stamp=(e:Entity,placed=false)=>JSON.stringify([e.def,e.owner,e.access,e.by,e.params,e.state,...(placed?[e.in,h.model.worldPose(e)]:[])]);
 function check(s:Soul,id:string,action:string,text?:unknown,finish=false){
  const e=fire(id);if(!e)return fail('The marshmallow campfire is no longer there.');const no=h.denied(id,s);if(no)return no;
  const b=h.engine.world.entities[s.entityId],at=b?.pose?.p;if(!b?.human||!at)return fail('Your native body is unavailable.');
  if(e.state?.on!==true)return fail('Light this campfire before toasting or turning a skewer.');
  const held=Object.entries(h.engine.world.entities).filter(([,x])=>x.support?.kind==='in-hand'&&x.support.by===s.entityId);
  if(held.length!==1||!named(held[0][0],'core-marshmallow-skewer'))return fail('Pick up one actual marshmallow skewer and keep it in your hands.');
  const item=named(held[0][0],'core-marshmallow-skewer')!;const denied=h.denied(item.id,s);if(denied)return denied;
  if(text!==undefined&&(typeof text!=='string'||text!==item.id))return fail('Choose the exact ID of the marshmallow skewer held in your hands.');
  if(action==='eat-skewer'){if(item.state?.ready!==true||Number(item.state?.left??0)<=.05)return fail('Toast both sides before eating; an empty stick cannot supply more food.');}else if(item.state?.ready===true||item.state?.packed===false)return fail('This marshmallow is already toasted or eaten; enjoy it or keep the empty stick.');
  const side=item.state?.side??'a';if(action==='toast-side'&&item.state?.[side=== 'a'?'a':'b']===true)return fail('This exposed side is already golden; turn the skewer to expose the other side.');
  const p=h.model.worldPose(e),level=h.levelAt(p.x,p.z,supportY(h.model,e));
  if(finish&&(level!==h.levelAt(at[0],at[2],at[1])||Math.hypot(at[0]-p.x,at[2]-p.z)>1.8))return fail('Complete the work beside this campfire on its native floor.');
  return{e,item,level,p};
 }
 function plan(s:EdgeSoul,id:string,action:string,params?:Record<string,unknown>){
  if(!fire(id)||!['toast-side','turn-skewer','eat-skewer'].includes(action))return null;
  if(params!==undefined&&!params.text)return fail('Choose the exact ID of your held marshmallow skewer in text.');
  const c=check(s,id,action,params?.text);if('code'in c)return c;
  if(action==='eat-skewer')return h.eat(s,c.item.id)??fail('The native food plan is unavailable for this skewer.');
  const x=c.p.x+Math.sin(c.p.yaw)*1.5*c.p.s,z=c.p.z+Math.cos(c.p.yaw)*1.5*c.p.s;
  return{summary:action==='toast-side'?'Toast the exposed side of the real held marshmallow, then release the work pose.':'Turn the same held skewer to expose the other side.',steps:[{verb:'stand',params:{}},{verb:'mars:walk_to',params:{x,z,level:c.level}},{verb:'mars:pose_v1',params:{activity:'operate',seconds:action==='toast-side'?3:.75,face:[c.p.x,c.p.z]}},{verb:'mars:pose_v1',params:{activity:'stretch',seconds:.5,base:'idle',release:true,face:[c.p.x,c.p.z]}},{verb:'stand',params:{}}]};
 }
 function begin(s:EdgeSoul,id:string,action:string,params:Record<string,unknown>){if(action==='eat-skewer'){h.eatBegin(s.entityId);return;}if(!fire(id)||!['toast-side','turn-skewer','eat-skewer'].includes(action))return;const c=check(s,id,action,params.text);if('code'in c)return;requested.set(s.soulId,{fire:id,item:c.item.id,action,body:s.entityId,soul:s.soulId,name:s.name.slice(0,80),world:h.worldId,tick:h.engine.world.tick,fireStamp:stamp(c.e,true),itemStamp:stamp(c.item),invalid:false});}
 function valid(q:Work){const s=h.soul(q.soul),e=fire(q.fire),item=h.model.entities.get(q.item),held=h.engine.world.entities[q.item]?.support;return !!s&&s.entity_id===q.body&&!!e&&!!item&&q.world===h.worldId&&held?.kind==='in-hand'&&held.by===q.body&&stamp(e,true)===q.fireStamp&&stamp(item)===q.itemStamp&&!h.denied(e.id,{soulId:s.id,entityId:s.entity_id,name:s.name})&&!h.denied(item.id,{soulId:s.id,entityId:s.entity_id,name:s.name});}
 function tick(){for(const q of pending.values())if(!valid(q))q.invalid=true;}
 function onReceipt(r:EdgeReceipt){const m=/^object:(.+):(toast-side|turn-skewer)$/.exec(r.capability);if(r.phase==='started'){const q=requested.get(r.soulId);requested.delete(r.soulId);if(q&&m&&q.fire===m[1]&&q.action===m[2]&&q.tick===r.acceptedTick)pending.set(r.id,q);return;}if(!['completed','failed','replaced'].includes(r.phase))return;const q=pending.get(r.id);pending.delete(r.id);if(!q||!m||r.phase!=='completed'||q.invalid||q.fire!==m[1]||q.action!==m[2]||q.soul!==r.soulId||!valid(q)||!Number.isSafeInteger(r.endedTick)||r.endedTick!-q.tick<(q.action==='toast-side'?60:15))return;const s=h.soul(q.soul)!,c=check({soulId:s.id,entityId:s.entity_id,name:s.name},q.fire,q.action,q.item,true);if('code'in c)return;const st=c.item.state??{};if(st.lastReceipt===r.id||r.endedTick!<Number(st.lastCompletedTick??-1))return;const side=st.side??'a',patch:Record<string,unknown>={lastBy:q.name,lastReceipt:r.id,lastCompletedTick:r.endedTick};if(q.action==='turn-skewer')patch.side=side==='a'?'b':'a';else{patch[side==='a'?'a':'b']=true;if(st[side==='a'?'b':'a']===true)Object.assign(patch,{ready:true,packed:false,left:1});}if(!h.commit([opSchema.parse({op:'set',id:q.item,state:patch})],`${r.soulId} completed marshmallow skewer work`).accepted)h.log('skewer-toast: completion refused; marshmallow unchanged');}
 return{plan,begin,onReceipt,tick,facts(id:string){const e=named(id,'core-marshmallow-skewer');if(e)return{skewerToast:`Same marshmallow skewer. Exposed side: ${e.state?.side??'a'}. Side A: ${e.state?.a?'golden':'raw'}; side B: ${e.state?.b?'golden':'raw'}. ${e.state?.ready?`Toasted food remaining: ${e.state?.left??0}; two native bites leave the same empty stick.`:'One supplied marshmallow; toast both sides beside a lit marshmallow campfire before eating.'} Last preparer: ${e.state?.lastBy||'none'} (completion snapshot). Keep this exact skewer held throughout native work. No refill or new food.`};return fire(id)?{skewerToast:'Pick up a supplied marshmallow skewer. Send toast-side, turn-skewer or eat-skewer with its exact ID in text. Eating delegates to the native food plan on the actual held item. Three seconds of completed native work toast only the exposed side. Both sides must be golden before native eating. Light/put-out use ordinary native contact.'}:null;}};
}
export type SkewerToast=ReturnType<typeof createSkewerToast>;
