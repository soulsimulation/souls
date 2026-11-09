import type {EdgeLedger} from '../ledger/ledger.ts';
import type {EdgeCapability,EdgeSoul} from '../contract.ts';
import type {Place} from '../ledger/places.ts';
import type {MeaningPart} from '../../god/meaning.ts';
import {parseCapability,tokens,type VocabResult} from '../ledger/vocabulary.ts';
import {knownPart} from './resolved-parts.ts';

type Candidate={capability:string;name:string;place:string;target?:MeaningPart['target'];available:boolean;reason?:string;code?:string;what?:string;matched?:string[];unverified?:string[]};
const names=(p:Place)=>[p.name,...(p.aliases??[]),...(p.ref?[p.ref]:[])];
const words=(xs:string[])=>new Set(xs.flatMap(tokens));
const covers=(q:string[],set:Set<string>)=>q.every(w=>set.has(w));
/** A bound object seat's own names: its label's name, the id after the verb, the target id, the label's words after the verb. */
const seatNames=(c:EdgeCapability)=>[c.label.split(/\s*[([]|,\s*by\s/)[0]!,c.id.slice(c.id.indexOf(':')+1),c.target!.id,parseCapability(c.label,new Set(['sit'])).rest];
const GENERIC_SEAT=new Set(['down','here','nearby','nearest','closest','somewhere','seat','chair','bench']);
// #848: a relation word between a seat and its place ("the bench outside the cottage", "the bench inside the hall"). `inside`
// reads as `in` (already a stop word). `outside` stays a constraint, read as the authored adjective `outdoor`, never dropped:
// a place with no outdoor seat still names none. Only when a name follows it (see the sit path).
const RELATION=new Map<string,string[]>([['inside',[]],['outside',['outdoor']]]);
export const PURPOSE=/^(?:(?:find|show|suggest|choose|take me to|go to|head to)\s+)?(?:somewhere|(?:a|the|any)\s+(?:place|venue|spot))\s+(?:to|for)\s+(.+)$|^where\s+(?:can|could|should)\s+(?:i|we)\s+(.+)$/i;
const stem=(w:string)=>w.length>5&&w.endsWith('ing')?w.slice(0,-3):w.length>4&&w.endsWith('ed')?w.slice(0,-2):w.length>3&&w.endsWith('s')?w.slice(0,-1):w;
const purposeWords=(xs:string[])=>new Set(xs.flatMap(tokens).map(stem));
const PURPOSE_FILLER=new Set(['do','doing','have','having','get','go','going','find','somewhere','place','venue','spot']);

/** Scope names are identities, not descriptions; purpose descriptions are explicitly weaker discovery evidence. */
function contexts(L:EdgeLedger,p:Place,soul:EdgeSoul):string[]{
 const out=names(p),seen=new Set([p.id]);
 for(let id=p.semanticParent??p.parent,n=0;id&&n<12;n++){
  const a=L.places.byId.get(id);if(!a||seen.has(id))break;seen.add(id);
  if(a.parent!==null&&L.knowledge.knows(soul.soulId,a.id))out.push(...names(a));id=a.semanticParent??a.parent;
 }return out;
}
function candidate(L:EdgeLedger,soul:EdgeSoul,capability:string,p:Place,name:string,target:MeaningPart['target'],caps:EdgeCapability[],plans:Parameters<EdgeLedger['resolveOnDemand']>[3]):Candidate{
 const r=L.resolveOnDemand(soul,capability,caps,plans).v;
 if(r.kind==='unknown'||r.cap.id!==capability)return {capability,name,place:p.id,...(target?{target}:{}),available:false,reason:r.kind==='unknown'?r.reason:'The exact action is not offered now.',...(r.kind==='unknown'&&r.code?{code:r.code}:{})};
 return {capability,name,place:p.id,...(target?{target}:{}),available:r.cap.available,...(r.cap.blocked?{reason:r.cap.blocked.reason,code:r.cap.blocked.code}:{})};
}
function choice(kind:string,requested:string,candidates:Candidate[],reason:string,extra:Record<string,unknown>={}):VocabResult{
 return {kind:'unknown',code:candidates.length?'capability.choose':'capability.unavailable',reason,didYouMean:candidates.map(c=>({id:c.capability,label:c.name,...c})),discovery:{kind,requested,candidates,...extra}};
}

/** Return options. Never guess a fixture, invent an action, or reinterpret an interaction as travel. #849: a sit request
 * whose words name exactly one bound seat by its own title or alias (not only its place) answers with that seat when it is
 * available, and with its own reason when it is not. A dry run says so; an act still takes only an id (`oneSeat`, in the
 * ledger). `take: false` (a purpose question, "where can I sit ...") only lists. */
export function semanticDiscovery(L:EdgeLedger,soul:EdgeSoul,text:string,caps:EdgeCapability[],plans:Parameters<EdgeLedger['resolveOnDemand']>[3],take=true):VocabResult|null{
 if(text.includes(':'))return null;
 const all=[...L.places.byId.values()],known=all.filter(p=>L.knowledge.knows(soul.soulId,p.id));
 const purpose=PURPOSE.exec(text.trim());
 if(purpose){
  // Preserve established untargeted activity commands (read a book, take a nap).
  // Venue discovery is a fallback, not a conversion of an executable activity to travel.
  const existing=parseCapability(text,new Set(caps.map(c=>c.verb)));
  if(!tokens(existing.rest).length&&!['walk','sit'].includes(existing.verb)&&caps.some(c=>c.verb===existing.verb))return null;
  const requested=(purpose[1]??purpose[2]).trim();
  if(parseCapability(requested,new Set([...caps.map(c=>c.verb),'sit'])).verb==='sit')return semanticDiscovery(L,soul,requested,caps,plans,false);
  const scope=/\s+(?:in|at)\s+(.+)$/i.exec(requested),activity=scope?requested.slice(0,scope.index):requested;
  const q=tokens(activity).filter(w=>!PURPOSE_FILLER.has(w));if(!q.length)return choice('purpose',requested,[],'Name the activity or purpose you want a place for.');
  const scoped=scope?known.filter(p=>covers(tokens(scope[1]),words(names(p)))):[];
  if(scope&&!scoped.length)return choice('purpose',requested,[],'The named location is not known; no other location was substituted.');
  const within=(p:Place)=>{if(!scope)return true;const allowed=new Set(scoped.map(a=>a.id)),seen=new Set<string>();for(let at:Place|undefined=p;at&&!seen.has(at.id);at=L.places.byId.get(at.semanticParent??at.parent??'')){if(allowed.has(at.id))return true;seen.add(at.id);}return false;};
  const ranked=known.filter(p=>p.parent!==null&&within(p)).map(p=>{
   const own=purposeWords([...names(p),p.semanticKind??'',p.semanticRole??'']),facts=purposeWords([p.description??'']);
   const matched=q.filter(w=>own.has(stem(w))||facts.has(stem(w))),score=matched.reduce((n,w)=>n+(own.has(stem(w))?3:1),0);
   return {p,matched,score};
  }).filter(x=>x.score>0).sort((a,b)=>b.matched.length-a.matched.length||b.score-a.score||(b.p.salience??0)-(a.p.salience??0)||a.p.id.localeCompare(b.p.id)).slice(0,8);
  const candidates=ranked.map(({p,matched})=>({...candidate(L,soul,`walk:${p.ref??p.id}`,p,p.name,undefined,caps,plans),...(p.description?{what:p.description}:{}),matched,unverified:q.filter(w=>!matched.includes(w))}));
  return choice('purpose',requested,candidates,candidates.length?'Choose a destination by its exact capability ID; these are places whose authored purpose matches your request.':'No public place purpose matched; no destination was chosen.',{note:'Purpose describes a suitable place; it does not confirm the activity is happening now.'});
 }
 const parsed=parseCapability(text,new Set([...caps.map(c=>c.verb),'sit']));if(parsed.verb!=='sit')return null;
 // An infinitive/so-clause after a named seat states why to sit, not a second seat identity.
 // #1152: how long is not part of the seat's name, and "outside" is how a person says the part's "outdoor".
 const target=parsed.rest.split(/\s+(?:so(?:\s+that)?|in\s+order\s+to|to|for\s+(?:a\s+(?:while|bit|moment)|some\s+time))(?:\s+|$)/i)[0],raw=tokens(target).filter(w=>w!=='down'),plain=raw.map(w=>w==='outside'?'outdoor':w);
 // (built on first use only: a generic or exact sit returns before it, as it did before #848)
 let built:{p:Place;part:NonNullable<Place['parts']>[number];scope:Set<string>;own:Set<string>}[]|undefined;
 const match=(q:string[])=>(built??=known.flatMap(p=>(p.parts??[]).filter(part=>knownPart(L,soul,p,part)).map(part=>({p,part,scope:words(contexts(L,p,soul)),own:words([part.title,...(part.aliases??[])])})))).filter(x=>covers(q,new Set([...x.scope,...x.own])));
 // #848: a relation word between a seat and its place is read only when the words read that way name a seat ("the bench
 // outside the cottage"); otherwise ("sit outside", "sit outside with Bo", "the bench outside the hall") the words keep
 // their old handling, so a phrase that named nothing before still answers as before
 const mapped=raw.flatMap((w,i)=>RELATION.has(w)&&i<raw.length-1?RELATION.get(w)!:[w]);
 const q=mapped.join(' ')!==raw.join(' ')&&match(mapped).length?mapped:plain;
 if(!q.length||q.every(w=>GENERIC_SEAT.has(w)))return null;
 // Existing exact fixture identities retain the normal vocabulary/admission path. A shared
 // word in a semantic part must not intercept a fully named ordinary object.
 const identity=raw.join(' ');
 if(caps.some(c=>c.verb==='sit'&&c.target?.kind==='object'&&seatNames(c).some(n=>tokens(n).join(' ')===identity)))return null;
 const entries=match(q);
 // Do not relax an explicit target to a nearby fixture if a named part/place is missing or unsupported.
 const relevant=entries.length||known.some(p=>p.parts?.length&&q.some(w=>words([...contexts(L,p,soul),...p.parts!.filter(part=>knownPart(L,soul,p,part)).flatMap(x=>[x.title,...(x.aliases??[])])]).has(w)));
 if(!relevant)return null;
 const ranked=entries.sort((a,b)=>q.filter(w=>b.own.has(w)).length-q.filter(w=>a.own.has(w)).length||a.p.id.localeCompare(b.p.id)||a.part.id.localeCompare(b.part.id));
 // (one entry per seat: a seat bound under two known places is still one seat)
 const sits=new Set<string>(),seats=ranked.filter(x=>x.part.sit&&!sits.has(x.part.sit)&&!!sits.add(x.part.sit)).slice(0,8);
 const candidates=seats.map(({p,part})=>({...candidate(L,soul,part.sit!,p,`${part.title} — ${p.name}`,part.target,caps,plans),...(part.what?{what:part.what}:{})}));
 // #849: one seat, named by a word of its own (title or alias), as typed (a #848 relation word read as `outdoor` is not
 // the seat's name: "sit outside the cottage" names a place), that its place names do not share: taken when available (the ledger binds
 // it by its exact id and the act answer's `resolved` names it), refused with its own reason when not; never a one-entry choice
 // (a word like "seat" or "bench" names this one only where its place has no other seat: "the seat in Chiba" is a question)
 const alone=()=>(seats[0].p.parts??[]).filter(x=>x.sit&&knownPart(L,soul,seats[0].p,x)).length===1;
 if(take&&seats.length===1&&raw.some(w=>seats[0].own.has(w)&&!seats[0].scope.has(w)&&(!GENERIC_SEAT.has(w)||alone()))){
  const c=candidates[0];
  if(c.available)return {kind:'alias',cap:{id:c.capability,verb:'sit',label:c.name,available:true} as EdgeCapability,note:`The only seat these words name is ${c.name} (${c.capability}); send that id to sit there.`,oneSeat:true};
  return {kind:'unknown',code:c.code??'capability.unavailable',reason:`The only seat these words name, ${c.name} (${c.capability}), cannot be taken now: ${c.reason??'it is not offered.'} No other seat was chosen.`,didYouMean:[{id:c.capability,label:c.name,...c}],discovery:{kind:'interaction',requested:'sit',candidates}};
 }
 // F5 (#376): no part matches, but bound seats hold every word in their own name ("presenter box" names presenter-timber-box):
 // one seat (or numbered copies of one, which the vocabulary already reads as the nearest) keeps the normal path; seats
 // of different names are ambiguous and are named, never chosen.
 if(!candidates.length){
  // own names only (label head, id, target id): the label's "by <neighbours>" and kind words never name a seat
  const own=caps.filter(c=>c.verb==='sit'&&c.target?.kind==='object'&&covers(q,words(seatNames(c).slice(0,3))));
  const base=(c:EdgeCapability)=>{const t=tokens(seatNames(c)[0]!);return (/^\d+$/.test(t.at(-1)??'')&&t.length>1?t.slice(0,-1):t).join(' ');};
  const byBase=new Map<string,EdgeCapability>();for(const c of own)if(!byBase.has(base(c)))byBase.set(base(c),c);
  if(byBase.size===1)return null;
  if(byBase.size>1){const kept=[...byBase.values()].slice(0,8),named=kept.map(c=>({capability:c.id,name:seatNames(c)[0]!,place:c.target!.id,available:c.available,...(c.blocked?{reason:c.blocked.reason}:{})}));return choice('interaction','sit',named,`Several seats are named that way (${named.map(c=>c.name).join(', ')}); choose one by its exact sit capability ID. No seat has been selected.`);}
 }
 if(!candidates.length){const c=unresolvedCompanion(L,soul,text,caps,plans,known);if(c)return c;}
 return choice('interaction','sit',candidates,candidates.length?'Choose a bound seat by its exact sit capability ID. No seat has been selected.':'No bound sit action matches that named target; no nearby seat or walk was substituted.');
}

// #1242: "sit outside with Bo" when the words after "with" name no Soul the asker can invite (together/1 reads a Soul it can
// invite before this, and takes the words then): the seat words alone are read, their seats are listed, never taken, and the
// answer says which names were not found (`unresolved.with`), so the agent can tell its owner that part instead of reporting
// nothing. Not when the seat words name no seat ("sit with Zed on the bench": the ground is never offered for a named seat)
// or the "with" words name a place or part ("with a view"): those keep the refusal.
const WITH=/^(.+?)\s+(?:together\s+with|along\s+with|with)\s+(?!me\b)(.+?)[\s.!?]*$/i;
const COMPANION_TAIL=/\s+(?:now|here|right\s+now|(?:next\s+to|near|by|beside|under|outside|inside|on|at|in)\s+.*|for\s+(?:a\s+(?:while|bit|minute|moment)|some\s+time)|so(?:\s+that)?\s+.*|to\s+.*|in\s+order\s+to\s+.*)$/i;
function unresolvedCompanion(L:EdgeLedger,soul:EdgeSoul,text:string,caps:EdgeCapability[],plans:Parameters<EdgeLedger['resolveOnDemand']>[3],known:Place[]):VocabResult|null{
 const m=WITH.exec(text.trim());if(!m)return null;
 const head=m[1]!.trim(),who=m[2]!.replace(COMPANION_TAIL,'').trim();if(!who)return null;
 const seatWords=tokens(parseCapability(head,new Set([...caps.map(c=>c.verb),'sit'])).rest).filter(w=>w!=='down');if(!seatWords.length)return null;
 const whoWords=tokens(who);
 if(known.some(p=>{const ws=words([...names(p),...(p.parts??[]).filter(part=>knownPart(L,soul,p,part)).flatMap(x=>[x.title,...(x.aliases??[])])]);return whoWords.some(w=>ws.has(w));}))return null;
 // (each name the way together/1 splits them; a name no Soul in this world has is named as missing, alone)
 const list=who.split(/\s*(?:,|\band\b|&)\s*/i).map(x=>x.trim()).filter(Boolean),minds=[...L.host.minds.values()].filter(x=>x.soulId!==soul.soulId);
 const unknown=list.filter(n=>{const w=n.toLowerCase().replace(/^(?:the|my)\s+/,'');return !minds.some(x=>x.soulId===w||x.name.toLowerCase()===w);});
 const missing=unknown.length?unknown.join(', '):who,say=unknown.length?`"${missing}" is not read: no Soul you can invite from here is called that, and no seat is described that way. Nobody was invited.`:`"${who}" could not all be invited from here, so nobody was invited.`;
 const v=L.resolveOnDemand(soul,head,[...caps],new Map(plans)).v;
 const seat=(id:string)=>id.startsWith('sit:')&&!id.endsWith(':here');
 const candidates:Candidate[]=(v.kind!=='unknown'?(seat(v.cap.id)?[{capability:v.cap.id,name:v.cap.label,place:v.cap.target?.id??'',available:v.cap.available,...(v.cap.blocked?{reason:v.cap.blocked.reason,code:v.cap.blocked.code}:{})}]:[])
  :v.discovery?.kind==='interaction'?((v.discovery.candidates as Candidate[]|undefined)??[]):[]).filter(c=>seat(c.capability));
 return choice('interaction','sit',candidates,candidates.length?`${say} The seat words alone ("${head}") name ${candidates.map(c=>`${c.name} (${c.capability})`).join(', ')}: choose one by its exact sit capability ID. No seat has been selected.`:`${say} No bound sit action matches the rest either; no nearby seat or walk was substituted.`,{unresolved:{with:missing}});
}

/** Explore accepts bare purpose words as well as sentences. Bare words must all be
 * supported by one candidate's authored facts; never discard a missing name/qualifier. */
export function exploreDiscovery(L:EdgeLedger,soul:EdgeSoul,query:string,caps:EdgeCapability[],plans:Parameters<EdgeLedger['resolveOnDemand']>[3]):VocabResult|null{
 const direct=semanticDiscovery(L,soul,query,caps,plans,false);if(direct)return direct;
 if(query.includes(':'))return null;
 const result=semanticDiscovery(L,soul,`a place for ${query}`,caps,plans);
 if(!result||result.kind!=='unknown'||result.discovery?.kind!=='purpose')return null;
 const candidates=(result.discovery.candidates as Candidate[]).filter(c=>!c.unverified?.length);
 return candidates.length?choice('purpose',query,candidates,result.reason,{note:result.discovery.note}):null;
}
