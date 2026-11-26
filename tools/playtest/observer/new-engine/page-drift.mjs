// Page drift (0.137 trial, three Souls on Eden): where the old page draws each body (its own stream worker, V2Bridge and
// the takes sampled as the page samples them) against the public stream's record of it, every 250 ms, over a scripted
// run of acts by three paired Souls (fern, reed, moss) on a local Eden. Fake minds, loopback, its folder under .local/.
//
//   POSDRIFT_SCRIPT='[{"who":"fern","words":["act","<id>","--wait"]},{"who":"moss","find":"campfire"}]' \
//     node tools/playtest/observer/new-engine/page-drift.mjs <out dir> [template]
//   node tools/playtest/observer/new-engine/page-drift.mjs --gaps <out dir>/trace.jsonl
//
// POSDRIFT_BUILD names a checkout whose v2/target holds release binaries and the replica package and whose v2/web/dist
// is built (default this one; V2_BIN, V2_REPLICA_PKG and V2_WEB override, as run.sh reads them). --gaps prints each
// stretch where the drawn place is over 3 m from the record.
import { join, resolve } from 'node:path';
import { writeFileSync, appendFileSync, mkdirSync, readFileSync } from 'node:fs';

if (process.argv[2] === '--gaps') { gaps(process.argv[3]); process.exit(0); }
const OTHER = process.env.POSDRIFT_BUILD ?? join(import.meta.dirname, '../../../..');
process.env.V2_BIN ??= join(OTHER, 'v2/target/release');
process.env.V2_REPLICA_PKG ??= join(OTHER, 'v2/target/wasm-load/pkg');
process.env.SOULS_REPLICA_PKG ??= process.env.V2_REPLICA_PKG;
process.env.V2_WEB ??= join(OTHER, 'v2/web/dist');

const out = resolve(process.argv[2]);
const template = process.argv[3] ?? 'worlds/templates/eden-2026.json';
mkdirSync(out, { recursive: true });
const log = (...a) => { const l = `${new Date().toISOString().slice(11, 23)} ${a.join(' ')}`; console.log(l); appendFileSync(join(out, 'log.txt'), l + '\n'); };

const { startWorld, stopWorld } = await import('../../../../tools/playtest/arena/new-engine/world.mjs');
const { pairSeat } = await import('../../../../tools/playtest/arena/new-engine/seat.mjs');
const { streamViewer, pageKey } = await import('../../../../tools/playtest/observer/new-engine/stream.mjs');
const { V2Bridge, BEHIND_US } = await import('../../../../apps/web/src/v2-engine/bridge.ts');
const { sampleTake } = await import('../../../../mars/viewer/engine/take/replay.ts');
const { TICK_US, DT } = await import('../../../../apps/web/src/v2-engine/takes.ts');

const world = await startWorld({ template, dir: join(out, 'world') });
log('world', world.page);
const stop = async () => { try { await stopWorld(world); } catch {} };
process.on('SIGINT', async () => { await stop(); process.exit(130); });

const bridge = new V2Bridge({ rulesVersion: 'repro/1' });
const viewer = await streamViewer({ world });
// tap the worker's posts into the bridge as the page does
const post = globalThis.self.postMessage;
globalThis.self.postMessage = (m, t) => { post(m, t); try { bridge.receive(m); } catch (e) { log('bridge error', e.stack); } };

const seats = [];
for (const label of ['fern', 'reed', 'moss']) seats.push(await pairSeat({ world, dir: join(out, 'seats'), label }));
for (const s of seats) { await s.join(); log('joined', s.label, s.info().body); }

/** The page's drawn place of body `client id` at world time `t`, world metres, from the takes as the page samples them. */
function drawn(bodyId, t) {
  const key = pageKey(bodyId);
  const b = bridge['bodies']().find((x) => x.node === key);
  if (!b) return null;
  const tick = Math.floor(t / TICK_US);
  const c = bridge.view.takes.chunks.find((x) => x.fromTick <= tick && tick < x.toTick);
  if (!c) return { none: true, chunks: bridge.view.takes.chunks.length, last: bridge.view.takes.chunks.at(-1)?.toTick, tick };
  const e = sampleTake(c.take, (tick - c.fromTick) * DT).entities[b.entity];
  return e ? { p: e.p, activity: e.activity } : { missing: b.entity };
}
/** The stream record's place in world metres (bridge's world transform of the node). */
function recorded(bodyId) {
  const w = bridge['world'](pageKey(bodyId));
  return w ? [w.p[0] / 1e6, w.p[1] / 1e6, w.p[2] / 1e6] : null;
}

