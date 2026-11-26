#!/usr/bin/env node
// Crews of two, four and six Souls carry heavy loads to the Mars camp's loading spot, each Soul driven only by its own
// client commands (`v2/client/src/cli/souls.mjs`: `carry …`), in its own folder. Nothing reaches into the world any other
// way: every step below is one Soul's own command line, logged with its answer.
//
// The Mars camp template (worlds/templates/mars-camp.json, its `loading` batch) holds a loading spot of four bays at
// (24, 24) m and four loads in a row west of it, which the Mars map (content/worlds/mars/map.json) names in the
// construction kinds: two pallets of crates (a crew of two), a generator (four) and a timber bundle (four to six).
//
//   local   the template's world served like production under the old page (arena/new-engine/old-page.mjs), six test
//           Souls paired, the steps run, and with --record <seconds> one uncut clip of the old page at a fixed camera:
//             node tools/playtest/loading-spot/loading-spot.mjs local [--dir <folder>] [--record 300]
//   print   the steps as the shell lines a person types, one Soul each.
//
// The steps (`haul`): Ada and Bo carry pallet 1 to the spot; Cy and Di try the generator alone and are refused by name
// (`carry-crew-too-small`), then Ed and Fay join them and the four carry it; all six carry the timber bundle; Ed and
// Fay carry pallet 2. Each crew: everyone to their grip, the front offers, the rest accept in grip order, the front
// lifts, every carrier `carry to <crew> the loading spot` at once, the front sets it down, everyone leaves. The run's
// transcript is `<dir>/loading-spot.json`: each command, its answer, and where each load ends.
import { mkdirSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { isMain } from '../../lib/is-main.mjs';
import { REPO_ROOT } from '../../lib/paths.mjs';
import { pairSeat } from '../arena/new-engine/seat.mjs';
import { runner, templateFacts } from '../rack-bay/rack-bay.mjs';

export const TEMPLATE = 'worlds/templates/mars-camp.json';
/** The spot and the loads as the template places them (metres). */
export const AT = { spot: [24, 24], loads: { 'pallet-crates-1': [16.4, 24], generator: [14, 24], 'timber-bundle': [11.6, 24], 'pallet-crates-2': [9.2, 24] } };
/** The fixed camera for the clip: south of the row, the spot to the right. */
export const CAMERA = { position: [18, 9, 38], target: [18.5, 0.5, 24], fov: 55 };
export const LABELS = ['ada', 'bo', 'cy', 'di', 'ed', 'fay'];
export const SPOT = 'the loading spot';

/**
 * One crew carries `load` to the loading spot. `crew`: the Souls in grip order, `[front, back, ...sides]`, each side
 * `[who, 'left'|'right', n]` (the n-th grip between the ends, from the back; the n-th to accept takes it).
 * → {crew, bay}
 */
export async function carryToSpot({ run, both }, bodies, load, [front, back, ...sides]) {
  await both([front, 'carry', 'grip', load, 'front'], [back, 'carry', 'grip', load, 'back'],
    ...sides.map(([who, side, n]) => [who, 'carry', 'grip', load, side, String(n)]));
  const { crew } = await run(front, 'carry', 'offer', bodies[back], ...sides.map(([who]) => bodies[who]));
  for (const who of [back, ...sides.map(([w]) => w)]) await run(who, 'carry', 'accept', crew);
  await run(front, 'carry', 'lift', crew, load);
  // Every carrier's copy current first, so their walks start together: the world breaks a carry off when a carrier
  // drifts more than 1 m from its place (sim::activity::carry::STRETCH), and a walk sent 1.5 s ahead of the rest does.
  const all = [front, back, ...sides.map(([w]) => w)];
  await both(...all.map((who) => [who, 'look']));
  const went = await both(...all.map((who) => [who, 'carry', 'to', crew, SPOT]));
  await run(front, 'carry', 'set-down', crew);
  await both(...[front, back, ...sides.map(([w]) => w)].map((who) => [who, 'carry', 'leave', crew]));
  return { crew, bay: went[0].bay ?? null };
}

/** A step that must be refused by name: → the refusal; throws when it is taken. */
async function refused(seats, log, lines, code, who, ...words) {
  const ans = await seats[who].cli(...words);
  lines.push({ at: null, who, words, ok: !!ans.ok, code: ans.code ?? null, detail: ans.detail ?? null, expected: code });
  log(`${who}: ${words.join(' ')} -> ${ans.ok ? 'ok (expected a refusal)' : `REFUSED ${ans.code} ${ans.detail ?? ''}`}`);
  if (ans.ok || ans.code !== code) throw new Error(`${who}: ${words.join(' ')} was not refused ${code} (${ans.code ?? 'taken'})`);
  return ans;
}

/** The haul: pallet 1 by two, the generator refused to two and carried by four, the bundle by six, pallet 2 by two. */
export async function haul(r, bodies, seats, log = () => {}) {
  const out = {};
  out['pallet-crates-1'] = await carryToSpot(r, bodies, 'pallet-crates-1', ['ada', 'bo']);
  // Two alone cannot lift the generator: the world refuses it by name, and they let go.
  await r.both(['cy', 'carry', 'grip', 'generator', 'front'], ['di', 'carry', 'grip', 'generator', 'back']);
  const { crew: two } = await r.run('cy', 'carry', 'offer', bodies.di);
  await r.run('di', 'carry', 'accept', two);
  out.tooSmall = await refused(seats, log, r.lines, 'carry-crew-too-small', 'cy', 'carry', 'lift', two, 'generator');
  await r.both(['cy', 'carry', 'leave', two], ['di', 'carry', 'leave', two]);
  out.generator = await carryToSpot(r, bodies, 'generator', ['cy', 'di', ['ed', 'right', 1], ['fay', 'right', 2]]);
  out['timber-bundle'] = await carryToSpot(r, bodies, 'timber-bundle', ['ada', 'bo', ['cy', 'right', 1], ['di', 'left', 2], ['ed', 'right', 3], ['fay', 'left', 4]]);
  out['pallet-crates-2'] = await carryToSpot(r, bodies, 'pallet-crates-2', ['ed', 'fay']);
  return out;
}

/** Where each load is now, in a Soul's copy (`query find`): its name, what it is in and where (metres). */
export async function loadsWhere(seat) {
  const q = await seat.cli('query', JSON.stringify([{ find: 'pallet' }, { find: 'generator' }, { find: 'timber' }, { find: 'loading' }]));
  return (q.answers ?? []).flatMap((x) => x.found ?? []).map((f) => ({ id: f.id, name: f.name, kind: f.kind, in: f.in ?? null, at: f.at ?? f.pos ?? null }));
}

/** The steps as a person types them: a recording runner that answers each command with a named placeholder. */
export async function printLines() {
  let n = 0;
  const seats = Object.fromEntries(LABELS.map((l) => [l, { cli: async (...words) => {
    console.log(`node souls.mjs ${words.join(' ')} --soul <${l}>`);
    if (words[1] === 'offer') return { ok: true, crew: `<crew${++n}>` };
    return words[1] === 'lift' && words[3] === 'generator' && n === 2 ? { ok: false, code: 'carry-crew-too-small' } : { ok: true };
  } }]));
  const r = runner(seats, () => {});
  await haul(r, Object.fromEntries(LABELS.map((l) => [l, `<${l}>`])), seats);
}

async function main() {
  const argv = process.argv.slice(2), opt = (k, d) => { const i = argv.indexOf(`--${k}`); return i >= 0 ? argv[i + 1] : d; };
  const mode = argv[0];
  if (mode === 'print') return printLines();
  if (mode !== 'local') { console.error('usage: loading-spot.mjs local [--dir d] [--record s] | print'); process.exit(2); }
  const stamp = new Date().toISOString().replace(/[-:]/g, '').replace(/\..*/, '');
  const dir = resolve(opt('dir', join(REPO_ROOT, '.local/loading-spot', stamp)));
  mkdirSync(dir, { recursive: true });
  const log = (s) => console.error(`loading-spot: ${s}`);
  const out = { mode, template: TEMPLATE, steps: [] };
  const save = () => writeFileSync(join(dir, 'loading-spot.json'), JSON.stringify(out, null, 1));
  const { startOldPage } = await import('../arena/new-engine/old-page.mjs');
  const record = Number(opt('record', 0));
  const world = await startOldPage({ template: TEMPLATE, dir: join(dir, 'world'), facts: templateFacts({ template: TEMPLATE, out: dir }), history: false, marsWeb: opt('mars-web', undefined), log });
  out.page = world.page;
  const seats = {}, bodies = {};
  try {
    for (const l of LABELS) {
      seats[l] = await pairSeat({ world: world.world, dir: join(dir, 'seats'), label: l, name: l[0].toUpperCase() + l.slice(1) });
      bodies[l] = (await seats[l].join()).body;
      log(`${l}: body ${bodies[l]}`);
    }
    out.bodies = bodies; out.before = await loadsWhere(seats.ada); save();
    const play = async () => {
      const t0 = Date.now(), r = runner(seats, log, t0); out.steps = r.lines;
      try { out.result = await haul(r, bodies, seats, log); out.ok = true; } catch (e) { out.ok = false; out.failed = e.message; }
      out.ms = Date.now() - t0; save();
    };
    if (record) {
      const { capture } = await import('../../launch-video/capture.mjs');
      const { cameraShot } = await import('../../launch-video/scene.mjs');
      let done = null;
      out.clip = { file: join(dir, 'loading-spot.mp4'), camera: CAMERA };
      out.clip.sidecar = await capture({ url: world.page, out: out.clip.file, seconds: record, size: '1280x720', hour: '12:00', shot: cameraShot({ fixed: CAMERA }, record, 16 / 9), log, onPlay: () => { done = play(); } });
      await done;
    } else await play();
    out.after = await loadsWhere(seats.ada); save();
    log(out.ok ? `done: ${out.steps.length} commands, ${(out.ms / 1000).toFixed(0)} s; bays ${JSON.stringify(Object.fromEntries(Object.entries(out.result).filter(([, v]) => v?.bay).map(([k, v]) => [k, v.bay])))}` : `stopped: ${out.failed}`);
  } finally {
    for (const s of Object.values(seats)) await s.stop();
    save(); await world.stop();
  }
}

if (isMain(import.meta.url)) main().catch((e) => { console.error(`loading-spot: ${e.stack ?? e.message}`); process.exit(1); });
