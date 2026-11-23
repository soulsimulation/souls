// Who was where in a span of a new-engine world's history (0.135 P3a), for the camera's planner. It plays the history
// with the old page's own history worker (apps/web/src/v2-engine/history-worker.ts: V4's bundle walk, applied on the
// replica's WASM) in this process, from the world's `history/` folder on disk or its address, and turns each bundle's
// body samples into places in the world frame. Nothing is sent to a world; a stopped world's folder is enough.
//
//   const { places, nodes } = await placesIn({ history: '<world folder>/history/', fromUs, toUs });
import { existsSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { REPO_ROOT } from '../lib/paths.mjs';
import { REPLICA_PKG } from '../playtest/arena/new-engine/seat.mjs';
import { hookOnce } from '../playtest/observer/new-engine/stream.mjs';

const WORKER = join(REPO_ROOT, 'apps/web/src/v2-engine/history-worker.ts');
const Q = 2 ** 30;

/** A rotation `[w, x, y, z]` (units of 2^30, the stream's) applied to `v`. */
export function rotate(q, v) {
  const [w, x, y, z] = q.map((c) => c / Q), [vx, vy, vz] = v;
  const tx = 2 * (y * vz - z * vy), ty = 2 * (z * vx - x * vz), tz = 2 * (x * vy - y * vx);
  return [vx + w * tx + (y * tz - z * ty), vy + w * ty + (z * tx - x * tz), vz + w * tz + (x * ty - y * tx)];
}
const mul = (a, b) => { const [aw, ax, ay, az] = a.map((c) => c / Q), [bw, bx, by, bz] = b.map((c) => c / Q);
  return [aw * bw - ax * bx - ay * by - az * bz, aw * bx + ax * bw + ay * bz - az * by, aw * by - ax * bz + ay * bw + az * bx, aw * bz + ax * by - ay * bx + az * bw].map((c) => c * Q); };

/** Each node's frame in the world: `{pos µm, rot}` composed up its parents. */
export function frames(nodes) {
  const byId = new Map(nodes.map((n) => [n.id, n])), done = new Map();
  const of = (id, depth = 0) => {
    if (done.has(id)) return done.get(id);
    const n = byId.get(id);
    if (!n || depth > 64) return { pos: [0, 0, 0], rot: [Q, 0, 0, 0] };
    const p = n.parent ? of(n.parent, depth + 1) : { pos: [0, 0, 0], rot: [Q, 0, 0, 0] };
    const r = rotate(p.rot, n.pos), f = { pos: [p.pos[0] + r[0], p.pos[1] + r[1], p.pos[2] + r[2]], rot: mul(p.rot, n.rot ?? [Q, 0, 0, 0]) };
    done.set(id, f);
    return f;
  };
  return of;
}

/** A body's sample (`[body, frame, slot, at µs, x, y, z µm]`) as a place in metres in the world frame. */
export function placeOf(sample, frameOf) {
  const [body, frame, , at, x, y, z] = sample, f = frameOf(frame), r = rotate(f.rot, [x, y, z]);
  return { id: body, at, p: [(f.pos[0] + r[0]) / 1e6, (f.pos[1] + r[1]) / 1e6, (f.pos[2] + r[2]) / 1e6] };
}

let n = 0;
/** The places of every body in [fromUs, toUs], with the moment's nodes. `history`: a folder or an address ending in `/`. */
export async function placesIn({ history, fromUs, toUs, pkg = REPLICA_PKG }) {
  hookOnce(pkg);
  const base = /^https?:/.test(history) ? new URL(history).href : pathToFileURL(resolve(history) + '/').href;
  if (!/^https?:/.test(history) && !existsSync(join(resolve(history), 'header'))) throw Error(`no history at ${history} (a world writes it with a store: startWorld({history}))`);
  const self = { onmessage: null, postMessage: (m) => waiting?.(m) };
  let waiting = null;
  globalThis.self = self;
  await import(`${pathToFileURL(WORKER).href}?history=${++n}`);
  const seek = (at, seq) => new Promise((ok, no) => { waiting = (m) => (m.t === 'seeked' ? ok(m.s) : no(Error(m.message))); self.onmessage({ data: { base, seq, at } }); });
  const places = [];
  let nodes = null, at = fromUs, seq = 0;
  for (let i = 0; i < 1000; i++) {
    const s = await seek(at, ++seq);
    nodes ??= s.nodes;
    const frameOf = frames(s.nodes);
    // the moment's own places, then the bundle's samples within the span
    if (i === 0) for (const nd of s.nodes) if (nd.kind.startsWith('souls:body') && nd.parent) places.push(placeOf([nd.id, nd.parent, null, at, ...nd.pos], frameOf));
    for (const smp of s.samples) if (smp[3] >= fromUs && smp[3] <= toUs) places.push(placeOf(smp, frameOf));
    if (s.next === null || s.next > toUs || s.next <= at) break;
    at = s.next;
  }
  return { places, nodes: nodes ?? [] };
}
