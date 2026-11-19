// A link to a moment (V9, #2719): the world, its lineage (a fork is another lineage, T3), the world time in
// microseconds (T5) and a camera, all in the fragment after `#`, so the page is one cache entry and the moment is
// never sent to a server. No part number, epoch or tick: those are a stream's, and change; these mean the same next
// year.
import { readCamera, writeCamera, type CameraAt } from '../camera/link.ts';

export type Moment = { world: string; lineage: string; at: number; camera: CameraAt | null };

export function readMoment(hash: string): Moment | null {
  const q = new URLSearchParams(hash.replace(/^#/, ''));
  const world = q.get('w'), lineage = q.get('l'), at = Number(q.get('t'));
  if (!world || !lineage || !q.has('t') || !Number.isSafeInteger(at)) return null;
  return { world, lineage, at, camera: readCamera(q.get('c')) };
}

export function writeMoment(m: Moment): string {
  const q = new URLSearchParams({ w: m.world, l: m.lineage, t: String(Math.round(m.at)) });
  if (m.camera) q.set('c', writeCamera(m.camera));
  return `#${q.toString()}`;
}

/** Where a world's history is served, from the page: `h/<world>/<lineage>/` beside the stream files. */
export const historyBase = (m: Pick<Moment, 'world' | 'lineage'>, root = './s/h/') =>
  `${root}${encodeURIComponent(m.world)}/${encodeURIComponent(m.lineage)}/`;