const trace = join(out, 'trace.jsonl');
let running = true;
(async () => {
  while (running) {
    const to = bridge.view.newestTo;
    if (to !== null) {
      const shown = to - BEHIND_US - 12 * TICK_US;
      const row = { wall: Date.now(), to, shown };
      for (const s of seats) {
        const b = s.info().body; if (!b) continue;
        row[s.label] = { rec: recorded(b), drawn: drawn(b, shown), recAt: viewer.node(b)?.at ?? null, parent: viewer.node(b)?.parent, slot: viewer.node(b)?.slot };
      }
      appendFileSync(trace, JSON.stringify(row) + '\n');
    }
    await new Promise((r) => setTimeout(r, 250));
  }
})();

async function act(seat, ...words) {
  const a = await seat.cli(...words);
  log(seat.label, words.join(' '), '->', JSON.stringify(a).slice(0, 300));
  return a;
}
async function look(seat) { const l = await seat.cli('status'); return l; }
const find = async (seat, q) => ((await seat.cli('find', q)).found ?? []).filter((r) => !String(r.kind ?? '').startsWith('souls:body'));
const pause = (ms) => new Promise((r) => setTimeout(r, ms));

const [fern, reed, moss] = seats;
writeFileSync(join(out, 'status0.json'), JSON.stringify(await look(fern), null, 2));
const script = JSON.parse(process.env.POSDRIFT_SCRIPT ?? '[]');
for (const step of script) {
  const s = seats.find((x) => x.label === step.who);
  if (step.find) {
    const f = await find(s, step.find);
    log(s.label, 'find', step.find, '->', JSON.stringify(f.slice(0, 3).map((r) => [r.id, r.kind, r.name, r.distance_m ?? r.away_m])));
    if (f[0]) await act(s, 'act', ...(step.verb ? [`${step.verb}:${f[0].id}`] : [f[0].id]), ...(step.wait === false ? [] : ['--wait']));
  } else if (step.words) await act(s, ...step.words);
  if (step.pause) await pause(step.pause);
  writeFileSync(join(out, `status-${s.label}.json`), JSON.stringify(await look(s), null, 2));
}
await pause(Number(process.env.POSDRIFT_TAIL ?? 10_000));
running = false;
for (const s of seats) await s.stop();
await stop();
process.exit(0);

/** Each stretch where the drawn place is over 3 m from the record, per Soul. */
function gaps(file) {
  const rows = readFileSync(file, 'utf8').trim().split('\n').map((l) => JSON.parse(l));
  const t0 = rows[0].wall;
  for (const who of ['fern', 'reed', 'moss']) {
    let open = null;
    for (const r of rows) {
      const s = r[who];
      if (!s?.rec || !s.drawn?.p) continue;
      const d = Math.hypot(s.rec[0] - s.drawn.p[0], s.rec[2] - s.drawn.p[2]);
      const t = ((r.wall - t0) / 1000).toFixed(1);
      if (d > 3 && !open) open = { t, d, s };
      if (open && d > 3) open.max = Math.max(open.max ?? 0, d);
      if (open && d <= 3) { console.log(`${who} gap from ${open.t}s to ${t}s, max ${open.max.toFixed(1)} m; first rec ${open.s.rec.map((x) => x.toFixed(1))} drawn ${open.s.drawn.p.map((x) => x.toFixed(1))} parent ${open.s.parent}`); open = null; }
    }
    if (open) console.log(`${who} gap from ${open.t}s to the end, max ${open.max.toFixed(1)} m; rec ${open.s.rec.map((x) => x.toFixed(1))} drawn ${open.s.drawn.p.map((x) => x.toFixed(1))} parent ${open.s.parent}`);
  }
}
