import type {Engine,EngineFactory,EngineSnapshot} from '@souls/engine-contract';
import {MarsEngine} from './engine.ts';
import {SOULS_REPAIR_POLICY} from './refuse.ts';

const TAG='+'+SOULS_REPAIR_POLICY;
const marks=(v:string)=>v.split(TAG).length-1;
const strip=(v:string)=>v.replace(TAG,'');

/** #1323: the repair rules (`souls-repair/1`, #1150) on by default for a world the server runs, however old its history.
 *  `inner` is the world's own reader without them, exactly as 4.16 ran it. This reader replays and restores a history under
 *  the rules it was written with, and also the same history after its one logged adoption (`soulsRepairAdoptV1`, which the
 *  host writes at the head, WorldHost.adoptSoulsRepairV1). A snapshot restores under the policy it was taken with. One way:
 *  `inner` alone can't read an adopted history. `adopt: false` (`SIM_SOULS_REPAIR=0`) reads both, replays a logged adoption and proposes none.
 *  An `inner` that already has the rules (`SIM_SOULS_REPAIR=1`, shared building) is returned as it is, as in 4.16. */
export function soulsRepairReaderV1(inner:EngineFactory,options:{adopt:boolean}):EngineFactory{
  if(inner.rulesVersion.includes(TAG))return inner;
  const install=(e:Engine)=>{if(!(e instanceof MarsEngine))throw Error('souls-repair-adoption.native-required');e.enableSoulsRepairAdoptionReaderV1(options.adopt);return e;};
  return {...inner,
    canReplayHistory:v=>marks(v)<=1&&(inner.canReplayHistory?inner.canReplayHistory(strip(v))===true:true),
    canRestoreSnapshot:v=>marks(v)<=1&&(strip(v)===inner.rulesVersion||inner.canRestoreSnapshot?.(strip(v))===true),
    create:w=>install(inner.create(w)),
    restore(raw:EngineSnapshot){
      const cfg=(raw as EngineSnapshot&{cfg?:{soulsRepairV1?:unknown}}).cfg;
      if(cfg?.soulsRepairV1!==true)return install(inner.restore(raw));
      // the readers below know the history without the rules; the state hash doesn't name them, so their checks still hold
      const s=structuredClone(raw) as EngineSnapshot&{cfg:{soulsRepairV1?:boolean}};delete s.cfg.soulsRepairV1;
      const e=install(inner.restore(s));
      (e as MarsEngine).restoredUnderSoulsRepairV1();
      if(e.stateHash()!==raw.stateHash)throw Error('souls-repair-adoption.snapshot-state');
      return e;
    },
    validateHistoryHead(e,recorded){
      const n=marks(recorded);
      if(n>1)throw Error('souls-repair-adoption.history-head');
      if(n===0)return inner.validateHistoryHead?.(e,recorded);
      if(e.rulesVersion!==recorded||!(e instanceof MarsEngine))throw Error('souls-repair-adoption.history-head');
      // the readers below check the head they know: the same engine, read without the rules' name
      inner.validateHistoryHead?.(Object.create(e,{rulesVersion:{value:strip(recorded)}}) as Engine,strip(recorded));
    },
  };
}
