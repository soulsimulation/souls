// The v2 page's stream reader, copied as it is into ./source/ (#4153, X1): its worker fetches the stream's pointer and parts and plays them
// on the replica's WASM. #4177: the replica is the one the front door serves beside the world's page (`replica` is
// replica-served.ts unless V2_REPLICA_PKG bundles a package), so its address is posted to the worker first.
declare const __SIM_V2_REPLICA_SERVED__: boolean | undefined;   // vite.config.ts: false when V2_REPLICA_PKG bundles one
export const makeReader = (replica: string) => {
  const worker = new Worker(new URL('./source/worker.ts', import.meta.url), { type: 'module' });
  if (typeof __SIM_V2_REPLICA_SERVED__ === 'undefined' || __SIM_V2_REPLICA_SERVED__) worker.postMessage({ replica });
  return worker;
};
/** R2: the history worker (history-worker.ts), given the same served replica. */
export const makeHistoryReader = (replica: string) => {
  const worker = new Worker(new URL('./history-worker.ts', import.meta.url), { type: 'module' });
  if (typeof __SIM_V2_REPLICA_SERVED__ === 'undefined' || __SIM_V2_REPLICA_SERVED__) worker.postMessage({ replica });
  return worker;
};
/** K4 (0.135): the replica's `courseAt` on the page's own thread (a balloon's place along its course), from the served
 *  replica, or the bundled one where V2_REPLICA_PKG bundles it. */
export const loadCourseAt = async (replica: string): Promise<(field: Uint8Array, t: bigint) => ArrayLike<bigint>> => {
  const served = typeof __SIM_V2_REPLICA_SERVED__ === 'undefined' || __SIM_V2_REPLICA_SERVED__;
  const m = (served ? await import(/* @vite-ignore */ replica) : await import('replica')) as { default: () => Promise<unknown>; courseAt: (field: Uint8Array, t: bigint) => ArrayLike<bigint> };
  await m.default();
  return m.courseAt;
};
