#!/usr/bin/env node
// A crew of four or six humanoid Souls builds a timber shade in a Mars College world and takes it down again, each Soul
// driven only by its own client commands (`v2/client/src/cli/souls.mjs`: `carry …`, `part …`), each from its own
// folder. Nothing reaches into the world any other way: every step below is one Soul's own command line, logged with
// its answer.
//
// The Mars College camp template (worlds/templates/mars-camp.json) holds a shade yard in the carpentry kinds
// (content/kinds/carpentry: mars:timber_bent, mars:timber_rail, mars:shade_cloth, mars:shade_site): two bents standing,
// two rails and a shade cloth lying, beside a marked site east of the rack yard. The Mars map (content/worlds/mars/
// map.json) names their copies those kinds, so the template exported with it is a buildable world as it is.
//
// The shade: two bents (two posts and a tie each) stand in the site 3 m apart, a rail on each side joins their tops, a
// shade cloth rests on both rails. Its order is the kinds' (sim::structure): a bent is held until both rails brace it,
// a rail needs both bents standing, the cloth needs both rails and comes off first. Two carry a bent or a rail (up to
// four a rail), four to six the cloth.
//
//   local   the template's world served like production under the old page (arena/new-engine/old-page.mjs), four or
//           six test Souls paired, the build and take-down run against the template's own yard, and with
//           --record <seconds> one uncut clip of the old page at a fixed camera on the yard.
//             node tools/playtest/shade/shade.mjs local --crew 4|6 [--dir <folder>] [--record 600] [--mars-web <dir>]
//   print   the steps as the shell lines a person types, one Soul each:
//             node tools/playtest/shade/shade.mjs print --crew 4|6
//
// Four (`buildFour`): Ada and Bo raise bent 1, Bo holding it; Ada and Cy bent 2, Cy holding it; Ada and Di seat both
// rails; the holders let go and the frame stands; all four lift the cloth onto the rails. Six (`buildSix`): two crews
// raise both bents at once, two crews seat both rails at once, all six lift the cloth. Take-down (`takeDown`): four
// take the cloth off, a holder on each bent, the rails out, each bent carried back to where it stood. The transcript
// is `<dir>/shade.json`.
import { mkdirSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { isMain } from '../../lib/is-main.mjs';
import { REPO_ROOT } from '../../lib/paths.mjs';
import { pairSeat } from '../arena/new-engine/seat.mjs';
import { TEMPLATE, runner, templateFacts } from '../rack-bay/rack-bay.mjs';

/** The shade yard in mars-camp (metres): where each part lies or stands, the site, and where a rail's crew stops
 *  beside the site to set it in (within a metre of its slot, outside the bents' posts). */
export const AT = {
  site: [14, 15],
  bents: [[10, 13.5], [10, 16.5]],
  rails: [[11.5, 15], [17.5, 15]],
  cloth: [19, 15],
  railIn: [[12.25, 15], [15.75, 15]],
};
/** The fixed camera on the yard for the clip, from the south. */
export const CAMERA = { position: [14, 5.5, 25], target: [14, 1.2, 15], fov: 50 };
export const LABELS = ['ada', 'bo', 'cy', 'di', 'eve', 'fay'];
const xz = (p) => p.join(',');

/** A crew: `a` offers it (on the open ground, or `--on` a part to hold it), each of `others` accepts in turn. */
async function crewOf({ run }, bodies, a, others, on = null) {
  const { crew } = await run(a, 'carry', 'offer', ...others.map((o) => bodies[o]), ...(on ? ['--on', on] : []));
  for (const o of others) await run(o, 'carry', 'accept', crew);
  return crew;
}

/** A bent raised into its slot by `a` and `b`; `b` stays holding it. → the crew */
async function raise(r, bodies, ids, bent, slot, a, b) {
  await r.both([a, 'carry', 'grip', bent, 'back'], [b, 'carry', 'grip', bent, 'front']);
  const crew = await crewOf(r, bodies, a, [b]);
  await r.run(a, 'part', 'take', crew, bent);
  await r.both([a, 'carry', 'to', crew, ids.site, slot], [b, 'carry', 'to', crew, ids.site, slot]);
  await r.run(a, 'part', 'put', crew, ids.site, slot);
  await r.run(a, 'carry', 'leave', crew);
  return crew;
}

/** A rail seated by `a` and `b`, set in from beside the site at `stop`. → the crew */
async function seatRail(r, bodies, ids, rail, slot, stop, a, b, crew = null) {
  await r.both([a, 'carry', 'grip', rail, 'back', '--from', '2.2'], [b, 'carry', 'grip', rail, 'front', '--from', '2.2']);
  crew ??= await crewOf(r, bodies, a, [b]);
  await r.run(a, 'part', 'take', crew, rail);
  await r.both([a, 'carry', 'to', crew, xz(stop)], [b, 'carry', 'to', crew, xz(stop)]);
  await r.run(a, 'part', 'put', crew, ids.site, slot);
  return crew;
}

/** The cloth by a crew of four or six: the first at its back, the second at its front, the rest beside it. Taken from
 *  where it lies (`take`) or off the rails (`unseat`), carried to `to` (the site, or where it lay), put there. */
async function cloth(r, bodies, ids, who, how, to, into) {
  const [a, b, ...sides] = who;
  await Promise.all([
    r.run(a, 'carry', 'grip', ids.cloth, 'back', '--from', '2.2'),
    r.run(b, 'carry', 'grip', ids.cloth, 'front', '--from', '2.2'),
    ...sides.map((s, k) => r.run(s, 'carry', 'grip', ids.cloth, k % 2 ? 'left' : 'right', '--from', '1.3')),
  ]);
  const crew = await crewOf(r, bodies, a, [b, ...sides]);
  await r.run(a, 'part', how, crew, ids.cloth);
  await Promise.all(who.map((s) => r.run(s, 'carry', 'to', crew, xz(to))));
  await r.run(a, 'part', 'put', crew, ...into);
  await Promise.all(who.map((s) => r.run(s, 'carry', 'leave', crew)));
}

/** Four build it: the bents one after the other, then both rails by one crew, then the cloth. */
export async function buildFour(r, bodies, ids) {
  const holdA = await raise(r, bodies, ids, ids.bents[0], 'bent_a', 'ada', 'bo');
  const holdB = await raise(r, bodies, ids, ids.bents[1], 'bent_b', 'ada', 'cy');
  const crew = await seatRail(r, bodies, ids, ids.rails[0], 'rail_l', AT.railIn[0], 'ada', 'di');
  await seatRail(r, bodies, ids, ids.rails[1], 'rail_r', AT.railIn[1], 'ada', 'di', crew);
  // the rails brace both bents: the holders let go and the frame stands unheld
  await r.run('bo', 'carry', 'leave', holdA);
  await r.run('cy', 'carry', 'leave', holdB);
  await r.both(['ada', 'carry', 'leave', crew], ['di', 'carry', 'leave', crew]);
  await cloth(r, bodies, ids, ['ada', 'bo', 'cy', 'di'], 'take', AT.site, [ids.site, 'cloth']);
}

/** Six build it: both bents at once, both rails at once, then all six lift the cloth. */
export async function buildSix(r, bodies, ids) {
  const [holdA, holdB] = await Promise.all([
    raise(r, bodies, ids, ids.bents[0], 'bent_a', 'ada', 'bo'),
    raise(r, bodies, ids, ids.bents[1], 'bent_b', 'cy', 'di'),
  ]);
  const crews = await Promise.all([
    seatRail(r, bodies, ids, ids.rails[0], 'rail_l', AT.railIn[0], 'ada', 'eve'),
    seatRail(r, bodies, ids, ids.rails[1], 'rail_r', AT.railIn[1], 'cy', 'fay'),
  ]);
  await r.both(['bo', 'carry', 'leave', holdA], ['di', 'carry', 'leave', holdB]);
  await Promise.all([['ada', 'eve'], ['cy', 'fay']].flatMap(([a, b], k) => [r.run(a, 'carry', 'leave', crews[k]), r.run(b, 'carry', 'leave', crews[k])]));
  await cloth(r, bodies, ids, ['ada', 'bo', 'cy', 'di', 'eve', 'fay'], 'take', AT.site, [ids.site, 'cloth']);
}

/** Take-down by four: the cloth off to where it lay, a holder on each bent, the rails out to where they lay, each bent
 *  carried back to where it stood. */
export async function takeDown(r, bodies, ids) {
  await cloth(r, bodies, ids, ['ada', 'bo', 'cy', 'di'], 'unseat', AT.cloth, [xz(AT.cloth)]);
  const holds = [];
  for (const [bent, a, b] of [[ids.bents[0], 'cy', 'di'], [ids.bents[1], 'ada', 'bo']]) {
    await r.both([a, 'carry', 'grip', bent, 'right'], [b, 'carry', 'grip', bent, 'left']);
    const hold = await crewOf(r, bodies, a, [b], bent);
    await r.run(b, 'carry', 'leave', hold);
    holds.push([hold, a]);
  }
  const crew = await crewOf(r, bodies, 'bo', ['di']);
  for (const k of [1, 0]) {
    await r.both(['bo', 'carry', 'grip', ids.rails[k], 'back', '--from', '2.2'], ['di', 'carry', 'grip', ids.rails[k], 'front', '--from', '2.2']);
    await r.run('bo', 'part', 'unseat', crew, ids.rails[k]);
    await r.both(['bo', 'carry', 'to', crew, xz(AT.rails[k])], ['di', 'carry', 'to', crew, xz(AT.rails[k])]);
    await r.run('bo', 'part', 'put', crew, xz(AT.rails[k]));
  }
  await r.both(['bo', 'carry', 'leave', crew], ['di', 'carry', 'leave', crew]);
  for (const k of [1, 0]) {
    const [hold, holder] = holds[k], bent = ids.bents[k];
    await r.both(['bo', 'carry', 'grip', bent, 'back'], ['di', 'carry', 'grip', bent, 'front']);
    const out = await crewOf(r, bodies, 'bo', ['di'], bent);
    await r.run(holder, 'carry', 'leave', hold);
    await r.run('bo', 'part', 'unseat', out, bent);
    await r.both(['bo', 'carry', 'to', out, xz(AT.bents[k])], ['di', 'carry', 'to', out, xz(AT.bents[k])]);
    await r.run('bo', 'part', 'put', out, xz(AT.bents[k]));
    await r.both(['bo', 'carry', 'leave', out], ['di', 'carry', 'leave', out]);
  }
}

/** The shade yard's ids as Ada's own copy names them (`query find`). */
export async function findIds(seat) {
  const a = await seat.cli('query', JSON.stringify([{ find: 'timber' }, { find: 'shade' }]));
  const found = (a.answers ?? []).flatMap((x) => x.found ?? []);
  const key = (n) => String(n ?? '').toLowerCase().replace(/[^a-z0-9]/g, '');
  const named = (want) => { const f = found.find((x) => key(x.name) === want && /^mars:/.test(x.kind ?? '')); if (!f) throw new Error(`Ada's copy finds no "${want}" (found: ${found.map((x) => `${x.name} ${x.kind}`).join(', ')})`); return f.id; };
  return { site: named('shadesite'), bents: [named('timberbent1'), named('timberbent2')], rails: [named('timberrail1'), named('timberrail2')], cloth: named('shadecloth') };
}

/** Where each part is, in Ada's copy, once the last crew has let go (its activity ends a moment later), up to 10 s. */
async function partsWhere(seat, ids) {
  const want = new Set([...ids.bents, ...ids.rails, ids.cloth]);
  let parts = [];
  for (let i = 0; i < 20; i++) {
    const q = await seat.cli('query', JSON.stringify([{ find: 'timber' }, { find: 'shade' }]));
    parts = (q.answers ?? []).flatMap((x) => x.found ?? []).filter((f) => want.has(f.id)).map((f) => ({ id: f.id, name: f.name, in: f.in ?? null }));
    if (!parts.some((p) => /activity/.test(p.in ?? ''))) break;
    await new Promise((res) => setTimeout(res, 500));
  }
  return parts;
}

/** The steps as a person types them: a recording runner that answers each command with a named placeholder. */
export async function printLines(n) {
  let k = 0;
  const seats = Object.fromEntries(LABELS.slice(0, n).map((l) => [l, { cli: async (...words) => {
    console.log(`node souls.mjs ${words.join(' ')} --soul <${l}>`);
    return words[0] === 'carry' && words[1] === 'offer' ? { ok: true, crew: `<crew${++k}>` } : { ok: true };
  } }]));
  const ids = { site: '<site>', bents: ['<bent1>', '<bent2>'], rails: ['<rail1>', '<rail2>'], cloth: '<cloth>' };
  const bodies = Object.fromEntries(LABELS.map((l) => [l, `<${l}-body>`]));
  const r = runner(seats, () => {});
  await (n === 6 ? buildSix : buildFour)(r, bodies, ids);
  console.log('# take-down');
  await takeDown(r, bodies, ids);
}

async function main() {
  const argv = process.argv.slice(2), opt = (k, d) => { const i = argv.indexOf(`--${k}`); return i >= 0 ? argv[i + 1] : d; };
  const mode = argv[0], n = Number(opt('crew', 4));
  if (n !== 4 && n !== 6) throw new Error('--crew 4 or 6');
  if (mode === 'print') return printLines(n);
  if (mode !== 'local') { console.error('usage: shade.mjs local --crew 4|6 [--dir d] [--record s] [--mars-web d] | print --crew 4|6'); process.exit(2); }
  const stamp = new Date().toISOString().replace(/[-:]/g, '').replace(/\..*/, '');
  const dir = resolve(opt('dir', join(REPO_ROOT, '.local/shade', `${stamp}-crew${n}`)));
  mkdirSync(dir, { recursive: true });
  const log = (s) => console.error(`shade: ${s}`);
  const out = { mode, crew: n, steps: [] };
  const save = () => writeFileSync(join(dir, 'shade.json'), JSON.stringify(out, null, 1));
  const { startOldPage } = await import('../arena/new-engine/old-page.mjs');
  const template = opt('template', TEMPLATE), record = Number(opt('record', 0));
  const world = await startOldPage({ template, dir: join(dir, 'world'), facts: templateFacts({ template, out: dir }), history: false, marsWeb: opt('mars-web', undefined), log });
  out.page = 'local'; out.template = template;
  const seats = {}, bodies = {};
  try {
    for (const l of LABELS.slice(0, n)) {
      seats[l] = await pairSeat({ world: world.world, dir: join(dir, 'seats'), label: l, name: l[0].toUpperCase() + l.slice(1) });
      bodies[l] = (await seats[l].join()).body;
      log(`${l}: body ${bodies[l]}`);
    }
    out.ids = await findIds(seats.ada); out.bodies = bodies; out.before = await partsWhere(seats.ada, out.ids); save();
    const play = async () => {
      const t0 = Date.now(), r = runner(seats, log, t0); out.steps = r.lines;
      try {
        await (n === 6 ? buildSix : buildFour)(r, bodies, out.ids);
        out.builtAtS = (Date.now() - t0) / 1000; out.built = await partsWhere(seats.ada, out.ids); save();
        log(`built in ${out.builtAtS.toFixed(0)} s`);
        await takeDown(r, bodies, out.ids);
        out.ok = true;
      } catch (e) { out.ok = false; out.failed = e.message; }
      out.ms = Date.now() - t0; save();
    };
    if (record) {
      const { capture } = await import('../../launch-video/capture.mjs');
      const { cameraShot } = await import('../../launch-video/scene.mjs');
      let done = null;
      out.clip = { file: join(dir, 'shade.mp4'), camera: CAMERA };
      out.clip.sidecar = await capture({ url: world.page, out: out.clip.file, seconds: record, size: '1280x720', hour: '12:00', shot: cameraShot({ fixed: CAMERA }, record, 16 / 9), log, onPlay: () => { out.clip.playAt = Date.now(); done = play(); } });
      await done;
    } else await play();
    out.after = await partsWhere(seats.ada, out.ids); save();
    log(out.ok ? `done: ${out.steps.length} commands, 0 refused, built in ${out.builtAtS.toFixed(0)} s, all in ${(out.ms / 1000).toFixed(0)} s` : `stopped: ${out.failed}`);
  } finally {
    for (const s of Object.values(seats)) await s.stop();
    save(); await world.stop();
  }
}

if (isMain(import.meta.url)) main().catch((e) => { console.error(`shade: ${e.stack ?? e.message}`); process.exit(1); });
