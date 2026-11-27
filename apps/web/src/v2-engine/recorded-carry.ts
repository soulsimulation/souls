// One native pose history for loads and contacts. No clock, inferred travel heading, movement or scene ownership.
import type {NodeRec,PartRec,SnapshotRec,SampleRec} from './source/source.ts';
import type {CarryChange,CarryGrips,CrewMember,Q4,V3} from './source/carry-record.ts';
export type NativePose={p:V3;q:Q4}; // world metres, unit quaternion [w,x,y,z]
type Timed<T>={at:number;value:T};
const Q=2**30;
const norm=(q:Q4):Q4=>{const n=Math.hypot(...q);if(!Number.isFinite(n)||n<.5)throw Error('carry-pose: invalid quaternion');return q.map(x=>x/n)as Q4;};
export const rotate=(q:Q4,p:V3):V3=>{const[w,x,y,z]=q,[a,b,c]=p,tx=2*(y*c-z*b),ty=2*(z*a-x*c),tz=2*(x*b-y*a);return[a+w*tx+y*tz-z*ty,b+w*ty+z*tx-x*tz,c+w*tz+x*ty-y*tx];};
const mul=(a:Q4,b:Q4):Q4=>[a[0]*b[0]-a[1]*b[1]-a[2]*b[2]-a[3]*b[3],a[0]*b[1]+a[1]*b[0]+a[2]*b[3]-a[3]*b[2],a[0]*b[2]-a[1]*b[3]+a[2]*b[0]+a[3]*b[1],a[0]*b[3]+a[1]*b[2]-a[2]*b[1]+a[3]*b[0]];
export function slerp(a:Q4,b:Q4,t:number):Q4{a=norm(a);b=norm(b);let d=a.reduce((s,x,i)=>s+x*b[i],0);if(d<0){b=b.map(x=>-x)as Q4;d=-d;}if(d>.9995)return norm(a.map((x,i)=>x+(b[i]-x)*t)as Q4);const angle=Math.acos(Math.min(1,d)),s=Math.sin(angle),u=Math.sin((1-t)*angle)/s,v=Math.sin(t*angle)/s;return a.map((x,i)=>x*u+b[i]*v)as Q4;}
export const worldPoint=(pose:NativePose,p:V3):V3=>rotate(pose.q,p.map(x=>x/1e6)as V3).map((x,i)=>x+pose.p[i])as V3;
function put<T>(list:Timed<T>[],at:number,value:T){let i=list.findIndex(x=>x.at>=at);if(i<0)i=list.length;if(list[i]?.at===at)list[i]={at,value};else list.splice(i,0,{at,value});}
function at<T>(list:Timed<T>[]|undefined,time:number):T|undefined{if(!list)return;for(let i=list.length-1;i>=0;i--)if(list[i].at<=time)return list[i].value;}
function putGrips(list:Timed<CarryGrips>[],at:number,value:CarryGrips){const same=JSON.stringify(value);if(list.some(r=>r.at===at&&JSON.stringify(r.value)===same))return;let i=list.findIndex(r=>r.at>at);if(i<0)i=list.length;list.splice(i,0,{at,value});}
export type CarryObservation={grips:CarryGrips;members:CrewMember[]|null;pose:NativePose|null;at:number};
export class RecordedCarry{
 error:string|null=null;
 readonly nodes=new Map<string,NodeRec>();
 private records=new Map<string,Timed<NodeRec|null>[]>();
 private poseStarts=new WeakMap<NodeRec,number>();
 private samples=new Map<string,SampleRec[]>();
 private members=new Map<string,Timed<CrewMember[]>[]>();
 private grips=new Map<string,Timed<CarryGrips>[]>();
 private orders=new WeakMap<CarryGrips,Map<string,[number,number]|null>>();
 private floor=-Infinity;
 receive(m:{t:'part';p:PartRec}|{t:'snapshot';s:SnapshotRec}|{t:string}){
  if(m.t!=='part'&&m.t!=='snapshot')return;
  if(m.t==='snapshot'){this.error=null;this.floor=-Infinity;this.orders=new WeakMap();this.poseStarts=new WeakMap();this.nodes.clear();this.records.clear();this.samples.clear();this.members.clear();this.grips.clear();}
  const p='p'in m?m.p as PartRec:null,s='s'in m?m.s as SnapshotRec:p!;
  const time=p?.from??-Infinity;
  for(const id of s.removed){this.nodes.delete(id);const r=this.records.get(id)??[];put(r,time,null);this.records.set(id,r);}
  for(const n of s.nodes){const old=this.nodes.get(n.id),r=this.records.get(n.id)??[];this.nodes.set(n.id,n);
   // Snapshot/as-at state is never dated at a future bundle motion. Live changes with exact transfers below override it.
   const effective=old?(p?.to??time):p?time:n.at??time;
   const exactTransfer=p?.carryChanges?.some(c=>c.node===n.id&&c.pose);
   const poseChanged=!old||JSON.stringify([old.parent,old.slot,old.pos,old.rot])!==JSON.stringify([n.parent,n.slot,n.pos,n.rot]);
   if(!exactTransfer&&(!old||JSON.stringify(old)!==JSON.stringify(n))){
    // Metadata has its own boundary (slot points, kind/origin), but cannot restart an existing motion track.
    const prior=this.record(n.id,effective);this.poseStarts.set(n,poseChanged?effective:prior?this.poseStarts.get(prior)??r.at(-1)?.at??effective:effective);put(r,effective,n);
   }this.records.set(n.id,r);
   if(n.crewMembers){const h=this.members.get(n.id)??[];put(h,effective,n.crewMembers);this.members.set(n.id,h);}
   if(n.carryGrips&&!p?.carryChanges?.some(c=>c.node===n.id&&c.grips)){const h=this.grips.get(n.id)??[];putGrips(h,n.carryGrips.sinceUs,n.carryGrips);this.grips.set(n.id,h);}
  }
  if(!p)return;
  if(p.carryError)this.error=p.carryError;
  for(const sample of p.samples){const list=this.samples.get(sample[0])??[];let i=list.findIndex(s=>s[3]>=sample[3]);if(i<0)i=list.length;if(list[i]?.[3]===sample[3])list[i]=sample;else list.splice(i,0,sample);this.samples.set(sample[0],list);}
  for(const c of p.carryChanges??[])this.change(c);
  if(p.to>p.from)this.trim(p.to-30000000);
 }
 private change(c:CarryChange){
  if(c.members){const h=this.members.get(c.node)??[];put(h,c.at,c.members);this.members.set(c.node,h);}
  if(c.grips){const h=this.grips.get(c.node)??[];putGrips(h,c.at,c.grips);this.grips.set(c.node,h);}
  if(c.pose){const n=this.nodes.get(c.node),h=this.records.get(c.node)??[];if(n){const value={...n,...c.pose};this.poseStarts.set(value,c.at);put(h,c.at,value);this.records.set(c.node,h);}}
 }
 private record(id:string,time:number):NodeRec|null|undefined{return at(this.records.get(id),time);}
 nodeAt(id:string,time:number){return this.record(id,time)??null;}
 *nodesAt(time:number){for(const id of this.records.keys()){const node=this.record(id,time);if(node)yield node;}}
 hasSamples(id:string){return !!this.samples.get(id)?.length;}
 localPose(id:string,time:number){
  if(time<this.floor)return null;const n=this.record(id,time);if(!n)return null;
  let p=n.pos,q=n.rot,parent=n.parent,slot=n.slot;
  const samples=this.samples.get(id);let before=-1;if(samples)for(let i=samples.length-1;i>=0;i--)if(samples[i][3]<=time){before=i;break;}
  let recordAt=-Infinity;const revisions=this.records.get(id);if(revisions)for(let i=revisions.length-1;i>=0;i--)if(revisions[i].at<=time){recordAt=revisions[i].at;break;}
  recordAt=this.poseStarts.get(n)??recordAt;
  if(samples&&before>=0&&samples[before][3]>=recordAt){const a=samples[before],b=samples[before+1];if(!a[7])return null;
   parent=a[1];slot=a[2];p=[a[4],a[5],a[6]];q=a[7];
   if(b&&b[1]===parent&&b[2]===slot){if(!b[7])return null;const u=(time-a[3])/(b[3]-a[3]);p=p.map((x,i)=>x+([b[4],b[5],b[6]][i]-x)*u)as V3;q=slerp(q,b[7],u).map(x=>x*Q)as Q4;}
  }
  try{return{parent,slot,p:p.map(x=>x/1e6)as V3,q:norm(q.map(x=>x/Q)as Q4)};}catch{return null;}
 }
 /** A slot translates in its parent's axes; it does not add the slot metadata's display yaw. */
 pose(id:string,time:number,seen=new Set<string>()):NativePose|null{
  if(seen.has(id)||seen.size>=32)return null;seen.add(id);const local=this.localPose(id,time);if(!local)return null;
  if(local.parent===null)return{p:local.p,q:local.q};
  const up=this.record(local.parent,time);if(!up)return null;
  if(local.slot!==null){const point=up.slots?.find(s=>s[0]===local.slot);if(!point)return null;for(let k=0;k<3;k++)local.p[k]+=point[k+1]/1000;}
  const base=this.pose(local.parent,time,seen);if(!base)return null;const r=rotate(base.q,local.p);return{p:r.map((x,i)=>x+base.p[i])as V3,q:norm(mul(base.q,local.q))};
 }
 /** Raw, independently composable native brackets for the final-draw oracle. No drawn matrices enter this value. */
 evidence(id:string,time:number){
  const frames:{id:string;record:NodeRec;recordAt:number;bracket:SampleRec[];slotPoint:number[]|null}[]=[],seen=new Set<string>();
  for(let key:string|null=id;key!==null;){if(seen.has(key)||seen.size>=32)return null;seen.add(key);
   const list=this.records.get(key);let r:Timed<NodeRec|null>|undefined;if(list)for(let i=list.length-1;i>=0;i--)if(list[i].at<=time){r=list[i];break;}if(!r?.value)return null;
   const n:NodeRec=r.value,ss:SampleRec[]=this.samples.get(key)??[];let k=-1;for(let i=ss.length-1;i>=0;i--)if(ss[i][3]<=time){k=i;break;}
   const bracket:SampleRec[]=k<0?[]:ss.slice(k,k+2),poseAt=this.poseStarts.get(n)??r.at,use:boolean=!!bracket.length&&bracket[0][3]>=poseAt,parent:string|null=use?bracket[0][1]:n.parent,slot:number|null=use?bracket[0][2]:n.slot;
   const up=parent===null?null:this.record(parent,time),slotPoint=slot===null?null:up?.slots?.find(s=>s[0]===slot)??null;
   if(slot!==null&&!slotPoint)return null;
   frames.push({id:key,record:n,recordAt:Number.isFinite(poseAt)?poseAt:Number.MIN_SAFE_INTEGER,bracket,slotPoint});key=parent;
  }return{source:'native-records',at:time,frames};
 }
 observations(time:number):CarryObservation[]{if(this.error)return[];const out:CarryObservation[]=[];for(const[id,h]of this.grips){const g=at(h,time);if(g&&(g.phase!=='souls:released'||time-g.sinceUs<300000))out.push({grips:g,members:at(this.members.get(id),time)??null,pose:this.pose(g.load,time),at:time});}return out;}
 /** Upcoming validated assignments can prepare on the page's existing behind-native clock, never become active early. */
 preparing(time:number){const out:{grips:CarryGrips;holds:CarryGrips['holds']}[]=[];for(const h of this.grips.values()){
  const next=h.find(r=>r.at>time&&r.value.phase!=='souls:released');if(!next||next.at-time>300000)continue;
  const prior=at(h,time),holds=next.value.holds.filter(hold=>!prior||prior.phase==='souls:released'||prior.load!==next.value.load||!prior.holds.some(p=>p.body===hold.body&&p.grip===hold.grip&&JSON.stringify(p.handsUm)===JSON.stringify(hold.handsUm)));
  if(holds.length)out.push({grips:next.value,holds});}return out;
 }
 contactStates(time:number){
  const ids=new Set([...this.grips.keys(),...this.members.keys()]);return[...ids].map(crew=>{const node=this.record(crew,time),grips=at(this.grips.get(crew),time)??null,members=at(this.members.get(crew),time)??null;
   return{crew,at:time,field:node?.carryField??(grips?'valid' as const:'unknown' as const),grips,members};});
 }
 phaseHistory(crew:string,time:number){return(this.grips.get(crew)??[]).filter(r=>r.at<=time).map(r=>r.value);}
 /** Owner barriers use public intervals, not the previous rendered frame or mutable adapter flags. */
 ownedBetween(body:string,from:number,to:number){for(const h of this.grips.values())for(let i=0;i<h.length;i++){const g=h[i].value;if(!g.holds.some(hold=>hold.body===body))continue;const end=g.phase==='souls:released'?g.sinceUs+300000:Math.min(h[i+1]?.at??Infinity,g.untilUs??Infinity)+300000;if(g.sinceUs-300000<=to&&end>=from)return true;}return false;}
 /** A member removed from field 6 releases its previous hands at that exact public boundary. This is depiction only;
  * independent field-4 membership and the active contact interval remain unchanged. */
 retiring(time:number):CarryGrips[]{const out:CarryGrips[]=[];for(const h of this.grips.values()){let i=h.length-1;while(i>=0&&h[i].at>time)i--;if(i<1||time-h[i].at>=300000)continue;const now=h[i],before=h[i-1].value;if(now.value.phase==='souls:released')continue;const holds=before.holds.filter(old=>!now.value.holds.some(next=>next.body===old.body));if(holds.length)out.push({...before,phase:'souls:released',sinceUs:now.at,untilUs:undefined,holds});}return out;}
 /** Recorded points are assigned once from the native boundary body facing, never from the current drawn facing. */
 anatomical(g:CarryGrips,body:string):[number,number]|null{
  const hold=g.holds.find(h=>h.body===body);if(!hold)return null;
  const cached=this.orders.get(g);if(cached?.has(body))return cached.get(body)!;
  // Follow only this uninterrupted assignment. A released/missing body ends it, even when a later grip is identical.
  const history=this.grips.get(g.crew)??[];let index=history.findIndex(r=>r.value===g);if(index<0)index=history.findIndex(r=>r.at===g.sinceUs);
  let first=g;for(let i=index-1;i>=0;i--){const prior=history[i].value;if(prior.phase==='souls:released'||prior.load!==g.load||!prior.holds.some(h=>h.body===body&&h.grip===hold.grip&&JSON.stringify(h.handsUm)===JSON.stringify(hold.handsUm)))break;first=prior;}
  const inherited=this.orders.get(first);if(inherited?.has(body)){const order=inherited.get(body)!;let cache=this.orders.get(g);if(!cache)this.orders.set(g,cache=new Map());cache.set(body,order);return order;}
  const pose=this.pose(g.load,first.sinceUs),person=this.pose(body,first.sinceUs);if(!pose||!person)return null;
  const points=hold.handsUm.map(p=>worldPoint(pose,p)),right=rotate(person.q,[0,0,1]);
  const d=points[1].map((v,i)=>v-points[0][i]);const dot=d.reduce((s,v,i)=>s+v*right[i],0);
  // The native pair is deliberately unlabelled. At a boundary tie either bijection is valid: choose native order
  // deterministically, then keep it for the uninterrupted assignment. This is a drawing choice, not native L/R.
  const order:[number,number]=dot>=0?[0,1]:[1,0];let cache=this.orders.get(g);if(!cache)this.orders.set(g,cache=new Map());cache.set(body,order);return order;
 }
 private trim(floor:number){
  if(floor<=this.floor)return;
  // Resolve continuous assignments while their actual boundary context is present, before retaining only the live
  // playback horizon. The history reader has a separate window recording; it never guesses older poses from this one.
  for(const h of this.grips.values())for(const r of h)for(const hold of r.value.holds)this.anatomical(r.value,hold.body);
  const trim=<T>(h:Timed<T>[])=>{let k=0;while(k+1<h.length&&h[k+1].at<=floor)k++;if(k)h.splice(0,k);};
  for(const[id,h]of this.records){trim(h);if(h.length===1&&h[0].value===null&&h[0].at<floor){this.records.delete(id);this.samples.delete(id);this.members.delete(id);this.grips.delete(id);}}
  for(const h of this.samples.values()){let k=0;while(k+1<h.length&&h[k+1][3]<=floor)k++;if(k)h.splice(0,k);}
  for(const h of this.members.values())trim(h);for(const h of this.grips.values())if(h.at(-1)?.value.phase==='souls:released'&&h.at(-1)!.at<floor)h.splice(0,h.length-1);this.floor=floor;
 }

}
