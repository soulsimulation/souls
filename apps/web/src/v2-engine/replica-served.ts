// #4177: the new engine's replica (WASM) for the v2 reader's worker (vite.config.ts aliases `replica` here unless
// V2_REPLICA_PKG names a package to bundle). The page does not carry it: it loads the copy the front door serves for a
// world routed to v2 (`<world>/replica.js` and `replica_bg.wasm`, the deployed v2 client's own files; the launcher's
// cutover.mjs), so its bytes are always the running world's. The page's reader (reader.ts) posts that address to the
// worker before the stream; it is taken here, ahead of the worker's own handler.
type Replica = { default: () => Promise<unknown>; StreamPlayer: unknown; readPointer: unknown; historyAt: unknown; courseAt: unknown };

let address: (url: string) => void = () => {};
const served = new Promise<string>((y) => { address = y; });
(globalThis as unknown as { addEventListener?: (type: 'message', f: (e: MessageEvent) => void) => void }).addEventListener?.('message', (e) => {
  const url = (e.data as { replica?: unknown } | null)?.replica;
  if (typeof url !== 'string') return;
  e.stopImmediatePropagation();
  address(url);
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

/** Loads the served replica.js, which fetches replica_bg.wasm beside itself (wasm-bindgen's `--target web` init).
 *  #4986: an address on the asset CDN carries the origin's copy after a `#` (`<cdn address>#<origin path>`,
 *  replica-cdn.ts): that one is loaded when the CDN's does not load (its module or its WASM), so a viewer whose network
 *  cannot reach the CDN still gets the stream. */
export default async function init(): Promise<void> {
  const url = await served, at = url.indexOf('#'), origin = at < 0 ? '' : url.slice(at + 1);
  const load = async (from: string) => { const m = await import(/* @vite-ignore */ from) as Replica; await m.default(); return m; };
  const m = await load(at < 0 ? url : url.slice(0, at)).catch((error: unknown) => {
    if (!/^\/(?!\/)[A-Za-z0-9._/-]+\/replica\.js$/.test(origin) || origin.includes('..')) throw error;
    return load(new URL(origin, location.origin).href);
  });
  ({ StreamPlayer, readPointer, historyAt, courseAt } = m);
}
