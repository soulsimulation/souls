import{opSchema,type Op,type Entity,type WorldModel}from'@souls/world-compiler';
import{LEAF_CLUMPS,LEAF_START}from'../../../../packages/world-compiler/src/core-kit/leaf-art.ts';
import type{EdgeReceipt,EdgeSoul}from'../edge/contract.ts';
import{ACT_REACH}from'./actuators.ts';
type Soul=Pick<EdgeSoul,'soulId'|'entityId'|'name'>;type Refusal={code:string;reason:string};
type Body={pose?:{p:number[]};support?:{kind?:string;by?:string;on?:string};human?:{holding?:unknown;hands?:unknown;handActuator?:unknown}};
export type LeafArtHost={model:WorldModel;engine:{world:{tick:number;entities:Record<string,Body>};clearanceAtV1?(x:number,z:number,level?:number):number};levelAt(x:number,z:number,y:number):number;soul(id:string):{id:string;entity_id:string;name:string}|undefined;denied(id:string,soul:Soul):Refusal|null;commit(ops:Op[],note:string):{accepted:boolean};log(s:string):void};
type Choice={clump:typeof LEAF_CLUMPS[number];x:number;z:number}|'recover';type Capture={source:string;action:string;body:string;soul:string;stamp:string;choice:Choice;tick:number};
const numeric=(n:unknown):n is number=>typeof n==='number'&&Number.isFinite(n)&&n>=-.4&&n<=.4;
export function createLeafArt(h:LeafArtHost){
 const pending=new Map<string,Capture>(),started=new Map<string,Capture>();
 const target=(id:string)=>{const e=h.model.entities.get(id),d=e&&h.model.resolvedDef(e.def);return d?.name==='core-leaf-art'&&d.version===1?e!:null;};
 const stamp=(e:Entity)=>JSON.stringify([e.def,e.in,e.owner,e.access,e.state,e.params,h.model.worldPose(e),h.engine.world.entities[e.id]?.pose,h.engine.world.entities[e.id]?.support]);
 const coordinate=(v:unknown)=>typeof v==='string'&&/^[+-]?(?:\d+(?:\.\d*)?|\.\d+)$/.test(v)?Number(v):NaN;
 const choice=(action:string,p:Record<string,unknown>):Choice|null=>{if(action==='recover')return'recover';const x=coordinate(p.x??'0'),z=coordinate(p.z??'0'),clump=p.clump??'a';return action==='arrange'&&LEAF_CLUMPS.includes(clump as never)&&numeric(x)&&numeric(z)?{clump:clump as typeof LEAF_CLUMPS[number],x,z}:null;};
 const fail=(reason:string)=>({code:'object.state',reason});
 function ready(soul:Soul,id:string):Refusal|null{const e=target(id);if(!e)return{code:'object.gone',reason:'The leaf garden patch is no longer there.'};const no=h.denied(id,soul);if(no)return no;
  if(e.state?.leaves!==12||!Object.keys(LEAF_START).every(k=>numeric(e.state?.[k])&&e.state?.[k]===(e.params?.[k]??LEAF_START[k as keyof typeof LEAF_START])))return fail('This patch has unsupported leaf material or positions; nothing was moved.');
  const b=h.engine.world.entities[soul.entityId];if(!b?.human||!b.pose?.p)return{code:'body.unavailable',reason:'Your body is unavailable.'};
  if(b.human.holding||b.human.hands||b.human.handActuator||Object.values(h.engine.world.entities).some(v=>v.support?.kind==='in-hand'&&v.support.by===soul.entityId))return fail('Put down what you hold before arranging the leaves.');return null;}
 function plan(soul:EdgeSoul,id:string,action:string,p:Record<string,unknown>={}){if(!target(id)||!['arrange','recover'].includes(action))return null;const no=ready(soul,id);if(no)return no;const q=choice(action,p);if(!q)return fail('Choose clump a, b, c or d and finite local x/z from -0.4 to 0.4.');
  const e=target(id)!;if(q==='recover'&&Object.entries(LEAF_START).every(([k,v])=>e.state?.[k]===v))return fail('The same leaves are already in their initial scatter.');
  const wp=h.model.worldPose(e),worker=h.model.resolvedDef(e.def)!.slots.find(s=>s.id==='worker')!,c=Math.cos(wp.yaw),s=Math.sin(wp.yaw),x=wp.x+(worker.p[0]*c+worker.p[2]*s)*wp.s,z=wp.z+(-worker.p[0]*s+worker.p[2]*c)*wp.s,level=h.levelAt(x,z,wp.y);
  if(h.engine.clearanceAtV1&&h.engine.clearanceAtV1(x,z,level)<.4)return fail('Clear the ordinary standing point at the front of this leaf patch first.');
  return{summary:'Four completed seconds arrange the same twelve leaves; current clump coordinates remain discoverable.',steps:[{verb:'stand',params:{}},{verb:'mars:walk_to',params:{x,z,level}},{verb:'mars:pose_v1',params:{activity:'chalk',prop:'brush',seconds:4,face:[wp.x,wp.z]}},{verb:'stand',params:{}}]};}
 function begin(soul:EdgeSoul,id:string,action:string,p:Record<string,unknown>={}){const q=choice(action,p),e=target(id);if(q&&e&&!ready(soul,id))pending.set(soul.soulId,{source:id,action,body:soul.entityId,soul:soul.soulId,stamp:stamp(e),choice:q,tick:h.engine.world.tick});}
 function onReceipt(r:EdgeReceipt){const m=/^object:(.+):(arrange|recover)$/.exec(r.capability);if(!m)return;
  if(r.phase==='started'){const q=pending.get(r.soulId);pending.delete(r.soulId);if(q?.source===m[1]&&q.action===m[2])started.set(r.id,q);return;}
  if(!['completed','failed','replaced','aborted','cancelled'].includes(r.phase))return;const q=started.get(r.id);started.delete(r.id);const p=pending.get(r.soulId);if(p?.source===m[1]&&p.action===m[2])pending.delete(r.soulId);if(r.phase!=='completed'||!q||q.source!==m[1]||q.action!==m[2]||!Number.isSafeInteger(r.endedTick)||r.endedTick!<q.tick+80)return;
  const soul=h.soul(r.soulId),e=target(q.source);if(!soul||soul.id!==q.soul||soul.entity_id!==q.body||!e||stamp(e)!==q.stamp||ready({soulId:soul.id,entityId:soul.entity_id,name:soul.name},e.id)||e.state?.lastReceipt===r.id||r.endedTick!<Number(e.state?.lastCompletedTick??-1))return;
  const at=h.engine.world.entities[q.body]?.pose?.p,wp=h.model.worldPose(e);if(!at||Math.hypot(at[0]-wp.x,at[2]-wp.z)>ACT_REACH||h.levelAt(at[0],at[2],at[1])!==h.levelAt(wp.x,wp.z,wp.y))return;
  const positions=q.choice==='recover'?{...LEAF_START}:{[q.choice.clump+'x']:q.choice.x,[q.choice.clump+'z']:q.choice.z},state={...positions,moves:Number(e.state?.moves)+1,lastBy:soul.name.slice(0,80),lastReceipt:r.id,lastCompletedTick:r.endedTick};
  if(!h.commit([opSchema.parse({op:'set',id:e.id,params:positions,state})],`${r.soulId} arranged the same twelve fallen leaves`).accepted)h.log('leaf-art: world refused arrangement; previous material remains unchanged');}
 return{plan,begin,onReceipt,facts(id:string){const e=target(id);return e?{leafArt:`12 integral leaves, four clumps of three. ${LEAF_CLUMPS.map(c=>`${c}: (${e.state?.[c+'x']}, ${e.state?.[c+'z']})`).join('; ')}. Completed arrangements ${e.state?.moves}; last worker ${e.state?.lastBy||'none'}. Empty hands; choose local x/z in [-0.4,0.4], 4 seconds completed garden work; recover reuses the same leaves.`}:null;}};
}
export type LeafArt=ReturnType<typeof createLeafArt>;
