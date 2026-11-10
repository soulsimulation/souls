import {opSchema,type Entity,type Op,type WorldModel} from '@souls/world-compiler';
import type {EdgeReceipt,EdgeSoul} from '../edge/contract.ts';
import {supportY} from './nav.ts';
type No={code:string;reason:string};type Soul=Pick<EdgeSoul,'soulId'|'entityId'|'name'>;
type Body={pose?:{p:number[]};human?:{holding?:unknown;hands?:unknown;handActuator?:unknown};support?:{kind?:string;by?:string;on?:string}};
export type AnglingHost={model:WorldModel;worldId:string;engine:{world:{tick:number;entities:Record<string,Body>}};levelAt(x:number,z:number,y:number):number;soul(id:string):{id:string;entity_id:string;name:string}|undefined;denied(id:string,s:Soul):No|null;commit(ops:Op[],note:string):{accepted:boolean};log(s:string):void};
type Work={pool:string;creel:string;action:string;body:string;soul:string;name:string;world:string;tick:number;poolStamp:string;creelStamp:string;invalid:boolean};
export function createAngling(h:AnglingHost){
 const requested=new Map<string,Work>(),pending=new Map<string,Work>();
 const fail=(reason:string):No=>({code:'object.state',reason});
 const named=(id:string,name:string)=>{const e=h.model.entities.get(id),d=e&&h.model.resolvedDef(e.def);return e&&d?.name===name&&d.version===1?e:null;};
 const pool=(id:string)=>named(id,'core-angling-pool');
 const stamp=(e:Entity)=>JSON.stringify([e.def,e.owner,e.access,e.by,e.params,e.state,e.in,h.model.worldPose(e)]);
 const creelStamp=(e:Entity)=>{const parent=h.model.entities.get(e.in.parent);return JSON.stringify([stamp(e),h.engine.world.entities[e.id]?.support,parent&&stamp(parent)]);};
 const held=(body:string)=>Object.values(h.engine.world.entities).some(x=>x.support?.kind==='in-hand'&&x.support.by===body);
 function check(s:Soul,id:string,action:string,text?:unknown,finish=false){
  const e=pool(id);if(!e)return fail('The stocked angling pool is no longer there.');const no=h.denied(id,s);if(no)return no;
  const b=h.engine.world.entities[s.entityId],at=b?.pose?.p;if(!b?.human||!at)return fail('Your native body is unavailable.');
  if(b.human.holding||b.human.hands||b.human.handActuator||held(s.entityId))return fail('Empty your hands and place the selected creel on a fixed work surface before angling.');
  if(e.in.parent!=='world')return fail('The stocked pool must remain on its authored ground.');
  if(action==='catch-fish'&&(Number(e.state?.fish??3)<1||Number(e.state?.bait??3)<1))return fail('This pool has no supplied fish or bait left; release an existing catch to recover fish, but spent bait is not restored.');
  if(text===undefined)return{e};
  if(typeof text!=='string'||!text.trim())return fail('Choose the exact ID of a nearby empty creel for catching, or its recorded catch for release.');
  const chosen=h.model.entities.get(text);if(!chosen)return fail('The chosen creel is no longer there.');const denied=h.denied(chosen.id,s);if(denied)return denied;const item=named(chosen.id,'core-angling-creel');if(!item)return fail('Choose the exact actual angling creel ID.');
  const support=h.engine.world.entities[item.id]?.support,parent=h.model.entities.get(item.in.parent),pd=parent&&h.model.resolvedDef(parent.def);
  if(!parent||pd?.components.carryable||support?.kind!=='resting-on'||support.on!==parent.id||!item.in.slot||!h.model.slotsOf(parent).some(v=>v.id===item.in.slot&&v.kind==='surface'))return fail('Put this same creel on an admitted fixed work surface beside the pool.');
  const parentNo=h.denied(parent.id,s);if(parentNo)return parentNo;
  if(action==='catch-fish'&&item.state?.caught===true)return fail('This creel already holds one fish; release it to its recorded source before catching again.');
  if(action==='release-fish'&&(item.state?.caught!==true||item.state?.source!==id))return fail('Release requires one caught fish in this same creel and its SAME recorded source pool.');
  if(action==='release-fish'&&Number(e.state?.fish??3)>=3)return fail('The source fish stock is already full; unchanged source identity and stock are required.');
  const p=h.model.worldPose(e),q=h.model.worldPose(item),level=h.levelAt(p.x,p.z,supportY(h.model,e));
  if(level!==h.levelAt(q.x,q.z,supportY(h.model,item))||Math.hypot(q.x-p.x,q.z-p.z)>5)return fail('Keep the creel within five metres of its selected pool on the same native floor.');
  if(finish&&(h.levelAt(at[0],at[2],at[1])!==level||Math.hypot(at[0]-q.x,at[2]-q.z)>2))return fail('Complete the transfer beside the selected creel on its native floor.');
  return{e,item,parent,support,level,p,q};
 }
 function plan(s:EdgeSoul,id:string,action:string,params?:Record<string,unknown>){
  if(!pool(id)||!['catch-fish','release-fish'].includes(action))return null;
  if(params!==undefined&&!params.text)return fail('Choose the exact nearby creel ID in text.');
  const c=check(s,id,action,params?.text);if('code'in c)return c;if(!('item'in c)||!c.item)return{summary:'Choose the exact nearby creel ID in text.',steps:[]};
  const shore=[c.p.x+Math.sin(c.p.yaw)*2.3*c.p.s,c.p.z+Math.cos(c.p.yaw)*2.3*c.p.s],pp=h.model.worldPose(c.parent),gap=h.model.resolvedDef(c.parent.def)!.size.box[2]*pp.s/2+.6,front=[pp.x+Math.sin(pp.yaw)*gap,pp.z+Math.cos(pp.yaw)*gap];
  return{summary:action==='catch-fish'?'Complete native fishing, spend one supplied bait and transfer one fish into the same real creel.':'Return the one caught fish to its recorded source pool; retain the same empty creel and do not restore bait.',steps:[{verb:'stand',params:{}},{verb:'mars:walk_to',params:{x:shore[0],z:shore[1],level:c.level}},{verb:'mars:pose_v1',params:{activity:action==='catch-fish'?'fish':'operate',seconds:action==='catch-fish'?4:1,face:[c.p.x,c.p.z]}},{verb:'mars:pose_v1',params:{activity:'nod',seconds:.5,base:'idle',release:true,clear:true,face:[c.p.x,c.p.z]}},{verb:'stand',params:{}},{verb:'mars:walk_to',params:{x:front[0],z:front[1],level:c.level}},{verb:'mars:pose_v1',params:{activity:'operate',seconds:1,face:[c.q.x,c.q.z]}},{verb:'mars:pose_v1',params:{activity:'nod',seconds:.5,base:'idle',release:true,clear:true,face:[c.q.x,c.q.z]}},{verb:'stand',params:{}}]};
 }
 function begin(s:EdgeSoul,id:string,action:string,params:Record<string,unknown>){if(!pool(id)||!['catch-fish','release-fish'].includes(action))return;const c=check(s,id,action,params.text);if('code'in c||!('item'in c)||!c.item)return;requested.set(s.soulId,{pool:id,creel:c.item.id,action,body:s.entityId,soul:s.soulId,name:s.name.slice(0,80),world:h.worldId,tick:h.engine.world.tick,poolStamp:stamp(c.e),creelStamp:creelStamp(c.item),invalid:false});}
 function valid(q:Work){const s=h.soul(q.soul),e=pool(q.pool),item=h.model.entities.get(q.creel),body=h.engine.world.entities[q.body];return !!body?.human&&!!s&&s.entity_id===q.body&&!!e&&!!item&&q.world===h.worldId&&stamp(e)===q.poolStamp&&creelStamp(item)===q.creelStamp&&!held(q.body)&&!h.denied(e.id,{soulId:s.id,entityId:s.entity_id,name:s.name})&&!h.denied(item.id,{soulId:s.id,entityId:s.entity_id,name:s.name});}
 function tick(){for(const q of pending.values())if(!valid(q))q.invalid=true;}
 function onReceipt(r:EdgeReceipt){const m=/^object:(.+):(catch-fish|release-fish)$/.exec(r.capability);if(r.phase==='started'){const q=requested.get(r.soulId);requested.delete(r.soulId);if(q&&m&&q.pool===m[1]&&q.action===m[2]&&q.tick===r.acceptedTick)pending.set(r.id,q);return;}if(!['completed','failed','replaced'].includes(r.phase))return;const q=pending.get(r.id);pending.delete(r.id);if(!q||!m||r.phase!=='completed'||q.invalid||q.pool!==m[1]||q.action!==m[2]||q.soul!==r.soulId||!valid(q)||!Number.isSafeInteger(r.endedTick)||r.endedTick!-q.tick<(q.action==='catch-fish'?100:40))return;const s=h.soul(q.soul)!,c=check({soulId:s.id,entityId:s.entity_id,name:s.name},q.pool,q.action,q.creel,true);if('code'in c||!('item'in c)||!c.item)return;const st=c.e.state??{};if(st.lastReceipt===r.id||r.endedTick!<Number(st.lastCompletedTick??-1))return;const catching=q.action==='catch-fish',ops=[opSchema.parse({op:'set',id:q.pool,state:{fish:Number(st.fish??3)+(catching?-1:1),bait:Number(st.bait??3)-(catching?1:0),catches:Number(st.catches??0)+(catching?1:0),releases:Number(st.releases??0)+(catching?0:1),lastBy:q.name,lastReceipt:r.id,lastCompletedTick:r.endedTick}}),opSchema.parse({op:'set',id:q.creel,state:{caught:catching,source:catching?q.pool:'',sourceName:catching?(c.e.name||'stocked pool').slice(0,100):'',catcher:catching?q.name:String(c.item.state?.catcher??''),lastReceipt:r.id}})];if(!h.commit(ops,`${r.soulId} completed finite catch-and-release angling`).accepted)h.log('angling: atomic transfer refused; fish, bait and creel unchanged');}
 return{plan,begin,onReceipt,tick,facts(id:string){const e=pool(id);if(e)return{angling:`Stocked pool: fish ${e.state?.fish??3}/3; supplied bait ${e.state?.bait??3}/3. Completed catches: ${e.state?.catches??0}; releases: ${e.state?.releases??0}. Latest participant: ${e.state?.lastBy||'none'} (completion snapshot). Catch consumes one bait and moves one integral fish into an empty creel on a nearby fixed surface. Release returns that fish only to its recorded SAME pool, never bait. Exact creel ID in text; empty hands; no wild population or loose fish physics.`};const item=named(id,'core-angling-creel');return item?{angling:`Same portable creel: ${item.state?.caught?'one caught fish':'empty'}. Recorded source: ${item.state?.sourceName||'none'}; exact source ID: ${item.state?.source||'none'}. Catcher: ${item.state?.catcher||'none'} (historical snapshot). Place on a fixed work surface beside its recorded source to release. Fish is integral, not a loose item or ready-to-eat food. Empty creel remains real and reusable.`}:null;}};
}
export type Angling=ReturnType<typeof createAngling>;
