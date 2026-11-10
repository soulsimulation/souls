// Native timing and ordinary atomic admission conserve real material; decoration only observes committed backing state.
import {opSchema,type Op,type StoredDef,type WorldModel} from '@souls/world-compiler';
import type {EdgeReceipt,EdgeSoul} from '../edge/contract.ts';
import {collagePlacement,collagePatches} from '../../../../packages/world-compiler/src/core-kit/collage.ts';
import {ACT_REACH} from './actuators.ts';
type Refusal={code:string;reason:string};
type Body={pose?:{p:number[]};support?:{kind?:string;on?:string;by?:string};human?:{holding?:unknown;hands?:unknown;handActuator?:unknown}};
export type CollageHost={model:WorldModel;engine:{world:{entities:Record<string,Body>}};levelAt(x:number,z:number,y:number):number;soul(id:string):{id:string;entity_id:string;name:string}|undefined;denied(id:string,soul:{soulId:string;entityId:string;name:string}):Refusal|null;commit(ops:Op[],note:string):{accepted:boolean};log(message:string):void};
const exact=(d:StoredDef|undefined,name:string)=>d?.name===name&&d.version===1;
const identity=(e:{def:unknown;owner?:unknown;access?:unknown;by?:unknown;params?:unknown;state?:unknown})=>[e.def,e.owner,e.access,e.by,e.params,e.state];
export function createCollage(h:CollageHost){
 const pending=new Map<string,{id:string;body:string;action:string;stamp:string}>(),seen=new Set<string>();
 function ready(soul:Pick<EdgeSoul,'soulId'|'entityId'|'name'>,id:string,action:string){
  const e=h.model.entities.get(id),recover=action==='recover-paper';if(!e||!exact(h.model.resolvedDef(e.def),recover?'core-collage-board':'core-collage-paper'))return{no:{code:'object.gone',reason:'The collage material is no longer there.'}};
  const denied=h.denied(id,soul);if(denied)return{no:denied};
  const board=recover?e:h.model.entities.get(e.in.parent),support=h.engine.world.entities[id]?.support;
  if(!board||!exact(h.model.resolvedDef(board.def),'core-collage-board')||(!recover&&(!['paper','output'].includes(e.in.slot??'')||support?.kind!=='resting-on'||support.on!==board.id)))return{no:{code:'object.state',reason:'Put source paper on the fixed collage board before mounting it.'}};
  const parentDenied=h.denied(board.id,soul);if(parentDenied)return{no:parentDenied};
  const patches=collagePatches(board.state),slot=recover?Number(board.state?.recover)-1:Array.from({length:6},(_,i)=>i).find(i=>!patches.some(p=>p.slot===i)),current=patches.find(p=>p.slot===slot),selected=recover?null:collagePlacement(e.state?.selection);
  if(recover&&(!/^[1-6]$/.test(String(board.state?.recover))||!current))return{no:{code:'object.state',reason:'Choose an occupied patch number 1..6 from current inspection.'}};
  if(!recover&&(!selected||slot===undefined))return{no:{code:'capability.params',reason:'Choose valid x,z,angle in metres/degrees and an empty patch slot. Recover material when all six slots are full.'}};
  const shape=e.state?.shape==='tall'?'tall':'wide',w=shape==='tall'?.18:.3,d=shape==='tall'?.3:.18,scale=e.s??1,c=Math.abs(Math.cos(selected?.yaw??0)),s=Math.abs(Math.sin(selected?.yaw??0));
  if(!recover&&(Math.abs(scale-1)>1e-9||Math.abs(selected!.x)+(w*c+d*s)/2>.75||Math.abs(selected!.z)+(w*s+d*c)/2>.5))return{no:{code:'object.state',reason:'Use a normal-size paper portion and keep the complete rotated paper on the board.'}};
  if(recover&&[...(h.model.children.get(board.id)??[])].some(child=>h.model.entities.get(child)?.in.slot==='output'))return{no:{code:'object.state',reason:'Pick up the recovered material from the output slot before removing another patch.'}};
  const body=h.engine.world.entities[soul.entityId],pos=body?.pose?.p;if(!body?.human||!pos)return{no:{code:'body.unavailable',reason:'Your body is unavailable.'}};
  if(body.human.holding||body.human.hands||body.human.handActuator||Object.values(h.engine.world.entities).some(x=>x.support?.kind==='in-hand'&&x.support.by===soul.entityId))return{no:{code:'object.state',reason:'Put down held items before working collage material.'}};
  const stamp=JSON.stringify([identity(e),identity(board),e.in,support,h.model.worldPose(e),h.model.worldPose(board)]);return{e,board,support,selected,slot,current,shape,stamp};
 }
 function plan(soul:EdgeSoul,id:string,action:string){if(!['mount','recover-paper'].includes(action))return null;const e=h.model.entities.get(id);if(!e||!exact(h.model.resolvedDef(e.def),action==='mount'?'core-collage-paper':'core-collage-board'))return null;const a=ready(soul,id,action);if(a.no)return a.no;const p=h.model.worldPose(a.board!),x=p.x+Math.sin(p.yaw)*1.2*p.s,z=p.z+Math.cos(p.yaw)*1.2*p.s;return{summary:'Completed finite collage material work; inspect the actual composition and recovered portions.',steps:[{verb:'stand',params:{}},{verb:'mars:walk_to',params:{x,z,level:h.levelAt(p.x,p.z,p.y)}},{verb:'mars:pose_v1',params:{activity:'craft',seconds:4,prop:'brush',face:[p.x,p.z]}},{verb:'stand',params:{}}]};}
 function onReceipt(r:EdgeReceipt){
  const m=/^object:(.+):(mount|recover-paper)$/.exec(r.capability);if(!m)return;const soul=h.soul(r.soulId),id=m[1],action=m[2];
  if(r.phase==='started'){if(!soul||pending.has(r.id)||seen.has(r.id))return;const a=ready({soulId:soul.id,entityId:soul.entity_id,name:soul.name},id,action);if(a.e)pending.set(r.id,{id,body:soul.entity_id,action,stamp:a.stamp!});return;}
  if(!['completed','failed','replaced','aborted','cancelled'].includes(r.phase))return;const b=pending.get(r.id);pending.delete(r.id);if(r.phase!=='completed'||!b||b.id!==id||b.action!==action||!soul||b.body!==soul.entity_id||seen.has(r.id)||!Number.isSafeInteger(r.endedTick)||r.endedTick!<0)return;
  const a=ready({soulId:soul.id,entityId:soul.entity_id,name:soul.name},id,action);if(a.no||a.stamp!==b.stamp||a.board!.state?.lastReceipt===r.id||r.endedTick!<Number(a.board!.state?.lastCompletedTick??-1))return;
  const pos=h.engine.world.entities[soul.entity_id]?.pose?.p,p=h.model.worldPose(a.board!);if(!pos||Math.hypot(pos[0]-p.x,pos[2]-p.z)>ACT_REACH||h.levelAt(pos[0],pos[2],pos[1])!==h.levelAt(p.x,p.z,p.y))return;
  const remove=action==='recover-paper',maker=soul.name.slice(0,80),state:Record<string,unknown>={lastReceipt:r.id,lastCompletedTick:r.endedTick};
  for(const key of ['x','z','yaw','shape','colour','maker'])state[`p${a.slot}${key}`]=remove?(key==='colour'?'none':key==='shape'?'wide':key==='maker'?'':0):key==='shape'?a.shape!:key==='colour'?String(a.e!.state?.colour):key==='maker'?maker:a.selected![key as 'x'|'z'|'yaw'];
  const material:Op=remove?opSchema.parse({op:'place',def:'core/collage-paper@1',name:'recovered-collage-paper',in:{parent:a.board!.id,slot:'output'},p:[0,0],state:{colour:a.current!.colour,shape:a.current!.shape},about:{title:'Recovered collage material',what:`One real material portion recovered by ${maker}; originally mounted by ${a.current!.maker}. Not the original paper identity.`},...(a.board!.owner?{owner:a.board!.owner}:{}),...(a.board!.access?{access:a.board!.access}:{})}):opSchema.parse({op:'remove',id,cascade:false});
  const done=h.commit([material,opSchema.parse({op:'set',id:a.board!.id,state})],`${r.soulId} worked finite collage material`);if(done.accepted)seen.add(r.id);else h.log('collage: atomic material transfer refused; source and backing unchanged');
 }
 return{plan,onReceipt,facts(id:string){const e=h.model.entities.get(id),d=e&&h.model.resolvedDef(e.def);if(!e||!d)return null;if(exact(d,'core-collage-board'))return{collage:collagePatches(e.state).map(p=>`${p.slot+1}: ${p.shape} ${p.colour} at ${p.x},${p.z},${Math.round(p.yaw*180/Math.PI)} degrees by ${p.maker}`).join('; ')||'No mounted material.',collageRequirements:'Fixed real board; six patch slots, actual source paper on its surface, empty hands and permission. Four seconds native work consumes a source portion; selected removal recovers material on the clear output surface, not its old ID.'};if(!exact(d,'core-collage-paper'))return null;return{collage:`Real ${String(e.state?.colour??'red')} ${String(e.state?.shape??'wide')} paper portion. Selected ${String(e.state?.selection)}. Mount consumes this actual portion into the board; recovery later creates a real matching portion without preserving its ID.`};}};
}
export type Collage=ReturnType<typeof createCollage>;
