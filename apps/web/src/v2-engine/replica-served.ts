// #4177: the new engine's replica (WASM) for the v2 reader's worker (vite.config.ts aliases `replica` here unless
// V2_REPLICA_PKG names a package to bundle). The page does not carry it: it loads the copy the front door serves for a
// world routed to v2 (`<world>/replica.js` and `replica_bg.wasm`, the deployed v2 client's own files; the launcher's
// cutover.mjs), so its bytes are always the running world's. The page's reader (reader.ts) posts that address to the
// worker before the stream; it is taken here, ahead of the worker's own handler.
type Replica = { default: () => Promise<unknown>; StreamPlayer: unknown; readPointer: unknown; historyAt: unknown; courseAt: unknown };

// #4986: `replicaOrigin` is the origin's copy of a replica posted from the asset CDN (reader.ts), loaded when the CDN's
// does not load (its module or its WASM): a viewer whose network cannot reach the CDN still gets the stream.
type Address = { url: string; origin?: string };
let address: (a: Address) => void = () => {};
const served = new Promise<Address>((y) => { address = y; });
(globalThis as unknown as { addEventListener?: (type: 'message', f: (e: MessageEvent) => void) => void }).addEventListener?.('message', (e) => {
  const data = e.data as { replica?: unknown; replicaOrigin?: unknown } | null, url = data?.replica;
  if (typeof url !== 'string') return;
  e.stopImmediatePropagation();
  address(typeof data?.replicaOrigin === 'string' && data.replicaOrigin !== url ? { url, origin: data.replicaOrigin } : { url });
});

// Live bindings: set by init(), which the worker awaits before it plays anything (v2/web/src/source/worker.ts run()).
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export let StreamPlayer: any;
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export let readPointer: any;
/** R2: a past moment, for the old page's history worker (history-worker.ts). */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export let historyAt: any;
/** K4 (0.135): where a thing on a course is, for both workers (course-samples.ts). */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export let courseAt: any;

/** Loads the served replica.js, which fetches replica_bg.wasm beside itself (wasm-bindgen's `--target web` init). */
export default async function init(): Promise<void> {
  const { url, origin } = await served;
  const load = async (from: string) => { const m = await import(/* @vite-ignore */ from) as Replica; await m.default(); return m; };
  const m = await load(url).catch((error: unknown) => { if (!origin) throw error; return load(origin); });
  ({ StreamPlayer, readPointer, historyAt, courseAt } = m);
}
