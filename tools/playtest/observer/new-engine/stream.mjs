// What a viewer of a new-engine world sees (0.135 P1): the public stream, played by the old page's own stream worker
// (apps/web/src/v2-engine/source/worker.ts) on the replica's WASM in this process, as v2/client/served/e2e reads it.
// It reads only the public stream through the front door: never a token, never a Soul's copy. The gateway's answers
// to each seat's intents are the seats' own (receipts.mjs), not the viewer's.
//
//   const v = await streamViewer({ world, pkg });   // world: arena/new-engine/world.mjs startWorld's answer
//   v.bodies(), v.said(), v.node(clientId), v.links(clientId), v.errors; v.close()
import { existsSync, readFileSync, statSync } from 'node:fs';
import { registerHooks } from 'node:module';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { REPO_ROOT } from '../../../lib/paths.mjs';
import { REPLICA_PKG } from '../../arena/new-engine/seat.mjs';

const WORKER = join(REPO_ROOT, 'apps/web/src/v2-engine/source/worker.ts');

/** The stream's id for a client id (`<scope>-<counter>` → `<scope>.<counter>`), as the page keys its nodes. */
export const pageKey = (id) => String(id).replace(/-(\d+)$/, '.$1');
/** The client's id for a stream node id. */
export const clientKey = (id) => String(id).replace(/\.(\d+)$/, '-$1');

/** The stream's address from a world's advert (`views/world.json`, its `stream` relative to the world's page). */
export const streamUrl = (page, advert) => new URL(String(advert.stream).replace(/\/?$/, '/'), page).href;

let hooked = null;
const timers = new Set();
/** Once per process: `replica` resolves to the package, a file: fetch reads the file (the WASM, a world's history), timers are kept. */
export function hookOnce(pkg) {
  if (hooked) { if (hooked !== pkg) throw new Error(`one replica package per process: ${hooked} already loaded`); return; }
  if (!existsSync(join(pkg, 'replica.js'))) throw new Error(`no replica package at ${pkg} (v2/tools/dev/run.sh builds one)`);
  const url = pathToFileURL(join(pkg, 'replica.js')).href;
  registerHooks({ resolve: (s, c, next) => (s === 'replica' ? { url, shortCircuit: true } : next(s, c)) });
  const realFetch = globalThis.fetch;
  globalThis.fetch = (input, init) => {
    const u = String(input instanceof Request ? input.url : input);
    if (!u.startsWith('file:')) return realFetch(input, init);
    // a file: a world's folder read in place (its history), or the WASM; a missing file answers 404, as the origin does
    const f = new URL(u);
    return Promise.resolve(existsSync(f) && statSync(f).isFile() ? new Response(readFileSync(f), { headers: { 'content-type': 'application/wasm' } }) : new Response(null, { status: 404 }));
  };
  const realSetInterval = globalThis.setInterval;
  globalThis.setInterval = (f, ms, ...a) => { const t = realSetInterval(f, ms, ...a); timers.add(t); return t; };
  hooked = pkg;
}

/** A public node record's links (record key 9: `[n, "<ns>:<link>@<rev>", [scope, counter], audience]`), as
 *  `{ type: "<ns>:<link>", end: <client id> }`. The page's records carry only a body's Soul from them (`publicSoul`). */
export function linksOf(record) {
  const out = [];
  for (const l of (record instanceof Map ? record.get(9) : null) ?? []) {
    if (!Array.isArray(l) || typeof l[1] !== 'string' || !Array.isArray(l[2]) || !(l[2][0] instanceof Uint8Array)) continue;
    out.push({ type: l[1].split('@')[0], end: `${Buffer.from(l[2][0]).toString('hex')}-${Number(l[2][1])}` });
  }
  return out;
}

/** Each node's links as the replica's stream player gives its records to the page's worker (its `query` by id and its
 *  `snapshot`), read beside the worker: client id → links. One table for the process, as the replica is one. */
