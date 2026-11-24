// sleep-rollout-e2e.sh's viewer: reads a world's public stream pointer as a viewer does (the file the origin serves at
// /w/<world>/views/...), and plays it with the old page's own code (apps/web/src/v2-engine/bridge.ts, stream-health.ts).
//
//   node sleep-viewer.mjs pointer <world folder>           the pointer as JSON (field 11: asleep, stillUntil)
//   node sleep-viewer.mjs view <world folder> <seconds>    plays the sleeping world's pointer for that many real
//                                                          seconds: its time must go on one second a second, with no
//                                                          stall notice; exit 1 otherwise
//   node sleep-viewer.mjs catchup <pointer> <pointer>      the world's clock after a wake: the same mapping of wall
//                                                          time as when it went to sleep (to the millisecond), and
//                                                          quiet up to its own now; exit 1 otherwise
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

/** The cut-down CBOR the stream writes (v2/crates/replica/src/encode.rs): integers, byte strings, text, arrays, maps. */
function cbor(bytes) {
  let i = 0;
  const len = (ai) => {
    if (ai < 24) return ai;
    const n = 1 << (ai - 24);
    let v = 0n;
    for (let k = 0; k < n; k++) v = (v << 8n) | BigInt(bytes[i++]);
    return Number(v);
  };
  const item = () => {
    const b = bytes[i++], major = b >> 5, n = len(b & 31);
    switch (major) {
      case 0: return n;
      case 1: return -1 - n;
      case 2: { const v = bytes.slice(i, i + n); i += n; return v; }
      case 3: { const v = Buffer.from(bytes.slice(i, i + n)).toString(); i += n; return v; }
      case 4: return Array.from({ length: n }, item);
      case 5: { const m = new Map(); for (let k = 0; k < n; k++) m.set(item(), item()); return m; }
      default: throw new Error(`cbor: major type ${major}`);
    }
  };
  return item();
}

function pointer(world) {
  const meta = JSON.parse(readFileSync(join(world, 'views', 'world.json'), 'utf8'));
  const m = cbor(readFileSync(join(world, meta.stream, 'pointer')));
  const sleep = m.get(11);
  return {
    newest: m.get(1) ?? null, period: m.get(2), newestTo: m.get(4) ?? null, anchorWorld: m.get(5), anchorWallMs: m.get(6),
    quietUntil: m.get(7) ?? null, ...(Array.isArray(sleep) ? { asleep: true, stillUntil: sleep[0] ?? null } : {}),
  };
}

const [cmd, a, b] = process.argv.slice(2);
if (cmd === 'pointer') {
  console.log(JSON.stringify(pointer(a)));
} else if (cmd === 'view') {
  const p = pointer(a);
  if (!p.asleep) { console.log('the pointer does not say the world sleeps'); process.exit(1); }
  // The page's code needs the workspace's packages (pnpm install).
  const { V2Bridge } = await import('../../../../apps/web/src/v2-engine/bridge.ts');
  const { streamNotice } = await import('../../../../apps/web/src/v2-engine/stream-health.ts');
  const bridge = new V2Bridge({ rulesVersion: 'sleep-rollout-e2e' });
  const Q = 2 ** 30;
  bridge.receive({ t: 'snapshot', s: { nodes: [{ id: 'w.0', kind: 'souls:place@1', parent: null, slot: null, pos: [0, 0, 0], rot: [Q, 0, 0, 0], at: null }], removed: [] } });
  const startedAt = Date.now(), seen = [];
  let lastPartAt = null, shown = null, notices = 0;
  while (Date.now() - startedAt < Number(b) * 1000) {
    // The page reads the pointer again every 250 ms.
    bridge.receive({ t: 'pointer', p: pointer(a) });
    const now = Date.now();
    if (bridge.view.newestTo !== shown) { shown = bridge.view.newestTo; lastPartAt = now; }
    if (streamNotice({ failed: false, error: null, errorAtParts: null, parts: bridge.view.parts, startedAt, lastPartAt, now })) notices++;
    seen.push([now, bridge.view.newestTo]);
    await new Promise((ok) => setTimeout(ok, 250));
  }
  const [w0, t0] = seen[0], [w1, t1] = seen.at(-1);
  const rate = (t1 - t0) / ((w1 - w0) * 1000);
  console.log(`world time went on ${((t1 - t0) / 1e6).toFixed(2)} s over ${((w1 - w0) / 1000).toFixed(2)} s of wall time (rate ${rate.toFixed(3)}), `
    + `${notices} stall notices, still until ${p.stillUntil === null ? 'an intent (nothing due)' : `${((p.stillUntil - t1) / 1e6).toFixed(0)} s on`}`);
  process.exit(notices === 0 && Math.abs(rate - 1) < 0.05 ? 0 : 1);
} else if (cmd === 'catchup') {
  const before = JSON.parse(a), after = JSON.parse(b);
  const offset = (p) => p.anchorWorld - p.anchorWallMs * 1000;
  const drift = offset(after) - offset(before), slept = (after.anchorWallMs - before.anchorWallMs) / 1000;
  const behind = after.anchorWorld - Math.max(after.quietUntil ?? 0, after.newestTo ?? 0);
  console.log(`world time minus wall time moved ${drift} µs across ${slept.toFixed(1)} s (asleep, woken, served); `
    + `awake: ${!after.asleep}, quiet up to ${(behind / 1e3).toFixed(0)} ms before its now`);
  process.exit(Math.abs(drift) < 1000 && !after.asleep && behind >= 0 && behind < 2_000_000 ? 0 : 1);
} else {
  console.error('use pointer <world> | view <world> <seconds> | catchup <pointer> <pointer>');
  process.exit(2);
}
