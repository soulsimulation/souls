#!/usr/bin/env node
// #2434 door-fit/2 for templates: each template as door-fit/1 left it (#2383, read from git at --from) is booted in memory,
// the live rule (fitWorldDoorsV2, with its reach check) runs on it while the world ticks, and the result is written into
// worlds/templates/<name>.json: building place ops onto their every-doorway revision, an upstairs or inside door right
// after its building as the building's child (by a tmp ref), the new outside doors in one batch after everything else
// (after door-fit/1's, #2397), anchored 'center' at their building's settled height, so a door never cuts a foundation pad
// or re-settles its building away from it, and the props door-fit/2 moved at their new spot.
// A door whose frame cuts off a way reached before its fit is taken out by the rule and is not written.
//
//   node tools/worlds/fit-doors.mjs [--from <git rev>] [--check] <template>...
//
// --from: the commit holding the door-fit/1 templates (default: #2397's squash commit on main, below). --check: write nothing, exit 1 when
// a template differs from what the fit gives. Fake minds, in memory; Eden takes many minutes on a loaded machine.
import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { setImmediate } from 'node:timers/promises';
import { bootEden } from '../../apps/server/test/eden-capabilities-timing.ts';
import { DOOR_FIT_HELD, fitWorldDoorsV2 } from '../../apps/server/src/god/door-fit.ts';
import { engineDoorReach } from '../../apps/server/src/edge-runtime-rules.ts';

/** Doors left out of the templates: the rule's own list (door-fit.ts DOOR_FIT_HELD), which the rule already holds back;
 *  kept here as a guard so a template never carries one. */
const CUT_OFF = DOOR_FIT_HELD;
/** #2397's squash commit on main (door-fit/1 templates from tools/worlds/fit-doors-v1.mjs: its doors in a final batch at
 *  their buildings' heights, with #2448), so the default and --check work from main. */
const DOOR_FIT1_REV = 'c24bf911d';
/** How far (m) a door may stand from its building's settled height before the sweep names it. */
const OFF_MAX = 0.05;
const boot = (tpl, name) => { const f = join(mkdtempSync(join(tmpdir(), 'fit-doors-')), `${name}.json`); writeFileSync(f, JSON.stringify(tpl)); return bootEden(() => {}, pathToFileURL(f)); };
const root = new URL('../../', import.meta.url);

const args = process.argv.slice(2);
let from = DOOR_FIT1_REV, check = false;
const names = [];
for (let i = 0; i < args.length; i++) {
  if (args[i] === '--from') from = args[++i];
  else if (args[i] === '--check') check = true;
  else names.push(args[i]);
}
if (!names.length) { console.error('usage: fit-doors.mjs [--from <rev>] [--check] <template>...'); process.exit(2); }

