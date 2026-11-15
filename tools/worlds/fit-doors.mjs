#!/usr/bin/env node
// #2434 door-fit/2 for templates: each template as door-fit/1 left it (#2383, read from git at --from) is booted in memory,
// the live rule (fitWorldDoorsV2, with its reach check) runs on it while the world ticks, and the result is written into
// worlds/templates/<name>.json: building place ops onto their every-doorway revision, the new doors placed right after
// them (an upstairs or inside door as the building's child, by a tmp ref), the props door-fit/2 moved at their new spot.
// A door whose frame cuts off a way reached before its fit is taken out by the rule and is not written.
//
//   node tools/worlds/fit-doors.mjs [--from <git rev>] [--check] <template>...
//
// --from: the commit holding the door-fit/1 templates (default: #2383's head below). --check: write nothing, exit 1 when
// a template differs from what the fit gives. Fake minds, in memory; Eden takes many minutes on a loaded machine.
import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { setImmediate } from 'node:timers/promises';
import { bootEden } from '../../apps/server/test/eden-capabilities-timing.ts';
import { fitWorldDoorsV2 } from '../../apps/server/src/god/door-fit.ts';
import { engineDoorReach } from '../../apps/server/src/edge-runtime-rules.ts';

/** Doors left out of the templates: their frame cuts their building off (a one-shot reach pass on a settled boot of the
 *  fitted Eden found things inside no longer reached from outside the front door with each in, #2434 bc13f17b0). The
 *  rule's own reach check compares door sides only and does not catch these, so they are named here. */
const CUT_OFF = new Set(['artists-studio-2-door-3', 'artists-studio-3-door-1-0', 'artists-studio-8-door-3', 'artists-studio-4-door-3']);
/** #2383's head (door-fit/1 templates, every fitted door open). */
const DOOR_FIT1_REV = 'bba6d65ad';
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

let differs = 0;
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
  let doors = 0, moved = 0, tmpN = 0;
  for (const f of rep.fitted) {
    const op = byName.get(key(undefined, f.name)); if (!op) { console.log(`[${name}] no op for ${f.name}`); continue; }
    op.def = f.ref;
    const batch = tpl.batches.find((b) => b.ops.includes(op)), at = batch.ops.indexOf(op);
    const tmp = op.tmp ?? (op.tmp = `$df${++tmpN}`);
    const add = f.doors.filter((d) => !CUT_OFF.has(d.name)).map((d) => {
      const { in: inn, mode: _m, op: _o, ...rest } = d;
      return { op: 'place', ...(inn?.parent && inn.parent !== 'world' ? { in: { parent: tmp } } : {}), ...rest };
    });
    batch.ops.splice(at + 1, 0, ...add); doors += add.length;
    for (const m of f.moves ?? []) {
      const ent = w.god.model.entities.get(m.id), up = ent && ent.in.parent !== 'world' ? w.god.model.entities.get(ent.in.parent)?.name : undefined;
      const pop = ent?.name && byName.get(key(up, ent.name));
      if (pop) { pop.p = m.p; moved++; } else console.log(`[${name}] move: no op for ${m.id}`);
    }
  }
  w.close();
  const out = JSON.stringify(tpl, null, 2) + '\n', dest = new URL(`worlds/templates/${name}.json`, root);
  console.log(`[${name}] buildings ${rep.buildings}, doors ${doors}, flipped ${rep.flipped.length}, moved ${moved}, held ${rep.held.length}, kept ${rep.kept.length}, left ${rep.left.length}`);
  if (rep.kept.length) console.log(`[${name}] kept: ${rep.kept.join(', ')}`);
  if (check) { if (readFileSync(dest, 'utf8') !== out) { differs++; console.log(`[${name}] differs from the committed template`); } }
  else writeFileSync(dest, out);
}
process.exit(differs ? 1 : 0);