const linkTable = new Map();
let tapped = null;
async function tapLinks(pkg) {
  if (tapped) return tapped;
  tapped = (async () => {
    const { StreamPlayer } = await import(pathToFileURL(join(pkg, 'replica.js')).href);
    const { decode } = await import(pathToFileURL(join(REPO_ROOT, 'apps/web/node_modules/cborg/cborg.js')).href);
    const keep = (r) => { if (r instanceof Map && Array.isArray(r.get(1)) && r.get(1)[0] instanceof Uint8Array) linkTable.set(`${Buffer.from(r.get(1)[0]).toString('hex')}-${Number(r.get(1)[1])}`, linksOf(r)); };
    const read = (bytes) => { try { const v = decode(bytes, { useMaps: true }); if (Array.isArray(v)) v.forEach(keep); else keep(v); } catch { /* not a record */ } };
    for (const name of ['query', 'snapshot']) {
      const real = StreamPlayer.prototype[name];
      StreamPlayer.prototype[name] = function (...a) { const out = real.apply(this, a); read(out); return out; };
    }
  })();
  return tapped;
}

let n = 0;
/** A fresh viewer from now on, of `world`'s stream or of the `stream` address given. Resolves once its worker is started. */
export async function streamViewer({ world = null, stream = null, pkg = REPLICA_PKG }) {
  hookOnce(pkg);
  await tapLinks(pkg);
  // a stream's address given (a world's old page names it, as soul.game's does), else the world's advert
  if (!stream) {
    const advert = await fetch(`${world.page}views/world.json`, { signal: AbortSignal.timeout(10_000) }).then((r) => (r.ok ? r.json() : null), () => null)
      ?? JSON.parse(readFileSync(join(world.dir, 'world/views/world.json'), 'utf8'));
    stream = streamUrl(world.page, advert);
  }
  const v = { stream, nodes: new Map(), parts: 0, saidRecs: [], errors: [], played: null };
  const self = {
    onmessage: null,
    postMessage: (m) => {
      if (m.t === 'part') {
        v.parts++; v.played = m.p.to;
        for (const id of m.p.removed) v.nodes.delete(id);
        for (const node of m.p.nodes) v.nodes.set(node.id, node);
        for (const s of m.p.said ?? []) v.saidRecs.push({ ...s, speaker: s.speaker });
      } else if (m.t === 'snapshot') { for (const id of m.s.removed) v.nodes.delete(id); for (const node of m.s.nodes) v.nodes.set(node.id, node); }
      else if (m.t === 'error') v.errors.push(m.message);
    },
  };
  // The worker takes `self` as its scope when it is imported: each viewer imports its own copy.
  globalThis.self = self;
  await import(`${pathToFileURL(WORKER).href}?viewer=${++n}`);
  self.onmessage({ data: { stream } });
  return Object.assign(v, {
    /** Bodies in view: [{id (client id), kind, pos (µm, parent frame), parent}] */
    bodies: () => [...v.nodes.values()].filter((x) => x.kind.startsWith('souls:body')).map((x) => ({ id: clientKey(x.id), kind: x.kind, pos: x.pos, parent: x.parent })),
    /** The node for a client id, or null. */
    node: (id) => v.nodes.get(pageKey(id)) ?? null,
    /** A node's links by its client id (`linksOf`), as last played; [] when none were read. */
    links: (id) => linkTable.get(String(id)) ?? [],
    /** What was said in public since this viewer started: [{speaker (client id), at, words}] */
    said: () => v.saidRecs.map((s) => ({ speaker: clientKey(s.speaker), at: s.at, words: s.words, private: !!s.private })),
    /** Waits until `pred(v)` holds (or the viewer errs); → true, or false at the timeout. */
    async until(pred, ms = 30_000) {
      const end = Date.now() + ms;
      while (Date.now() < end) { if (v.errors.length) return false; if (pred(v)) return true; await new Promise((r) => setTimeout(r, 100)); }
      return false;
    },
  });
}

/** Stops every viewer's polling in this process. */
export function closeViewers() { for (const t of timers) clearInterval(t); timers.clear(); }