let differs = 0, unsettled = 0;
for (const name of names) {
  const src = execFileSync('git', ['show', `${from}:worlds/templates/${name}.json`], { cwd: root, encoding: 'utf8', maxBuffer: 64 << 20 });
  const tpl = JSON.parse(src);
  const file = join(mkdtempSync(join(tmpdir(), 'fit-doors-')), `${name}.json`); writeFileSync(file, src);
  const w = await bootEden(() => {}, pathToFileURL(file));
  const E = w.host.engine, sp = E.rt.services.spatial; sp.sync(E.world);
  const bodies = Object.values(E.world.entities).flatMap((e) => (e.human && e.pose?.p ? [[e.pose.p[0], e.pose.p[2]]] : []));
  const tick = async () => { w.host.tickOnce(); await setImmediate(); w.host.drainInputs(); };
  // the world ticks while the rule runs, as a serving world does between its slices (the reach check waits on the engine)
  let done = false;
  const run = fitWorldDoorsV2(w.god, bodies, (m) => console.log(`[${name}] ${m}`), sp.scene.obstacles, { walk: engineDoorReach(w.host, w.god), pause: tick });
  run.then(() => { done = true; }, () => { done = true; });
  while (!done) await tick();
  const rep = await run;

  // a place op by its parent's name and its own (a prop's name repeats across buildings: storeroom-bench, living-table)
  const key = (parent, name) => `${parent ?? 'world'}/${name}`;
  const byName = new Map(tpl.batches.flatMap((b) => b.ops).filter((o) => o.op === 'place' && o.name).map((o) => [key(o.in?.parent, o.name), o]));
  // a root door's height over its building's (its floor's), from the fitted world
  const rootDoors = [], of = new Map();
  for (const f of rep.fitted) for (const d of f.doors) if (!(d.in?.parent && d.in.parent !== 'world') && Array.isArray(d.p) && d.p.length > 2)
    of.set(d, { building: f.name, off: Math.round((d.p[1] - w.god.model.worldPose(w.god.model.entities.get(f.id)).y) * 1000) / 1000 });
  let doors = 0, moved = 0, tmpN = 0;
  for (const f of rep.fitted) {
    const op = byName.get(key(undefined, f.name)); if (!op) { console.log(`[${name}] no op for ${f.name}`); continue; }
    op.def = f.ref;
    const batch = tpl.batches.find((b) => b.ops.includes(op)), at = batch.ops.indexOf(op);
    const kids = f.doors.filter((d) => !CUT_OFF.has(d.name) && d.in?.parent && d.in.parent !== 'world');
    if (kids.length) {
      const tmp = op.tmp ?? (op.tmp = `$df${++tmpN}`);
      batch.ops.splice(at + 1, 0, ...kids.map((d) => { const { in: _in, mode: _m, op: _o, ...rest } = d; return { op: 'place', in: { parent: tmp }, ...rest }; }));
    }
    for (const d of f.doors.filter((x) => !CUT_OFF.has(x.name) && !kids.includes(x))) {
      const { in: _in, mode: _m, op: _o, ...rest } = d, o = { op: 'place', ...rest, ...(of.has(d) ? { anchor: 'center' } : {}) };
      rootDoors.push(o); if (of.has(d)) of.set(o, of.get(d));
    }
    doors += f.doors.filter((x) => !CUT_OFF.has(x.name)).length;
    for (const m of f.moves ?? []) {
      const ent = w.god.model.entities.get(m.id), up = ent && ent.in.parent !== 'world' ? w.god.model.entities.get(ent.in.parent)?.name : undefined;
      const pop = ent?.name && byName.get(key(up, ent.name));
      if (pop) { pop.p = m.p; moved++; } else console.log(`[${name}] move: no op for ${m.id}`);
    }
  }
  w.close();
  for (let k = 0; k < rootDoors.length; k += 256) tpl.batches.push({ note: 'door-fit/2 (#2434): a real door in each outside doorway door-fit/1 left bare, at its building\'s height', ops: rootDoors.slice(k, k + 256) });
  // each outside door at its building's settled height in a fresh genesis of the result (#2397's rounds), then a sweep
  // of every fitted door against its building's height
  let settled = false;
  for (let round = 1; round <= 4; round++) {
    const g = await boot(tpl, name), m = g.god.model;
    let n = 0;
    for (const d of rootDoors) {
      const x = of.get(d), bid = x && m.names.get(`world/${x.building}`); if (!bid) continue;
      const y = Math.round((m.worldPose(m.entities.get(bid)).y + x.off) * 1000) / 1000;
      if (Math.abs(d.p[1] - y) > 0.005) { d.p = [d.p[0], y, d.p[2]]; n++; }
    }
    if (!n) {
      const off = [];
      for (const e of m.entities.values()) {
        if (e.in.parent !== 'world' || e.def.replace(/^core-/, 'core/') !== 'core/door@2' || !/-door-[\d-]+$/.test(e.name ?? '')) continue;
        const b = m.names.get(`world/${e.name.replace(/-door-[\d-]+$/, '')}`); if (!b) continue;
        const dy = m.worldPose(e).y - m.worldPose(m.entities.get(b)).y, want = rootDoors.find((r) => r.name === e.name), o = want ? of.get(want)?.off ?? 0 : 0;
        if (Math.abs(dy - o) > OFF_MAX) off.push(`${e.name} ${(dy - o).toFixed(2)} m`);
      }
      console.log(`[${name}] sweep: ${off.length} door(s) more than ${OFF_MAX * 100} cm off their building${off.length ? ': ' + off.join(', ') : ''}`);
      settled = !off.length;
    }
    g.close();
    console.log(`[${name}] round ${round}: ${n} door(s) moved to their building's height`);
    if (!n) break;
  }
  // review of #2438: doors still moving after the last round, or any off their building, fail the run
  if (!settled) { unsettled++; console.log(`[${name}] doors not settled at their buildings' heights after the last round`); }
  const out = JSON.stringify(tpl, null, 2) + '\n', dest = new URL(`worlds/templates/${name}.json`, root);
  console.log(`[${name}] buildings ${rep.buildings}, doors ${doors}, flipped ${rep.flipped.length}, moved ${moved}, held ${rep.held.length}, kept ${rep.kept.length}, left ${rep.left.length}`);
  if (rep.kept.length) console.log(`[${name}] kept: ${rep.kept.join(', ')}`);
  if (check) { if (readFileSync(dest, 'utf8') !== out) { differs++; console.log(`[${name}] differs from the committed template`); } }
  else writeFileSync(dest, out);
}
process.exit(differs || unsettled ? 1 : 0);
