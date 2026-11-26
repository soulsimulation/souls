#!/usr/bin/env node
// Four humanoid Souls build one pallet-rack bay in a Mars College world and take it down again, each driven only by its
// own client commands (`v2/client/src/cli/souls.mjs`: `carry …`, `part …`). Nothing reaches into the world any other
// way: every step below is one Soul's own command line, logged with its answer.
//
// The Mars College camp template (worlds/templates/mars-camp.json) holds a rack yard in the construction kinds
// (content/kinds/construction: mars:frame_stand, mars:rack_upright, mars:rack_beam, mars:rack_bay): a frame stand with
// two frames, two loose beams and one bay site on the open ground south of the campfire. The Mars map
// (content/worlds/mars/map.json) names their copies those kinds, so the template exported with it is a buildable world
// as it is; nothing is seeded.
//
//   local   the template's world served like production under the old page (arena/new-engine/old-page.mjs), four
//           test Souls paired, the steps run against the template's own yard, and with --record <seconds> one uncut
//           clip of the old page at a fixed camera on the yard. Then the creator places one more frame live with a
//           title ("spare frame"), and Ada and Bo take it and lay it down again, naming it only by that title.
//             node tools/playtest/rack-bay/rack-bay.mjs local [--template worlds/templates/mars-camp.json] [--dir <folder>] [--record 240]
//           With --stage live the yard is placed instead by the world's creator in one `souls-god.mjs batch`, as a staged
//           world on soul.game would get it, each thing titled ("rack frame 1"); its slots have their points (#4688).
//           It goes 6 m south of the template's own yard (`AT_LIVE`), which that world still holds as plain things. A
//           live-placed stand is walked over as a seeded one is (no walk box), so a frame carried back comes down into
//           it and its `part put` is not refused `part.not-held`.
//           With --crew 6 six Souls build two bays side by side in a run, from a yard the creator places live (two
//           stands of two frames, eight beams, the two bays, and a 6.1 m frame): each bay's frames by two, its four
//           beams (low, then high) by three, a front, a back and a side beside the middle grip; then all six carry the
//           6.1 m frame together, one at each of its six grips (`buildTwoBays`).
//             node tools/playtest/rack-bay/rack-bay.mjs local --crew 6 [--record 900]
//   stage   the creator's `souls-god.mjs` lines that place the same yard live in a staged world (printed, not run):
//             node tools/playtest/rack-bay/rack-bay.mjs stage
//   run     the steps against four Souls already paired and standing in a world (soul.game's staged test world):
//             node tools/playtest/rack-bay/rack-bay.mjs run --folder <home folder> --souls ada=<soul id>,bo=<id>,cy=<id>,di=<id>
//           The folder is where `node souls.mjs` runs for them (its `.souls/`). Ids come from Ada's own `query find`.
//   print   the steps as the shell lines a person types, one Soul each, crews and ids as names to fill in.
//
// The steps (`buildAndTakeDown`): Ada and Bo carry frame 1 from the stand into the bay's upright_a, Bo holding it; Ada
// and Cy frame 2 into upright_b, Cy holding it; the change of crew: Di takes frame 1 over from Bo; Ada and Bo seat both
// low beams; everyone lets go and the bay stands unheld. Take-down: hold crews on the frames, Bo and Di lift each beam
// out and lay it where it lay, then each frame back into its stand slot. The run's transcript is `<dir>/rack-bay.json`.
import { spawn } from 'node:child_process';
import { copyFileSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { isMain } from '../../lib/is-main.mjs';
import { REPO_ROOT } from '../../lib/paths.mjs';
import { exportFacts } from '../arena/new-engine/world.mjs';
import { PAIR, lastJson, pairArgs, pairSeat, seatEnv, seatOf } from '../arena/new-engine/seat.mjs';

export const TEMPLATE = 'worlds/templates/mars-camp.json';
/** The Mars map: its rows name the rack yard's copies the construction kinds. */
export const MAP = 'content/worlds/mars/map.json';
/** The yard on mars-camp's open ground south of the campfire (metres): the stand, the two beams' places, the bay, and
 *  where the creator places the spare frame live. */
export const AT = { stand: [-6, 20], beams: [[-4, 20], [-3.7, 20]], bay: [6, 20], spare: [-1, 22] };
/** Where the creator places the yard live: 6 m south of the template's own, which a world started from the template
 *  alone still holds as plain things (its frames' posts would stop a crew's carry into a stand placed over them). */
export const AT_LIVE = { stand: [-6, 26], beams: [[-4, 26], [-3.7, 26]], bay: [6, 26], spare: [-1, 28] };
/** The fixed camera on the yard for the clip: the camp's halls behind it. */
export const CAMERA = { position: [0, 6, 31], target: [0, 1, 20.5], fov: 50 };
/** The title the creator gives the frame it places live; the Souls name it only by this. */
export const SPARE = 'spare frame';
const LABELS = ['ada', 'bo', 'cy', 'di'];
/** Six Souls' yard (--crew 6), south of the template's own: two stands of two frames, eight beams lying along z in two
 *  rows, two bays beside each other in a run (the second's first frame 0.7 m from the first's last), and the 6.1 m
 *  frame, standing, which all six carry `tall.to`. Metres. */
export const AT6 = {
  stands: [[-6, 26], [-6, 30]],
  beams: [-3.6, -2.8, -2, -1.2].flatMap((x) => [[x, 26]]).concat([-3.6, -2.8, -2, -1.2].map((x) => [x, 30])),
  bays: [[6, 26], [6, 29.6]],
  tall: { at: [-2, 35], to: [5, 35] },
};
/** The camera for six: farther back and higher, both bays and the 6.1 m frame in view. */
export const CAMERA6 = { position: [0, 11, 46], target: [0, 1, 29], fov: 50 };
const SIX = ['ada', 'bo', 'cy', 'di', 'ed', 'fy'];
/** Where a beam's carriers stand from its middle (m): outside the bay's frames, which stand at its slots' ends. */
const BEAM_FROM = '1.8';
const GOD = join(REPO_ROOT, 'v2/client/src/creator/souls-god.mjs');

/** The template's facts with its own rack yard, exported with the Mars map. Nothing is added. → the facts' path */
export function templateFacts({ template = TEMPLATE, out }) {
  return exportFacts(template, join(out, 'template.facts.json'), MAP);
}

/** The yard as one creator edit (`souls-god.mjs batch`, all or none): the stand with a frame in each slot, two beams on
 *  the ground, the bay; each with the title Souls see it by. */
export function stageBatch(ground, at = AT_LIVE) {
  const m = (v) => v; // a batch's `at` is metres (#4700)
  return [
    { op: 'place', name: 1, kind: 'mars:frame_stand', in: ground, at: [m(at.stand[0]), 0, m(at.stand[1])], title: 'frame stand' },
    { op: 'place', name: 2, kind: 'mars:rack_upright', in: 1, slot: 1, title: 'rack frame 1' },
    { op: 'place', name: 3, kind: 'mars:rack_upright', in: 1, slot: 2, title: 'rack frame 2' },
    ...at.beams.map((p, k) => ({ op: 'place', name: 4 + k, kind: 'mars:rack_beam', in: ground, at: [m(p[0]), 0, m(p[1])], title: `rack beam ${k + 1}` })),
    { op: 'place', name: 6, kind: 'mars:rack_bay', in: ground, at: [m(at.bay[0]), 0, m(at.bay[1])], title: 'rack bay' },
  ];
}

/** Six Souls' yard as one creator edit: the stands with their frames, the beams, the two bays, the 6.1 m frame. */
export function stageBatch6(ground, at = AT6) {
  const ops = [];
  let n = 0;
  at.stands.forEach((p, k) => {
    const stand = ++n;
    ops.push({ op: 'place', name: stand, kind: 'mars:frame_stand', in: ground, at: [p[0], 0, p[1]], title: `frame stand ${k + 1}` });
    for (const slot of [1, 2]) ops.push({ op: 'place', name: ++n, kind: 'mars:rack_upright', in: stand, slot, title: `rack frame ${2 * k + slot}` });
  });
  at.beams.forEach((p, k) => ops.push({ op: 'place', name: ++n, kind: 'mars:rack_beam', in: ground, at: [p[0], 0, p[1]], title: `rack beam ${k + 1}` }));
  at.bays.forEach((p, k) => ops.push({ op: 'place', name: ++n, kind: 'mars:rack_bay', in: ground, at: [p[0], 0, p[1]], title: `rack bay ${k + 1}` }));
  ops.push({ op: 'place', name: ++n, kind: 'mars:rack_upright_6m', in: ground, at: [at.tall.at[0], 0, at.tall.at[1]], title: 'tall frame' });
  return ops;
}

/** The creator's lines that place the same yard live (printed for a staged world on soul.game). */
export function stageLines(at = AT_LIVE) {
  return [
    "# as the world's creator, in the creator's folder (souls-god.mjs paired with --creator <grant>)",
    "node souls-god.mjs describe   # the ground's id (kind ground): <ground>",
    `node souls-god.mjs batch '${JSON.stringify(stageBatch('<ground>', at))}'`,
    'node souls-god.mjs describe <bay>   # its slots: upright_a, upright_b, beam_high_l/r, beam_low_l/r',
  ];
}

/** Pairs the world's creator (test person Ada) into its own home for `souls-god.mjs` (local worlds: the grant is the
 *  world folder's `creator`). → god(...words) → the command's JSON answer */
export async function pairCreator({ world, worldDir, dir }) {
  const folder = resolve(dir, 'creator'), home = join(folder, '.souls'), env = seatEnv(home);
  mkdirSync(folder, { recursive: true });
  const node = (args, onText) => new Promise((ok) => {
    const p = spawn(process.execPath, args, { cwd: folder, env, stdio: ['ignore', 'pipe', 'pipe'] });
    let o = ''; p.stdout.on('data', (d) => { o += d; onText?.(o); }); p.on('close', () => ok(o));
  });
  let asked = null;
  const going = node([PAIR, ...pairArgs(world, 'creator'), '--creator', `creator-${readFileSync(join(worldDir, 'creator'), 'utf8').trim()}`],
    (t) => { asked ??= t.split('\n').map((l) => { try { return JSON.parse(l); } catch { return null; } }).find((j) => j?.step === 'approve') ?? null; });
  for (let i = 0; i < 1200 && !asked; i++) await new Promise((r) => setTimeout(r, 50));
  if (!asked) throw new Error('no creator pairing code');
  const a = await fetch(new URL('/v1/pair/approve', world.directory), { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ code: asked.code, confirm: true, test_person: 'Ada' }) });
  if (a.status !== 200) throw new Error(`creator approval answered ${a.status}`);
  if (!lastJson(await going)?.ok) throw new Error('creator pairing failed');
  mkdirSync(join(home, 'kinds'), { recursive: true });
  copyFileSync(join(worldDir, 'world/world.kinds'), join(home, 'kinds', `${world.world}.kinds`));
  const god = async (...words) => lastJson(await node([GOD, ...words])) ?? { ok: false };
  god.quit = () => node([GOD, 'stop']);   // the daemon's op `stop` ends it
  return god;
}

