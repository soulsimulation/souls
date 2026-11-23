// The v2 page's stream reader, reused as it is (#4153): its worker fetches the stream's pointer and parts and plays them
// on the replica's WASM. The build bundles it (and the WASM, when V2_REPLICA_PKG names the package) from v2/web.
export const makeReader = () => new Worker(new URL('../../../../v2/web/src/source/worker.ts', import.meta.url), { type: 'module' });
