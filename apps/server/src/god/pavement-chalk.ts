// Completion-only drawing on one real ground patch. The viewer observes this same bounded composition.
import {opSchema,type Op,type StoredDef,type WorldModel} from '@souls/world-compiler';
import {chalkLines,CHALK_COLOURS,type ChalkLine} from '../../../../packages/world-compiler/src/core-kit/pavement-chalk.ts';
import type {EdgeReceipt,EdgeSoul} from '../edge/contract.ts';
import {ACT_REACH} from './actuators.ts';
type Refusal={code:string;reason:string};
type Body={pose?:{p:number[]};support?:{kind?:string;on?:string;by?:string};human?:{holding?:unknown;hands?:unknown;handActuator?:unknown}};
type Approach=(id:string,soul:EdgeSoul,front:[number,number]|null,radius?:number)=>{p:[number,number];level:number}|null;
export type PavementChalkHost={model:WorldModel;engine:{world:{entities:Record<string,Body>}};levelAt(x:number,z:number,y:number):number;soul(id:string):{id:string;entity_id:string;name:string}|undefined;denied(id:string,soul:{soulId:string;entityId:string;name:string}):Refusal|null;commit(ops:Op[],note:string,clientRef:string):{accepted:boolean};log(message:string):void};
const exact=(d:StoredDef|undefined)=>d?.name==='core-pavement-lines'&&d.version===1;
const stamp=(s:Record<string,unknown>|undefined)=>JSON.stringify(['lines','selection','erase',...CHALK_COLOURS].map(k=>s?.[k]));
export function selectedChalkLine(value:unknown):Omit<ChalkLine,'maker'>|null {
 if(typeof value!=='string')return null;const m=/^\s*([+-]?(?:\d+(?:\.\d*)?|\.\d+)),\s*([+-]?(?:\d+(?:\.\d*)?|\.\d+))\s+([+-]?(?:\d+(?:\.\d*)?|\.\d+)),\s*([+-]?(?:\d+(?:\.\d*)?|\.\d+))\s+(red|blue|yellow)\s*$/i.exec(value);if(!m)return null;
 const s={x1:Number(m[1]),z1:Number(m[2]),x2:Number(m[3]),z2:Number(m[4]),colour:m[5].toLowerCase() as ChalkLine['colour']};return chalkLines(JSON.stringify([{...s,maker:''}]))?s:null;
}
export function createPavementChalk(h:PavementChalkHost){
 const pending=new Map<string,{patch:string;body:string;action:string;state:string;support:string;pose:string}>();
 const patch=(id:string)=>{const e=h.model.entities.get(id);return e&&exact(h.model.resolvedDef(e.def))?e:null;};
 function ready(soul:Pick<EdgeSoul,'soulId'|'entityId'|'name'>,id:string,action:string){
  const e=patch(id);if(!e)return{no:{code:'object.gone',reason:'The pavement patch is no longer there.'}};const denied=h.denied(id,soul);if(denied)return{no:denied};
  const lines=chalkLines(e.state?.lines);if(!lines)return{no:{code:'object.state',reason:'The stored chalk composition is invalid.'}};
  const selected=selectedChalkLine(e.state?.selection),index=Number(e.state?.erase)-1;
  if(action==='draw-line'&&!selected)return{no:{code:'capability.params',reason:'Choose x1,z1 x2,z2 red/blue/yellow; coordinates -0.45..0.45 metres and a line at least3cm long.'}};
  if(action==='draw-line'&&(lines.length>=8||!Number.isSafeInteger(e.state?.[selected!.colour])||Number(e.state?.[selected!.colour])<1))return{no:{code:'object.state',reason:'The patch is full or that chalk colour is spent. Erase a mark for room; erasing does not restore chalk.'}};
  if(action==='erase-stroke'&&(!/^[1-8]$/.test(String(e.state?.erase))||!lines[index]))return{no:{code:'object.state',reason:'Choose an actual current stroke number from inspection.'}};
  const support=h.engine.world.entities[id]?.support;if(e.in.parent!=='world'||support?.kind!=='ground')return{no:{code:'object.state',reason:'The pavement patch must rest on real ground.'}};
  const body=h.engine.world.entities[soul.entityId],pos=body?.pose?.p,p=h.model.worldPose(e);
  if(!body?.human||!pos)return{no:{code:'body.unavailable',reason:'Your body is unavailable.'}};
  if(body.human.holding||body.human.hands||body.human.handActuator||Object.values(h.engine.world.entities).some(x=>x.support?.kind==='in-hand'&&x.support.by===soul.entityId))return{no:{code:'object.state',reason:'Put down held items before drawing or erasing.'}};
  if(h.levelAt(pos[0],pos[2],pos[1])!==h.levelAt(p.x,p.z,p.y))return{no:{code:'object.state',reason:'Reach the same floor as the pavement first.'}};
  return{e,lines,selected,index,support};
 }
 function plan(soul:EdgeSoul,id:string,action:string,approach:Approach){
  if(!['draw-line','erase-stroke'].includes(action)||!patch(id))return null;const a=ready(soul,id,action);if(a.no)return a.no;
  const p=h.model.worldPose(a.e!),front:[number,number]=[p.x+Math.sin(p.yaw),p.z+Math.cos(p.yaw)],stand=approach(id,soul,front,1.5);if(!stand)return{code:'object.state',reason:'No ordinary reachable standing point is available beside the pavement.'};
  return{summary:`Completed four seconds ${action==='draw-line'?'drawing the selected line':'erasing only the selected current stroke'}; inspect the actual composition.`,steps:[{verb:'stand',params:{}},{verb:'mars:walk_to',params:{x:stand.p[0],z:stand.p[1],level:stand.level}},{verb:'mars:pose_v1',params:{activity:'garden',seconds:4,prop:'tool',face:[p.x,p.z]}},{verb:'stand',params:{}}]};
 }
 function onReceipt(r:EdgeReceipt){
  const m=/^object:(.+):(draw-line|erase-stroke)$/.exec(r.capability);if(!m)return;const soul=h.soul(r.soulId),id=m[1],action=m[2];
  if(r.phase==='started'){if(!soul||pending.has(r.id))return;const a=ready({soulId:soul.id,entityId:soul.entity_id,name:soul.name},id,action);if(a.e)pending.set(r.id,{patch:id,body:soul.entity_id,action,state:stamp(a.e.state),support:JSON.stringify([a.e.in,a.support]),pose:JSON.stringify(h.model.worldPose(a.e))});return;}
  if(!['completed','failed','replaced','aborted','cancelled'].includes(r.phase))return;const bound=pending.get(r.id);pending.delete(r.id);
  if(r.phase!=='completed'||!bound||bound.patch!==id||bound.action!==action||!soul||bound.body!==soul.entity_id||!Number.isSafeInteger(r.endedTick)||r.endedTick!<0)return;
  const a=ready({soulId:soul.id,entityId:soul.entity_id,name:soul.name},id,action);if(a.no||stamp(a.e!.state)!==bound.state||JSON.stringify([a.e!.in,a.support])!==bound.support||JSON.stringify(h.model.worldPose(a.e!))!==bound.pose||a.e!.state?.lastReceipt===r.id||r.endedTick!<Number(a.e!.state?.lastCompletedTick??-1))return;
  const pos=h.engine.world.entities[soul.entity_id]?.pose?.p,p=h.model.worldPose(a.e!);if(!pos||Math.hypot(pos[0]-p.x,pos[2]-p.z)>ACT_REACH)return;
  const lines=[...a.lines!],state:Record<string,unknown>={lastReceipt:r.id,lastCompletedTick:r.endedTick};if(action==='draw-line'){lines.push({...a.selected!,maker:soul.name.slice(0,80)});state[a.selected!.colour]=Number(a.e!.state?.[a.selected!.colour])-1;}else lines.splice(a.index!,1);state.lines=JSON.stringify(lines);
  const done=h.commit([opSchema.parse({op:'set',id,state})],`${r.soulId} ${action} on pavement`,`pavement-chalk:${r.id}`);if(!done.accepted)h.log('pavement chalk: world refused batch; drawing and chalk unchanged');
 }
 return{plan,onReceipt,facts(id:string){const e=patch(id);if(!e)return null;const lines=chalkLines(e.state?.lines);return{pavementChalk:lines?lines.map((s,i)=>`${i+1}: ${s.x1},${s.z1} to ${s.x2},${s.z2} ${s.colour}, by ${s.maker}`).join('; ')||'No current strokes.':'Invalid stored composition.',chalkRemaining:CHALK_COLOURS.map(c=>`${c} ${e.state?.[c]}`).join(', '),chalkRequirements:'Real grounded patch; empty hands, same floor, four seconds native ground-work. Choose text: x1,z1 x2,z2 red/blue/yellow, coordinates -0.45..0.45 metres. Up to8 current strokes; choose-stroke current number to erase. Erasing shifts later numbers and does not restore chalk.',chalkSelection:String(e.state?.selection),chalkErase:String(e.state?.erase)};}};
}
export type PavementChalk=ReturnType<typeof createPavementChalk>;
