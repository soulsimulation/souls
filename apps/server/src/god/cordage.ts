// Existing native craft owns time; one ordinary batch transforms the bound cord and moves its reusable binding.
import{opSchema,type Op,type StoredDef,type WorldModel}from'@souls/world-compiler';
import type{EdgeReceipt,EdgeSoul}from'../edge/contract.ts';
import{ACT_REACH}from'./actuators.ts';
type Refusal={code:string;reason:string};
type Body={pose?:{p:number[]};support?:{kind?:string;on?:string;by?:string};human?:{holding?:unknown;hands?:unknown;handActuator?:unknown}};
export type CordageHost={model:WorldModel;engine:{world:{entities:Record<string,Body>};clearanceAtV1?(x:number,z:number,level?:number):number};levelAt(x:number,z:number,y:number):number;soul(id:string):{id:string;entity_id:string;name:string}|undefined;denied(id:string,soul:{soulId:string;entityId:string;name:string}):Refusal|null;commit(ops:Op[],note:string,clientRef:string):{accepted:boolean};log(message:string):void};
const isBench=(d:StoredDef|undefined)=>d?.name==='core-cordage-board'&&d.version===1;
const isCord=(d:StoredDef|undefined)=>d?.name==='core-camp-cord'&&d.version===1;
type Choice='loop'|'guyline'|'untie';
export function createCordage(h:CordageHost){
 const pending=new Map<string,{cord:string;bench:string;body:string;choice:Choice;form:unknown;text:unknown}>();
 const bench=(id:string)=>{const e=h.model.entities.get(id);return e&&isBench(h.model.resolvedDef(e.def))?e:null;};
 const choice=(action:string):Choice|null=>action==='tie-loop'?'loop':action==='tie-guyline'?'guyline':action==='untie'?'untie':null;
 function ready(soul:Pick<EdgeSoul,'soulId'|'entityId'|'name'>,id:string,c:Choice){
  const at=bench(id);if(!at)return{no:{code:'object.gone',reason:'The cordage board is no longer there.'}};
  const no=h.denied(id,soul);if(no)return{no};
  const children=[...(h.model.children.get(id)??[])].map(i=>h.model.entities.get(i)!).filter(e=>e?.in.slot==='cord');
  const cord=children.length===1&&isCord(h.model.resolvedDef(children[0].def))?children[0]:null;
  if(!cord)return{no:{code:'object.state',reason:'Put one camp cord on the cord board first.'}};
  const form=Number(cord.state?.form);
  if(c==='untie' ? (![1,2].includes(form)||at.state?.bindings!==0) : (form!==0||at.state?.bindings!==1))return{no:{code:'object.state',reason:c==='untie'?'Return one prepared cord with its binding to this board before untying.':'This operation needs loose cord and the available reusable binding; untie a prepared cord first.'}};
  const denied=h.denied(cord.id,soul);if(denied)return{no:denied};
  const support=h.engine.world.entities[cord.id]?.support;
  if(support?.kind!=='resting-on'||support.on!==id)return{no:{code:'object.state',reason:'The cord must actually rest on this cordage board.'}};
  const body=h.engine.world.entities[soul.entityId],pos=body?.pose?.p,p=h.model.worldPose(at);
  if(!body?.human||!pos)return{no:{code:'body.unavailable',reason:'Your body is unavailable.'}};
  if(body.human.holding||body.human.hands||body.human.handActuator||Object.values(h.engine.world.entities).some(x=>x.support?.kind==='in-hand'&&x.support.by===soul.entityId))return{no:{code:'object.state',reason:'Put down what you are holding before preparing cord.'}};
  if(h.levelAt(pos[0],pos[2],pos[1])!==h.levelAt(p.x,p.z,p.y))return{no:{code:'object.state',reason:'Reach the same floor as the cordage board first.'}};
  return{at,cord};
 }
 function plan(soul:EdgeSoul,id:string,action:string){
  const c=choice(action);if(!c||!bench(id))return null;
  const r=ready(soul,id,c);if(r.no)return r.no;
  const p=h.model.worldPose(r.at!),d=h.model.resolvedDef(r.at!.def)!,worker=d.slots.find(s=>s.id==='worker')!,cord=d.slots.find(s=>s.id==='cord')!,cos=Math.cos(p.yaw),sin=Math.sin(p.yaw);
  const point=(v:number[])=>({x:p.x+(v[0]*cos+v[2]*sin)*p.s,z:p.z+(-v[0]*sin+v[2]*cos)*p.s}),stand=point(worker.p),face=point(cord.p),level=h.levelAt(stand.x,stand.z,p.y);
  if(h.engine.clearanceAtV1&&h.engine.clearanceAtV1(stand.x,stand.z,level)<.4)return{code:'object.state',reason:'There is no clear standing room at this cordage board.'};
  return{summary:`Completed ten seconds ${c==='untie'?'untying the cord':`preparing a ${c}`}; inspect the cord and reusable binding.`,steps:[{verb:'stand',params:{}},{verb:'mars:walk_to',params:{x:stand.x,z:stand.z,level}},{verb:'mars:pose_v1',params:{activity:'craft',seconds:10,prop:'tool',face:[face.x,face.z]}},{verb:'stand',params:{}}]};
 }
 function onReceipt(r:EdgeReceipt){
  const m=/^object:(.+):(tie-loop|tie-guyline|untie)$/.exec(r.capability);if(!m)return;
  const soul=h.soul(r.soulId),id=m[1],c=choice(m[2])!;
  if(r.phase==='started'){
   if(!soul||pending.has(r.id))return;const at=ready({soulId:soul.id,entityId:soul.entity_id,name:soul.name},id,c);
   if(at.cord)pending.set(r.id,{cord:at.cord.id,bench:id,body:soul.entity_id,choice:c,form:at.cord.state?.form,text:at.cord.state?.text});return;
  }
  if(!['completed','failed','replaced','aborted','cancelled'].includes(r.phase))return;
  const bound=pending.get(r.id);pending.delete(r.id);
  if(r.phase!=='completed'||!bound||bound.bench!==id||bound.choice!==c||!soul||bound.body!==soul.entity_id||!Number.isSafeInteger(r.endedTick)||r.endedTick!<0)return;
  const at=ready({soulId:soul.id,entityId:soul.entity_id,name:soul.name},id,c);
  if(at.no||at.cord!.id!==bound.cord||at.cord!.state?.form!==bound.form||at.cord!.state?.text!==bound.text||at.at!.state?.lastReceipt===r.id||r.endedTick!<Number(at.at!.state?.lastCompletedTick??-1))return;
  const pos=h.engine.world.entities[soul.entity_id]?.pose?.p,p=h.model.worldPose(at.at!);
  if(!pos||Math.hypot(pos[0]-p.x,pos[2]-p.z)>ACT_REACH)return;
  const name=soul.name.slice(0,80),title=c==='untie'?'Loose camp cord':c==='loop'?'Bound camp cord loop':'Bundled camp guyline',text=`${title} ${c==='untie'?'untied':'prepared'} by ${name}.`.slice(0,160);
  const done=h.commit([
   opSchema.parse({op:'set',id,state:{bindings:c==='untie'?1:0,text:`Last operation: ${c}, by ${name}.`.slice(0,160),lastReceipt:r.id,lastCompletedTick:r.endedTick}}),
   opSchema.parse({op:'set',id:bound.cord,state:{form:c==='untie'?0:c==='loop'?1:2,text},about:{title,what:text}}),
  ],`${r.soulId} prepared camp cord`,`cordage:${r.id}`);
  if(!done.accepted)h.log('cordage: world refused the cordage batch; cord and binding unchanged');
 }
 return{plan,onReceipt,facts(id:string){const e=h.model.entities.get(id);if(!e)return null;const d=h.model.resolvedDef(e.def);
  if(isCord(d))return{campCord:String(e.state?.text||'Loose camp cord: return to a cordage board to prepare a loop or bundled guyline.')};
  if(isBench(d))return{cordage:`Reusable binding ${e.state?.bindings===1?'available':'on the prepared cord'}. ${e.state?.text||'Put one camp cord on the board and choose loop, guyline or untie; ten seconds with empty hands.'}`};
  return null;}};
}
export type Cordage=ReturnType<typeof createCordage>;
