// W2 (0.135): the one hand-off between the v2 hook and the entity layer for a world drawn from its stream
// (stream-scene.ts builds the snapshot; WorldEntityLayer draws it). Kept apart and small: the layer loads it with the
// page, and nothing here pulls the stream's reader or the library into the layer's chunk.
import { TILE_N, tileKey, type Terrain } from '@souls/ground';
import type { StreamSnapshot } from './stream-scene.ts';

/** Whether the page reads a v2 stream (its inline config names one; use-v2-souls.ts `v2Stream` checks its form). Read
 *  when the page's code loads: main.tsx takes the inline config away before the layer starts. */
const BOUND = typeof window !== 'undefined' && typeof (window as unknown as { __simConfig?: { v2Stream?: unknown } }).__simConfig?.v2Stream === 'string';

/** Whether this page reads a v2 stream. */
export const streamBound = (): boolean => BOUND;
/** Whether this page asks for the old world's views (`/v1/world/snapshot`, `/v1/scene`, `/v1/edge/items`,
 *  `/v1/edge/platforms`, `/v1/kernel`): always on an old-engine world; on a v2 world unless its inline config says none
 *  are published (`v2Views: false`, tools/world-launcher/cutover.mjs v2Fields), where each would answer 404 and the
 *  page draws the world from its stream. */
const VIEWS = typeof window !== 'undefined' ? (window as unknown as { __simConfig?: { v2Views?: unknown } }).__simConfig?.v2Views : undefined;
export const oldViews = (): boolean => !BOUND || VIEWS !== false;

let offer: { promise: Promise<StreamSnapshot>; resolve(s: StreamSnapshot): void } | null = null;
const theOffer = () => {
  if (!offer) { let resolve!: (s: StreamSnapshot) => void; offer = { promise: new Promise((r) => { resolve = r; }), resolve }; }
  return offer;
};
/** The v2 hook hands the stream's snapshot over (once). */
export const offerScene = (s: StreamSnapshot): void => theOffer().resolve(s);
/** Whether this page draws its world from the stream though a captured snapshot is published (`?scene=stream`). */
export const streamSceneAsked = (): boolean => BOUND && typeof location !== 'undefined' && new URLSearchParams(location.search).get('scene') === 'stream';
/** The stream's snapshot once the stream has shown the open ground, on a page that reads one; null on any other page
 *  or when `signal` ends first. */
export function streamScene(signal: AbortSignal): Promise<StreamSnapshot | null> {
  if (!BOUND || signal.aborted) return Promise.resolve(null);
  return Promise.race([theOffer().promise, new Promise<null>((r) => signal.addEventListener('abort', () => r(null), { once: true }))]);
}

/** The terrain draws the stream's heights: each tile as the stream has it, flat at the base where it has none. */
export function fixTerrain(t: Terrain, heights: ReadonlyMap<string, Float32Array>): void {
  const flat = new Float32Array(TILE_N * TILE_N).fill(t.ground.base);
  Object.assign(t, { fixed: true, tile: (tx: number, tz: number) => heights.get(tileKey(tx, tz)) ?? flat, peek: (x: number, z: number) => t.sample(x, z) });
}
/** Whether a terrain draws fixed heights (its recipe has no landforms to read). */
export const fixedTerrain = (t: Terrain): boolean => (t as Terrain & { fixed?: boolean }).fixed === true;
