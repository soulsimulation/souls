// Native craft owns time; ordinary atomic God admission owns both actual paper pieces.
import {opSchema,type Op,type StoredDef,type WorldModel} from '@souls/world-compiler';
import type {EdgeReceipt,EdgeSoul} from '../edge/contract.ts';
import {ACT_REACH} from './actuators.ts';
type Refusal={code:string;reason:string};
type Body={pose?:{p:number[]};support?:{kind?:string;on?:string;by?:string};human?:{holding?:unknown;hands?:unknown;handActuator?:unknown}};
type Approach=(id:string,soul:EdgeSoul,front:[number,number]|null,radius?:number)=>{p:[number,number];level:number}|null;
export type PaperCuttingHost={model:WorldModel;engine:{world:{entities:Record<string,Body>}};levelAt(x:number,z:number,y:number):number;soul(id:string):{id:string;entity_id:string;name:string}|undefined;denied(id:string,soul:{soulId:string;entityId:string;name:string}):Refusal|null;commit(ops:Op[],note:string,clientRef:string):{accepted:boolean};log(message:string):void};
const exact=(d:StoredDef|undefined)=>d?.name==='core-cutting-sheet'&&d.version===1;
export function createPaperCutting(h:PaperCuttingHost){
 const pending=new Map<string,{id:string;body:string;division:string;stamp:string;support:string;pose:string}>();
 const sheet=(id:string)=>{const e=h.model.entities.get(id);return e&&exact(h.model.resolvedDef(e.def))?e:null;};
 function ready(soul:Pick<EdgeSoul,'soulId'|'entityId'|'name'>,id:string){
  const e=sheet(id);if(!e)return{no:{code:'object.gone',reason:'The paper sheet is no longer there.'}};
  const denied=h.denied(id,soul);if(denied)return{no:denied};
  const division=String(e.state?.division);if(e.state?.part!=='whole'||!['quarter','half','three-quarter'].includes(division))return{no:{code:'object.state',reason:'Choose an uncut sheet and a supported division first.'}};
  const support=h.engine.world.entities[id]?.support,parent=h.model.entities.get(e.in.parent),pd=parent&&h.model.resolvedDef(parent.def);
  if(!parent||pd?.components?.carryable||support?.kind!=='resting-on'||support.on!==parent.id||!e.in.slot||!h.model.slotsOf(parent).some(s=>s.id===e.in.slot&&s.kind==='surface'))return{no:{code:'object.state',reason:'Put the sheet on an admitted fixed work surface with room beside it.'}};
  const parentDenied=h.denied(parent.id,soul);if(parentDenied)return{no:parentDenied};
  const body=h.engine.world.entities[soul.entityId],pos=body?.pose?.p,p=h.model.worldPose(e),pp=h.model.worldPose(parent);
  if(!body?.human||!pos)return{no:{code:'body.unavailable',reason:'Your body is unavailable.'}};
  if(body.human.holding||body.human.hands||body.human.handActuator||Object.values(h.engine.world.entities).some(x=>x.support?.kind==='in-hand'&&x.support.by===soul.entityId))return{no:{code:'object.state',reason:'Put down what you are holding before cutting paper.'}};
  if(h.levelAt(pos[0],pos[2],pos[1])!==h.levelAt(p.x,p.z,p.y))return{no:{code:'object.state',reason:'Reach the same floor as the paper first.'}};
  // World offset along the sheet's right; convert once to the actual fixed parent's local surface coordinates.
  const wx=p.x+.55*p.s*Math.cos(p.yaw),wz=p.z-.55*p.s*Math.sin(p.yaw),dx=(wx-pp.x)/pp.s,dz=(wz-pp.z)/pp.s;
  const slot=h.model.slotsOf(parent).find(s=>s.id===e.in.slot)!,out:[number,number]=[dx*Math.cos(pp.yaw)-dz*Math.sin(pp.yaw)-slot.p[0],dx*Math.sin(pp.yaw)+dz*Math.cos(pp.yaw)-slot.p[2]];
  if([...(h.model.children.get(parent.id)??[])].some(child=>{if(child===id)return false;const e=h.model.entities.get(child);if(!e||e.in.slot!==sheet(id)?.in.slot)return false;const q=h.model.worldPose(e);return Math.hypot(q.x-wx,q.z-wz)<.32;}))return{no:{code:'object.state',reason:'Clear the output room 55 cm to the right of the paper first.'}};
  return{e,parent,support,division,out};
 }
 function plan(soul:EdgeSoul,id:string,action:string,approach:Approach){
  if(action!=='cut-paper'||!sheet(id))return null;const a=ready(soul,id);if(a.no)return a.no;
  const p=h.model.worldPose(a.e!),stand=approach(id,soul,[p.x+Math.sin(p.yaw)*.7,p.z+Math.cos(p.yaw)*.7],1.5);
  if(!stand)return{code:'object.state',reason:'No ordinary reachable standing point is available beside the sheet.'};
  return{summary:'Completed cutting paper; inspect and rearrange both actual paper pieces.',steps:[{verb:'stand',params:{}},{verb:'mars:walk_to',params:{x:stand.p[0],z:stand.p[1],level:stand.level}},{verb:'mars:pose_v1',params:{activity:'craft',seconds:4,prop:'tool',face:[p.x,p.z]}},{verb:'stand',params:{}}]};
 }
 function onReceipt(r:EdgeReceipt){
  const m=/^object:(.+):cut-paper$/.exec(r.capability);if(!m)return;const soul=h.soul(r.soulId),id=m[1];
  if(r.phase==='started'){if(!soul||pending.has(r.id))return;const a=ready({soulId:soul.id,entityId:soul.entity_id,name:soul.name},id);if(a.e)pending.set(r.id,{id,body:soul.entity_id,division:a.division!,stamp:JSON.stringify([a.e.state,a.e.params,a.e.owner,a.e.access]),support:JSON.stringify([a.e.in,a.support]),pose:JSON.stringify([h.model.worldPose(a.e),h.model.worldPose(a.parent!)])});return;}
  if(!['completed','failed','replaced','aborted','cancelled'].includes(r.phase))return;const b=pending.get(r.id);pending.delete(r.id);
  if(r.phase!=='completed'||!b||b.id!==id||!soul||b.body!==soul.entity_id||!Number.isSafeInteger(r.endedTick)||r.endedTick!<0)return;
  const a=ready({soulId:soul.id,entityId:soul.entity_id,name:soul.name},id);if(a.no||a.division!==b.division||JSON.stringify([a.e!.state,a.e!.params,a.e!.owner,a.e!.access])!==b.stamp||JSON.stringify([a.e!.in,a.support])!==b.support||JSON.stringify([h.model.worldPose(a.e!),h.model.worldPose(a.parent!)])!==b.pose||a.e!.state?.lastReceipt===r.id||r.endedTick!<Number(a.e!.state?.lastCompletedTick??-1))return;
  const pos=h.engine.world.entities[soul.entity_id]?.pose?.p,p=h.model.worldPose(a.e!);if(!pos||Math.hypot(pos[0]-p.x,pos[2]-p.z)>ACT_REACH)return;
  const other=a.division==='quarter'?'three-quarter':a.division==='three-quarter'?'quarter':'half',maker=soul.name.slice(0,80),origin=id.slice(0,80);
  const done=h.commit([opSchema.parse({op:'set',id,state:{part:a.division,maker,origin,lastReceipt:r.id,lastCompletedTick:r.endedTick}}),opSchema.parse({op:'place',def:'core/paper-piece@1',name:'cut-paper-piece',in:{parent:a.parent!.id,slot:a.e!.in.slot},p:a.out,r:a.e!.r,s:a.e!.s,mode:'strict',params:a.e!.params,state:{part:other,maker,origin},about:{title:'Cut paper piece',what:`Cut by ${maker} from ${(a.e!.name??'paper sheet').slice(0,80)}; complementary ${other} width. Real portable paper for independent arrangement.`},...(a.e!.owner?{owner:a.e!.owner}:{}),...(a.e!.access?{access:a.e!.access}:{})})],`${r.soulId} cut paper`,`paper-cutting:${r.id}`);
  if(!done.accepted)h.log('paper cutting: world refused atomic material subdivision; original sheet unchanged');
 }
 return{plan,onReceipt,facts(id:string){const e=h.model.entities.get(id),d=e&&h.model.resolvedDef(e.def);if(!e||!d||!['core-cutting-sheet','core-paper-piece'].includes(d.name)||d.version!==1)return null;const part=String(e.state?.part??'whole'),width=part==='whole'?60:part==='quarter'?15:part==='half'?30:45;return{paperCutting:`${width} by40cm paper; ${part}. ${e.state?.maker?'Cut by '+String(e.state.maker)+', source '+String(e.state.origin)+'.':'Uncut supplied sheet.'} ${exact(d)&&part==='whole'?'Selected '+String(e.state?.division)+'. Fixed admitted surface, empty hands, samefloor and clear room55cm to right; fourseconds native craft produces two independently carryable pieces.':'Carry/place this actual piece independently; no further cutting supported.'}`};}};
}
export type PaperCutting=ReturnType<typeof createPaperCutting>;