/** The yard placed live by the creator in one edit, as `stageLines` prints it. → {ok, steps, bay, stand: their describes} */
export async function stageLive(god, log = () => {}, at = AT_LIVE, batch = stageBatch) {
  const steps = [];
  const go = async (...words) => {
    const a = await god(...words);
    steps.push({ words, ok: !!a.ok, answer: a });
    log(`creator: ${words.join(' ').slice(0, 120)} -> ${a.ok ? 'ok' : `REFUSED ${a.code ?? ''} ${a.detail ?? a.error ?? ''}`}`);
    if (!a.ok) throw Object.assign(new Error(words.join(' ')), { answer: a });
    return a;
  };
  try {
    await go('batch', JSON.stringify(batch(await groundOf(god), at)));
    let nodes = [];
    for (let i = 0; i < 40 && !nodes.some((n) => n.kind === 'mars:rack_bay'); i++) { nodes = (await god('describe')).nodes ?? []; await new Promise((r) => setTimeout(r, 250)); }
    const id = (k) => nodes.find((n) => n.kind === k)?.id;
    return { ok: true, steps, bay: await god('describe', String(id('mars:rack_bay'))), stand: await god('describe', String(id('mars:frame_stand'))) };
  } catch (e) { return { ok: false, steps, failed: e.answer ?? e.message }; }
}

