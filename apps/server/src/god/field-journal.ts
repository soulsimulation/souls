// Native writing owns time. One ordinary completed batch appends to the bound journal and spends ink.
import {opSchema,type Op,type StoredDef,type WorldModel} from '@souls/world-compiler';
import type {EdgeReceipt,EdgeSoul} from '../edge/contract.ts';
import {ACT_REACH} from './actuators.ts';
type Approach=(id:string,soul:EdgeSoul,front:[number,number]|null,radius?:number)=>{p:[number,number];level:number}|null;
type Refusal={code:string;reason:string};
type Body={pose?:{p:number[]};support?:{kind?:string;on?:string;by?:string};human?:{holding?:unknown;hands?:unknown;handActuator?:unknown}};
export type JournalHost={model:WorldModel;engine:{world:{entities:Record<string,Body>};clearanceAtV1?(x:number,z:number,level?:number):number};levelAt(x:number,z:number,y:number):number;soul(id:string):{id:string;entity_id:string;name:string}|undefined;denied(id:string,soul:{soulId:string;entityId:string;name:string}):Refusal|null;commit(ops:Op[],note:string,clientRef:string):{accepted:boolean};log(message:string):void};
const isDesk=(d:StoredDef|undefined)=>d?.name==='core-field-writing-desk'&&d.version===1;
const isJournal=(d:StoredDef|undefined)=>d?.name==='core-field-journal'&&d.version===1;
type Entry={entry:string;by:string;writer:string};
function entries(state:Record<string,unknown>|undefined):Entry[]|null{
 try{const x=JSON.parse(String(state?.history??'[]'));return Array.isArray(x)&&x.length<=5&&x.length===state?.count&&x.every(e=>e&&typeof e.entry==='string'&&e.entry.length>0&&e.entry.length<=100&&typeof e.by==='string'&&e.by.length<=80&&typeof e.writer==='string'&&e.writer.length<=80)?x:null;}catch{return null;}
}
export function createFieldJournal(h:JournalHost){
 const pending=new Map<string,{journal:string;desk:string;body:string;draft:string;history:unknown;count:unknown;ink:unknown;pose:string}>();
 const desk=(id:string)=>{const e=h.model.entities.get(id);return e&&isDesk(h.model.resolvedDef(e.def))?e:null;};
 function ready(soul:Pick<EdgeSoul,'soulId'|'entityId'|'name'>,id:string){
  const at=desk(id);if(!at)return{no:{code:'object.gone',reason:'The writing desk is no longer there.'}};
  const denied=h.denied(id,soul);if(denied)return{no:denied};
  const children=[...(h.model.children.get(id)??[])].map(i=>h.model.entities.get(i)!).filter(e=>e?.in.slot==='journal');
  const book=children.length===1&&isJournal(h.model.resolvedDef(children[0].def))?children[0]:null;
  if(!book)return{no:{code:'object.state',reason:'Put one field journal on the journal writing surface first.'}};
  const no=h.denied(book.id,soul);if(no)return{no};
  const history=entries(book.state);if(!history)return{no:{code:'object.state',reason:'This journal history is invalid; no entry or ink was changed.'}};
  if(history.length>=5)return{no:{code:'object.state',reason:'This journal is full: its five earlier entries remain unchanged.'}};
  const draft=typeof book.state?.draft==='string'?book.state.draft.trim():'';
  if(!draft||draft.length>100)return{no:{code:'object.state',reason:'Draft the next entry on the journal first (1–100 characters).'}};
  if(!Number.isSafeInteger(at.state?.ink)||Number(at.state?.ink)<1)return{no:{code:'object.state',reason:'Appending needs one unused ink charge.'}};
  const support=h.engine.world.entities[book.id]?.support;
  if(support?.kind!=='resting-on'||support.on!==id)return{no:{code:'object.state',reason:'The journal must actually rest on this writing desk.'}};
  const body=h.engine.world.entities[soul.entityId],pos=body?.pose?.p,p=h.model.worldPose(at);
  if(!body?.human||!pos)return{no:{code:'body.unavailable',reason:'Your body is unavailable.'}};
  if(body.human.holding||body.human.hands||body.human.handActuator||Object.values(h.engine.world.entities).some(x=>x.support?.kind==='in-hand'&&x.support.by===soul.entityId))return{no:{code:'object.state',reason:'Put down what you are holding before writing.'}};
  if(h.levelAt(pos[0],pos[2],pos[1])!==h.levelAt(p.x,p.z,p.y))return{no:{code:'object.state',reason:'Reach the same floor as the writing desk first.'}};
  return{at,book,history,draft};
 }
 function plan(soul:EdgeSoul,id:string,action:string,approach:Approach){
  if(action!=='append-entry'||!desk(id))return null;
  const r=ready(soul,id);if(r.no)return r.no;
  const p=h.model.worldPose(r.at!),d=h.model.resolvedDef(r.at!.def)!,worker=d.slots.find(s=>s.id==='writer')!,c=Math.cos(p.yaw),s=Math.sin(p.yaw),book=h.model.worldPose(r.book!);
  const front:[number,number]=[p.x+(worker.p[0]*c+worker.p[2]*s)*p.s,p.z+(-worker.p[0]*s+worker.p[2]*c)*p.s],stand=approach(r.book!.id,soul,front,1.5);
  if(!stand)return{code:'object.state',reason:'There is no ordinary reachable standing room beside this journal.'};
  return{summary:'Completed ten seconds writing the next signed entry; inspect the same journal for its full history and remaining capacity.',steps:[{verb:'stand',params:{}},{verb:'mars:walk_to',params:{x:stand.p[0],z:stand.p[1],level:stand.level}},{verb:'mars:pose_v1',params:{activity:'write',seconds:10,prop:'pen',face:[book.x,book.z]}},{verb:'stand',params:{}}]};
 }
 function onReceipt(r:EdgeReceipt){
  const m=/^object:(.+):append-entry$/.exec(r.capability);if(!m)return;
  const soul=h.soul(r.soulId),id=m[1];
  if(r.phase==='started'){
   if(!soul||pending.has(r.id))return;const a=ready({soulId:soul.id,entityId:soul.entity_id,name:soul.name},id);
   if(a.book)pending.set(r.id,{journal:a.book.id,desk:id,body:soul.entity_id,draft:String(a.book.state?.draft),history:a.book.state?.history,count:a.book.state?.count,ink:a.at!.state?.ink,pose:JSON.stringify(h.model.worldPose(a.at!))});return;
  }
  if(!['completed','failed','replaced','aborted','cancelled'].includes(r.phase))return;
  const bound=pending.get(r.id);pending.delete(r.id);
  if(r.phase!=='completed'||!bound||bound.desk!==id||!soul||bound.body!==soul.entity_id||!Number.isSafeInteger(r.endedTick)||r.endedTick!<0)return;
  const a=ready({soulId:soul.id,entityId:soul.entity_id,name:soul.name},id);
  if(a.no||a.book!.id!==bound.journal||a.book!.state?.draft!==bound.draft||a.book!.state?.history!==bound.history||a.book!.state?.count!==bound.count||a.at!.state?.ink!==bound.ink||JSON.stringify(h.model.worldPose(a.at!))!==bound.pose||a.at!.state?.lastReceipt===r.id||r.endedTick!<Number(a.at!.state?.lastCompletedTick??-1))return;
  const pos=h.engine.world.entities[soul.entity_id]?.pose?.p,p=h.model.worldPose(a.at!);
  if(!pos||Math.hypot(pos[0]-p.x,pos[2]-p.z)>ACT_REACH)return;
  const by=soul.name.slice(0,80),history=[...a.history!,{entry:a.draft!,by,writer:soul.id.slice(0,80)}];
  const done=h.commit([
   opSchema.parse({op:'set',id,state:{ink:Number(a.at!.state?.ink)-1,lastReceipt:r.id,lastCompletedTick:r.endedTick}}),
   opSchema.parse({op:'set',id:bound.journal,state:{history:JSON.stringify(history),count:history.length,draft:''},about:{title:'Field journal',what:`${history.length} signed entries; latest written by ${by}. Earlier entries remain unchanged.`}}),
  ],`${r.soulId} appended a field journal entry`,`field-journal:${r.id}`);
  if(!done.accepted)h.log('field journal: world refused the append batch; history and ink unchanged');
 }
 return{plan,onReceipt,facts(id:string){const e=h.model.entities.get(id);if(!e)return null;const d=h.model.resolvedDef(e.def);
  if(isJournal(d)){const history=entries(e.state);return{fieldJournal:history?`${history.length}/5 entries. ${history.map((x,i)=>`${i+1}. ${x.entry} — ${x.by}`).join(' | ')}`:'Invalid history; no append available.',journalDraft:String(e.state?.draft??''),journalRequirements:'Draft an entry, then put this journal on a supplied writing desk. Append with empty hands; ten seconds of writing and one ink charge. Earlier entries cannot be edited.'};}
  if(isDesk(d))return{fieldWritingDesk:`Ink ${Number(e.state?.ink??0)}/5. Put one field journal on the journal surface, draft its next entry, then append (10 seconds, empty hands).`};
  return null;}};
}
export type FieldJournal=ReturnType<typeof createFieldJournal>;
