import {opSchema,type Entity,type Op,type WorldModel} from '@souls/world-compiler';
import type {EdgeReceipt,EdgeSoul} from '../edge/contract.ts';
import {ACT_REACH} from './actuators.ts';
import {supportY} from './nav.ts';
type No={code:string;reason:string};type Soul=Pick<EdgeSoul,'soulId'|'entityId'|'name'>;
type Body={pose?:{p:number[]};human?:{holding?:unknown;hands?:unknown;handActuator?:unknown};support?:{kind?:string;by?:string;on?:string}};
export type PillowHost={model:WorldModel;engine:{world:{tick:number;entities:Record<string,Body>}};levelAt(x:number,z:number,y:number):number;soul(id:string):{id:string;entity_id:string;name:string}|undefined;denied(id:string,s:Soul):No|null;commit(ops:Op[],note:string):{accepted:boolean};log(message:string):void};
const actions=['patch-pillow','inflate-pillow','vent-pillow'];
export function createCampPillow(h:PillowHost){
 type Work={id:string;pillow:string;action:string;body:string;soul:string;name:string;tick:number;stamp:string};
 const requested=new Map<string,Work>(),pending=new Map<string,Work>();
 const fail=(reason:string):No=>({code:'object.state',reason});
 const named=(id:string,name:string)=>{const e=h.model.entities.get(id),d=e&&h.model.resolvedDef(e.def);return e&&d?.name===name&&d.version===1?e:null;};
 const kit=(id:string)=>named(id,'core-pillow-repair-kit'),pillow=(id:string)=>named(id,'core-camp-pillow');
 const entityStamp=(e:Entity)=>[e.def,e.owner,e.access,e.by,e.params,e.state,e.in,h.model.worldPose(e),h.engine.world.entities[e.id]?.support];
 const stamp=(id:string,pid:string)=>{const a=kit(id),b=pillow(pid),parent=a&&h.model.entities.get(a.in.parent);return a&&b?JSON.stringify([entityStamp(a),entityStamp(b),parent&&entityStamp(parent)]):'';};
 function check(s:Soul,id:string,action:string,text:unknown,finish=false){
  const e=kit(id);if(!e)return fail('The selected pillow repair kit is no longer there.');const no=h.denied(id,s);if(no)return no;
  if(typeof text!=='string'||!text.trim())return fail('Choose the exact camp-pillow ID in text.');
  const chosen=h.model.entities.get(text.trim());if(!chosen)return fail('Choose an existing camp-pillow ID.');const denied=h.denied(chosen.id,s);if(denied)return denied;
  const k=pillow(chosen.id);if(!k)return fail('Choose the real camp pillow, not another object.');
  const body=h.engine.world.entities[s.entityId],at=body?.pose?.p;if(!body?.human||!at)return fail('Your native body is unavailable.');
  if(body.human.holding||body.human.hands||body.human.handActuator||Object.values(h.engine.world.entities).some(x=>x.support?.kind==='in-hand'&&x.support.by===s.entityId))return fail('Empty your hands and set the SAME pillow and repair kit on a fixed work table.');
  const parent=h.model.entities.get(e.in.parent);if(!parent)return fail('Put pillow and repair kit on the same fixed work table.');const parentNo=h.denied(parent.id,s);if(parentNo)return parentNo;
  const pd=h.model.resolvedDef(parent.def);if(parent.in.parent!=='world'||!pd?.components.surface||pd.components.carryable||k.in.parent!==parent.id||[e,k].some(x=>{const z=h.engine.world.entities[x.id]?.support;return z?.kind!=='resting-on'||z.on!==parent.id;}))return fail('Put the SAME pillow and kit side by side on one fixed work table.');
  const air=Number(e.state?.air??3),spent=Number(e.state?.spent??0),patches=Number(e.state?.patches??1),pressure=Number(k.state?.pressure??0),sealed=k.state?.sealed??false;
  if(![air,spent,patches,pressure].every(Number.isSafeInteger)||air<0||air>3||air+spent!==3||patches<0||patches>1||pressure<0||pressure>3||typeof sealed!=='boolean'||(!sealed&&pressure>0))return fail('The supplied pillow or repair material state is inconsistent.');
  if(action==='patch-pillow'&&(sealed||patches<1))return fail(sealed?'This SAME pillow is already patched and sealed.':'No supplied patch remains; choose a stocked repair kit.');
  if(action==='inflate-pillow'){if(!sealed)return fail('Patch the punctured pillow before inflating it.');if(air<1)return fail('No stored pump air remains; choose a stocked repair kit.');if(pressure>=3)return fail('This SAME pillow is fully inflated; vent it before adding air.');}
  if(action==='vent-pillow'&&pressure<1)return fail('This pillow is already flat; inflate the sealed pillow before venting it.');
  const p=h.model.worldPose(e),q=h.model.worldPose(k),pp=h.model.worldPose(parent),gap=pd.size.box[2]*pp.s/2+.6,front=[pp.x+Math.sin(pp.yaw)*gap,pp.z+Math.cos(pp.yaw)*gap],level=h.levelAt(p.x,p.z,supportY(h.model,e));
  if(level!==h.levelAt(q.x,q.z,supportY(h.model,k))||[p,q].some(x=>Math.hypot(front[0]-x.x,front[1]-x.z)>ACT_REACH))return fail('Keep both pillow and kit within ordinary reach from the table standing point on the same floor.');
  if(finish&&(h.levelAt(at[0],at[2],at[1])!==level||[p,q].some(x=>Math.hypot(at[0]-x.x,at[2]-x.z)>ACT_REACH)))return fail('Complete the native work beside BOTH the pillow and repair kit on their floor.');
  return{e,k,p,level,front,air,spent,patches,pressure};
 }
 function plan(s:EdgeSoul,id:string,action:string,params?:Record<string,unknown>){if(!actions.includes(action)||!kit(id))return null;const c=check(s,id,action,params?.text);if('code'in c)return c;return{summary:`${action}: complete native work on the SAME chosen pillow.`,steps:[{verb:'stand',params:{}},{verb:'mars:walk_to',params:{x:c.front[0],z:c.front[1],level:c.level}},{verb:'mars:pose_v1',params:{activity:'operate',seconds:3,face:[c.p.x,c.p.z]}},{verb:'mars:pose_v1',params:{activity:'nod',seconds:.5,base:'idle',release:true,clear:true,face:[c.p.x,c.p.z]}},{verb:'stand',params:{}}]};}
 function begin(s:EdgeSoul,id:string,action:string,params:Record<string,unknown>){if(!actions.includes(action))return;const c=check(s,id,action,params.text);if('code'in c)return;requested.set(s.soulId,{id,pillow:c.k.id,action,body:s.entityId,soul:s.soulId,name:s.name.slice(0,80),tick:h.engine.world.tick,stamp:stamp(id,c.k.id)});}
 function onReceipt(r:EdgeReceipt){const m=/^object:(.+):(patch-pillow|inflate-pillow|vent-pillow)$/.exec(r.capability);if(!m)return;
  if(r.phase==='started'){const q=requested.get(r.soulId);requested.delete(r.soulId);if(q&&q.id===m[1]&&q.action===m[2]&&q.tick===r.acceptedTick&&r.startedTick===q.tick)pending.set(r.id,q);return;}
  if(!['completed','failed','replaced','aborted','cancelled'].includes(r.phase))return;const q=pending.get(r.id);pending.delete(r.id);
  if(!q||r.phase!=='completed'||q.id!==m[1]||q.action!==m[2]||q.soul!==r.soulId||r.acceptedTick!==q.tick||r.startedTick!==q.tick||!Number.isSafeInteger(r.endedTick)||r.endedTick!-q.tick<60||stamp(q.id,q.pillow)!==q.stamp)return;
  const s=h.soul(q.soul);if(!s||s.entity_id!==q.body)return;const c=check({soulId:s.id,entityId:s.entity_id,name:s.name},q.id,q.action,q.pillow,true);if('code'in c||c.e.state?.lastReceipt===r.id||r.endedTick!<Number(c.e.state?.lastCompletedTick??-1))return;
  const history={lastBy:q.name,lastReceipt:r.id,lastCompletedTick:r.endedTick},source=q.action==='patch-pillow'?{patches:c.patches-1,patchReady:false}:q.action==='inflate-pillow'?{air:c.air-1,spent:c.spent+1}:{};
  const target=q.action==='patch-pillow'?{sealed:true,patched:true}:q.action==='inflate-pillow'?{pressure:c.pressure+1,low:c.pressure===0,medium:c.pressure===1,full:c.pressure===2}: {pressure:0,low:false,medium:false,full:false,vented:Number(c.k.state?.vented??0)+c.pressure};
  const ops:Op[]=[opSchema.parse({op:'set',id:q.id,state:{...source,...history}}),opSchema.parse({op:'set',id:q.pillow,state:{...target,...history}})];if(!h.commit(ops,'Completed native camp pillow maintenance').accepted)h.log('camp-pillow: atomic completion refused; pillow and repair supplies unchanged');
 }
 return{plan,begin,onReceipt,facts(id:string){const e=kit(id);if(e)return{campPillow:`Repair stock: patches ${e.state?.patches??1}/1; stored air ${e.state?.air??3}/3; spent air ${e.state?.spent??0}. Exact camp-pillow ID in text. SAME fixed table, empty hands, three completed native seconds. Venting gives no refund. Latest participant ${e.state?.lastBy||'none'} (snapshot).`};const k=pillow(id);return k?{campPillow:`SAME portable pillow: ${k.state?.sealed?'patched and sealed':'punctured'}, pressure ${k.state?.pressure??0}/3; deliberately vented air ${k.state?.vented??0}. Maintained by ${k.state?.lastBy||'none'} (snapshot). Use repair kit with exact pillow ID. No sleep, body loading, passive leak or air-physics claim.`}:null;}};
}
export type CampPillow=ReturnType<typeof createCampPillow>;