/** The open ground's id in the creator's copy (a daemon just started has no copy yet: its first describe is empty). */
async function groundOf(god) {
  for (let i = 0; i < 40; i++) {
    const ground = ((await god('describe')).nodes ?? []).find((n) => /ground/.test(n.kind ?? ''))?.id;
    if (ground) return ground;
    await new Promise((r) => setTimeout(r, 500));
  }
  throw new Error("the creator's describe names no ground");
}

/** One more frame, placed live by the creator with a title, which Ada and Bo find, take and lay down again by that
 *  title alone: no id passes from the creator to them. → {placed: the creator's answer, seen: Ada's find of it} */
export async function spareFrame(god, { run, both }, seats, bodies, at = AT, log = () => {}) {
  const [x, z] = at.spare, ground = await groundOf(god);
  const placed = await god('place', 'mars:rack_upright', '--in', ground, '--at', `${x},0,${z}`, '--title', SPARE);
  log(`creator: place mars:rack_upright --title "${SPARE}" -> ${placed.ok ? 'ok' : `REFUSED ${placed.code ?? ''} ${placed.detail ?? ''}`}`);
  if (!placed.ok) throw Object.assign(new Error(`the creator's place was refused ${placed.code}`), { answer: placed });
  let seen = [];
  for (let i = 0; i < 40 && !seen.length; i++) {
    await run('ada', 'look');   // a query reads the copy as it is; a look brings it current first
    seen =((await seats.ada.cli('query', JSON.stringify([{ find: 'spare' }]))).answers ?? []).flatMap((a) => a.found ?? []).filter((f) => f.name === SPARE);
    if (!seen.length) await new Promise((r) => setTimeout(r, 500));
  }
  if (!seen.length) {
    const frames = ((await seats.ada.cli('query', JSON.stringify([{ find: 'rack_upright' }]))).answers ?? []).flatMap((a) => a.found ?? []);
    throw new Error(`Ada's copy shows nothing named "${SPARE}" (its frames: ${frames.map((f) => `${f.id} "${f.name}"`).join(', ')}; placed ${JSON.stringify(placed.names ?? placed)})`);
  }
  await both(['ada', 'carry', 'grip', SPARE, 'back'], ['bo', 'carry', 'grip', SPARE, 'front']);
  const { crew } = await run('ada', 'carry', 'offer', bodies.bo);
  await run('bo', 'carry', 'accept', crew);
  await run('ada', 'part', 'take', crew, SPARE);
  const to = `${x + 1.5},${z}`;
  await both(['ada', 'carry', 'to', crew, to], ['bo', 'carry', 'to', crew, to]);
  await run('ada', 'part', 'put', crew, to);
  await both(['ada', 'carry', 'leave', crew], ['bo', 'carry', 'leave', crew]);
  return { placed, seen };
}

