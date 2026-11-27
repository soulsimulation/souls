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

/** #4986 review: a CDN copy whose module has not loaded this long after the worker asked is taken as hung, and the
 *  origin's copy is loaded instead. 8 s, as the page's own (phased-entry.ts APP_CDN_HANG_MS): replica.js is the small
 *  glue (the 2.4 MB WASM comes after it, untimed), so a link that cannot bring it in 8 s is not slow but stuck, and the
 *  head script asked the CDN for it before the page's code had even run. */
export const REPLICA_CDN_HANG_MS = 8_000;

/** Loads the served replica.js, which fetches replica_bg.wasm beside itself (wasm-bindgen's `--target web` init).
 *  #4986: an address on the asset CDN carries the origin's copy after a `#` (`<cdn address>#<origin path>`,
 *  replica-cdn.ts): that one is loaded when the CDN's does not load (its module, in REPLICA_CDN_HANG_MS, or its WASM),
 *  so a viewer whose network cannot reach the CDN still gets the stream. */
export default async function init(): Promise<void> {
  const url = await served, at = url.indexOf('#'), origin = at < 0 ? '' : url.slice(at + 1);
  const load = async (from: string, hang = 0) => {
    let timer: ReturnType<typeof setTimeout> | undefined;
    const module = import(/* @vite-ignore */ from) as Promise<Replica>;
    const m = await (hang ? Promise.race([module, new Promise<never>((_, no) => { timer = setTimeout(() => no(Error(`replica: ${from} did not load in ${hang} ms`)), hang); })]).finally(() => clearTimeout(timer)) : module);
    await m.default(); return m;
  };
  const m = await (at < 0 ? load(url) : load(url.slice(0, at), REPLICA_CDN_HANG_MS).catch((error: unknown) => {
    if (!/^\/(?!\/)[A-Za-z0-9._/-]+\/replica\.js$/.test(origin) || origin.includes('..')) throw error;
    return load(new URL(origin, location.origin).href);
  }));
  ({ StreamPlayer, readPointer, historyAt, courseAt } = m);
}
