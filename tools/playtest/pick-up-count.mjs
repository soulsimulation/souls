// #1216 counted scenario: pick-ups on a real god world (the native owner fixture: the server's world host, edge routes,
// god mode and engine bridge in process, fake minds), each one counted by how its receipt ended. A receipt still
// `started` after the limit is `never-ended`. Deterministic (ticks, not wall-clock), so one arm's repeats should agree.
//   node tools/playtest/pick-up-count.mjs [--limit 7200] [--only <arm substring>] > counts.json
// Arms: two Souls at one table from the starts that hung harvest (#1214), and one Soul picking things up off the ground.
import {setImmediate} from 'node:timers/promises';
import {Hono} from '../../apps/server/node_modules/hono/dist/index.js';
import {fixture, invite, accept, factory} from '../../apps/server/test/native-owner-fixture.ts';
import {EdgeLedger} from '../../apps/server/src/edge/ledger/ledger.ts';
import {mountEdgeRoutes} from '../../apps/server/src/edge/routes.ts';
import {GodMode} from '../../apps/server/src/god/god.ts';
import {installEngineBridge} from '../../apps/server/src/god/engine-bridge.ts';

const ENDED = ['completed', 'failed', 'cancelled', 'replaced'];
const LIMIT = Number(process.argv[process.argv.indexOf('--limit') + 1]) || 7200;
const quiet = console.log; console.log = () => {}; console.warn = () => {};   // the world's own boot lines go nowhere

async function run(ops, picks, ben) {
 const f = fixture(':memory:', factory, {durableClockV1: true}); f.brain.quiesce();
 const edge = new EdgeLedger(f.host, f.db, undefined, {ambient: false}), app = new Hono(); let soul;
 const comms = mountEdgeRoutes(app, {host: f.host, db: f.db, souls: f.souls, ledger: edge, soul: () => soul});
 try {
  const god = new GodMode(f.db, {worldId: f.host.worldId, ownerId: 'dev:admin', tick: () => f.host.engine.world.tick, emit() {}});
  installEngineBridge({host: f.host, god, edge, log() {}, worldLore: false, worldClock: false});
  const tick = async (n = 5) => { for (let i = 0; i < n; i++) { f.host.tickOnce(); await setImmediate(); f.host.drainInputs(); } };
  await tick();
  const join = async (k, name) => { await invite(f, k); const row = await accept(f.host, f.souls.create('dev:' + k, {name, description: 'Pick-up count'})); await tick(); return {soulId: row.id, entityId: row.entity_id}; };
  const ana = await join('ana', 'Ana'), b = ben ? await join('ben', 'Ben') : null;
  const at = f.host.engine.world.entities[ana.entityId].pose.p, [ax, az] = [at[0], at[2]];
  if (b) { await accept(f.host, f.host.enqueue('edge-relocate', `edge:${b.soulId}`, {soulId: b.soulId, entityId: b.entityId, to: [ax + ben[0], az + ben[1]], why: 'test placement'})); await tick(20); }
  const sc = god.act({ops: ops(ax, az)}); if (!sc.accepted) throw Error('scene refused: ' + JSON.stringify(sc.failures?.slice(0, 2)));
  await tick(45);
  const id = n => [...god.model.entities.values()].find(e => e.name === n).id, who = {ana, ben: b};
  const rs = [];
  for (const [s, item] of picks) {
   soul = who[s];
   const r = await (await accept(f.host, app.request('/v1/edge/act', {method: 'POST', headers: {'content-type': 'application/json'}, body: JSON.stringify({capability: `pick-up:${id(item)}`, strict: true})}))).json();
   rs.push(r.accepted ? {soulId: soul.soulId, id: r.receipt.id} : {refused: r.code ?? r.error?.code ?? 'refused'});
  }
  const live = rs.filter(r => r.id), receipt = r => edge.receipt(r.soulId, r.id);
  for (let n = 0; n < LIMIT && !live.every(r => ENDED.includes(receipt(r)?.phase)); n++) await tick(1);
  return rs.map(r => {
   if (!r.id) return {outcome: 'refused', code: r.refused};
   const x = receipt(r);
   return ENDED.includes(x.phase) ? {outcome: x.phase, code: x.code ?? null, ticks: x.endedTick - x.acceptedTick} : {outcome: 'never-ended', code: null, ticks: null};
  });
 } finally { comms.close(); f.host.stop(); f.db.close(); }
}

const table = (r = 0, at = 0.15) => (ax, az) => [
 {op: 'place', def: 'core/table@1', name: 'garden-table', p: [ax + 2.5, az + 1.9], r},
 {op: 'place', def: 'core/harvest-basket@1', name: 'basket', in: {parent: 'garden-table', slot: 'top'}, p: [at, 0.1]},
 {op: 'place', def: 'core/flower-vase@1', name: 'vase', in: {parent: 'garden-table', slot: 'top'}, p: [-at, 0.1]}];
const arms = [
 ...[[3, 0], [3, 0.3], [4, 0], [0, 3], [5, 3], [1.5, -1], [2.5, 4], [-1, 2], [2.9, 1.1]].map(s => ({arm: `two at a table, Ben from ${s}`, ops: table(), ben: s, picks: [['ana', 'basket'], ['ben', 'vase']]})),
 ...[[2.5, 0.25], [3, 0]].map(s => ({arm: `two at a turned table, Ben from ${s}`, ops: table(2.4, 0.25), ben: s, picks: [['ana', 'vase'], ['ben', 'basket']]})),
 {arm: 'one at a table', ops: table(), picks: [['ana', 'basket']]},
 ...['core/harvest-basket@1', 'core/flower-vase@1', 'core/bowl@2', 'core/cup@2', 'core/lantern@3', 'core/kettle@3', 'core/book@1', 'core/apple@1']
  .flatMap(def => [0.7, 1.5, 3, 5].map(d => ({arm: `${def} on the ground at ${d} m`, ops: (ax, az) => [{op: 'place', def, name: 'thing', p: [ax + d, az]}], picks: [['ana', 'thing']]}))),
];
const only = process.argv.includes('--only') ? process.argv[process.argv.indexOf('--only') + 1] : null;
const out = [];
for (const a of arms.filter(a => !only || a.arm.includes(only))) {
 let rs; try { rs = await run(a.ops, a.picks, a.ben); } catch (e) { rs = a.picks.map(() => ({outcome: 'error', code: String(e.message).slice(0, 160)})); }
 rs.forEach((r, i) => out.push({arm: a.arm, pick: a.picks[i].join(':'), ...r}));
}
const count = k => out.filter(r => r.outcome === k).length;
quiet(JSON.stringify({limit: LIMIT, picks: out.length, completed: count('completed'), failed: count('failed'), refused: count('refused'), neverEnded: count('never-ended'), errors: count('error'), rows: out}, null, 1));
process.exit(0);