/** A runner over seats: `run(who, ...words)` logs and returns the answer; a refused step throws with the refusal. */
export function runner(seats, log = console.log, t0 = Date.now()) {
  const lines = [];
  const run = async (who, ...words) => {
    const at = (Date.now() - t0) / 1000;
    const ans = await seats[who].cli(...words);
    lines.push({ at, who, words, ok: !!ans.ok, code: ans.code ?? null, detail: ans.detail ?? ans.reason ?? null, crew: ans.crew ?? null });
    log(`${at.toFixed(1)}s ${who}: ${words.join(' ')} -> ${ans.ok ? 'ok' : `REFUSED ${ans.code} ${ans.detail ?? ans.reason ?? ''}`}${ans.crew ? ` crew ${ans.crew}` : ''}`);
    if (!ans.ok) throw Object.assign(new Error(`${who}: ${words.join(' ')} refused ${ans.code} ${ans.detail ?? ''}`), { answer: ans });
    return ans;
  };
  const both = (...steps) => Promise.all(steps.map((s) => run(...s)));
  return { run, both, lines };
}

/** The ids as Ada's own copy names them (`query find`). */
export async function findIds(seat) {
  const a = await seat.cli('query', JSON.stringify([{ find: 'rack' }, { find: 'stand' }]));
  const found = (a.answers ?? []).flatMap((x) => x.found ?? []);
  // the template's names (frame-stand, rack-frame-1) and the titles a creator stages live ("rack frame 1") alike
  const key = (n) => String(n ?? '').toLowerCase().replace(/[^a-z0-9]/g, '');
  // of the construction kinds only: a template exported without the Mars map has the yard as plain things
  const named = (want) => { const f = found.find((x) => key(x.name) === want && /^mars:/.test(x.kind ?? '')); if (!f) throw new Error(`Ada's copy finds no "${want}" (found: ${found.map((x) => x.name).join(', ')})`); return f.id; };
  return { bay: named('rackbay'), stand: named('framestand'), fa: named('rackframe1'), fb: named('rackframe2'), beams: [named('rackbeam1'), named('rackbeam2')] };
}

