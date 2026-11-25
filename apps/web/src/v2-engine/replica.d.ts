// R2: the `replica` module as the page's history worker and stream reader use it (vite.config.ts aliases it to the served replica,
// replica-served.ts, or to a bundled package; wasm-bindgen's own replica.d.ts says the same).
declare module 'replica' {
  export default function init(): Promise<unknown>;
  // X1: the stream reader (source/worker.ts) plays parts with these (wasm-bindgen's replica.d.ts, the parts used)
  export class StreamPlayer {
    constructor(header: Uint8Array | number[]);
    static fromBaseline(header: Uint8Array | number[], baseline: Uint8Array | number[]): StreamPlayer;
    free(): void;
    cross(generation: string, digest: string): void;
    events(): Uint8Array;
    next(): bigint;
    playDeferred(bytes: Uint8Array | number[]): string;
    play(bytes: Uint8Array | number[]): string;
    publicHash(): string;
    query(query: Uint8Array | number[]): Uint8Array;
    samples(): string;
    snapshot(): Uint8Array;
    verify(): void;
  }
  export function readPointer(bytes: Uint8Array | number[]): string;
  export function historyAt(header: Uint8Array, bundle: Uint8Array, sha256: Uint8Array, at: bigint, withHash: boolean): Uint8Array;
  /** K4 (0.135): a course's `[x, y, z, vx, vy, vz]` µm and µm a second at world time `t` µs (both workers, course-samples.ts). */
  export function courseAt(field: Uint8Array, t: bigint): BigInt64Array;
}
