import {opSchema,type Entity,type Op,type WorldModel} from '@souls/world-compiler';
import type {EdgeReceipt,EdgeSoul} from '../edge/contract.ts';
import {supportY} from './nav.ts';
type No={code:string;reason:string};
type Soul=Pick<EdgeSoul,'soulId'|'entityId'|'name'>;
type Body={pose?:{p:number[]};human?:{holding?:unknown;hands?:unknown;handActuator?:unknown};support?:{kind?:string;by?:string;on?:string}};
export type FiltrationHost={model:WorldModel;worldId:string;engine:{world:{tick:number;entities:Record<string,Body>}};levelAt(x:number,z:number,y:number):number;soul(id:string):{id:string;entity_id:string;name:string}|undefined;denied(id:string,s:Soul):No|null;commit(ops:Op[],note:string):{accepted:boolean};log(s:string):void};
type Work={filter:string;carafe:string;action:string;body:string;soul:string;name:string;world:string;tick:number;filterStamp:string;carafeStamp:string;invalid:boolean};
const actions=['filter-water','empty-carafe','replace-cartridge'];
export function createFiltration(h:FiltrationHost){
 const requested=new Map<string,Work>(),pending=new Map<string,Work>();
 const fail=(reason:string):No=>({code:'object.state',reason});
 const named=(id:string,name:string)=>{const e=h.model.entities.get(id),d=e&&h.model.resolvedDef(e.def);return e&&d?.name===name&&d.version===1?e:null;};
 const filter=(id:string)=>named(id,'core-camp-water-filter');
 const stamp=(e:Entity)=>JSON.stringify([e.def,e.owner,e.access,e.by,e.params,e.state,e.in,h.model.worldPose(e)]);
 const carafeStamp=(e:Entity)=>{const parent=h.model.entities.get(e.in.parent);return JSON.stringify([stamp(e),h.engine.world.entities[e.id]?.support,parent&&stamp(parent)]);};
 const held=(body:string)=>Object.values(h.engine.world.entities).some(x=>x.support?.kind==='in-hand'&&x.support.by===body);
 function check(s:Soul,id:string,action:string,text:unknown,finish=false){
  const e=filter(id);if(!e)return fail('The camp water filter is no longer there.');const no=h.denied(id,s);if(no)return no;
  const b=h.engine.world.entities[s.entityId],at=b?.pose?.p;if(!b?.human||!at)return fail('Your native body is unavailable.');
  if(b.human.holding||b.human.hands||b.human.handActuator||held(s.entityId))return fail('Empty your hands and put the selected carafe on a fixed work surface beside the filter.');
  if(typeof text!=='string'||!text.trim())return fail('Choose the exact nearby water carafe ID in text.');
  const target=h.model.entities.get(text.trim());if(!target)return fail('Choose an existing nearby water carafe ID.');const denied=h.denied(target.id,s);if(denied)return denied;
  const item=named(target.id,'core-filter-carafe');if(!item)return fail('Choose the real filter carafe, not another object.');
  const support=h.engine.world.entities[item.id]?.support,parent=h.model.entities.get(item.in.parent);
  if(support?.kind!=='resting-on'||support.on!==item.in.parent||!parent||h.model.resolvedDef(parent.def)?.name!=='core-table')return fail('Put the same carafe on a fixed table beside this filter first.');
  const parentNo=h.denied(parent.id,s);if(parentNo)return parentNo;
  const full=Number(item.state?.water??0)>0;
  if(action==='filter-water'&&full)return fail('Empty this full carafe before filtering another portion.');
  if(action==='filter-water'&&Number(e.state?.cloudy??3)<1)return fail('No supplied cloudy water remains; draining does not replenish it.');
  if(action==='filter-water'&&Number(e.state?.capacity??2)<1)return fail('The installed cartridge is spent; replace it using a supplied spare.');
  if(action==='empty-carafe'&&!full)return fail('This same carafe is already empty; filter one portion first.');
  if(action==='replace-cartridge'&&Number(e.state?.capacity??2)>0)return fail('Use the installed cartridge until spent before replacing it.');
  if(action==='replace-cartridge'&&Number(e.state?.spares??1)<1)return fail('No spare cartridge remains; replacement cannot restore free capacity.');
  const p=h.model.worldPose(e),q=h.model.worldPose(item),level=h.levelAt(p.x,p.z,supportY(h.model,e));
  if(level!==h.levelAt(q.x,q.z,supportY(h.model,item))||Math.hypot(q.x-p.x,q.z-p.z)>5)return fail('Keep the selected carafe within five metres of this filter on the same native floor.');
  if(finish&&(h.levelAt(at[0],at[2],at[1])!==level||Math.hypot(at[0]-q.x,at[2]-q.z)>2))return fail('Complete the work beside the selected carafe on its native floor.');
  return{e,item,parent,level,p,q};
 }
 function plan(s:EdgeSoul,id:string,action:string,params?:Record<string,unknown>){
  if(!filter(id)||!actions.includes(action))return null;
  const c=check(s,id,action,params?.text);if('code'in c)return c;
  const pp=h.model.worldPose(c.parent),gap=h.model.resolvedDef(c.parent.def)!.size.box[2]*pp.s/2+.6,front=[pp.x+Math.sin(pp.yaw)*gap,pp.z+Math.cos(pp.yaw)*gap];
  return{summary:action==='filter-water'?'Spend one cloudy portion and cartridge use; fill the same carafe with simulated clear water.':action==='empty-carafe'?'Drain the carafe; supplied water and cartridge capacity are not recovered.':'Consume one finite spare to replace the spent cartridge with two uses.',steps:[{verb:'stand',params:{}},{verb:'mars:walk_to',params:{x:front[0],z:front[1],level:c.level}},{verb:'mars:pose_v1',params:{activity:'operate',seconds:action==='filter-water'?3:2,face:[c.q.x,c.q.z]}},{verb:'mars:pose_v1',params:{activity:'nod',seconds:.5,base:'idle',release:true,clear:true,face:[c.q.x,c.q.z]}},{verb:'stand',params:{}}]};
 }
 function begin(s:EdgeSoul,id:string,action:string,params:Record<string,unknown>){if(!filter(id)||!actions.includes(action))return;const c=check(s,id,action,params.text);if('code'in c)return;requested.set(s.soulId,{filter:id,carafe:c.item.id,action,body:s.entityId,soul:s.soulId,name:s.name.slice(0,80),world:h.worldId,tick:h.engine.world.tick,filterStamp:stamp(c.e),carafeStamp:carafeStamp(c.item),invalid:false});}
 function valid(q:Work){const s=h.soul(q.soul),e=filter(q.filter),item=h.model.entities.get(q.carafe),body=h.engine.world.entities[q.body];return !!body?.human&&!!s&&s.entity_id===q.body&&!!e&&!!item&&q.world===h.worldId&&stamp(e)===q.filterStamp&&carafeStamp(item)===q.carafeStamp&&!held(q.body)&&!h.denied(e.id,{soulId:s.id,entityId:s.entity_id,name:s.name})&&!h.denied(item.id,{soulId:s.id,entityId:s.entity_id,name:s.name});}
 function tick(){for(const q of pending.values())if(!valid(q))q.invalid=true;}
 function onReceipt(r:EdgeReceipt){const m=/^object:(.+):(filter-water|empty-carafe|replace-cartridge)$/.exec(r.capability);if(r.phase==='started'){const q=requested.get(r.soulId);requested.delete(r.soulId);if(q&&m&&q.filter===m[1]&&q.action===m[2]&&q.tick===r.acceptedTick)pending.set(r.id,q);return;}if(!['completed','failed','replaced'].includes(r.phase))return;const q=pending.get(r.id);pending.delete(r.id);if(!q||!m||r.phase!=='completed'||q.invalid||q.filter!==m[1]||q.action!==m[2]||q.soul!==r.soulId||!valid(q)||!Number.isSafeInteger(r.endedTick)||r.endedTick!-q.tick<(q.action==='filter-water'?60:40))return;const s=h.soul(q.soul)!,c=check({soulId:s.id,entityId:s.entity_id,name:s.name},q.filter,q.action,q.carafe,true);if('code'in c)return;const st=c.e.state??{};if(st.lastReceipt===r.id||r.endedTick!<Number(st.lastCompletedTick??-1))return;const filtering=q.action==='filter-water',emptying=q.action==='empty-carafe',replacing=q.action==='replace-cartridge';const ops=[opSchema.parse({op:'set',id:q.filter,state:{cloudy:Number(st.cloudy??3)-(filtering?1:0),capacity:replacing?2:Number(st.capacity??2)-(filtering?1:0),spares:Number(st.spares??1)-(replacing?1:0),filtered:Number(st.filtered??0)+(filtering?1:0),drained:Number(st.drained??0)+(emptying?1:0),lastBy:q.name,lastReceipt:r.id,lastCompletedTick:r.endedTick}}),opSchema.parse({op:'set',id:q.carafe,state:{water:filtering?1:emptying?0:Number(c.item.state?.water??0),lastBy:q.name,lastReceipt:r.id}})];if(!h.commit(ops,`${r.soulId} completed finite camp filtration`).accepted)h.log('filtration: atomic work refused; water, cartridge and carafe unchanged');}
 return{plan,begin,onReceipt,tick,facts(id:string){const e=filter(id);if(e)return{filtration:`Camp filter: supplied cloudy water ${e.state?.cloudy??3}/3; installed cartridge uses ${e.state?.capacity??2}/2; spare cartridges ${e.state?.spares??1}/1. Filtered total ${e.state?.filtered??0}; deliberately drained ${e.state?.drained??0}. Latest participant ${e.state?.lastBy||'none'} (completion snapshot). Filter into an empty carafe; replace only a spent cartridge. Exact nearby carafe ID in text, fixed table, empty hands. Simulated clarity, no potability or health claim.`};const item=named(id,'core-filter-carafe');return item?{filtration:`Same portable filter carafe: ${Number(item.state?.water??0)>0?'one clear-water portion':'empty'}. Latest participant ${item.state?.lastBy||'none'} (snapshot). Drain at the filter before refilling; draining never restores supply or cartridge capacity. Simulated water only; no drinking or potability claim.`}:null;}};
}
export type Filtration=ReturnType<typeof createFiltration>;
