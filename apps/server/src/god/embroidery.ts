// Native completed work changes the same cloth and conserves abstract reusable thread units.
import {opSchema,type Op,type StoredDef,type WorldModel} from '@souls/world-compiler';
import type {EdgeReceipt,EdgeSoul} from '../edge/contract.ts';
import {embroideryStitches,stitchSelection,THREAD_COLOURS} from '../../../../packages/world-compiler/src/core-kit/embroidery.ts';
import {ACT_REACH} from './actuators.ts';
type Refusal={code:string;reason:string};
type Body={pose?:{p:number[]};support?:{kind?:string;on?:string;by?:string};human?:{holding?:unknown;hands?:unknown;handActuator?:unknown}};
type Approach=(id:string,soul:EdgeSoul,front:[number,number]|null,radius?:number)=>{p:[number,number];level:number}|null;
export type EmbroideryHost={model:WorldModel;engine:{world:{entities:Record<string,Body>}};levelAt(x:number,z:number,y:number):number;soul(id:string):{id:string;entity_id:string;name:string}|undefined;denied(id:string,soul:{soulId:string;entityId:string;name:string}):Refusal|null;commit(ops:Op[],note:string):{accepted:boolean};log(message:string):void};

const exact=(d:StoredDef|undefined)=>d?.name==='core-embroidery-hoop'&&d.version===1;
const identity=(e:{def:unknown;owner?:unknown;access?:unknown;by?:unknown})=>[e.def,e.owner,e.access,e.by];
const stamp=(s:Record<string,unknown>|undefined)=>JSON.stringify(s);
export function createEmbroidery(h:EmbroideryHost){
 const pending=new Map<string,{id:string;body:string;action:string;state:string;support:string;pose:string;identity:string}>(),seen=new Set<string>();
 const hoop=(id:string)=>{const e=h.model.entities.get(id);return e&&exact(h.model.resolvedDef(e.def))?e:null;};
 function ready(soul:Pick<EdgeSoul,'soulId'|'entityId'|'name'>,id:string,action:string){
  const e=hoop(id);if(!e)return{no:{code:'object.gone',reason:'The embroidery hoop is no longer there.'}};
  const denied=h.denied(id,soul);if(denied)return{no:denied};
  const stitches=embroideryStitches(e.state),selected=stitchSelection(e.state?.selection),index=Number(e.state?.erase)-1,current=stitches.find(s=>s.slot===index);
  if(action==='stitch'&&!selected)return{no:{code:'capability.params',reason:'Choose x1,z1 x2,z2 red/blue/gold inside radius 0.19 metres, at least 0.025 metres apart.'}};
  if(action==='stitch'&&(stitches.length>=6||!Number.isSafeInteger(e.state?.[selected!.colour])||Number(e.state?.[selected!.colour])<1))return{no:{code:'object.state',reason:'The cloth is full or that thread colour is spent. Unpick an actual stitch to reuse its thread.'}};
  if(action==='unpick'&&(!/^[1-6]$/.test(String(e.state?.erase))||!current||Number(e.state?.[current.colour])>=3))return{no:{code:'object.state',reason:'Choose an occupied stitch slot 1..6 from inspection.'}};
  const support=h.engine.world.entities[id]?.support,parent=h.model.entities.get(e.in.parent);
  if(!parent||support?.kind!=='resting-on'||support.on!==parent.id||!e.in.slot||!h.model.slotsOf(parent).some(s=>s.id===e.in.slot&&s.kind==='surface')||h.model.resolvedDef(parent.def)?.components.carryable)return{no:{code:'object.state',reason:'Put the hoop on a real fixed work surface before stitching or unpicking.'}};
  const parentDenied=h.denied(parent.id,soul);if(parentDenied)return{no:parentDenied};
  const body=h.engine.world.entities[soul.entityId],pos=body?.pose?.p;
  if(!body?.human||!pos)return{no:{code:'body.unavailable',reason:'Your body is unavailable.'}};
  if(body.human.holding||body.human.hands||body.human.handActuator||Object.values(h.engine.world.entities).some(x=>x.support?.kind==='in-hand'&&x.support.by===soul.entityId))return{no:{code:'object.state',reason:'Put down held items before embroidery work.'}};
  return{e,parent,support,selected,current,stitches};
 }
 function plan(soul:EdgeSoul,id:string,action:string,approach:Approach){
  if(!['stitch','unpick'].includes(action)||!hoop(id))return null;const a=ready(soul,id,action);if(a.no)return a.no;
  const p=h.model.worldPose(a.e!),front:[number,number]=[p.x+Math.sin(p.yaw),p.z+Math.cos(p.yaw)],stand=approach(id,soul,front,1.5);if(!stand)return{code:'object.state',reason:'No ordinary reachable standing point is available beside this hoop.'};
  return{summary:'Completed four seconds of embroidery hand work; inspect actual stitches and reusable thread.',steps:[{verb:'stand',params:{}},{verb:'mars:walk_to',params:{x:stand.p[0],z:stand.p[1],level:stand.level}},{verb:'mars:pose_v1',params:{activity:'craft',seconds:4,prop:'brush',face:[p.x,p.z]}},{verb:'stand',params:{}}]};
 }
 function onReceipt(r:EdgeReceipt){
  const m=/^object:(.+):(stitch|unpick)$/.exec(r.capability);if(!m)return;const soul=h.soul(r.soulId),id=m[1],action=m[2];
  if(r.phase==='started'){if(!soul||pending.has(r.id)||seen.has(r.id))return;const a=ready({soulId:soul.id,entityId:soul.entity_id,name:soul.name},id,action);if(a.e)pending.set(r.id,{id,body:soul.entity_id,action,state:stamp(a.e.state),support:JSON.stringify([a.e.in,a.support]),pose:JSON.stringify([h.model.worldPose(a.e),h.model.worldPose(a.parent!)]),identity:JSON.stringify([identity(a.e),identity(a.parent!)])});return;}
  if(!['completed','failed','replaced','aborted','cancelled'].includes(r.phase))return;const bound=pending.get(r.id);pending.delete(r.id);
  if(r.phase!=='completed'||!bound||bound.id!==id||bound.action!==action||!soul||bound.body!==soul.entity_id||seen.has(r.id)||!Number.isSafeInteger(r.endedTick)||r.endedTick!<0)return;
  const a=ready({soulId:soul.id,entityId:soul.entity_id,name:soul.name},id,action);if(a.no||JSON.stringify([identity(a.e!),identity(a.parent!)])!==bound.identity||stamp(a.e!.state)!==bound.state||JSON.stringify([a.e!.in,a.support])!==bound.support||JSON.stringify([h.model.worldPose(a.e!),h.model.worldPose(a.parent!)])!==bound.pose||a.e!.state?.lastReceipt===r.id||r.endedTick!<Number(a.e!.state?.lastCompletedTick??-1))return;
  const pos=h.engine.world.entities[soul.entity_id]?.pose?.p,p=h.model.worldPose(a.e!);if(!pos||Math.hypot(pos[0]-p.x,pos[2]-p.z)>ACT_REACH||h.levelAt(pos[0],pos[2],pos[1])!==h.levelAt(p.x,p.z,p.y))return;
  const remove=action==='unpick',slot=remove?a.current!.slot:Array.from({length:6},(_,i)=>i).find(i=>!a.stitches!.some(s=>s.slot===i))!,colour=remove?a.current!.colour:a.selected!.colour;
  const state:Record<string,unknown>={[colour]:Number(a.e!.state?.[colour])+(remove?1:-1),lastReceipt:r.id,lastCompletedTick:r.endedTick};
  for(const k of ['x1','z1','x2','z2'] as const)state[`s${slot}${k}`]=remove?0:a.selected![k];state[`s${slot}colour`]=remove?'none':colour;state[`s${slot}maker`]=remove?'':soul.name.slice(0,80);
  const done=h.commit([opSchema.parse({op:'set',id,state,about:{title:'Embroidered cloth',what:`Same portable cloth; ${remove?'unpicked':'stitched'} ${colour} thread by ${soul.name.slice(0,80)}. Inspect current free-coordinate stitches and remaining reusable thread.`}})],`${r.soulId} worked embroidery`);if(done.accepted)seen.add(r.id);else h.log('embroidery: world refused batch; cloth and thread unchanged');
 }
 return{plan,onReceipt,facts(id:string){const e=hoop(id);if(!e)return null;return{embroidery:embroideryStitches(e.state).map(s=>`${s.slot+1}: ${s.x1},${s.z1} to ${s.x2},${s.z2} ${s.colour}, by ${s.maker}`).join('; ')||'No current stitches.',threadRemaining:THREAD_COLOURS.map(c=>`${c} ${e.state?.[c]}`).join(', '),embroideryRequirements:'Fixed admitted work surface, empty hands; four seconds native work. Choose free endpoints inside radius 0.19m, red/blue/gold. Six stitch slots; unpick returns the actual colour unit. Abstract reusable units, no thread-length simulation.'};}};
}
export type Embroidery=ReturnType<typeof createEmbroidery>;
