// The v2 page's stream reader, copied as it is into ./source/ (#4153, X1): its worker fetches the stream's pointer and parts and plays them
// on the replica's WASM. #4177: the replica is the one the front door serves beside the world's page (`replica` is
// replica-served.ts unless V2_REPLICA_PKG bundles a package), so its address is posted to the worker first.
// #4986: a replica on the asset CDN (replica-cdn.ts) is posted with the origin's copy of it, the worker's fallback.
import { replicaOrigin } from './replica-cdn.ts';
declare const __SIM_V2_REPLICA_SERVED__: boolean | undefined;   // vite.config.ts: false when V2_REPLICA_PKG bundles one
const address = (replica: string) => { const origin = replicaOrigin(replica); return origin ? { replica, replicaOrigin: origin } : { replica }; };
export const makeReader = (replica: string) => {
  const worker = new Worker(new URL('./source/worker.ts', import.meta.url), { type: 'module' });
  if (typeof __SIM_V2_REPLICA_SERVED__ === 'undefined' || __SIM_V2_REPLICA_SERVED__) worker.postMessage(address(replica));
  return worker;
};
/** R2: the history worker (history-worker.ts), given the same served replica. */
export const makeHistoryReader = (replica: string) => {
  const worker = new Worker(new URL('./history-worker.ts', import.meta.url), { type: 'module' });
  if (typeof __SIM_V2_REPLICA_SERVED__ === 'undefined' || __SIM_V2_REPLICA_SERVED__) worker.postMessage(address(replica));
  return worker;
};