/** Build the bay from the stand's frames and two loose beams, change a crew, and take it down to where each part was. */
export async function buildAndTakeDown({ run, both }, bodies, { bay, stand, fa, fb, beams }, homes = AT.beams.map((b) => b.join(','))) {
  const crew = async (a, b, on = null) => { const { crew: c } = await run(a, 'carry', 'offer', bodies[b], ...(on ? ['--on', on] : [])); await run(b, 'carry', 'accept', c); return c; };
  // Frame 1 by Ada and Bo into upright_a; Bo stays holding it.
  await both(['ada', 'carry', 'grip', fa, 'back'], ['bo', 'carry', 'grip', fa, 'front']);
  const crewA = await crew('ada', 'bo');
  await run('ada', 'part', 'take', crewA, fa);
  await both(['ada', 'carry', 'to', crewA, bay, 'upright_a'], ['bo', 'carry', 'to', crewA, bay, 'upright_a']);
  await run('ada', 'part', 'put', crewA, bay, 'upright_a');
  await run('ada', 'carry', 'leave', crewA);
  // Frame 2 by Ada and Cy into upright_b; Cy stays holding it.
  await both(['ada', 'carry', 'grip', fb, 'back'], ['cy', 'carry', 'grip', fb, 'front']);
  const crewB = await crew('ada', 'cy');
  await run('ada', 'part', 'take', crewB, fb);
  await both(['ada', 'carry', 'to', crewB, bay, 'upright_b'], ['cy', 'carry', 'to', crewB, bay, 'upright_b']);
  await run('ada', 'part', 'put', crewB, bay, 'upright_b');
  await run('ada', 'carry', 'leave', crewB);
  // The change of crew on frame 1, standing in its slot: Di takes Bo's place.
  await both(['di', 'carry', 'grip', fa, 'right'], ['ada', 'carry', 'grip', fa, 'left']);
  const crewA2 = await crew('di', 'ada', fa);
  await run('ada', 'carry', 'leave', crewA2);
  await run('bo', 'carry', 'leave', crewA);
  // The two low beams by Ada and Bo, each joined to both frames.
  const crewC = await crew('ada', 'bo');
  for (const [beam, slot] of [[beams[0], 'beam_low_l'], [beams[1], 'beam_low_r']]) {
    await both(['ada', 'carry', 'grip', beam, 'back', '--from', '2.2'], ['bo', 'carry', 'grip', beam, 'front', '--from', '2.2']);
    await run('ada', 'part', 'take', crewC, beam);
    await both(['ada', 'carry', 'to', crewC, bay, slot], ['bo', 'carry', 'to', crewC, bay, slot]);
    await run('ada', 'part', 'put', crewC, bay, slot);
  }
  // Everyone lets go: the bay stands unheld.
  await run('cy', 'carry', 'leave', crewB);
  await run('di', 'carry', 'leave', crewA2);
  await both(['ada', 'carry', 'leave', crewC], ['bo', 'carry', 'leave', crewC]);
  const built = Date.now();

  // Take-down. Hold crews on the frames: Cy holds frame 1, Ada frame 2.
  await both(['cy', 'carry', 'grip', fa, 'right'], ['di', 'carry', 'grip', fa, 'left']);
  const holdA = await crew('cy', 'di', fa);
  await run('di', 'carry', 'leave', holdA);
  await both(['ada', 'carry', 'grip', fb, 'right'], ['bo', 'carry', 'grip', fb, 'left']);
  const holdB = await crew('ada', 'bo', fb);
  await run('bo', 'carry', 'leave', holdB);
  // Bo and Di lift the beams out, the right one first, and lay each where it lay.
  const crewD = await crew('bo', 'di');
  for (const [k, beam] of [[1, beams[1]], [0, beams[0]]]) {
    await both(['bo', 'carry', 'grip', beam, 'back', '--from', '2.2'], ['di', 'carry', 'grip', beam, 'front', '--from', '2.2']);
    await run('bo', 'part', 'unseat', crewD, beam);
    await both(['bo', 'carry', 'to', crewD, homes[k]], ['di', 'carry', 'to', crewD, homes[k]]);
    await run('bo', 'part', 'put', crewD, homes[k]);
  }
  await both(['bo', 'carry', 'leave', crewD], ['di', 'carry', 'leave', crewD]);
  // Each frame out by Bo and Di, its holder letting go, back into its slot on the stand.
  for (const [f, hold, holder, slot] of [[fb, holdB, 'ada', 'frame_2'], [fa, holdA, 'cy', 'frame_1']]) {
    await both(['bo', 'carry', 'grip', f, 'back'], ['di', 'carry', 'grip', f, 'front']);
    const out = await crew('bo', 'di', f);
    await run(holder, 'carry', 'leave', hold);
    await run('bo', 'part', 'unseat', out, f);
    await both(['bo', 'carry', 'to', out, stand, slot], ['di', 'carry', 'to', out, stand, slot]);
    await run('bo', 'part', 'put', out, stand, slot);
    await both(['bo', 'carry', 'leave', out], ['di', 'carry', 'leave', out]);
  }
  return { built };
}

