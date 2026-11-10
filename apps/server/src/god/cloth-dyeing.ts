// Existing native craft owns time; one ordinary batch transforms the bound cloth and consumes its supplies.
import{opSchema,type Op,type StoredDef,type WorldModel}from'@souls/world-compiler';
import type{EdgeReceipt,EdgeSoul}from'../edge/contract.ts';
import{ACT_REACH}from'./actuators.ts';
type Refusal={code:string;reason:string};
type Body={pose?:{p:number[]};support?:{kind?:string;on?:string;by?:string};human?:{holding?:unknown;hands?:unknown;handActuator?:unknown}};
export type ClothDyeingHost={model:WorldModel;engine:{world:{entities:Record<string,Body>};clearanceAtV1?(x:number,z:number,level?:number):number};levelAt(x:number,z:number,y:number):number;soul(id:string):{id:string;entity_id:string;name:string}|undefined;denied(id:string,soul:{soulId:string;entityId:string;name:string}):Refusal|null;commit(ops:Op[],note:string,clientRef:string):{accepted:boolean};log(message:string):void};
const isBench=(d:StoredDef|undefined)=>d?.name==='core-cloth-dye-bench'&&d.version===1;
const isCloth=(d:StoredDef|undefined)=>d?.name==='core-dyeable-cloth'&&d.version===1;
type Color='indigo'|'rust';type Pattern='solid'|'banded';
export function createClothDyeing(h:ClothDyeingHost){
 const pending=new Map<string,{cloth:string;bench:string;body:string;color:Color;pattern:Pattern;dye:unknown;banded:unknown;text:unknown}>();
 const bench=(id:string)=>{const e=h.model.entities.get(id);return e&&isBench(h.model.resolvedDef(e.def))?e:null;};
 const choice=(action:string)=>{const m=/^dye-(indigo|rust)-(solid|banded)$/.exec(action);return m?{color:m[1]as Color,pattern:m[2]as Pattern}:null;};
 function ready(soul:Pick<EdgeSoul,'soulId'|'entityId'|'name'>,id:string,color:Color){
  const at=bench(id);if(!at)return{no:{code:'object.gone',reason:'The cloth-dye bench is no longer there.'}};
  const no=h.denied(id,soul);if(no)return{no};
  if(at.state?.[color]!==1||![1,2].includes(Number(at.state?.water)))return{no:{code:'object.state',reason:`This bench needs an unused ${color} charge and water.`}};
  const children=[...(h.model.children.get(id)??[])].map(i=>h.model.entities.get(i)!).filter(e=>e?.in.slot==='cloth');
  const cloth=children.length===1&&isCloth(h.model.resolvedDef(children[0].def))?children[0]:null;
  if(!cloth)return{no:{code:'object.state',reason:'Put one dyeable folded cloth on the cloth board first.'}};
  const denied=h.denied(cloth.id,soul);if(denied)return{no:denied};
  const support=h.engine.world.entities[cloth.id]?.support;
  if(support?.kind!=='resting-on'||support.on!==id)return{no:{code:'object.state',reason:'The cloth must actually rest on this dye board.'}};
  const body=h.engine.world.entities[soul.entityId],pos=body?.pose?.p,p=h.model.worldPose(at);
  if(!body?.human||!pos)return{no:{code:'body.unavailable',reason:'Your body is unavailable.'}};
  if(body.human.holding||body.human.hands||body.human.handActuator||Object.values(h.engine.world.entities).some(x=>x.support?.kind==='in-hand'&&x.support.by===soul.entityId))return{no:{code:'object.state',reason:'Put down what you are holding before dyeing.'}};
  if(h.levelAt(pos[0],pos[2],pos[1])!==h.levelAt(p.x,p.z,p.y))return{no:{code:'object.state',reason:'Reach the same floor as the dye bench first.'}};
  return{at,cloth};
 }
 function plan(soul:EdgeSoul,id:string,action:string){
  const c=choice(action);if(!c||!bench(id))return null;
  const r=ready(soul,id,c.color);if(r.no)return r.no;
  const p=h.model.worldPose(r.at!),d=h.model.resolvedDef(r.at!.def)!,worker=d.slots.find(s=>s.id==='worker')!,cloth=d.slots.find(s=>s.id==='cloth')!,cos=Math.cos(p.yaw),sin=Math.sin(p.yaw);
  const point=(v:number[])=>({x:p.x+(v[0]*cos+v[2]*sin)*p.s,z:p.z+(-v[0]*sin+v[2]*cos)*p.s}),stand=point(worker.p),face=point(cloth.p),level=h.levelAt(stand.x,stand.z,p.y);
  if(h.engine.clearanceAtV1&&h.engine.clearanceAtV1(stand.x,stand.z,level)<.4)return{code:'object.state',reason:'There is no clear standing room at this dye board.'};
  return{summary:`Completed ten seconds dyeing the cloth ${c.color} ${c.pattern}; inspect its new finish and spent supplies.`,steps:[{verb:'stand',params:{}},{verb:'mars:walk_to',params:{x:stand.x,z:stand.z,level}},{verb:'mars:pose_v1',params:{activity:'craft',seconds:10,prop:'brush',face:[face.x,face.z]}},{verb:'stand',params:{}}]};
 }
 function onReceipt(r:EdgeReceipt){
  const m=/^object:(.+):(dye-(?:indigo|rust)-(?:solid|banded))$/.exec(r.capability);if(!m)return;
  const soul=h.soul(r.soulId),id=m[1],c=choice(m[2])!;
  if(r.phase==='started'){
   if(!soul||pending.has(r.id))return;const at=ready({soulId:soul.id,entityId:soul.entity_id,name:soul.name},id,c.color);
   if(at.cloth)pending.set(r.id,{cloth:at.cloth.id,bench:id,body:soul.entity_id,...c,dye:at.cloth.state?.dye,banded:at.cloth.state?.banded,text:at.cloth.state?.text});return;
  }
  if(!['completed','failed','replaced','aborted','cancelled'].includes(r.phase))return;
  const bound=pending.get(r.id);pending.delete(r.id);
  if(r.phase!=='completed'||!bound||bound.bench!==id||bound.color!==c.color||bound.pattern!==c.pattern||!soul||bound.body!==soul.entity_id||!Number.isSafeInteger(r.endedTick)||r.endedTick!<0)return;
  const at=ready({soulId:soul.id,entityId:soul.entity_id,name:soul.name},id,c.color);
  if(at.no||at.cloth!.id!==bound.cloth||at.cloth!.state?.dye!==bound.dye||at.cloth!.state?.banded!==bound.banded||at.cloth!.state?.text!==bound.text||at.at!.state?.lastReceipt===r.id||r.endedTick!<Number(at.at!.state?.lastCompletedTick??-1))return;
  const pos=h.engine.world.entities[soul.entity_id]?.pose?.p,p=h.model.worldPose(at.at!);
  if(!pos||Math.hypot(pos[0]-p.x,pos[2]-p.z)>ACT_REACH)return;
  const name=soul.name.slice(0,80),title=`${c.color==='indigo'?'Indigo':'Rust'} ${c.pattern} cloth`,text=`${title} dyed by ${name}.`.slice(0,160);
  const done=h.commit([
   opSchema.parse({op:'set',id,state:{[c.color]:0,water:Number(at.at!.state?.water)-1,text:`Last finish: ${c.color} ${c.pattern}, by ${name}.`.slice(0,160),lastReceipt:r.id,lastCompletedTick:r.endedTick}}),
   opSchema.parse({op:'set',id:bound.cloth,state:{dye:c.color==='indigo'?1:2,banded:c.pattern==='banded',text},about:{title,what:text}}),
  ],`${r.soulId} dyed a folded cloth`,`cloth-dyeing:${r.id}`);
  if(!done.accepted)h.log('cloth-dyeing: world refused the dye batch; cloth and supplies unchanged');
 }
 return{plan,onReceipt,facts(id:string){const e=h.model.entities.get(id);if(!e)return null;const d=h.model.resolvedDef(e.def);
  if(isCloth(d))return{dyedCloth:e.state?.dye===0?'Undyed folded cloth: choose pigment and solid or banded on a supplied dye bench.':String(e.state?.text||'Dyed folded cloth.')};
  if(isBench(d))return{clothDyeing:`Indigo ${e.state?.indigo===1?'available':'used'}, rust ${e.state?.rust===1?'available':'used'}, water ${Number(e.state?.water??0)} charges. ${e.state?.text||'Put one dyeable cloth on the board, choose color/pattern and work ten seconds with empty hands.'}`};
  return null;}};
}
export type ClothDyeing=ReturnType<typeof createClothDyeing>;
