import type { MarsEngine } from './engine.ts';
import { humanBirthRequestSchema, type Engine, type EngineFactory, type HumanBirthProbe, type HumanBirthRequest, type Vec3 } from '@souls/engine-contract';

/** Run the existing native placer in an exact detached checkpoint. This never
 * accepts a birth, advances live time, reserves capacity or repairs old logs.
 * Non-resumable live work defers; invariant/codec errors remain errors. */
export function probeNativeHumanBirth(engine:Engine,factory:EngineFactory,raw:unknown):HumanBirthProbe {
  const request=humanBirthRequestSchema.parse(raw);
  if(!engine.rulesVersion.startsWith('sim-mars/1+')||!factory.rulesVersion.startsWith('sim-mars/1+')
    ||(factory.rulesVersion!==engine.rulesVersion&&(factory.canRestoreSnapshot?.(engine.rulesVersion)!==true||factory.canReplayHistory?.(engine.rulesVersion)!==true)))
    throw new Error('Native birth probe requires the matching native engine factory');
  const base={schema:engine.schema,rulesVersion:engine.rulesVersion,tick:engine.world.tick,stateHash:engine.stateHash()};
  const common={contract:'detached-native-birth/1' as const,base,request};
  const existing=engine.world.entities[request.id];
  if(existing){
    if(existing.kind==='human'&&existing.human?.soul===request.soul&&existing.label===request.label)
      return {...common,outcome:'existing',position:[...existing.pose.p]};
    return {...common,outcome:'unavailable',diagnostic:{code:'birth.identity-conflict',message:'The entity id already belongs to a different body identity.'}};
  }
  if(!engine.canSnapshot?.())return {...common,outcome:'deferred',diagnostic:{code:'birth.checkpoint-required',message:'Current native activity has no exact resumable checkpoint.'}};
  const snapshot=engine.snapshot() as ReturnType<Engine['snapshot']>&{dropped?:number};
  if(snapshot.dropped!==0||snapshot.tick!==base.tick||snapshot.stateHash!==base.stateHash)
    throw new Error('Native birth checkpoint is not exact');
  const detached=factory.restore(snapshot);
  if(detached.rulesVersion!==engine.rulesVersion||detached.stateHash()!==base.stateHash)throw new Error('Native birth checkpoint did not restore exactly');
  try{
    try{detached.spawnHuman(request);}
    catch(error){
      if(error instanceof Error&&error.message==='no free standing room at the arrival point')
        return {...common,outcome:'unavailable',diagnostic:{code:'birth.arrival-unavailable',message:error.message}};
      throw error;
    }
    const body=detached.world.entities[request.id];
    if(!body||body.kind!=='human'||body.human?.soul!==request.soul)throw new Error('Native birth probe did not create the requested body identity');
    const issue=(detached as MarsEngine).humanBirthIssue(request.id);
    if(issue)return {...common,outcome:'unavailable',diagnostic:issue};
    return {...common,outcome:'ready',position:[...body.pose.p]};
  }finally{
    if(engine.stateHash()!==base.stateHash||engine.world.tick!==base.tick)throw new Error('Native birth probe changed the authoritative world');
  }
}

/** A13 (#2621): a native birth's outcome read on the live engine. The same answer as probeNativeHumanBirth (placement or
 * refusal, for the same reasons), without its full-world snapshot and restore: placement is spawnHuman's own search
 * (MarsEngine.birthPlacementV1), so the lifecycle guard that runs it in drainInputs, just before the birth applies with
 * no engine change between, answers for the very state the birth lands in. */
export type NativeBirthPlacement = {request:HumanBirthRequest} & (
  | {outcome:'ready'|'existing';position:Vec3}
  | {outcome:'deferred'|'unavailable';diagnostic:{code:string;message:string}}
);
export function placeNativeHumanBirth(engine:Engine,raw:unknown):NativeBirthPlacement {
  const request=humanBirthRequestSchema.parse(raw);
  if(!engine.rulesVersion.startsWith('sim-mars/1+'))throw new Error('Native birth placement requires a native engine');
  const existing=engine.world.entities[request.id];
  if(existing){
    if(existing.kind==='human'&&existing.human?.soul===request.soul&&existing.label===request.label)
      return {request,outcome:'existing',position:[...existing.pose.p]};
    return {request,outcome:'unavailable',diagnostic:{code:'birth.identity-conflict',message:'The entity id already belongs to a different body identity.'}};
  }
  // As the probe: a birth waits out native activity that has no exact resumable checkpoint (no rule change here).
  if(!engine.canSnapshot?.())return {request,outcome:'deferred',diagnostic:{code:'birth.checkpoint-required',message:'Current native activity has no exact resumable checkpoint.'}};
  const r=(engine as unknown as MarsEngine).birthPlacementV1(request);
  return r.ok?{request,outcome:'ready',position:[...r.p]}:{request,outcome:'unavailable',diagnostic:{code:r.diagnostic.code,message:r.diagnostic.message}};
}

/** The birth path's one entry. SIM_BIRTH_PROBE=1 decides by the detached probe instead (the A/B "off" arm);
 * SIM_BIRTH_PROBE=oracle decides on the live engine and throws on any difference from the probe. Read per call. */
export function nativeBirthPlacement(engine:Engine,factory:EngineFactory,raw:unknown):NativeBirthPlacement {
  const mode=process.env.SIM_BIRTH_PROBE;
  if(mode==='1')return withoutBase(probeNativeHumanBirth(engine,factory,raw));
  const live=placeNativeHumanBirth(engine,raw);
  if(mode==='oracle'){
    const probe=withoutBase(probeNativeHumanBirth(engine,factory,raw));
    if(JSON.stringify(probe)!==JSON.stringify(live))throw new Error(`native birth placement differs from the detached probe: ${JSON.stringify(live)} vs ${JSON.stringify(probe)}`);
  }
  return live;
}
function withoutBase(p:HumanBirthProbe):NativeBirthPlacement {
  const {contract:_contract,base:_base,...rest}=p;return rest;
}