/** Six Souls' ids by the titles the creator gave (`stageBatch6`), as Ada's copy names them. */
export async function findIds6(seat) {
  // one find for each kind of part: a find names a dozen things at most
  const a = await seat.cli('query', JSON.stringify([{ find: 'rack frame' }, { find: 'rack beam' }, { find: 'rack bay' }, { find: 'tall frame' }]));
  const found = (a.answers ?? []).flatMap((x) => x.found ?? []);
  const named = (want) => { const f = found.find((x) => x.name === want && /^mars:/.test(x.kind ?? '')); if (!f) throw new Error(`Ada's copy finds no "${want}" (found: ${found.map((x) => x.name).join(', ')})`); return f.id; };
  return {
    bays: [1, 2].map((k) => ({ bay: named(`rack bay ${k}`), fa: named(`rack frame ${2 * k - 1}`), fb: named(`rack frame ${2 * k}`), beams: [1, 2, 3, 4].map((b) => named(`rack beam ${4 * (k - 1) + b}`)) })),
    tall: named('tall frame'),
  };
}

/**
 * Six Souls build two bays beside each other, each Soul by its own commands, then all six carry the 6.1 m frame. Each
 * bay: its first frame by two into upright_a, the front holding it; its second by two into upright_b, the front holding
 * it; its four beams by three (a front, a back, and a side beside the beam's middle grip), the low ones and then the
 * high ones, each pair right then left so none is carried past one seated at its height; then the holders let go and
 * the bay stands. The 6.1 m frame: its front, its back and four sides each at a grip, offered by the front to the
 * other five, lifted, carried `to` and set down.
 */
export async function buildTwoBays({ run, both }, bodies, { bays, tall }, to = AT6.tall.to) {
  const all = (...steps) => Promise.all(steps.map((s) => run(...s)));
  const crew = async (a, others, on = null) => {
    const { crew: c } = await run(a, 'carry', 'offer', ...others.map((o) => bodies[o]), ...(on ? ['--on', on] : []));
    for (const o of others) await run(o, 'carry', 'accept', c);   // in order: the back, then each side
    return c;
  };
  const frame = async (f, back, front, bay, slot) => {
    await both([back, 'carry', 'grip', f, 'back'], [front, 'carry', 'grip', f, 'front']);
    const c = await crew(front, [back]);
    await run(front, 'part', 'take', c, f);
    await both([back, 'carry', 'to', c, bay, slot], [front, 'carry', 'to', c, bay, slot]);
    await run(front, 'part', 'put', c, bay, slot);
    await run(back, 'carry', 'leave', c);   // the front holds it standing in its slot
    return c;
  };
  const teams = [
    { a: ['ada', 'bo'], b: ['cy', 'di'], beams: ['ada', 'cy', 'ed'] },
    { a: ['ed', 'fy'], b: ['bo', 'di'], beams: ['ada', 'cy', 'ed'] },
  ];
  const built = [];
  for (const [k, { bay, fa, fb, beams }] of bays.entries()) {
    const t = teams[k];
    const holdA = await frame(fa, t.a[0], t.a[1], bay, 'upright_a');
    const holdB = await frame(fb, t.b[0], t.b[1], bay, 'upright_b');
    const [front, back, side] = t.beams;
    const c = await crew(front, [back, side]);
    for (const [beam, slot] of [[beams[0], 'beam_low_r'], [beams[1], 'beam_low_l'], [beams[2], 'beam_high_r'], [beams[3], 'beam_high_l']]) {
      await all([back, 'carry', 'grip', beam, 'back', '--from', BEAM_FROM], [front, 'carry', 'grip', beam, 'front', '--from', BEAM_FROM], [side, 'carry', 'grip', beam, 'side', '1']);
      await run(front, 'part', 'take', c, beam);
      await all([back, 'carry', 'to', c, bay, slot], [front, 'carry', 'to', c, bay, slot], [side, 'carry', 'to', c, bay, slot]);
      await run(front, 'part', 'put', c, bay, slot);
    }
    await all([front, 'carry', 'leave', c], [back, 'carry', 'leave', c], [side, 'carry', 'leave', c]);
    await run(t.a[1], 'carry', 'leave', holdA);
    await run(t.b[1], 'carry', 'leave', holdB);
    built.push(Date.now());
  }
  // The 6.1 m frame by all six, one at each grip: Ada in front, Bo at the back, the others beside its grips between.
  const ends = ['ada', 'bo'], sides = ['cy', 'di', 'ed', 'fy'];
  await all(['ada', 'carry', 'grip', tall, 'front', '--from', '3.1'], ['bo', 'carry', 'grip', tall, 'back', '--from', '3.1'], ...sides.map((s, k) => [s, 'carry', 'grip', tall, 'side', String(k + 1)]));
  const c = await crew('ada', ['bo', ...sides]);
  await run('ada', 'carry', 'lift', c, tall);
  const where = `${to[0]},${to[1]}`;
  await all(...[...ends, ...sides].map((s) => [s, 'carry', 'to', c, where]));
  await run('bo', 'carry', 'set-down', c);
  await all(...[...ends, ...sides].map((s) => [s, 'carry', 'leave', c]));
  return { built };
}

