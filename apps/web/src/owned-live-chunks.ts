import {recordedTakeChunkSchema,type RecordedTakeChunk} from '@souls/protocol';
// Only this module can brand a validated, detached, deeply immutable wire chunk.
// Mutable caller objects are never identity-cached or frozen in place.
const owned=new WeakSet<object>();
// A built world carries its static physics (entityPhysicsV1: every building's floors, walls and stairs) in each take's
// final state: Eden 2026 (3.5k entities, 244 furnished buildings) is ~290k nodes. The old 200k cap silently dropped
// every live chunk there, so the viewer never drew a first frame. 2M keeps a bound against runaway data.
export const LIVE_CHUNK_NODE_BUDGET=2_000_000;
// take-entities-ref/1 (L3e): the socket decoder shares one deeply frozen entity table between chunks that carry the same
// world, so each entity's owned copy is made once and reused (Eden 2026: ~4,900 entities, ~40 ms desktop / ~160 ms phone a
// chunk otherwise). Only deeply frozen source values are cached: they cannot change, so they are their own exact copy.
const sharedEntity=new WeakMap<object,{value:unknown;nodes:number}>(),cachedOwned=new WeakSet<object>();
/** P2 phones (arrival): a deeply frozen, plain, acyclic, finite source entity is its own owned copy. It cannot change, so
 *  copying it (and walking it twice more to check and to freeze the copy) bought nothing: those three walks were most of a
 *  4x phone's snapshot-adoption task (~120 MB allocated per local Eden 2026 arrival). One walk checks exactly what
 *  detachedData would refuse and counts its nodes; anything unfrozen is still copied as before. Returns the node count, or
 *  -1 when some part is not frozen (the caller copies). Throws what detachedData throws. */
function frozenPlainNodes(value:unknown,ancestors:Set<object>,depth:number):number{
 if(depth>64)throw Error('Live chunk data budget');
 if(value===null||value===undefined||typeof value==='string'||typeof value==='boolean')return 1;
 if(typeof value==='number'){if(!Number.isFinite(value))throw Error('Nonfinite live chunk');return 1;}
 if(typeof value!=='object'||ancestors.has(value))throw Error('Live chunk plain acyclic data required');
 if(!Object.isFrozen(value))return -1;
 const array=Array.isArray(value),prototype=Object.getPrototypeOf(value);
 if(prototype!==(array?Array.prototype:Object.prototype)&&prototype!==null)throw Error('Live chunk plain data required');
 ancestors.add(value);let nodes=1;
 try{for(const key of Reflect.ownKeys(value)){
  if(array&&key==='length')continue;if(typeof key!=='string')throw Error('Live chunk symbol');
  const property=Object.getOwnPropertyDescriptor(value,key);if(!property||!Object.hasOwn(property,'value'))throw Error('Live chunk accessor');
  // a hidden key or an own __proto__ is copied by detachedData with defineProperty; keep that path for them
  if(!property.enumerable||key==='__proto__')return -1;
  const n=frozenPlainNodes(property.value,ancestors,depth+1);if(n<0)return -1;nodes+=n;
 }}finally{ancestors.delete(value);}
 return nodes;
}
function detachedEntity(value:unknown,ancestors:Set<object>,budget:{nodes:number},depth:number):unknown{
 if(!value||typeof value!=='object')return detachedData(value,ancestors,budget,depth);
 const hit=sharedEntity.get(value);
 if(hit){if((budget.nodes+=hit.nodes)>LIVE_CHUNK_NODE_BUDGET)throw Error('Live chunk data budget');return hit.value;}
 const nodes=frozenPlainNodes(value,ancestors,depth);
 if(nodes>=0){if((budget.nodes+=nodes)>LIVE_CHUNK_NODE_BUDGET)throw Error('Live chunk data budget');cachedOwned.add(value);sharedEntity.set(value,{value,nodes});return value;}
 return detachedData(value,ancestors,budget,depth);
}
/** The shared table itself (take-entities-ref/1): a frozen table whose every entity is reused as above is reused too, and
 *  cached, instead of being rebuilt key by key (~4,900 keys on Eden 2026) and frozen again for every live chunk. Returns
 *  null when any part needs copying; the caller then copies exactly as before. */
