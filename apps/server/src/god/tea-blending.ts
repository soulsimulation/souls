import {opSchema, type Op, type WorldModel} from '@souls/world-compiler';
import type {EdgeReceipt, EdgeSoul} from '../edge/contract.ts';
import {ACT_REACH} from './actuators.ts';
type Refusal = {code:string;reason:string};
type Body = {pose?:{p:number[]};support?:{kind?:string;on?:string;by?:string};human?:{holding?:unknown;hands?:Record<string,unknown>;handActuator?:unknown}};
type Approach = (id:string,soul:EdgeSoul,front:[number,number]|null,radius?:number)=>{p:[number,number];level:number}|null;
export type TeaBlendingHost = {model:WorldModel;engine:{world:{entities:Record<string,Body>}};levelAt(x:number,z:number,y:number):number;soul(id:string):{id:string;entity_id:string;name:string}|undefined;denied(id:string,soul:Pick<EdgeSoul,'soulId'|'entityId'|'name'>):Refusal|null;commit(ops:Op[],note:string):{accepted:boolean};log(message:string):void};
const fields=['green','mint','blendGreen','blendMint','reserveGreen','reserveMint'] as const;
export function createTeaBlending(h:TeaBlendingHost) {
 const pending=new Map<string,{id:string;body:string;action:string;stamp:string;startedTick:number}>();
 const item=(id:string)=>{const e=h.model.entities.get(id),d=e&&h.model.resolvedDef(e.def);return d?.name==='core-tea-blending-caddy'&&d.version===1?e:null;};
 const stamp=(e:NonNullable<ReturnType<typeof h.model.entities.get>>)=>[e.id,e.def,e.in,e.state,e.params,e.owner,e.access,e.by,h.model.worldPose(e),h.engine.world.entities[e.id]?.pose,h.engine.world.entities[e.id]?.support];
 function ready(soul:Pick<EdgeSoul,'soulId'|'entityId'|'name'>,id:string,action:string) {
  const e=item(id);if(!e)return{no:{code:'object.gone',reason:'This tea-blending caddy is no longer here.'}};
  const denied=h.denied(id,soul);if(denied)return{no:denied};
  const st=e.state!,n=Object.fromEntries(fields.map(k=>[k,Number(st[k])]));
  if(fields.some(k=>!Number.isInteger(n[k])||n[k]<0||n[k]>8||e.params?.[k]!==n[k])||n.blendGreen+n.blendMint>4||n.reserveGreen+n.reserveMint>8||n.green+n.blendGreen+n.reserveGreen!==8||n.mint+n.blendMint+n.reserveMint!==8)return{no:{code:'object.state',reason:'Restore the caddy’s matching finite stocks and mixed quantities before working it.'}};
  const native=h.engine.world.entities[id],parent=h.model.entities.get(e.in.parent);
  if(parent){const parentDenied=h.denied(parent.id,soul);if(parentDenied)return{no:parentDenied};}
  const pd=parent&&h.model.resolvedDef(parent.def);
  if(!parent||!pd?.components.surface||pd.components.carryable||native?.support?.kind!=='resting-on'||native.support.on!==parent.id||!e.in.slot||!h.model.slotsOf(parent).some(s=>s.id===e.in.slot&&s.kind==='surface')||!native.pose||!h.engine.world.entities[parent.id]?.pose)return{no:{code:'object.state',reason:'Put this caddy on a stable permitted fixed table before choosing or mixing leaves; held custom work is unavailable.'}};
  const body=h.engine.world.entities[soul.entityId];if(!body?.human||!body.pose)return{no:{code:'body.unavailable',reason:'Your body is unavailable.'}};
  if(body.human.holding||Object.values(body.human.hands??{}).some(Boolean)||body.human.handActuator||Object.values(h.engine.world.entities).some(b=>b.support?.kind==='in-hand'&&b.support.by===soul.entityId))return{no:{code:'object.state',reason:'Put down held items before working the tea caddy.'}};
  if(Number(st.batches)>=100000||Number(st.recoveries)>=100000)return{no:{code:'object.state',reason:'This caddy’s bounded preparation record is full.'}};
  const m=/^([0-4]) ([0-4])$/.exec(String(st.recipe));let green=0,mint=0;
  if(action==='blend') {if(!m||Number(m[1])+Number(m[2])<1)return{no:{code:'object.state',reason:'Choose additions as two whole numbers, green-tea then mint, such as 2 1; add at least one portion.'}};green=Number(m[1]);mint=Number(m[2]);if(green>n.green||mint>n.mint)return{no:{code:'object.state',reason:'The chosen additions exceed the actual remaining leaf stocks; choose smaller amounts.'}};if(n.blendGreen+n.blendMint+green+mint>4)return{no:{code:'object.state',reason:'The mixing well holds four portions; recover its current mixture or choose fewer additions.'}};}
  if(action==='recover'&&(n.blendGreen+n.blendMint===0||n.reserveGreen+n.reserveMint+n.blendGreen+n.blendMint>8))return{no:{code:'object.state',reason:'Recovery needs a nonempty well and enough room in the eight-portion mixed reserve.'}};
  if(action==='restore'&&(n.reserveGreen+n.reserveMint===0||n.reserveGreen+n.reserveMint+n.blendGreen+n.blendMint>4))return{no:{code:'object.state',reason:'Restore needs an actual mixed reserve that fits in the four-portion well.'}};
  return{e,parent,n,green,mint};
 }
 const binding=(a:ReturnType<typeof ready>)=>a.e?JSON.stringify([stamp(a.e),stamp(a.parent!)]):'';
 function plan(soul:EdgeSoul,id:string,action:string,approach:Approach) {
  if(!item(id)||!['choose-additions','blend','recover','restore'].includes(action))return null;
  const a=ready(soul,id,action);if(a.no)return a.no;if(action==='choose-additions')return null;
  const p=h.model.worldPose(a.e!),stand=approach(id,soul,null,1.5);if(!stand)return{code:'object.state',reason:'No ordinary reachable standing place is available beside this caddy.'};
  return{summary:'Completed three seconds of native leaf preparation; inspect the conserved actual mixture.',steps:[{verb:'stand',params:{}},{verb:'mars:walk_to',params:{x:stand.p[0],z:stand.p[1],level:stand.level}},{verb:'mars:pose_v1',params:{activity:'operate',seconds:3,face:[p.x,p.z]}},{verb:'mars:pose_v1',params:{activity:'nod',seconds:.5,base:'idle',release:true,clear:true,face:[p.x,p.z]}},{verb:'stand',params:{}}]};
 }
 function onReceipt(r:EdgeReceipt) {
  const m=/^object:(.+):(blend|recover|restore)$/.exec(r.capability);if(!m)return;const id=m[1],action=m[2],soul=h.soul(r.soulId);
  if(r.phase==='started'){if(!soul||pending.has(r.id))return;const a=ready({soulId:soul.id,entityId:soul.entity_id,name:soul.name},id,action);if(a.e&&a.e.state?.lastReceipt!==r.id&&Number.isSafeInteger(r.startedTick))pending.set(r.id,{id,body:soul.entity_id,action,stamp:binding(a),startedTick:r.startedTick!});return;}
  if(!['completed','failed','replaced','aborted','cancelled'].includes(r.phase))return;const b=pending.get(r.id);pending.delete(r.id);
  if(r.phase!=='completed'||!b||b.id!==id||b.action!==action||!soul||b.body!==soul.entity_id||!Number.isSafeInteger(r.endedTick)||r.startedTick!==b.startedTick||r.endedTick!-b.startedTick<60)return;
  const a=ready({soulId:soul.id,entityId:soul.entity_id,name:soul.name},id,action);if(!a.e||binding(a)!==b.stamp||a.e.state?.lastReceipt===r.id||r.endedTick!<Number(a.e.state?.lastCompletedTick??-1))return;
  const at=h.engine.world.entities[soul.entity_id]?.pose?.p,p=h.model.worldPose(a.e);if(!at||Math.hypot(at[0]-p.x,at[2]-p.z)>ACT_REACH||h.levelAt(at[0],at[2],at[1])!==h.levelAt(p.x,p.z,p.y))return;
  const n={...a.n};if(action==='blend'){n.green-=a.green!;n.mint-=a.mint!;n.blendGreen+=a.green!;n.blendMint+=a.mint!;}else if(action==='recover'){n.reserveGreen+=n.blendGreen;n.reserveMint+=n.blendMint;n.blendGreen=n.blendMint=0;}else{n.blendGreen+=n.reserveGreen;n.blendMint+=n.reserveMint;n.reserveGreen=n.reserveMint=0;}
  const state={...n,maker:soul.name.slice(0,80),batches:Number(a.e.state?.batches)+(action==='blend'?1:0),recoveries:Number(a.e.state?.recoveries)+(action==='recover'?1:0),lastReceipt:r.id,lastCompletedTick:r.endedTick};
  if(!h.commit([opSchema.parse({op:'set',id,state,params:n})],`${r.soulId} completed finite tea-leaf preparation`).accepted)h.log('tea blending: atomic preparation refused; original material preserved');
 }
 return{plan,onReceipt,facts(id:string){const e=item(id);if(!e)return null;return{teaBlend:`Pure stocks: ${e.state?.green} green-tea, ${e.state?.mint} mint portions. Well: ${e.state?.blendGreen} green-tea + ${e.state?.blendMint} mint; mixed reserve: ${e.state?.reserveGreen} green-tea + ${e.state?.reserveMint} mint. Chosen additions ${e.state?.recipe}; maker ${e.state?.maker||'none'}.`,teaBlendRequirements:'Supported fixed table and empty hands; three seconds native work per blend, recover or restore. Mixed leaves remain mixed. No brewing, drinking or health claim.'};}};
}
export type TeaBlending=ReturnType<typeof createTeaBlending>;
