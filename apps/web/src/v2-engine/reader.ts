// The v2 page's stream reader, reused as it is (#4153): its worker fetches the stream's pointer and parts and plays them
// on the replica's WASM. #4177: the replica is the one the front door serves beside the world's page (`replica` is
// replica-served.ts unless V2_REPLICA_PKG bundles a package), so its address is posted to the worker first.
declare const __SIM_V2_REPLICA_SERVED__: boolean | undefined;   // vite.config.ts: false when V2_REPLICA_PKG bundles one
export const makeReader = (replica: string) => {
  const worker = new Worker(new URL('../../../../v2/web/src/source/worker.ts', import.meta.url), { type: 'module' });
  if (typeof __SIM_V2_REPLICA_SERVED__ === 'undefined' || __SIM_V2_REPLICA_SERVED__) worker.postMessage({ replica });
  return worker;
};
