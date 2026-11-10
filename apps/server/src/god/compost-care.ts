import {opSchema,GROWTH_STAGES,type Op,type WorldModel} from '@souls/world-compiler';
import type {EdgeReceipt,EdgeSoul} from '../edge/contract.ts';
import {ACT_REACH} from './actuators.ts';
import {supportY} from './nav.ts';
type Refusal={code:string;reason:string};
type Body={pose?:{p:number[]};support?:{kind?:string;by?:string};human?:{holding?:unknown;hands?:unknown;handActuator?:unknown}};
export type CompostCareHost={model:WorldModel;worldId:string;engine:{world:{tick:number;entities:Record<string,Body>};clearanceAtV1?(x:number,z:number,level?:number):number};levelAt(x:number,z:number,y:number):number;soul(id:string):{id:string;entity_id:string;name:string}|undefined;denied(id:string,soul:{soulId:string;entityId:string;name:string}):Refusal|null;commit(ops:Op[],note:string,clientRef:string):{accepted:boolean};log(s:string):void};
type Capture={id:string;target:string;body:string;world:string;tick:number;stockStamp:string;targetStamp:string;growth:number;targetName:string};
const fail=(reason:string,code='object.state'):Refusal=>({code,reason});
export function createCompostCare(h:CompostCareHost){
 const requested=new Map<string,Capture>(),pending=new Map<string,Capture>();
 const item=(id:string)=>{const e=h.model.entities.get(id),d=e&&h.model.resolvedDef(e.def);return e&&d?.name==='core-compost-supply'&&d.version===1?e:null;};
 const stamp=(id:string)=>{const e=h.model.entities.get(id);return JSON.stringify([e?.in,e&&h.model.worldPose(e),e?.state]);};
 function check(s:Pick<EdgeSoul,'soulId'|'entityId'|'name'>,id:string,text?:unknown,finishing=false){
  const e=item(id);if(!e)return fail('This compost supply is no longer there.','object.gone');const no=h.denied(id,s);if(no)return no;
  const b=h.engine.world.entities[s.entityId],at=b?.pose?.p,p=h.model.worldPose(e);
  if(!b?.human||!at||at.length!==3||!at.every(Number.isFinite))return fail('Your native body is unavailable.','body.unavailable');
  if(b.human.holding||b.human.hands||b.human.handActuator||Object.values(h.engine.world.entities).some(x=>x.support?.kind==='in-hand'&&x.support.by===s.entityId))return fail('Empty your hands before feeding the planter.');
  const floor=h.levelAt(at[0],at[2],at[1]),stockFloor=h.levelAt(p.x,p.z,supportY(h.model,e));
  if(floor!==stockFloor||!finishing&&Math.hypot(at[0]-p.x,at[2]-p.z)>ACT_REACH)return fail('Start nearby on the same native floor as the compost supply.','object.out-of-reach');
  const portions=Number(e.state?.portions??3);if(!Number.isFinite(portions)||portions<1)return fail('No whole supplied compost portion remains.');
  if(text===undefined)return{e,b};if(typeof text!=='string'||!text.trim())return fail('Choose an existing nearby garden planter reference.');
  let target;try{target=h.model.get(text.trim());}catch{}if(!target)return fail('That planter is no longer there.','object.gone');
  const access=h.denied(target.id,s);if(access)return access;
  const d=h.model.resolvedDef(target.def),growth=Number(target.state?.growth??0);
  if(d?.name!=='core-garden-planter'||d.version!==2||!Number.isSafeInteger(growth)||growth<0||growth>=GROWTH_STAGES.length-1)return fail('Choose a supported garden planter@2 below the final fruiting stage.');
  const t=h.model.worldPose(target),targetFloor=h.levelAt(t.x,t.z,supportY(h.model,target));
  if(targetFloor!==stockFloor||Math.hypot(t.x-p.x,t.z-p.z)>8||finishing&&Math.hypot(at[0]-t.x,at[2]-t.z)>ACT_REACH)return fail('The planter must be nearby on the same native floor, with your body beside it at completion.','object.out-of-reach');
  return{e,b,target,growth};
 }
 function plan(s:EdgeSoul,id:string,action:string,params?:Record<string,unknown>){
  if(!item(id)||action!=='feed-planter')return null;const c=check(s,id,params?.text);if('code'in c)return c;
  if(!('target'in c)||!c.target)return{summary:'Choose an existing nearby garden planter@2 reference.',steps:[]};
  const points=[{e:c.e,margin:.5,seconds:1},{e:c.target,margin:.6,seconds:2}],steps:{verb:string;params:Record<string,unknown>}[]=[{verb:'stand',params:{}}];
  for(const q of points){const p=h.model.worldPose(q.e),gap=h.model.resolvedDef(q.e.def)!.size.box[2]/2*p.s+q.margin,x=p.x+Math.sin(p.yaw)*gap,z=p.z+Math.cos(p.yaw)*gap,level=h.levelAt(x,z,supportY(h.model,q.e));if(h.engine.clearanceAtV1&&h.engine.clearanceAtV1(x,z,level)<.4)return fail('There is no clear standing room at the compost supply or planter.');steps.push({verb:'mars:walk_to',params:{x,z,level}},{verb:'mars:pose_v1',params:{activity:'garden',prop:'tool',seconds:q.seconds,face:[p.x,p.z]}});}
  steps.push({verb:'stand',params:{}});return{summary:'Completed native garden work consumes one supplied compost portion and advances exactly this planter by one game growth stage.',steps};
 }
 function begin(s:EdgeSoul,id:string,action:string,params:Record<string,unknown>){if(!item(id)||action!=='feed-planter')return;const c=check(s,id,params.text);if('code'in c||!('target'in c)||!c.target)return;requested.set(s.soulId,{id,target:c.target.id,body:s.entityId,world:h.worldId,tick:h.engine.world.tick,stockStamp:stamp(id),targetStamp:stamp(c.target.id),growth:c.growth!,targetName:h.model.pathOf(c.target.id).slice(0,160)});}
 function onReceipt(r:EdgeReceipt){
  const m=/^object:(.+):feed-planter$/.exec(r.capability);
  if(r.phase==='started'){const q=requested.get(r.soulId);requested.delete(r.soulId);if(q&&m&&q.id===m[1]&&q.tick===r.acceptedTick&&!pending.has(r.id))pending.set(r.id,q);return;}
  if(!['completed','failed','replaced'].includes(r.phase))return;const q=pending.get(r.id);pending.delete(r.id);if(!q||!m||r.phase!=='completed')return;
  const e=item(q.id),s=h.soul(r.soulId);if(!e||!s||s.entity_id!==q.body||q.world!==h.worldId||q.stockStamp!==stamp(e.id)||q.targetStamp!==stamp(q.target)||!Number.isSafeInteger(r.endedTick)||r.endedTick!<0||r.endedTick!<Number(e.state?.lastCompletedTick??-1)||e.state?.lastReceipt===r.id)return;
  const c=check({soulId:s.id,entityId:s.entity_id,name:s.name},e.id,q.target,true);if('code'in c||!('target'in c)||!c.target||c.growth!==q.growth)return;
  const ops=[opSchema.parse({op:'set',id:e.id,state:{portions:Number(e.state?.portions??3)-1,feedings:Number(e.state?.feedings??0)+1,lastBy:s.name.slice(0,80),lastTarget:q.targetName,lastBefore:GROWTH_STAGES[q.growth],lastAfter:GROWTH_STAGES[q.growth+1],lastReceipt:r.id,lastCompletedTick:r.endedTick}}),opSchema.parse({op:'set',id:c.target.id,state:{growth:q.growth+1}})];
  if(!h.commit(ops,`${r.soulId} fed the chosen planter from supplied compost`,`compost-care:${r.id}`).accepted)h.log('compost-care: refused atomic completion batch; supply and plant unchanged');
 }
 return{plan,begin,onReceipt,facts(id:string){const e=item(id);if(!e)return null;return{compostCare:`Supplied compost portions: ${e.state?.portions??3}. Completed feedings: ${e.state?.feedings??0}. Latest player: ${e.state?.lastBy||'none'}. Latest completed target: ${e.state?.lastTarget||'none'}. Latest stage: ${e.state?.lastBefore||'none'} -> ${e.state?.lastAfter||'none'}. Choose an existing nearby core garden planter@2 reference in text. Supported whole stages seed/sprout/leafy/flowering advance one step, at most fruiting, only after completed native garden work; consumes one whole portion atomically. Permission to both objects, unchanged stock/plant/start binding, same-floor native body and empty hands required. Supplied compost and existing tool proxy; no compost-aging, real agronomic timing or borrowed-tool custody claim. Latest target/player are completed historical snapshots, not live foreign tracking.`};}};
}
export type CompostCare=ReturnType<typeof createCompostCare>;