/** The steps as a person types them: a recording runner that answers each command with a named placeholder. */
export async function printLines() {
  let n = 0;
  const seats = Object.fromEntries(LABELS.map((l) => [l, { cli: async (...words) => {
    console.log(`node souls.mjs ${words.join(' ')} --soul <${l}>`);
    return words[0] === 'carry' && words[1] === 'offer' ? { ok: true, crew: `<crew${++n}>` } : { ok: true };
  } }]));
  const ids = { bay: '<bay>', stand: '<stand>', fa: '<frame1>', fb: '<frame2>', beams: ['<beam1>', '<beam2>'] };
  await buildAndTakeDown(runner(seats, () => {}), Object.fromEntries(LABELS.map((l) => [l, `<${l}-body>`])), ids);
}

/** Where each part is, in Ada's copy; once the last crew has let go (its activity ends a moment later), up to 10 s. */
async function partsWhere(seat, ids) {
  const want = new Set([ids.fa, ids.fb, ...ids.beams]);
  let parts = [];
  for (let i = 0; i < 20; i++) {
    const q = await seat.cli('query', JSON.stringify([{ find: 'rack' }, { find: 'stand' }]));
    parts = (q.answers ?? []).flatMap((x) => x.found ?? []).filter((f) => want.has(f.id)).map((f) => ({ id: f.id, name: f.name, in: f.in ?? null }));
    if (!parts.some((p) => /activity/.test(p.in ?? ''))) break;
    await new Promise((r) => setTimeout(r, 500));
  }
  return parts;
}

