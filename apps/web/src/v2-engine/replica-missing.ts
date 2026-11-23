// Stands in for the new engine's replica (WASM) when this build was made without it (V2_REPLICA_PKG unset, the default
// build and the bundle gate's): the v2 reader's worker then reports this, and the page shows no Souls from it.
const missing = () => { throw new Error('this page was built without the v2 replica (set V2_REPLICA_PKG to its wasm-bindgen package)'); };
export default async function init(): Promise<never> { return missing(); }
export const StreamPlayer = missing;
export const readPointer = missing;
