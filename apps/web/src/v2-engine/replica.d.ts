// R2: the `replica` module as the page's history worker uses it (vite.config.ts aliases it to the served replica,
// replica-served.ts, or to a bundled package; wasm-bindgen's own replica.d.ts says the same).
declare module 'replica' {
  export default function init(): Promise<unknown>;
  export function historyAt(header: Uint8Array, bundle: Uint8Array, sha256: Uint8Array, at: bigint, withHash: boolean): Uint8Array;
}