function detachedTable(value:object,ancestors:Set<object>,budget:{nodes:number},depth:number):object|null{
 if(!Object.isFrozen(value)||Array.isArray(value))return null;
 const hit=sharedEntity.get(value);
 if(hit){if((budget.nodes+=hit.nodes)>LIVE_CHUNK_NODE_BUDGET)throw Error('Live chunk data budget');return hit.value as object;}
 const prototype=Object.getPrototypeOf(value);if(prototype!==Object.prototype&&prototype!==null)return null;
 const before=budget.nodes;
 if(++budget.nodes>LIVE_CHUNK_NODE_BUDGET||depth>64)throw Error('Live chunk data budget');
 ancestors.add(value);
 try{for(const key of Reflect.ownKeys(value)){
  const property=typeof key==='string'&&key!=='__proto__'?Object.getOwnPropertyDescriptor(value,key):undefined;
  if(!property||!property.enumerable||!Object.hasOwn(property,'value')){budget.nodes=before;return null;}
  if(detachedEntity(property.value,ancestors,budget,depth+1)!==property.value){budget.nodes=before;return null;}
 }}finally{ancestors.delete(value);}
 cachedOwned.add(value);sharedEntity.set(value,{value,nodes:budget.nodes-before});return value;
}
export function detachedData(value:unknown,ancestors=new Set<object>(),budget={nodes:0},depth=0,entities?:object):unknown{
 if(value===entities&&value&&typeof value==='object'){const table=detachedTable(value,ancestors,budget,depth);if(table)return table;}
 if(++budget.nodes>LIVE_CHUNK_NODE_BUDGET||depth>64)throw Error('Live chunk data budget');
 if(value===null||value===undefined||typeof value==='string'||typeof value==='boolean')return value;
 if(typeof value==='number'){if(!Number.isFinite(value))throw Error('Nonfinite live chunk');return value;}
 if(typeof value!=='object'||ancestors.has(value))throw Error('Live chunk plain acyclic data required');
 const array=Array.isArray(value),prototype=Object.getPrototypeOf(value);
 if(prototype!==(array?Array.prototype:Object.prototype)&&prototype!==null)throw Error('Live chunk plain data required');
 ancestors.add(value);const out:unknown[]|Record<string,unknown>=array?[]:{};
 try{for(const key of Reflect.ownKeys(value)){
  if(array&&key==='length')continue;if(typeof key!=='string')throw Error('Live chunk symbol');
  const property=Object.getOwnPropertyDescriptor(value,key);if(!property||!Object.hasOwn(property,'value'))throw Error('Live chunk accessor');
  const child=value===entities?detachedEntity(property.value,ancestors,budget,depth+1):detachedData(property.value,ancestors,budget,depth+1,entities);
  // F12: a plain assignment makes the same writable, configurable property (and keeps the copy a fast object); only a
  // hidden key or an own __proto__ needs defineProperty.
  if(property.enumerable&&key!=='__proto__')(out as Record<string,unknown>)[key]=child;
  else Object.defineProperty(out,key,{value:child,enumerable:property.enumerable,writable:true,configurable:true});
 }}finally{ancestors.delete(value);}
 return out;
}
// Freezes this module's own copies (detachedData's and the schema's output: plain data properties only, so a direct read
// is the value) bottom-up. A frozen node is already deeply frozen here (a checked source entity, or a node this froze), so
// the walk stops there instead of reading every property descriptor of the shared entities again.
function freeze(value:unknown){if(value&&typeof value==='object'&&!cachedOwned.has(value)&&!Object.isFrozen(value)){for(const key of Reflect.ownKeys(value))freeze((value as Record<PropertyKey,unknown>)[key]);Object.freeze(value);}}
// The viewer never reads a take's static physics (it draws geometry from /v1/scene); copying, validating and freezing
// it per live chunk cost ~120 ms a chunk on Eden 2026. Drop it from the owned copy only when every hop is plain data.
const dataOf=(value:unknown,key:string)=>{if(!value||typeof value!=='object'||Array.isArray(value))return undefined;const d=Object.getOwnPropertyDescriptor(value,key);return d&&Object.hasOwn(d,'value')?d.value as unknown:undefined;};
export function withoutStaticPhysics(raw:unknown):unknown{
 const take=dataOf(raw,'take'),state=dataOf(take,'finalState');
 if(!state||typeof state!=='object'||!Object.hasOwn(state,'entityPhysicsV1')||dataOf(state,'entityPhysicsV1')===undefined)return raw;
 const plain=(o:object)=>Reflect.ownKeys(o).every(k=>typeof k==='string'&&Object.hasOwn(Object.getOwnPropertyDescriptor(o,k)!,'value'));
 if(!plain(raw as object)||!plain(take as object)||!plain(state))return raw;
 const {entityPhysicsV1:_omit,...rest}=state as Record<string,unknown>;
 return {...(raw as object),take:{...(take as object),finalState:rest}};
}
export function ownLiveChunk(raw:unknown):RecordedTakeChunk|null{
 if(raw&&typeof raw==='object'&&owned.has(raw))return raw as RecordedTakeChunk;
 try{const chunk=withoutStaticPhysics(raw),table=dataOf(dataOf(dataOf(chunk,'take'),'finalState'),'entities');
  const copy=detachedData(chunk,undefined,undefined,0,table&&typeof table==='object'?table:undefined);
  // A reused shared table (detachedTable: frozen, every key a string with a checked plain value) already is what the
  // schema's z.record(string, unknown) would accept; parsing it rebuilt a ~4,900-key object for every chunk. The schema
  // checks the rest of the chunk with an empty table, and the shared one is put back.
  const shared=dataOf(dataOf(dataOf(copy,'take'),'finalState'),'entities'),reused=shared&&typeof shared==='object'&&cachedOwned.has(shared)?shared:null;
  type Loose={take:{finalState:Record<string,unknown>}}&Record<string,unknown>;
  const input=reused?{...(copy as Loose),take:{...(copy as Loose).take,finalState:{...(copy as Loose).take.finalState,entities:{}}}}:copy;
  const result=recordedTakeChunkSchema.safeParse(input);if(!result.success)return null;
  if(reused)(result.data.take.finalState as Record<string,unknown>).entities=reused;
  freeze(result.data);owned.add(result.data);return result.data;}catch{return null;}
}
export function ownedLiveChunk(raw:unknown):RecordedTakeChunk|null{return raw&&typeof raw==='object'&&owned.has(raw)?raw as RecordedTakeChunk:null;}
