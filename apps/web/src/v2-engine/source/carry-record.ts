// Public carry records have native identities and load-local micrometre contacts. They are not kind look-state.
import {decode} from 'cborg';
import {unpack} from './sound-record.ts';
export type V3=[number,number,number];
export type Q4=[number,number,number,number];
export type CrewMember={role:string;body:string;soul:string;link:string;intent:string};
export type CarryHold={body:string;grip:string;gripUm:V3;handsUm:[V3,V3]};
export type CarryGrips={crew:string;load:string;phase:string;sinceUs:number;untilUs?:number;holds:CarryHold[]};
export type CarryTrack={crew:string;load:string;phase:string;t0:number;t1:number;why?:string};
export type CarryChange={at:number;node:string;members?:CrewMember[];grips?:CarryGrips;track?:CarryTrack;pose?:{parent:string;slot:number|null;pos:V3;rot:Q4}};
const whole=(v:unknown):number=>{const n=typeof v==='bigint'?Number(v):v;if(typeof n!=='number'||!Number.isSafeInteger(n))throw Error('carry-record: whole number required');return n;};
export function nativeId(v:unknown):string{
 if(!Array.isArray(v)||v.length!==2||!(v[0] instanceof Uint8Array)||v[0].length!==16)throw Error('carry-record: native id required');
 const n=typeof v[1]==='bigint'?v[1]:BigInt(whole(v[1]));if(n<0n||n>0xffffffffffffffffn)throw Error('carry-record: native id range');
 return Array.from(v[0],b=>b.toString(16).padStart(2,'0')).join('')+'.'+n;
}
const map=(v:unknown):Map<number,unknown>=>{if(!(v instanceof Map))throw Error('carry-record: map required');return v;};
const point=(v:unknown):V3=>{if(!Array.isArray(v)||v.length!==3)throw Error('carry-record: point required');return v.map(whole)as V3;};
export function crewMembers(v:unknown):CrewMember[]|undefined{
 if(v===undefined)return;
 try{if(!Array.isArray(v))return;const out=v.map(row=>{if(!Array.isArray(row)||row.length!==5||typeof row[0]!=='string')throw Error('member');return{role:row[0],body:nativeId(row[1]),soul:nativeId(row[2]),link:nativeId(row[3]),intent:nativeId(row[4])};});if(new Set(out.map(m=>m.body)).size!==out.length)return;return out;}catch{return;}
}
export function carryGrips(v:unknown):CarryGrips|undefined{
 if(v===undefined)return;
 try{const m=map(v),hs=m.get(6);if(typeof m.get(3)!=='string'||!Array.isArray(hs))return;
 const holds=hs.map(h=>{const r=map(h),hands=r.get(4),grip=r.get(2);if(typeof grip!=='string'||!grip.startsWith('point:')||!Array.isArray(hands)||hands.length!==2)throw Error('hold');return{body:nativeId(r.get(1)),grip,gripUm:point(r.get(3)),handsUm:[point(hands[0]),point(hands[1])]as[V3,V3]};});
 if(new Set(holds.map(h=>h.body)).size!==holds.length)return;
 return{crew:nativeId(m.get(1)),load:nativeId(m.get(2)),phase:m.get(3)as string,sinceUs:whole(m.get(4)),...(m.has(5)?{untilUs:whole(m.get(5))}:{}),holds};}catch{return;}
}
export function carryTrack(v:unknown):CarryTrack|undefined{
 try{const m=map(v);if(typeof m.get(3)!=='string')return;return{crew:nativeId(m.get(1)),load:nativeId(m.get(2)),phase:m.get(3)as string,t0:whole(m.get(4)),t1:whole(m.get(5)),...(typeof m.get(6)==='string'?{why:m.get(6)as string}:{})};}catch{return;}
}
/** The native field-4 Set retains its OWN entry timestamp, independently of grip events. */
export function carryChanges(entries:unknown[]):CarryChange[]{
 const out:CarryChange[]=[];
 for(const raw of entries){const e=map(raw),at=whole(e.get(2));
  for(const raw of (e.get(7)as unknown[]|undefined)??[]){const c=map(raw);if(c.get(1)!==4)continue;const field=whole(c.get(3));
   if(field===4){const members=crewMembers(c.get(4));if(members)out.push({at,node:nativeId(c.get(2)),members});}
   if(field===6){const grips=carryGrips(c.get(4));if(grips)out.push({at:grips.sinceUs,node:nativeId(c.get(2)),grips});}
  }
  for(const raw of (e.get(8)as unknown[]|undefined)??[]){const ev=map(raw);
   if(ev.get(1)==='souls:carry-grips'){const grips=carryGrips(ev.get(2));if(grips)out.push({at:grips.sinceUs,node:nativeId(e.get(6)),grips});}
   if(ev.get(1)==='souls:carry-track'){const track=carryTrack(ev.get(2));if(track)out.push({at:track.t0,node:nativeId(e.get(6)),track});}
  }
  const transfer=e.get(9);if(transfer instanceof Map&&transfer.get(1)===1){const p=map(transfer.get(6)),f=map(p.get(1)),q=p.get(3);if(!Array.isArray(q)||q.length!==4)throw Error('carry-record: transfer rotation');out.push({at,node:nativeId(transfer.get(3)),pose:{parent:nativeId(f.get(1)),slot:f.has(2)?whole(f.get(2)):null,pos:point(p.get(2)),rot:q.map(whole)as Q4}});}
 }
 return out.sort((a,b)=>a.at-b.at);
}
export function carryChangesInPart(bytes:Uint8Array):CarryChange[]{const s=map(decode(bytes,{useMaps:true})),p=map(decode(unpack(s.get(6)as Uint8Array),{useMaps:true}));return carryChanges((p.get(2)as unknown[])??[]);}
export function carryChangesInBundle(bytes:Uint8Array):CarryChange[]{const b=map(decode(bytes,{useMaps:true})),v=b.get(6);return v instanceof Map?carryChanges((v.get(8)as unknown[])??[]):[];}

/** Full quaternion recovery from the SAME already-validated bundle; historyAt's legacy prefix stays unchanged. */
export function historyMotion(bytes:Uint8Array):[string,string,number|null,number,number,number,number,Q4][]{
 const b=map(decode(bytes,{useMaps:true})),view=b.get(6),out:[string,string,number|null,number,number,number,number,Q4][]=[];
 if(!(view instanceof Map))return out;
 for(const raw of (view.get(8)as unknown[])??[])for(const rawChange of (map(raw).get(7)as unknown[])??[]){const c=map(rawChange);if(c.get(1)!==7)continue;
  const h=map(c.get(2)),p=map(h.get(5)),f=map(p.get(1)),position=point(p.get(2)),q=p.get(3);if(!Array.isArray(q)||q.length!==4)throw Error('carry-record: history quaternion');
  out.push([nativeId(h.get(1)),nativeId(f.get(1)),f.has(2)?whole(f.get(2)):null,whole(h.get(2)),...position,q.map(whole)as Q4]);
 }return out;
}
