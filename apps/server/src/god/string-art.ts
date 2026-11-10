// Existing native craft owns time; completed work edits the same board and conserved finite strands.
import {opSchema,type Op,type StoredDef,type WorldModel} from '@souls/world-compiler';
import type {EdgeReceipt,EdgeSoul} from '../edge/contract.ts';
import {ACT_REACH} from './actuators.ts';
type Refusal={code:string;reason:string};
type Body={pose?:{p:number[]};support?:{kind?:string;on?:string;by?:string};human?:{holding?:unknown;hands?:unknown;handActuator?:unknown}};
type Approach=(id:string,soul:EdgeSoul,front:[number,number]|null,radius?:number)=>{p:[number,number];level:number}|null;
export type StringArtHost={model:WorldModel;engine:{world:{entities:Record<string,Body>}};levelAt(x:number,z:number,y:number):number;soul(id:string):{id:string;entity_id:string;name:string}|undefined;denied(id:string,soul:{soulId:string;entityId:string;name:string}):Refusal|null;commit(ops:Op[],note:string,clientRef:string):{accepted:boolean};log(message:string):void};
const paths=['ab','ac','ad','bc','bd','cd'],colours=['red','blue','gold'];
const exact=(d:StoredDef|undefined)=>d?.name==='core-string-art-board'&&d.version===1;
const stamp=(s:Record<string,unknown>|undefined)=>JSON.stringify(['from','to','colour',...paths,...colours].map(k=>s?.[k]));
export function createStringArt(h:StringArtHost){
 const pending=new Map<string,{board:string;body:string;action:string;state:string;support:string;pose:string}>();
 const board=(id:string)=>{const e=h.model.entities.get(id);return e&&exact(h.model.resolvedDef(e.def))?e:null;};
 function ready(soul:Pick<EdgeSoul,'soulId'|'entityId'|'name'>,id:string,action:string){
  const e=board(id);if(!e)return{no:{code:'object.gone',reason:'The string-art board is no longer there.'}};
  const denied=h.denied(id,soul);if(denied)return{no:denied};
  const from=String(e.state?.from??''),to=String(e.state?.to??''),colour=String(e.state?.colour??''),path=[from,to].sort().join('').toLowerCase(),colourIndex=colours.indexOf(colour)+1;
  if(!paths.includes(path)||from===to||!colourIndex)return{no:{code:'object.state',reason:'Choose two different pegs A/B/C/D and red, blue or gold first.'}};
  const current=e.state?.[path];if(!Number.isSafeInteger(current)||Number(current)<0||Number(current)>3)return{no:{code:'object.state',reason:'The selected connection state is invalid.'}};
  const stock=Number(e.state?.[action==='unstring-path'?colours[Number(current)-1]:colour]);
  if(action==='string-path'&&current!==0)return{no:{code:'object.state',reason:'That path already has a strand; unstring it before replacing it.'}};
  if(action==='string-path'&&(!Number.isSafeInteger(stock)||stock<1))return{no:{code:'object.state',reason:`No ${colour} strands remain; unstring one of that colour to reuse it.`}};
  if(action==='unstring-path'&&(current===0||!Number.isSafeInteger(stock)||stock>=2))return{no:{code:'object.state',reason:'The selected path has no reusable strand.'}};
  const support=h.engine.world.entities[id]?.support,parent=h.model.entities.get(e.in.parent);
  if(!parent||support?.kind!=='resting-on'||support.on!==parent.id||!e.in.slot||!h.model.resolvedDef(parent.def)?.slots.some(s=>s.id===e.in.slot&&s.kind==='surface'))return{no:{code:'object.state',reason:'Put the board on a real admitted work surface before stringing or unstringing.'}};
  const parentDenied=h.denied(parent.id,soul);if(parentDenied)return{no:parentDenied};
  const body=h.engine.world.entities[soul.entityId],pos=body?.pose?.p,p=h.model.worldPose(e);
  if(!body?.human||!pos)return{no:{code:'body.unavailable',reason:'Your body is unavailable.'}};
  if(body.human.holding||body.human.hands||body.human.handActuator||Object.values(h.engine.world.entities).some(x=>x.support?.kind==='in-hand'&&x.support.by===soul.entityId))return{no:{code:'object.state',reason:'Put down what you are holding before working the string-art board.'}};
  if(h.levelAt(pos[0],pos[2],pos[1])!==h.levelAt(p.x,p.z,p.y))return{no:{code:'object.state',reason:'Reach the same floor as the board first.'}};
  return{e,parent,support,path,colour,colourIndex,current:Number(current),stock};
 }
 function plan(soul:EdgeSoul,id:string,action:string,approach:Approach){
  if(!['string-path','unstring-path'].includes(action)||!board(id))return null;
  const a=ready(soul,id,action);if(a.no)return a.no;
  const p=h.model.worldPose(a.e!),front:[number,number]=[p.x+Math.sin(p.yaw)*.7,p.z+Math.cos(p.yaw)*.7],stand=approach(id,soul,front,1.5);
  if(!stand)return{code:'object.state',reason:'No ordinary reachable standing point is available beside this board.'};
  return{summary:`Completed ten seconds ${action==='string-path'?'stringing':'unstringing'} the selected path; inspect the actual connections and remaining strands.`,steps:[{verb:'stand',params:{}},{verb:'mars:walk_to',params:{x:stand.p[0],z:stand.p[1],level:stand.level}},{verb:'mars:pose_v1',params:{activity:'craft',seconds:10,prop:'tool',face:[p.x,p.z]}},{verb:'stand',params:{}}]};
 }
 function onReceipt(r:EdgeReceipt){
  const m=/^object:(.+):(string-path|unstring-path)$/.exec(r.capability);if(!m)return;const soul=h.soul(r.soulId),id=m[1],action=m[2];
  if(r.phase==='started'){
   if(!soul||pending.has(r.id))return;const a=ready({soulId:soul.id,entityId:soul.entity_id,name:soul.name},id,action);
   if(a.e)pending.set(r.id,{board:id,body:soul.entity_id,action,state:stamp(a.e.state),support:JSON.stringify([a.e.in,a.support]),pose:JSON.stringify([h.model.worldPose(a.e),h.model.worldPose(a.parent!)])});return;
  }
  if(!['completed','failed','replaced','aborted','cancelled'].includes(r.phase))return;const bound=pending.get(r.id);pending.delete(r.id);
  if(r.phase!=='completed'||!bound||bound.board!==id||bound.action!==action||!soul||bound.body!==soul.entity_id||!Number.isSafeInteger(r.endedTick)||r.endedTick!<0)return;
  const a=ready({soulId:soul.id,entityId:soul.entity_id,name:soul.name},id,action);
  if(a.no||stamp(a.e!.state)!==bound.state||JSON.stringify([a.e!.in,a.support])!==bound.support||JSON.stringify([h.model.worldPose(a.e!),h.model.worldPose(a.parent!)])!==bound.pose||a.e!.state?.lastReceipt===r.id||r.endedTick!<Number(a.e!.state?.lastCompletedTick??-1))return;
  const pos=h.engine.world.entities[soul.entity_id]?.pose?.p,p=h.model.worldPose(a.e!);if(!pos||Math.hypot(pos[0]-p.x,pos[2]-p.z)>ACT_REACH)return;
  const remove=action==='unstring-path',colour=remove?colours[a.current!-1]:a.colour!,by=soul.name.slice(0,80);
  const done=h.commit([opSchema.parse({op:'set',id,state:{[a.path!]:remove?0:a.colourIndex,[colour]:a.stock!+(remove?1:-1),lastReceipt:r.id,lastCompletedTick:r.endedTick},about:{title:'String-art composition',what:`${remove?'Unstrung':'Strung'} ${a.path!.toUpperCase()} in ${colour}, by ${by}. Inspect actual current connections and remaining strands.`}})],`${r.soulId} worked string art`,`string-art:${r.id}`);
  if(!done.accepted)h.log('string art: world refused the batch; composition and strands unchanged');
 }
 return{plan,onReceipt,facts(id:string){const e=board(id);if(!e)return null;return{stringArt:`Connections: ${paths.filter(k=>Number(e.state?.[k])>0).map(k=>`${k.toUpperCase()} ${colours[Number(e.state?.[k])-1]}`).join(', ')||'none'}. Strands left: ${colours.map(k=>`${k} ${Number(e.state?.[k]??0)}`).join(', ')}. Selected ${String(e.state?.from)}–${String(e.state?.to)} ${String(e.state?.colour)}.`,stringArtRequirements:'Pegs A/B/C/D: rear-left/rear-right/front-right/front-left. Choose a path; put this board on an admitted work surface. Empty hands, same floor, ten seconds native craft; unstring a path to recover its actual colour strand.'};}};
}
export type StringArt=ReturnType<typeof createStringArt>;