async function main() {
  const argv = process.argv.slice(2), opt = (k, d) => { const i = argv.indexOf(`--${k}`); return i >= 0 ? argv[i + 1] : d; };
  const mode = argv[0];
  if (mode === 'stage') { for (const l of stageLines()) console.log(l); return; }
  if (mode === 'print') return printLines();
  const stamp = new Date().toISOString().replace(/[-:]/g, '').replace(/\..*/, '');
  const dir = resolve(opt('dir', join(REPO_ROOT, '.local/rack-bay', stamp)));
  mkdirSync(dir, { recursive: true });
  const log = (s) => console.error(`rack-bay: ${s}`);
  const out = { mode, steps: [] };
  const save = () => writeFileSync(join(dir, 'rack-bay.json'), JSON.stringify(out, null, 1));
  if (mode === 'run') {
    const folder = resolve(opt('folder', '.')), souls = Object.fromEntries(String(opt('souls', '')).split(',').filter(Boolean).map((p) => p.split('=')));
    for (const l of LABELS) if (!souls[l]) throw new Error(`--souls needs ${LABELS.join(',')}`);
    const seats = Object.fromEntries(LABELS.map((l) => [l, seatOf({ label: l, folder, home: join(folder, '.souls'), soul: souls[l], env: { ...process.env, SOULS_HOME: join(folder, '.souls') }, log: join(dir, `${l}.commands.jsonl`) })]));
    const bodies = {};
    for (const l of LABELS) bodies[l] = (await seats[l].cli('status')).body;
    out.ids = await findIds(seats.ada); out.bodies = bodies; save();
    const r = runner(seats, log); out.steps = r.lines;
    try { out.result = await buildAndTakeDown(r, bodies, out.ids); out.ok = true; } catch (e) { out.ok = false; out.failed = e.message; } finally { save(); }
    log(out.ok ? `done: ${r.lines.length} commands, 0 refused` : `stopped: ${out.failed}`);
    return;
  }
  if (mode !== 'local') { console.error('usage: rack-bay.mjs local [--template t] [--dir d] [--record s] | stage | print | run --folder f --souls ada=..,bo=..,cy=..,di=..'); process.exit(2); }
  const { startOldPage } = await import('../arena/new-engine/old-page.mjs');
  const template = opt('template', TEMPLATE), record = Number(opt('record', 0));
  const six = opt('crew', '4') === '6';
  const live = six || opt('stage', 'template') === 'live', at = live ? AT_LIVE : AT;
  const world = await startOldPage({ template, dir: join(dir, 'world'), facts: live ? null : templateFacts({ template, out: dir }), history: false, marsWeb: opt('mars-web', undefined), log });
  out.page = world.page; out.template = template; out.stage = live ? 'live' : 'facts';
  const seats = {}, bodies = {};
  let god = null;
  try {
    god = await pairCreator({ world: world.world, worldDir: join(dir, 'world', 'world'), dir });
    if (live) {
      out.staged = six ? await stageLive(god, log, AT6, stageBatch6) : await stageLive(god, log, at); save();
      if (!out.staged.ok) { log(`staging stopped: ${JSON.stringify(out.staged.failed)}`); return; }
    }
    for (const l of six ? SIX : LABELS) {
      seats[l] = await pairSeat({ world: world.world, dir: join(dir, 'seats'), label: l, name: l[0].toUpperCase() + l.slice(1) });
      bodies[l] = (await seats[l].join()).body;
      log(`${l}: body ${bodies[l]}`);
    }
    out.ids = six ? await findIds6(seats.ada) : await findIds(seats.ada); out.bodies = bodies;
    if (!six) out.before = await partsWhere(seats.ada, out.ids);
    save();
    log(`page ${world.page}`);
    const play = six ? async () => {
      const t0 = Date.now(), r = runner(seats, log, t0); out.steps = r.lines;
      try { const v = await buildTwoBays(r, bodies, out.ids); out.builtAtS = v.built.map((b) => (b - t0) / 1000); out.ok = true; } catch (e) { out.ok = false; out.failed = e.message; }
      out.ms = Date.now() - t0; save();
    } : async () => {
      const t0 = Date.now(), r = runner(seats, log, t0); out.steps = r.lines;
      try { const v = await buildAndTakeDown(r, bodies, out.ids, at.beams.map((b) => b.join(','))); out.builtAtS = (v.built - t0) / 1000; out.ok = true; } catch (e) { out.ok = false; out.failed = e.message; }
      out.ms = Date.now() - t0; save();
      // a frame the creator places live, titled, which Ada and Bo name only by its title
      const n = r.lines.length;
      try { out.spare = { ...(await spareFrame(god, r, seats, bodies, at, log)), ok: true }; } catch (e) { out.spare = { ok: false, failed: e.message }; }
      out.spare.steps = r.lines.slice(n); out.steps = r.lines.slice(0, n); save();
    };
    if (record) {
      const { capture } = await import('../../launch-video/capture.mjs');
      const { cameraShot } = await import('../../launch-video/scene.mjs');
      let done = null;
      const camera = six ? CAMERA6 : CAMERA;
      out.clip = { file: join(dir, 'rack-bay.mp4'), camera };
      out.clip.sidecar = await capture({ url: world.page, out: out.clip.file, seconds: record, size: '1280x720', hour: '12:00', shot: cameraShot({ fixed: camera }, record, 16 / 9), log, onPlay: () => { done = play(); } });
      await done;
    } else await play();
    if (!six) out.after = await partsWhere(seats.ada, out.ids);
    save();
    log(out.ok ? `done: ${out.steps.length} commands, 0 refused, ${(out.ms / 1000).toFixed(0)} s` : `stopped: ${out.failed}`);
    if (!six) log(out.spare?.ok ? `spare frame: ${out.spare.steps.length} commands by its title, 0 refused` : `spare frame stopped: ${out.spare?.failed}`);
  } finally {
    // every daemon this run started ends with it, the creator's too
    for (const s of Object.values(seats)) await s.stop();
    await god?.quit();
    save(); await world.stop();
  }
}

if (isMain(import.meta.url)) main().catch((e) => { console.error(`rack-bay: ${e.stack ?? e.message}`); process.exit(1); });
