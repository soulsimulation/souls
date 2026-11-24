#!/usr/bin/env node
// Four humanoid Souls build one pallet-rack bay in a Mars College world and take it down again, each driven only by its
// own client commands (`v2/client/src/cli/souls.mjs`: `carry …`, `part …`). Nothing reaches into the world any other
// way: every step below is one Soul's own command line, logged with its answer.
//
// The Mars College templates (worlds/templates/mars-camp.json, mars-two.json) hold no rack yard in the construction
// kinds (content/kinds/construction: mars:frame_stand, mars:rack_upright, mars:rack_beam, mars:rack_bay). mars-camp's
// stock pile is two old `core:pallet_rack` fixtures with four `core:rack_beam`s in their sockets: they import with their
// socket slots, but no kind entry makes them parts a crew can take. So a world for this needs the yard added:
//
//   local   the yard is seeded from facts (`yardFacts`: N2's test-world yard things, the Mars College template's facts
//           around them), the world served like production under the old page (arena/new-engine/old-page.mjs), four
//           test Souls paired, the steps run, and with --record <seconds> one uncut clip of the old page at a fixed
//           camera on the yard.
//             node tools/playtest/rack-bay/rack-bay.mjs local [--template worlds/templates/mars-camp.json] [--dir <folder>] [--record 240]
//           With --stage live the yard is placed instead by the world's creator in one `souls-god.mjs batch`, as a staged
//           world on soul.game would get it. Until a thing placed live gets its slots' points (another lane), the first
//           `part take` of a frame standing in the live-placed stand is refused `part-pose` (24 Nov 2026).
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
import { execFileSync, spawn } from 'node:child_process';
import { copyFileSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { isMain } from '../../lib/is-main.mjs';
import { REPO_ROOT } from '../../lib/paths.mjs';
import { exportFacts } from '../arena/new-engine/world.mjs';
import { PAIR, lastJson, pairArgs, pairSeat, seatEnv, seatOf } from '../arena/new-engine/seat.mjs';

export const TEMPLATE = 'worlds/templates/mars-camp.json';
/** The yard on mars-camp's open ground south of the campfire (metres): the stand, the two beams' places, the bay. */
export const AT = { stand: [-6, 20], beams: [[-4, 20], [-3.7, 20]], bay: [6, 20] };
/** The fixed camera on the yard for the clip: the camp's halls behind it. */
export const CAMERA = { position: [0, 6, 31], target: [0, 1, 20.5], fov: 50 };
const LABELS = ['ada', 'bo', 'cy', 'di'];
const BIN = process.env.V2_BIN ?? join(REPO_ROOT, 'v2/target/debug');
const GOD = join(REPO_ROOT, 'v2/client/src/creator/souls-god.mjs');

/** The template's facts with N2's test-world yard added at `at` (a frame stand with two frames in its slots, two loose
 *  beams) and a rack bay with its entry's slots. → the facts' path */
export function yardFacts({ template = TEMPLATE, out, at = AT }) {
  mkdirSync(out, { recursive: true });
  const f = JSON.parse(readFileSync(exportFacts(template, join(out, 'template.facts.json')), 'utf8'));
  execFileSync(join(BIN, 'testworld'), ['--out', join(out, 'tw')], { stdio: 'ignore' });
  const tw = JSON.parse(readFileSync(join(out, 'tw/testworld-s1-t0.facts.json'), 'utf8'));
  const bayEntry = JSON.parse(readFileSync(join(REPO_ROOT, 'content/kinds/construction/rack_bay.json'), 'utf8'));
  for (const k of tw.kinds.filter((k) => /frame-stand|rack-upright|rack-beam/.test(k.ref))) f.kinds.push(k);
  f.kinds.push({ ref: 'mars-rack-bay@1', hash: 'b'.repeat(64), name: 'mars:rack_bay', form: 'point' });
  const mm = ([x, z]) => [Math.round(x * 1000), Math.round(z * 1000)];
  const byId = Object.fromEntries(tw.things.map((t) => [t.id, t]));
  const place = (t, p, yaw = 0) => { const [x, z] = mm(p); return { ...t, pose: [x, 0, z, yaw], world: [x, 0, z, yaw] }; };
  const [sx, sz] = mm(at.stand);
  const stand = place(byId['yard-stand'], at.stand);
  const frames = ['yard-frame-1', 'yard-frame-2'].map((id) => { const t = byId[id]; return { ...t, world: [sx + t.pose[0], t.pose[1], sz + t.pose[2], 0] }; });
  const beams = ['yard-beam-1', 'yard-beam-2'].map((id, k) => place(byId[id], at.beams[k]));
  const slots = Object.entries(bayEntry.slots).map(([name, s], k) => ({ n: k + 1, id: name, kind: 'bay', at: s.at_mm, yaw: 0, capacity: 1 }));
  const [bx, bz] = mm(at.bay);
  const bay = { id: 'site-bay', def: 'mars-rack-bay@1', ref: 'mars-rack-bay@1', parent: null, pose: [bx, 0, bz, 0], world: [bx, 0, bz, 0], scale_ppm: 1_000_000, name: 'the rack bay', slots };
  f.things.push(stand, ...frames, ...beams, bay);
  for (const [ref, n] of [['testworld-frame-stand@1', 1], ['testworld-rack-upright@1', 2], ['testworld-rack-beam@1', 2], ['mars-rack-bay@1', 1]]) f.byRef[ref] = (f.byRef[ref] ?? 0) + n;
  const file = join(out, 'yard.facts.json');
  writeFileSync(file, JSON.stringify(f));
  return file;
}

/** The yard as one creator edit (`souls-god.mjs batch`, all or none): the stand with a frame in each slot, two beams on
 *  the ground, the bay; each named (field 1, text as hex: a plain string is refused `intent.text-not-a-name`). */
export function stageBatch(ground, at = AT) {
  const m = (v) => Math.round(v * 1000), name = (t) => ({ 1: { hex: Buffer.from(t).toString('hex') } });
  return [
    { op: 'place', name: 1, kind: 'mars:frame_stand', in: ground, at: [m(at.stand[0]), 0, m(at.stand[1])], fields: name('frame-stand') },
    { op: 'place', name: 2, kind: 'mars:rack_upright', in: 1, slot: 1, fields: name('rack-frame-1') },
    { op: 'place', name: 3, kind: 'mars:rack_upright', in: 1, slot: 2, fields: name('rack-frame-2') },
    ...at.beams.map((p, k) => ({ op: 'place', name: 4 + k, kind: 'mars:rack_beam', in: ground, at: [m(p[0]), 0, m(p[1])], fields: name(`rack-beam-${k + 1}`) })),
    { op: 'place', name: 6, kind: 'mars:rack_bay', in: ground, at: [m(at.bay[0]), 0, m(at.bay[1])], fields: name('rack-bay') },
  ];
}

/** The creator's lines that place the same yard live (printed for a staged world on soul.game). */
export function stageLines(at = AT) {
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
export async function stageLive(god, log = () => {}, at = AT) {
  const steps = [];
  const go = async (...words) => {
    const a = await god(...words);
    steps.push({ words, ok: !!a.ok, answer: a });
    log(`creator: ${words.join(' ').slice(0, 120)} -> ${a.ok ? 'ok' : `REFUSED ${a.code ?? ''} ${a.detail ?? a.error ?? ''}`}`);
    if (!a.ok) throw Object.assign(new Error(words.join(' ')), { answer: a });
    return a;
  };
  try {
    let ground = null;   // a daemon just started has no copy yet: its first describe is empty
    for (let i = 0; i < 40 && !ground; i++) { ground = ((await go('describe')).nodes ?? []).find((n) => /ground/.test(n.kind ?? ''))?.id; if (!ground) await new Promise((r) => setTimeout(r, 500)); }
    if (!ground) throw new Error("the creator's describe names no ground");
    await go('batch', JSON.stringify(stageBatch(ground, at)));
    let nodes = [];
    for (let i = 0; i < 40 && !nodes.some((n) => n.kind === 'mars:rack_bay'); i++) { nodes = (await god('describe')).nodes ?? []; await new Promise((r) => setTimeout(r, 250)); }
    const id = (k) => nodes.find((n) => n.kind === k)?.id;
    return { ok: true, steps, bay: await god('describe', String(id('mars:rack_bay'))), stand: await god('describe', String(id('mars:frame_stand'))) };
  } catch (e) { return { ok: false, steps, failed: e.answer ?? e.message }; }
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
  // seeded names ("the yard's frame stand", "rack frame 1") and staged ones (frame-stand, rack-frame-1) alike
  const key = (n) => String(n ?? '').toLowerCase().replace(/[^a-z0-9]/g, '');
  // a thing staged live shows as its kind and number ("rack_bay 136"): then by kind, in the order the creator placed them
  const n = (id) => Number(String(id).split('-').pop());
  const ofKind = (k) => found.filter((x) => x.kind === k).sort((a, b) => n(a.id) - n(b.id));
  const named = (want, kind, k = 0) => { const f = found.find((x) => key(x.name).endsWith(want)) ?? ofKind(kind)[k]; if (!f) throw new Error(`Ada's copy finds no "${want}" (found: ${found.map((x) => x.name).join(', ')})`); return f.id; };
  return { bay: named('rackbay', 'mars:rack_bay'), stand: named('framestand', 'mars:frame_stand'), fa: named('rackframe1', 'mars:rack_upright', 0), fb: named('rackframe2', 'mars:rack_upright', 1),
    beams: [named('rackbeam1', 'mars:rack_beam', 0), named('rackbeam2', 'mars:rack_beam', 1)] };
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
  const live = opt('stage', 'facts') === 'live';
  const world = await startOldPage({ template, dir: join(dir, 'world'), facts: live ? null : yardFacts({ template, out: dir }), history: false, marsWeb: opt('mars-web', undefined), log });
  out.page = world.page; out.template = template; out.stage = live ? 'live' : 'facts';
  const seats = {}, bodies = {};
  let god = null;
  try {
    if (live) {
      god = await pairCreator({ world: world.world, worldDir: join(dir, 'world', 'world'), dir });
      out.staged = await stageLive(god, log); save();
      if (!out.staged.ok) { log(`staging stopped: ${JSON.stringify(out.staged.failed)}`); return; }
    }
    for (const l of LABELS) {
      seats[l] = await pairSeat({ world: world.world, dir: join(dir, 'seats'), label: l, name: l[0].toUpperCase() + l.slice(1) });
      bodies[l] = (await seats[l].join()).body;
      log(`${l}: body ${bodies[l]}`);
    }
    out.ids = await findIds(seats.ada); out.bodies = bodies; out.before = await partsWhere(seats.ada, out.ids); save();
    log(`page ${world.page}`);
    const play = async () => {
      const t0 = Date.now(), r = runner(seats, log, t0); out.steps = r.lines;
      try { const v = await buildAndTakeDown(r, bodies, out.ids); out.builtAtS = (v.built - t0) / 1000; out.ok = true; } catch (e) { out.ok = false; out.failed = e.message; }
      out.ms = Date.now() - t0; save();
    };
    if (record) {
      const { capture } = await import('../../launch-video/capture.mjs');
      const { cameraShot } = await import('../../launch-video/scene.mjs');
      let done = null;
      out.clip = { file: join(dir, 'rack-bay.mp4'), camera: CAMERA };
      out.clip.sidecar = await capture({ url: world.page, out: out.clip.file, seconds: record, size: '1280x720', hour: '12:00', shot: cameraShot({ fixed: CAMERA }, record, 16 / 9), log, onPlay: () => { done = play(); } });
      await done;
    } else await play();
    out.after = await partsWhere(seats.ada, out.ids); save();
    log(out.ok ? `done: ${out.steps.length} commands, 0 refused, ${(out.ms / 1000).toFixed(0)} s` : `stopped: ${out.failed}`);
  } finally {
    // every daemon this run started ends with it, the creator's too
    for (const s of Object.values(seats)) await s.stop();
    await god?.quit();
    save(); await world.stop();
  }
}

if (isMain(import.meta.url)) main().catch((e) => { console.error(`rack-bay: ${e.stack ?? e.message}`); process.exit(1); });
