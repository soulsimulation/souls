#!/usr/bin/env node
// #2383 door-fit/1 for templates: each template before the fit (by default the committed fitted template mapped back: its
// fitted revisions to their old ones, its fitted doors left out; or --from <git rev>'s template as it is) is booted in
// memory, the live rule (fitWorldDoorsV1, with the hand check) runs on it, and the result is written into
// worlds/templates/<name>.json: building place ops onto their fitted revision, and the doors in one batch after
// everything else, as a live world's fit places them (a root thing re-settles on the ground when a later batch changes the
// ground under it, so a door placed before its building's last re-settle was left behind: #2448's vineyard villa).
// Each door then takes its building's height in a fresh genesis of the result, until none moves.
//
//   node tools/worlds/fit-doors-v1.mjs [--from <git rev>] [--check] <template>...
//
// --check: write nothing, exit 1 when a template differs from what the fit gives. Fake minds, in memory.
import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { bootEden } from '../../apps/server/test/eden-capabilities-timing.ts';
import { DOOR_FIT_DOOR, fitWorldDoorsV1 } from '../../apps/server/src/god/door-fit.ts';
import { DOOR_FIT_FROM } from '../../packages/world-compiler/src/index.ts';

/** Doors left out of the templates (an open gap, as a held door). Open, the leaf cuts its room off from the room's own
 *  entry, measured on a fresh genesis: region-alpine-mountain-station/hall has no walk goal with door-1 open, and one with
 *  it closed or left out. The rule's hand check does not see an open leaf across a slope. */
const CUT_OFF = new Set(['region-alpine-mountain-station-door-1']);
const root = new URL('../../', import.meta.url);
const back = new Map([...DOOR_FIT_FROM].map(([from, to]) => [to.ref, from]));
const fitDoor = (o) => o.def === DOOR_FIT_DOOR && /-door-\d+$/.test(o.name ?? '');
const boot = (tpl, name) => { const f = join(mkdtempSync(join(tmpdir(), 'fit-doors-v1-')), `${name}.json`); writeFileSync(f, JSON.stringify(tpl)); return bootEden(() => {}, pathToFileURL(f)); };

const args = process.argv.slice(2);
let from = null, check = false;
const names = [];
for (let i = 0; i < args.length; i++) {
  if (args[i] === '--from') from = args[++i];
  else if (args[i] === '--check') check = true;
  else names.push(args[i]);
}
if (!names.length) { console.error('usage: fit-doors-v1.mjs [--from <rev>] [--check] <template>...'); process.exit(2); }

let differs = 0;
for (const name of names) {
  const dest = new URL(`worlds/templates/${name}.json`, root), committed = readFileSync(dest, 'utf8');
  const tpl = JSON.parse(from ? execFileSync('git', ['show', `${from}:worlds/templates/${name}.json`], { cwd: root, encoding: 'utf8', maxBuffer: 64 << 20 }) : committed);
  if (!from) {
    for (const b of tpl.batches) b.ops = b.ops.filter((o) => !fitDoor(o)).map((o) => (back.has(o.def) ? { ...o, def: back.get(o.def) } : o));
    tpl.batches = tpl.batches.filter((b) => b.ops.length);
  }
  const w = await boot(tpl, name);
  const E = w.host.engine, sp = E.rt.services.spatial; sp.sync(E.world);
  const bodies = Object.values(E.world.entities).flatMap((e) => (e.human && e.pose?.p ? [[e.pose.p[0], e.pose.p[2]]] : []));
  const rep = await fitWorldDoorsV1(w.god, bodies, (m) => console.log(`[${name}] ${m}`), sp.scene.obstacles, { pause: async () => {} });
  w.close();

  const byName = new Map(tpl.batches.flatMap((b) => b.ops).filter((o) => o.op === 'place' && o.name).map((o) => [o.name, o]));
  const doors = [], of = new Map();
  for (const f of rep.fitted) {
    const op = byName.get(f.name); if (!op) { console.log(`[${name}] no op for ${f.name}`); continue; }
    op.def = f.ref;
    for (const d of f.doors) {
      if (CUT_OFF.has(d.name)) continue;
      const { in: _in, mode: _mode, ...rest } = d;
      doors.push(rest); of.set(rest, f.name);
    }
  }
  for (let k = 0; k < doors.length; k += 256) tpl.batches.push({ note: 'door-fit/1 (#2383): a real door in each fitted outside doorway, at its building\'s height', ops: doors.slice(k, k + 256) });
  for (let round = 1; round <= 4; round++) {
    const g = await boot(tpl, name), m = g.god.model;
    let moved = 0;
    for (const d of doors) {
      const bid = m.names.get(`world/${of.get(d)}`); if (!bid || d.p.length < 3) continue;
      const y = Math.round(m.worldPose(m.entities.get(bid)).y * 1000) / 1000;
      if (Math.abs(d.p[1] - y) > 0.005) { d.p = [d.p[0], y, d.p[2]]; moved++; }
    }
    g.close();
    console.log(`[${name}] round ${round}: ${moved} door(s) moved to their building's height`);
    if (!moved) break;
  }
  const indent = /^\{\n( +)/.exec(committed)?.[1]?.length ?? 2, out = JSON.stringify(tpl, null, indent) + '\n';
  console.log(`[${name}] buildings ${rep.buildings}, doors ${doors.length}, series ${rep.series.length}, held ${rep.held.length} (and ${rep.fitted.reduce((n, f) => n + f.doors.filter((d) => CUT_OFF.has(d.name)).length, 0)} cut off), kept ${rep.kept.length}, left ${rep.left.length}`);
  if (check) { if (committed !== out) { differs++; console.log(`[${name}] differs from the committed template`); } }
  else writeFileSync(dest, out);
}
process.exit(differs ? 1 : 0);
