// One actual native two-carrier lifecycle. Resources belong to runOwnedAttempt; controls are ordinary UI/CLI input.
// The scene (from attempt 7): the camp's loose rack beam on open ground, lifted by its two ends, carried south along its
// own length and then east round a corner, and set down. The front's `carry to` walks the whole crew (the world keeps
// each carrier's place), so one command starts a leg and the driver waits out its walk. A rack frame is not the scene:
// the world carries a frame standing, its native hand contacts at its foot's middle, out of its carriers' reach.
import { execFile, spawn } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import { existsSync, mkdirSync, openSync, closeSync, readFileSync, writeFileSync, appendFileSync, fsyncSync, renameSync, copyFileSync } from 'node:fs';
import { join } from 'node:path';
import { PAIR, pairArgs, lastJson, seatOf, seatEnv } from '../../playtest/arena/new-engine/seat.mjs';
import { contactTools } from '../../playtest/carry-contact/oracle.mjs';
import { entityId } from '../../../apps/web/src/v2-engine/entity-id.ts';
import { layerDraws } from '../../../apps/web/src/v2-engine/layer-draws.ts';
import { nativeCameraMode } from './camera-native-page.mjs';
// A second scene, a survey (attempt 12; CARRY_SCENE=bay): a beam seated between two held frames, by four Souls in the
// camp's own yard. Two crews carry the stand's two frames into the bay's upright slots at once; the west carrier of
// each lets go and the east one stays holding its frame. The two free Souls then take a loose beam, carry it to the
// bay's west mouth, 0.45 m outside the slot's line (the frames' posts stand on that line), and `part put` sets it in
// from there. The frames' carries start as the seats are paired, so the whole scene fits the attempt's 90 s journey;
// the page is open before the frames are taken. The contact oracle watches the beam's crew and is recorded as a
// measurement: this scene's checks are that every command was accepted, the parts ended in the bay and the page raised
// no error. (The holders cannot let go yet: a frame stands unheld only with a beam on each of its columns.)
const SCENES = {
  beam: { who: ['ada', 'bo'], load: 'rack-beam-4', kind: 'mars:rack_beam', entry: 'content/kinds/construction/rack_beam.json',
    view: 'post=0&hour=12:00&eye=3.5,3.2,26.5&at=-2,.9,22.3', liftMs: 2500, legs: [['-3.1,23.5', 4500], ['-0.5,23.5', 3500]] },
  bay: { who: ['ada', 'bo', 'cy', 'di'], kind: 'mars:rack_beam', entry: 'content/kinds/construction/rack_beam.json',
    view: 'post=0&hour=12:00&eye=.8,5.5,32&at=.8,.8,20.5',
    build: { bay: 'rack-bay', frames: [['rack-frame-1', 'upright_a', 'ada', 'bo'], ['rack-frame-2', 'upright_b', 'di', 'cy']], carriers: ['ada', 'di'], beam: ['rack-beam-1', 'beam_low_l', '4.978,20'] } },
  // A third survey (B4, attempt 14; CARRY_SCENE=raise): the camp has no lying upright, so two Souls take the stand's first
  // frame off it standing, set it down on open ground and lay it down (`part lower`); carry it lying to its place by the
  // bay and set it down; raise it about its foot (Ada the lifter beside its top, Bo the footer beside its base), hold it
  // and lower it. A raise the world turns back (its end refused, rehearsal r3 to r5) is asked again, at most three times.
  raise: { who: ['ada', 'bo'], kind: 'mars:rack_upright', entry: 'content/kinds/construction/rack_upright.json',
    view: 'post=0&hour=12:00&eye=-2.5,4.2,27&at=1.5,.9,17.5',
    raise: { frame: 'rack-frame-1', lifter: 'ada', footer: 'bo', down: '-1,17', place: '4,18.3' } },
  // The first third of the build (B4 item 3, attempt 16; CARRY_SCENE=third): each of the stand's frames is carried standing
  // to its upright place by the bay, set down, laid down away from the bay and raised there by its own pair, who hold it;
  // then a third crew carries a loose beam to the bay's west mouth and asks to seat it on the low left slot. On today's
  // native a raise ends standing on the ground, not in the bay's slot, so that put is refused (support.none); the survey
  // records the answer.
  third: { who: ['ada', 'bo', 'cy', 'di', 'ed', 'fi'], kind: 'mars:rack_upright', entry: 'content/kinds/construction/rack_upright.json',
    view: 'post=0&hour=12:00&eye=-1,4.6,29&at=4,.9,19.5',
    third: { bay: 'rack-bay', frames: [['rack-frame-1', 'ada', 'bo', '6,18.552', '6,14', 'upright_a'], ['rack-frame-2', 'di', 'cy', '6,21.448', '6,26', 'upright_b']],
      beam: ['rack-beam-1', 'ed', 'fi', '4.978,20', 'beam_low_l'], more: [['rack-beam-2', ['4,16', '8,16', '7.022,20'], 'beam_low_r']] } },
  // A plywood sheet carried by two (B4 item 5, attempt 17; CARRY_SCENE=sheet; the deck yard of #5258): taken from the
  // sheet pile, carried east then south, set down by the deck bay.
  sheet: { who: ['ada', 'bo'], kind: 'mars:plywood_sheet', entry: 'content/kinds/construction/plywood_sheet.json',
    view: 'post=0&hour=12:00&eye=-21,4.4,33.5&at=-27,.6,25.5',
    carry: { load: 'plywood-sheet-1', back: 'ada', front: 'bo', legs: [['-27,25', 7000], ['-24,25', 7000]] } },
  // A 2x4 joist carried by two (B4 item 5, attempt 18; CARRY_SCENE=joist): from the deck yard's pile east, then north.
  joist: { who: ['ada', 'bo'], kind: 'mars:two_by_four', entry: 'content/kinds/construction/two_by_four.json',
    view: 'post=0&hour=12:00&eye=-21,4.4,33.5&at=-27,.6,25.5',
    carry: { load: 'two-by-four-1', back: 'ada', front: 'bo', legs: [['-25,27.2', 8000], ['-25,25', 8000]] } },
  // The first third on the reference's own parts (attempt 20; CARRY_SCENE=deck; #5258's deck yard, #5268's raise into a
  // slot, holders outside the bay, and a crew turning its load): each 12 ft frame carried lying from the pile, turned to
  // its slot's heading, set down with its foot at the slot and raised into it by its pair, who hold it; a third crew
  // seats a low deck beam on each column; the holders let go.
  deck: { who: ['ada', 'bo', 'cy', 'di', 'ed', 'fi'], kind: 'mars:rack_upright_12ft', entry: 'content/kinds/construction/rack_upright_12ft.json',
    view: 'post=0&hour=12:00&eye=-17.5,5.2,31&at=-25,1.2,22',
    third: { bay: 'deck-bay', frames: [['deck-frame-1', 'ada', 'bo', ['to -26,17', 'turn -90', 'to -24,20.095'], null, 'upright_a'],
      ['deck-frame-2', 'di', 'cy', ['to -26,30', 'turn 90', 'to -24,26.649'], null, 'upright_b']],
      beam: ['deck-beam-1', 'ed', 'fi', '-25.022,23.372', 'beam_low_l'], more: [['deck-beam-2', ['-27,17', '-22.978,17', '-22.978,23.372'], 'beam_low_r'],
        ['deck-beam-3', ['-25.022,23.372'], 'beam_high_l'], ['deck-beam-4', ['-27,17', '-22.978,17', '-22.978,23.372'], 'beam_high_r']],
      joists: { names: ['two-by-four-1', 'two-by-four-2', 'two-by-four-3', 'two-by-four-4', 'two-by-four-5'], slots: ['j1', 'j2', 'j3', 'j4', 'j5'],
        turnAt: ['-26.5,22.2', '-26.5,22.8', '-26.5,23.37', '-26.5,23.95', '-26.5,24.55'], turn: '90', under: ['-24,22.2', '-24,22.8', '-24,23.37', '-24,23.95', '-24,24.55'],
        crews: [['ada', 'bo', [0, 3]], ['di', 'cy', [1, 4]], ['ed', 'fi', [2]]] } } },
  // The climb (B5, attempt 23; CARRY_SCENE=climb; #5281's ways): the 12 ft bay built as in attempt 21 (frames carried,
  // turned and raised into deck_bay, four deck beams, the holders let go), then Bo reads `object <deck-frame-1>` and
  // climbs by its first `climb to` offer's name (`object <frame> climb to <name>`), stands there, and comes back down
  // by walking onto the ground (`act <ground id>`: a Soul's walk names a thing, not a point). The world writes no
  // rows while a body is on a ladder, so the page's drawn position of the climber is sampled every 100 ms.
  climb: { who: ['ada', 'bo', 'cy', 'di', 'ed', 'fi'], kind: 'mars:rack_upright_12ft', entry: 'content/kinds/construction/rack_upright_12ft.json',
    view: 'post=0&hour=12:00&eye=-17.5,5.2,31&at=-25,1.2,22',
    third: { bay: 'deck-bay', frames: [['deck-frame-1', 'ada', 'bo', ['to -26,17', 'turn -90', 'to -24,20.095'], null, 'upright_a'],
      ['deck-frame-2', 'di', 'cy', ['to -26,30', 'turn 90', 'to -24,26.649'], null, 'upright_b']],
      beam: ['deck-beam-1', 'ed', 'fi', '-25.022,23.372', 'beam_low_l'], more: [['deck-beam-2', ['-27,17', '-22.978,17', '-22.978,23.372'], 'beam_low_r'],
        ['deck-beam-3', ['-25.022,23.372'], 'beam_high_l'], ['deck-beam-4', ['-27,17', '-22.978,17', '-22.978,23.372'], 'beam_high_r']],
      climb: { who: 'bo', frame: 'deck-frame-1' } } },
  // The take-down without the deck (N5, attempt 25; CARRY_SCENE=teardown): the 12 ft bay built as in attempt 21 (frames
  // carried lying, turned and raised into deck_bay, four deck beams, the holders let go), then taken down by the same
  // Souls' ordinary commands in reverse: two holders take each frame beside its posts (`carry grip <frame> left|right`,
  // `carry offer <name> --on <frame>`); the beam crew unseats the 1.8 m beams, then the 0.5 m ones, from 0.45 m outside
  // the bay (`carry grip <beam> back|front --out 0.45`, `part unseat`), and carries each back to where it lay by the
  // build's ways reversed; each frame's holders go to the raise crew's places (`carry grip <frame> top|foot`) and lower
  // it out of its slot away from the bay (`part lower`); each frame is carried back lying by its build's steps reversed.
  teardown: { who: ['ada', 'bo', 'cy', 'di', 'ed', 'fi'], kind: 'mars:rack_upright_12ft', entry: 'content/kinds/construction/rack_upright_12ft.json',
    view: 'post=0&hour=12:00&eye=-17.5,5.2,31&at=-25,1.2,22',
    third: { bay: 'deck-bay', frames: [['deck-frame-1', 'ada', 'bo', ['to -26,17', 'turn -90', 'to -24,20.095'], null, 'upright_a'],
      ['deck-frame-2', 'di', 'cy', ['to -26,30', 'turn 90', 'to -24,26.649'], null, 'upright_b']],
      beam: ['deck-beam-1', 'ed', 'fi', '-25.022,23.372', 'beam_low_l'], more: [['deck-beam-2', ['-27,17', '-22.978,17', '-22.978,23.372'], 'beam_low_r'],
        ['deck-beam-3', ['-25.022,23.372'], 'beam_high_l'], ['deck-beam-4', ['-27,17', '-22.978,17', '-22.978,23.372'], 'beam_high_r']],
      // each beam from its mouth north clear of the frames, west, then south along its own length onto the pile (each
      // pile place west of the ones already back, rehearsal t2); each frame by its build's steps reversed to its pile
      teardown: { beams: [['deck-beam-4', ['-22.978,17', '-26.95,17', '-26.95,20.5']], ['deck-beam-3', ['-25.022,17', '-27.3,17', '-27.3,20.5']],
        ['deck-beam-2', ['-22.978,17', '-27.65,17', '-27.65,20.5']], ['deck-beam-1', ['-25.022,17', '-28,17', '-28,20.5']]],
        frames: [['to -26,17', 'turn 90', 'to -31.829,19'], ['to -26,30', 'turn -90', 'to -31.829,21.5']] } } },
  // Crews of four and six (N5; CARRY_SCENE=crews): four carry the camp's generator, one at each of its grips (front,
  // back, a side carrier at each grip between: `carry grip <load> right 1`, `left 2`), lifted, walked south then east,
  // set down; then six carry the timber bundle (sides right 1, left 2, right 3, left 4) south then west and set it
  // down. The one who offers is the crew's front (rehearsal h1: with the offerer at the back, the side grips are
  // counted from the other end and the lift is refused carry-grip-out-of-reach).
  crews: { who: ['ada', 'bo', 'cy', 'di', 'ed', 'fi'], kind: 'mars:generator', entry: 'content/kinds/construction/generator.json',
    view: 'post=0&hour=12:00&eye=13,6.5,37&at=13,.6,27',
    crews: [{ load: 'generator', front: 'ada', back: 'bo', sides: [['cy', 'right', 1], ['di', 'left', 2]], legs: [['14,29', 8000], ['17,29', 8000]] },
      { load: 'timber-bundle', front: 'ada', back: 'bo', sides: [['cy', 'right', 1], ['di', 'left', 2], ['ed', 'right', 3], ['fi', 'left', 4]], legs: [['11.6,29', 8000], ['8,29', 8000]] }] },
  // Six Souls seat one rack beam (N5; CARRY_SCENE=sixbeam; #5206): two crews carry the stand's frames standing into
  // the rack bay's upright slots and hold them, two to a frame; two seat a low beam on each column (west mouth, then
  // round to the east mouth); the holders let go and the bay stands. Then all six take a loose beam, one at each of
  // its six grips (the offerer its front, sides right 1, left 2, right 3, left 4), carry it to the west mouth and seat
  // it in beam_high_l: the side carriers walk with it on the set-in.
  sixbeam: { who: ['ada', 'bo', 'cy', 'di', 'ed', 'fi'], kind: 'mars:rack_beam', entry: 'content/kinds/construction/rack_beam.json',
    view: 'post=0&hour=12:00&eye=-.5,5.2,30&at=3,.9,20',
    sixbeam: { bay: 'rack-bay', frames: [['rack-frame-1', 'ada', 'bo', 'upright_a'], ['rack-frame-2', 'cy', 'di', 'upright_b']],
      beams: ['ed', 'fi', [['rack-beam-1', ['4.978,20'], 'beam_low_l'], ['rack-beam-2', ['4,16', '8,16', '7.022,20'], 'beam_low_r']]],
      six: { load: 'rack-beam-3', front: 'ada', back: 'bo', sides: [['cy', 'right', 1], ['di', 'left', 2], ['ed', 'right', 3], ['fi', 'left', 4]], mouth: '4.978,20', slot: 'beam_high_l' } } },
  // The deck walk (B5, attempt 24; CARRY_SCENE=deckwalk; #5284's creator-placed ways): the world's creator places the
  // finished deck bay in one `souls-god.mjs batch`, a part of each slot's kind into each of deck_bay's slots in the
  // entry's order (frames, four beams, five joists, two sheets, the stair); then Ada walks up the stair onto the first
  // sheet's deck, across to the second's and back onto the ground (`act <place id>`, `act <ground id>`), and Bo climbs
  // built frame a by its own object's first climb offer and comes back down. Both bodies' drawn positions are sampled.
  deckwalk: { who: ['ada', 'bo'], kind: 'mars:deck_bay', entry: 'content/kinds/construction/deck_bay.json',
    view: 'post=0&hour=12:00&eye=-17.5,5.2,31&at=-25,1.2,22',
    deckwalk: { bay: 'deck-bay', walker: 'ada', climber: 'bo' } },
};
const SCENE = SCENES[process.env.CARRY_SCENE ?? 'beam'];
if (!SCENE) throw Error('carry-proof.scene');
const states = new Map();
const hash = bytes => createHash('sha256').update(bytes).digest('hex');
const native = id => id.replace(/-(\d+)$/, '.$1');
const save = (state, file, value) => writeFileSync(join(state.paths.dir, file), JSON.stringify(value, (_key, v) => typeof v === 'bigint' ? v.toString() : v, 2), { flag: 'wx', mode: 0o600 });
const delay = (ms, signal) => new Promise((ok, no) => {
  const abort = () => { clearTimeout(timer); no(signal.reason); };
  const timer = setTimeout(() => { signal.removeEventListener('abort', abort); ok(); }, ms);
  signal.addEventListener('abort', abort, { once: true }); if (signal.aborted) abort();
});
/** One ordinary command line of `who`'s own client; its answer, accepted or refused. */
async function asked(state, who, ...words) {
  state.signal.throwIfAborted();
  const seat = state.seats[who];
  const result = await new Promise((ok, no) => {
    const child = execFile(process.execPath, [join(state.recipe.checkout, 'v2/client/src/cli/souls.mjs'), ...words, '--soul', seat.soul],
      { cwd: seat.folder, env: seatEnv(seat.home, state.recipe.pkg), signal: state.signal, timeout: words[0] === 'carry' && words[1] === 'grip' ? 45000 : words[0] === 'carry' && words[1] === 'to' ? 40000 : words[0] === 'act' && words.includes('--wait') ? 75000 : 15000, maxBuffer: 4 << 20 },
      (error, stdout, stderr) => { const result = { who, words, stdout, stderr, code: child.exitCode, signal: child.signalCode }; save(state, `command-carry-${++state.ordinal}.json`, result); if (error) no(error); else { try { ok(JSON.parse(stdout)); } catch (e) { no(e); } } });
    state.recipe.registerCommand(child);
  });
  return result;
}
async function cli(state, who, ...words) {
  const result = await asked(state, who, ...words);
  if (result.ok !== true) throw Error(`carry-proof.command-refused: ${who} ${words.join(' ')}`);
  return result;
}
// Same ordinary pair/approve interface as pairSeat, with every finite subprocess registered before waiting.
async function pair(state, who) {
  const folder = join(state.paths.data, 'seats', who), home = join(folder, '.souls'); mkdirSync(folder, { recursive: true });
  let text = '', asked;
  const asking = new Promise((ok, no) => {
    const child = execFile(process.execPath, [PAIR, ...pairArgs(state.recipe.world, who)],
      { cwd: folder, env: seatEnv(home, state.recipe.pkg), signal: state.signal, timeout: 20000, maxBuffer: 1 << 20 },
      (error, stdout, stderr) => { save(state, `command-carry-pair-${who}.json`, { code: child.exitCode, signal: child.signalCode, stdout, stderr }); error ? no(error) : ok(lastJson(stdout)); });
    state.recipe.registerCommand(child);
    child.stdout.on('data', chunk => { text += chunk; asked ??= text.split('\n').map(lastJson).find(row => row?.step === 'approve'); });
  });
  // Attach the rejection handler immediately while the approval word arrives.
  const settled = asking.then(answer => ({ answer }), error => ({ error }));
  const until = Date.now() + 10000;
  while (!asked) { state.signal.throwIfAborted(); if (Date.now() > until) throw Error('carry-proof.pair-code'); await delay(20, state.signal); }
  const approval = await fetch(new URL('/v1/pair/approve', state.recipe.world.directory), { method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ code: asked.code, confirm: true, test_person: who }), signal: state.signal });
  if (approval.status !== 200) throw Error('carry-proof.pair-approval');
  const result = await settled; if (result.error) throw result.error;
  if (result.answer?.ok !== true || !result.answer.soul) throw Error('carry-proof.pair-result');
  const soul = result.answer.soul, post = (path, body) => fetch(new URL(path, state.recipe.world.directory), { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ ...body, test_person: who }), signal: state.signal });
  const mine = (await (await post('/v1/account/souls', {})).json()).souls ?? [];
  const key = mine.find(s => s.soul.replace(/^soul-/, '') === soul.replace(/^s_/, ''))?.soul ?? soul;
  if ((await post('/v1/account/souls/profile', { soul: key, name: who[0].toUpperCase() + who.slice(1) })).status !== 200) throw Error('carry-proof.name');
  return seatOf({ label: who, folder, home, soul, env: seatEnv(home, state.recipe.pkg), log: join(folder, 'commands.jsonl') });
}
/** The world's creator through the ordinary interface (rack-bay.mjs `pairCreator`): paired with --creator and approved
 *  as the seeded creator, its daemon started and registered like a Soul's, and `souls-god.mjs` asked as a command. */
async function creatorOf(state) {
  const { recipe, paths, signal } = state, folder = join(paths.data, 'seats', 'creator'), home = join(folder, '.souls'), worldDir = join(paths.data, 'world');
  mkdirSync(folder, { recursive: true });
  const env = seatEnv(home, recipe.pkg); let text = '', approve;
  const asking = new Promise((ok, no) => {
    const child = execFile(process.execPath, [PAIR, ...pairArgs(recipe.world, 'creator'), '--creator', `creator-${readFileSync(join(worldDir, 'creator'), 'utf8').trim()}`],
      { cwd: folder, env, signal, timeout: 20000, maxBuffer: 1 << 20 },
      (error, stdout, stderr) => { save(state, 'command-carry-pair-creator.json', { code: child.exitCode, signal: child.signalCode, stdout, stderr }); error ? no(error) : ok(lastJson(stdout)); });
    recipe.registerCommand(child);
    child.stdout.on('data', chunk => { text += chunk; approve ??= text.split('\n').map(lastJson).find(row => row?.step === 'approve'); });
  });
  const settled = asking.then(answer => ({ answer }), error => ({ error }));
  const until = Date.now() + 10000;
  while (!approve) { signal.throwIfAborted(); if (Date.now() > until) throw Error('carry-proof.creator-pair-code'); await delay(20, signal); }
  const approval = await fetch(new URL('/v1/pair/approve', recipe.world.directory), { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ code: approve.code, confirm: true, test_person: 'Ada' }), signal });
  if (approval.status !== 200) throw Error('carry-proof.creator-approval');
  const result = await settled; if (result.error) throw result.error;
  if (result.answer?.ok !== true) throw Error('carry-proof.creator-pair-result');
  mkdirSync(join(home, 'kinds'), { recursive: true });
  copyFileSync(join(worldDir, 'world/world.kinds'), join(home, 'kinds', `${recipe.world.world}.kinds`));
  const id = result.answer.soul; if (!/^c_/.test(id ?? '')) throw Error('carry-proof.creator-id');
  const fd = openSync(join(paths.dir, 'client-creator.log'), 'wx', 0o600);
  let daemon;
  try { daemon = spawn(process.execPath, [join(recipe.checkout, 'v2/client/src/daemon/daemon.mjs'), '--home', home, '--soul', id, '--pkg', recipe.pkg, '--ready-fd', '3'], { cwd: folder, env, detached: true, stdio: ['ignore', fd, fd, 'pipe'] }); }
  finally { closeSync(fd); }
  recipe.registerClient(daemon);
  await new Promise((ok, no) => { const timer = setTimeout(() => no(Error('carry-proof.creator-ready')), 10000); daemon.stdio[3].once('data', data => { clearTimeout(timer); String(data).trim() === 'ready' ? ok() : no(Error('carry-proof.creator-ready')); }); daemon.once('error', no); daemon.once('exit', () => no(Error('carry-proof.creator-exited'))); });
  return (...words) => new Promise((ok, no) => {
    const child = execFile(process.execPath, [join(recipe.checkout, 'v2/client/src/creator/souls-god.mjs'), ...words], { cwd: folder, env, signal: state.signal, timeout: 60000, maxBuffer: 4 << 20 },
      (error, stdout, stderr) => { save(state, `command-carry-${++state.ordinal}.json`, { who: 'creator', words, stdout, stderr, code: child.exitCode, signal: child.signalCode }); const a = lastJson(stdout); a ? ok(a) : no(error ?? Error('carry-proof.creator-answer')); });
    recipe.registerCommand(child);
  });
}
export async function prepare({ paths, recipe, signal }) {
  if (recipe?.kind !== 'native-page' || !recipe.world || !recipe.registerClient) throw Error('carry-proof.recipe');
  const state = { paths, recipe, signal, seats: {}, bodies: {}, ordinal: 0, loaded: {}, pending: [], pageErrors: [] };
  states.set(paths.dir, state);
  await Promise.all(SCENE.who.map(async who => {
    signal.throwIfAborted();
    const seat = await pair(state, who);
    state.seats[who] = seat;
    const fd = openSync(join(paths.dir, `client-${who}.log`), 'wx', 0o600);
    let daemon;
    try { daemon = spawn(process.execPath, [join(recipe.checkout, 'v2/client/src/daemon/daemon.mjs'), '--home', seat.home, '--soul', seat.soul, '--pkg', recipe.pkg, '--ready-fd', '3'],
      { cwd: seat.folder, env: seatEnv(seat.home, recipe.pkg), detached: true, stdio: ['ignore', fd, fd, 'pipe'] }); }
    finally { closeSync(fd); }
    recipe.registerClient(daemon);
    await new Promise((ok, no) => { const timer = setTimeout(() => no(Error('carry-proof.client-ready')), 10000); daemon.stdio[3].once('data', data => { clearTimeout(timer); String(data).trim() === 'ready' ? ok() : no(Error('carry-proof.client-ready')); }); daemon.once('error', no); daemon.once('exit', () => no(Error('carry-proof.client-exited'))); });
    await cli(state, who, 'act', 'life:join', '--wait');
    const until = Date.now() + 10000;
    while (!state.bodies[who]) { state.bodies[who] = (await cli(state, who, 'status')).body; if (Date.now() > until) throw Error('carry-proof.body-admission'); if (!state.bodies[who]) await delay(50, signal); }
  }));
  // Each carrier comes to its end along the load's own line (first 2.2 m out, then in): the page draws a body facing
  // the way it last walked, and the world does not turn a carrier to its load (attempt 8: Ada lifted with her back to it).
  if (SCENE.build) state.frames = standFrames(state).then(() => ({ ok: true }), error => ({ error: String(error.stack ?? error) }));
  if (SCENE.deckwalk) state.god = await creatorOf(state);
  state.grips = !SCENE.load ? Promise.resolve({ ok: true }) : Promise.all([['ada', 'front'], ['bo', 'back']].map(async ([who, end]) => { await cli(state, who, 'carry', 'grip', SCENE.load, end, '--from', '2.2'); await cli(state, who, 'carry', 'grip', SCENE.load, end); })).then(() => ({ ok: true }), error => ({ error: String(error.stack ?? error) }));
  return { dir: paths.dir };
}
async function offer(state) {
  const grips = await state.grips; if (!grips.ok) throw Error(grips.error);
  state.crew = (await cli(state, 'ada', 'carry', 'offer', state.bodies.bo)).crew;
  if (!state.crew) throw Error('carry-proof.crew');
  await cli(state, 'bo', 'carry', 'accept', state.crew);
  const query = await cli(state, 'ada', 'query', JSON.stringify([{ find: SCENE.load }]));
  state.load = (query.answers ?? []).flatMap(a => a.found ?? []).find(n => n.name === SCENE.load && n.kind.split('@')[0] === SCENE.kind);
  if (!state.load) throw Error('carry-proof.load');
}
/** What the observer has counted so far, kept as each part of the journey ends, so a failing part is known by name. */
async function phase(state, page, name) {
  const seen = await page.evaluate(() => { const o = window.__carryContactObserver; return o ? { counts: { ...o.counts }, maxima: structuredClone(o.maxima), total: o.total } : null; });
  if (seen) (state.phases ??= []).push({ phase: name, ...seen });
}
/** The front's ordinary `carry to` for each leg, its walk waited out, with one still as the leg ends. */
async function walk(state, page, paths, signal) {
  for (const [i, [to, ms]] of SCENE.legs.entries()) {
    await cli(state, 'ada', 'carry', 'to', state.crew, to);
    await delay(ms, signal);
    await page.screenshot({ path: join(paths.dir, `carry-leg-${i + 1}.png`) });
    await phase(state, page, 'leg-' + (i + 1));
  }
}
const diagnostic = (state, stage, detail = {}) => {
  appendFileSync(join(state.paths.dir, 'carry-install-diagnostic.jsonl'), JSON.stringify({ stage, at: new Date().toISOString(), ...detail }) + '\n', { mode: 0o600 });
};
const limited = (work, ms, name) => { let timer; return Promise.race([Promise.resolve().then(work), new Promise((_, no) => { timer = setTimeout(() => no(Error('carry-proof.' + name)), ms); })]).finally(() => clearTimeout(timer)); };
async function failureExecution(state, page) {
  const cdp = state.cdp;
  if (!cdp) return;
  try {
    const value = await limited(() => cdp.send('Runtime.evaluate', { expression: 'JSON.stringify({url:location.href,ready:document.readyState,install:window.__carryInstallState,observer:!!window.__carryContactObserver,frame:window.__soulsEntity?.renderer?.info?.render?.frame})', returnByValue: true, timeout: 500 }), 750, 'failure-state-timeout');
    diagnostic(state, 'failure-runtime-state', { value });
  } catch (error) { diagnostic(state, 'failure-runtime-state-error', { error: String(error) }); }
  try {
    const paused = new Promise(ok => cdp.once('Debugger.paused', e => ok(e.callFrames.map(f => ({ name: f.functionName, url: f.url, location: f.location })))));
    await limited(() => cdp.send('Debugger.pause'), 500, 'failure-pause-timeout');
    diagnostic(state, 'failure-execution-stack', { frames: await limited(() => paused, 500, 'failure-stack-timeout') });
  } catch (error) { diagnostic(state, 'failure-execution-stack-error', { error: String(error) }); }
  finally { await limited(() => cdp.send('Debugger.resume'), 500, 'failure-resume-timeout').catch(error => diagnostic(state, 'failure-resume-error', { error: String(error) })); }
}
/** One served file's bytes, hashed. A body that never arrives (attempt 7: a response of the navigation the driver's own
 *  goto replaced never finished, and the wait for it used the whole journey) is a cancelled load after `ms`, which the
 *  asset check passes only if the same path was read whole from another response. */
export const readAsset = (state, path, response, ms = 8000) => limited(() => response.body(), ms, 'asset-body-timeout')
  .then(bytes => { state.loaded[path] = hash(bytes); }, error => { (state.cancelledLoads ??= []).push({ path, error: String(error) }); });
export async function installContactObserver(page, config, { record, onFailure = async () => {}, timeoutMs = 10000 } = {}) {
  record('evaluate-begin', { config, pageURL: page.url() });
  try {
    const result = await limited(() => page.evaluate(contactTools, config), timeoutMs, 'observer-install-timeout');
    record('evaluate-return', { result });
    if (result?.installed !== true) throw Error('carry-proof.observer-not-installed');
    return result;
  } catch (error) { record('evaluate-error', { error: String(error) }); await onFailure(); throw error; }
}
export async function beforeNavigation({ page, paths, signal }) {
  const state = states.get(paths.dir); if (!state) throw Error('carry-proof.preparation');
  const pageError = error => state.pageErrors.push(String(error.stack ?? error));
  const consoleStage = message => { const text = message.text(); if (text.startsWith('carry-install-stage ')) diagnostic(state, 'page-stage', { value: JSON.parse(text.slice(20)) }); };
  page.on('console', consoleStage);
  state.cdp = await page.context().newCDPSession(page);
  state.cdp.on('Debugger.scriptParsed', e => { if (e.url && (state.scriptCount = (state.scriptCount ?? 0) + 1) <= 500) diagnostic(state, 'script-parsed', { url: e.url, executionContextId: e.executionContextId, isModule: e.isModule }); });
  await state.cdp.send('Debugger.enable');
  diagnostic(state, 'diagnostic-ready');
  const response = response => {
    const full = new URL(response.url()), path = full.pathname; if (!/\.(js|wasm)$/.test(path)) return;
    diagnostic(state, 'module-response', { url: full.href, origin: full.origin, status: response.status(), resourceType: response.request().resourceType() });
    state.pending.push(readAsset(state, path, response));
  };
  page.on('pageerror', pageError); page.on('response', response);
  return async () => {
    try {
      await Promise.all(state.pending);
      if (!page.isClosed()) {
        const observer = await page.evaluate(() => { const o = window.__carryContactObserver; if (!o) return null; o.stop(); const { stop, ...data } = o; return data; });
        save(state, 'carry-observer.json', observer);
      }
      save(state, 'carry-loaded.json', state.loaded); save(state, 'carry-page-errors.json', state.pageErrors);
    } finally { page.off('pageerror', pageError); page.off('response', response); page.off('console', consoleStage); await state.cdp?.detach().catch(() => {}); states.delete(paths.dir); }
  };
}
export function wholeRunFailure(observer, pageErrors) {
  return !observer || !!pageErrors.length || !!observer.failures?.length || !!observer.failedWitnesses?.length || Object.keys(observer.counts ?? {}).some(k => !['passed-native-pair', 'native-release-observation', 'native-inactive-observation'].includes(k));
}
async function verifyAssets(state, check) {
  await Promise.all(state.pending);
  const manifest = JSON.parse(readFileSync(join(state.paths.dir, 'native-page-provenance.json')));
  check('no-missing-cancelled-assets', (state.cancelledLoads ?? []).every(f => state.loaded[f.path]), JSON.stringify(state.cancelledLoads ?? []));
  for (const [path, actual] of Object.entries(state.loaded)) {
    const replica = /\/v2\/replica\/[^/]+\/(replica\.js|replica_bg\.wasm)$/.exec(path);
    const expected = replica ? manifest.trees['v2/target/wasm-load/pkg'][replica[1]] : manifest.trees['apps/web/dist'][path.slice(path.lastIndexOf('/assets/') + 1)];
    check('served-artifact-' + path, actual === expected, 'Loaded page/replica bytes match their separate pinned artifact trees.');
  }
  return manifest;
}
export function validateSetupApproval(ready, approval, signal, now = Date.now()) {
  signal.throwIfAborted();
  if (now >= ready.deadline) throw Error('carry-proof.setup-review-timeout');
  if (approval?.approved !== true || approval.nonce !== ready.nonce || approval.screenshotSHA256 !== ready.screenshotSHA256)
    throw Error('carry-proof.setup-review-mismatch');
  return true;
}
export async function setupGate(state, page, signal) {
  const paths = state.paths, screenshot = join(paths.dir, 'setup.png');
  await page.screenshot({ path: screenshot });
  signal.throwIfAborted();
  const provenance = JSON.parse(readFileSync(join(paths.dir, 'native-page-provenance.json')));
  const ready = { schema: 'carry-setup-ready/1', nonce: randomUUID(), screenshot: 'setup.png', screenshotSHA256: hash(readFileSync(screenshot)),
    source: { product: provenance.sourceHead, artifactSHA256: provenance.artifactPin.hash,
      driverSHA256: hash(readFileSync(new URL(import.meta.url))), oracleSHA256: hash(readFileSync(new URL('../../playtest/carry-contact/oracle.mjs', import.meta.url))) },
    deadline: Date.now() + 25000 };
  const temporary = join(paths.dir, 'setup-ready-' + ready.nonce + '.tmp');
  const fd = openSync(temporary, 'wx', 0o600);
  try { writeFileSync(fd, JSON.stringify(ready, null, 2) + '\n'); fsyncSync(fd); } finally { closeSync(fd); }
  renameSync(temporary, join(paths.dir, 'setup-ready.json'));
  const directory = openSync(paths.dir, 'r'); try { fsyncSync(directory); } finally { closeSync(directory); }
  console.log('SETUP_READY ' + paths.dir);
  for (;;) {
    signal.throwIfAborted();
    if (Date.now() >= ready.deadline) throw Error('carry-proof.setup-review-timeout');
    const approval = join(paths.dir, 'setup-approval.json');
    if (existsSync(approval)) { validateSetupApproval(ready, JSON.parse(readFileSync(approval)), signal); return; }
    await delay(100, signal);
  }
}
/** A thing of the construction kinds by its name, as Ada's own copy finds it. */
async function find(state, name) {
  for (let i = 0; i < 40; i++) {
    await asked(state, 'ada', 'look');
    const found = ((await asked(state, 'ada', 'query', JSON.stringify([{ find: name }]))).answers ?? []).flatMap(a => a.found ?? []).find(n => n.name === name && /^mars:/.test(n.kind ?? ''));
    if (found) return found; await delay(500, state.signal);
  }
  throw Error('carry-proof.find ' + name);
}
const crewOf = async (state, a, b) => { const crew = (await cli(state, a, 'carry', 'offer', state.bodies[b])).crew; if (!crew) throw Error('carry-proof.crew'); await cli(state, b, 'carry', 'accept', crew); return crew; };
// A grip's walk that ends short of its end (#5254, an engine bug: `away_m` in its answer) is asked again until its Soul
// is there, at most four times; the take after it would be refused out of reach (attempt 19).
async function gripAt(state, who, thing, end) {
  let a; for (let i = 0; i < 4; i++) { a = await cli(state, who, 'carry', 'grip', thing, end); if (!(a.away_m > 0.05)) return a; (state.shortWalks ??= []).push({ who, end, away_m: a.away_m }); }
  return a;
}
const gripEnds = (state, thing, back, front) => Promise.all([[back, 'back'], [front, 'front']].map(([who, end]) => gripAt(state, who, thing, end)));
// A command the world refuses for a moment (a way out still blocked by the crew ahead, a body that moved while the
// change was prepared) is asked again, as a Soul's own agent asks again.
// A take refused out of reach while its carriers are still walking to their ends (attempt 19: a grip's answer comes as
// its walk starts, and the walk from the camp takes about 18 s) is asked for up to 36 s.
async function retried(state, who, ...words) {
  for (let i = 0; ; i++) { const a = await asked(state, who, ...words); if (a.ok === true) return a; if (i >= (a.code === 'part.grip-out-of-reach' ? 24 : 8)) throw Error(`carry-proof.command-refused: ${who} ${words.join(' ')} ${a.code ?? ''}`); await delay(1500, state.signal); }
}
/** The survey scene's frames: each from the stand into its upright slot, the stand's first frame first and the second six
 *  seconds behind it (attempt 12: the second crew, first to its frame, found its way out blocked); its east carrier stays holding it. */
async function standFrames(state) {
  const B = SCENE.build, mark = step => (state.steps ??= []).push({ step, at: new Date().toISOString() });
  state.bay = (await find(state, B.bay)).id;
  const frames = []; for (const [name] of B.frames) frames.push((await find(state, name)).id);
  state.beam = await find(state, B.beam[0]);
  let leave; const left = new Promise(ok => { leave = ok; });
  await Promise.all(B.frames.map(async ([name, slot, lead, holder], k) => {
    await gripEnds(state, frames[k], lead, holder);
    if (k) await left;
    const crew = await crewOf(state, lead, holder);
    await cli(state, lead, 'part', 'take', crew, frames[k]); mark(name + '-taken');
    if (!k) setTimeout(leave, 6000);
    await retried(state, lead, 'carry', 'to', crew, state.bay, slot); mark(name + '-at-the-bay');
    await delay(500, state.signal); await retried(state, lead, 'part', 'put', crew, state.bay, slot); mark(`${name}-in-${slot}`);
    await cli(state, lead, 'carry', 'leave', crew); mark(`${name}-held-by-${holder}`);
  }));
}
/** The survey scene on the page: the frames stood and held (begun in `prepare`), then the beam seated between them. */
async function bayBuild({ state, page, paths, signal, check, arm, root }) {
  const B = SCENE.build, [back, front] = B.carriers, [name, slot, mouth] = B.beam;
  const shot = async step => { await page.screenshot({ path: join(paths.dir, step + '.png') }); (state.steps ??= []).push({ step, at: new Date().toISOString() }); };
  check('candidate-arm', arm === 'candidate');
  const manifest = await verifyAssets(state, check);
  await setupGate(state, page, signal);
  check('setup-page-errors', state.pageErrors.length === 0, state.pageErrors.join('\n'));
  try {
    const stood = await state.frames; if (!stood.ok) throw Error(stood.error);
    await delay(1000, signal); await shot('frames-held');
    state.crew = await crewOf(state, back, front);
    const beam = state.beam;
    await gripEnds(state, beam.id, back, front);
    await watchBeam({ state, page, check, beam, manifest, root });
    await cli(state, back, 'part', 'take', state.crew, beam.id);
    await delay(1000, signal); await shot('beam-taken'); await phase(state, page, 'take');
    await retried(state, back, 'carry', 'to', state.crew, mouth);
    await shot('beam-at-the-mouth'); await phase(state, page, 'carry');
    await delay(500, signal); await retried(state, back, 'part', 'put', state.crew, state.bay, slot);
    await delay(2500, signal); await shot('beam-seated'); await phase(state, page, 'seat');
    const parts = [...B.frames.map(f => f[0]), name], found = ((await asked(state, 'ada', 'query', JSON.stringify(parts.map(find => ({ find }))))).answers ?? []).flatMap(a => a.found ?? []);
    const ends = parts.map(part => ({ name: part, in: found.find(n => n.name === part && /^mars:/.test(n.kind ?? ''))?.in ?? null }));
    check('parts-in-the-bay', ends.every(e => String(e.in).includes(B.bay)), JSON.stringify(ends));
    check('no-page-errors', state.pageErrors.length === 0, state.pageErrors.join('\n'));
    const observer = await page.evaluate(() => { const o = window.__carryContactObserver; return o ? { counts: o.counts, failures: o.failures.length, failedWitnesses: o.failedWitnesses.length } : null; });
    save(state, 'survey-measurement.json', { note: 'The contact oracle on the beam, take to seat: a measurement, not a check of this scene.', observer, watch: state.watch ?? null, ends });
  } finally { save(state, 'carry-phases.json', { survey: true, steps: state.steps ?? [], phases: state.phases ?? [] }); }
}
/** The raise survey on the page (all of it after the setup gate). Its checks: every command accepted (a refusal for a
 *  moment asked again), the frame found, no page error; the contact oracle on the frame's crew is a measurement. */
async function raiseSurvey({ state, page, paths, signal, check, arm, root }) {
  const R = SCENE.raise, [lift, foot] = [R.lifter, R.footer], wait = ms => delay(ms, signal);
  const shot = async step => { await page.screenshot({ path: join(paths.dir, step + '.png') }); (state.steps ??= []).push({ step, at: new Date().toISOString() }); };
  check('candidate-arm', arm === 'candidate');
  const manifest = await verifyAssets(state, check);
  const frame = await find(state, R.frame);
  await setupGate(state, page, signal);
  check('setup-page-errors', state.pageErrors.length === 0, state.pageErrors.join('\n'));
  try {
    state.crew = await crewOf(state, lift, foot);
    await gripEnds(state, frame.id, lift, foot);
    await watchBeam({ state, page, check, beam: frame, manifest, root, carriers: [lift, foot] });
    await retried(state, lift, 'part', 'take', state.crew, frame.id); await wait(1500); await shot('taken-off-the-stand');
    await retried(state, lift, 'carry', 'to', state.crew, R.down); await wait(9000);
    await retried(state, lift, 'carry', 'set-down', state.crew); await wait(2500); await shot('set-down-standing'); await phase(state, page, 'set-down-standing');
    const stations = () => Promise.all([cli(state, lift, 'carry', 'grip', frame.id, 'top'), cli(state, foot, 'carry', 'grip', frame.id, 'foot')]);
    await stations(); await wait(1000);
    await retried(state, lift, 'part', 'lower', state.crew, frame.id); await wait(3500); await shot('laying-down'); await wait(5500); await shot('laid-down'); await phase(state, page, 'laid-down');
    await gripEnds(state, frame.id, lift, foot);
    await retried(state, lift, 'part', 'take', state.crew, frame.id); await wait(1500); await shot('taken-lying');
    await retried(state, lift, 'carry', 'to', state.crew, R.place); await wait(9000);
    await retried(state, lift, 'carry', 'set-down', state.crew); await wait(2500); await shot('at-its-place-lying'); await phase(state, page, 'carried-lying');
    for (let k = 1; ; k++) {
      await stations(); await wait(1000);
      await retried(state, lift, 'part', 'raise', state.crew, frame.id); await wait(3000); await shot(`raise-${k}-part-way`); await wait(3200); await shot(`raise-${k}-top`);
      await wait(4000); await shot(`raise-${k}-held`); await phase(state, page, `raise-${k}`);
      // a part the crew holds standing: `part lower <crew>` lowers it (#5264)
      const lowered = await asked(state, lift, 'part', 'lower', state.crew);
      (state.raises ??= []).push({ k, lower: lowered.ok === true ? 'accepted' : lowered.code ?? 'refused' });
      if (lowered.ok === true) { await wait(3500); await shot('lowering'); await wait(5500); await shot('lowered'); await phase(state, page, 'lowered'); break; }
      if (k >= 3 || lowered.code !== 'raise.not-standing') break;
      await wait(4000);
    }
    check('no-page-errors', state.pageErrors.length === 0, state.pageErrors.join('\n'));
    const observer = await page.evaluate(() => { const o = window.__carryContactObserver; return o ? { counts: o.counts, failures: o.failures.length, failedWitnesses: o.failedWitnesses.length } : null; });
    save(state, 'survey-measurement.json', { note: 'The contact oracle on the frame\'s crew: a measurement, not a check of this scene.', observer, watch: state.watch ?? null, raises: state.raises ?? [] });
  } finally { save(state, 'carry-phases.json', { survey: true, steps: state.steps ?? [], phases: state.phases ?? [] }); }
}
/** The drawn position of `who`'s body (`residents()`: its entity's p) every 100 ms until `until` resolves; the world
 *  writes no rows while a body is on a ladder or a stair, so this is what the page shows meanwhile. */
function sampled(state, page, who, until) {
  const out = [], t0 = Date.now(), soul = state.seats[who].soul;
  let on = true;
  const going = (async () => { while (on) { try { const r = await page.evaluate(id => (window.__soulsEntity?.residents?.() ?? []).find(s => s.id === id) ?? null, soul); out.push({ ms: Date.now() - t0, p: r?.p ?? null, activity: r?.activity ?? null }); } catch {} await delay(100, state.signal).catch(() => { on = false; }); } })();
  return until.finally(async () => { on = false; await going; }).then(() => out);
}
/** The largest drawn step of a sampled body between two samples 100 ms apart, metres, and where it was. */
const biggestStep = rows => rows.reduce((m, r, i) => { const a = rows[i - 1]?.p, b = r.p; if (!a || !b) return m; const d = Math.hypot(b[0] - a[0], b[1] - a[1], b[2] - a[2]); return d > m.m ? { m: d, at_ms: r.ms, from: a, to: b } : m; }, { m: 0 });
/** One Soul climbs `frame` by its own `object <frame>`'s first `climb to` offer, stands there, then walks back onto the
 *  ground (`act <ground id>`, the bay's parent); each move is waited for (`look` until its room is the place, or the
 *  walk's receipt). Returns the answers and the climber's sampled drawn positions. */
async function climbed(state, page, who, frame, bay, tag) {
  const wait = ms => delay(ms, state.signal), shot = async step => { await page.screenshot({ path: join(state.paths.dir, step + '.png') }); (state.steps ??= []).push({ step, at: new Date().toISOString() }); };
  const seen = await cli(state, who, 'object', frame), offer = (seen.offers ?? []).find(o => /^climb to /.test(o.name));
  const record = { who, frame, places: seen.places ?? null, ways_up: seen.ways_up ?? null, offers: (seen.offers ?? []).map(o => o.name) };
  if (!offer) return { ...record, climb: 'no climb offer' };
  record.climbTo = offer.name;
  const ground = (await cli(state, 'ada', 'object', bay)).parent;
  const up = (async () => {
    const sent = await asked(state, who, 'object', frame, ...offer.name.split(' '));
    record.sent = { ok: sent.ok === true, code: sent.code ?? null };
    for (let i = 0; i < 120; i++) { const l = await asked(state, who, 'look'); if (l.room?.kind === 'eden:floor') { record.up = { room: l.room.name, after_ms: i * 500 }; return; } await wait(500); }
    record.up = { room: null };
  })();
  const shots = (async () => { for (let i = 1; i <= 4; i++) { await wait(1500); await shot(`${tag}-climbing-${i}`); } })();
  record.upSamples = await sampled(state, page, who, up); await shots;
  await wait(1500); await shot(`${tag}-on-the-standing-place`); await wait(4000); await shot(`${tag}-standing-there`);
  const down = (async () => { const a = await asked(state, who, 'act', ground, '--wait'); record.down = { phase: a.phase ?? null, code: a.code ?? null }; })();
  const downShots = (async () => { for (let i = 1; i <= 4; i++) { await wait(1500); await shot(`${tag}-coming-down-${i}`); } })();
  record.downSamples = await sampled(state, page, who, down); await downShots;
  record.after = (await asked(state, who, 'look')).room ?? null;
  await wait(1500); await shot(`${tag}-back-on-the-ground`);
  record.upStep = biggestStep(record.upSamples); record.downStep = biggestStep(record.downSamples);
  return record;
}
/** The take-down (attempt 25), each step one Soul's ordinary command, a refusal for a moment asked again: two holders
 *  to each frame; the beams out, high then low, each carried back to where it lay; each frame lowered out of its slot
 *  from the raise crew's places and carried back lying. Returns each step's answer. */
async function takeDown({ state, page, T, bay, frames, bc, wait, shot }) {
  const D = T.teardown, [, back, front] = T.beam, out = { holds: [], beams: [], lowered: [], frames: [] };
  const hc = [];
  for (const [k, [, lift, foot]] of T.frames.entries()) {
    const f = frames[k];
    await Promise.all([gripAt(state, lift, f.id, 'left'), gripAt(state, foot, f.id, 'right')]);
    const crew = (await retried(state, lift, 'carry', 'offer', state.bodies[foot], '--on', f.id)).crew;
    await cli(state, foot, 'carry', 'accept', crew); hc.push(crew); out.holds.push(crew);
  }
  await wait(3000); await shot('holders-hold-the-frames'); await phase(state, page, 'held-for-the-take-down');
  for (const [name, ways] of D.beams) {
    const beam = await find(state, name);
    await Promise.all([[back, 'back'], [front, 'front']].map(([w, end]) => retried(state, w, 'carry', 'grip', beam.id, end, '--out', '0.45')));
    await retried(state, back, 'part', 'unseat', bc, beam.id); await wait(1500); await shot(`${name}-unseated`);
    for (const w of ways) { await retried(state, back, 'carry', 'to', bc, w); await wait(D.legMs ?? 6000); }
    await retried(state, back, 'carry', 'set-down', bc); await wait(2500); await shot(`${name}-where-it-lay`);
    out.beams.push(name);
  }
  for (const [k, [name, lift, foot]] of T.frames.entries()) {
    const f = frames[k];
    await Promise.all([gripAt(state, lift, f.id, 'top'), gripAt(state, foot, f.id, 'foot')]); await wait(800);
    await retried(state, lift, 'part', 'lower', hc[k], f.id); await wait(4000); await shot(`${name}-lowering`); await wait(8000); await shot(`${name}-laid-down`);
    out.lowered.push(name);
  }
  for (const [k, [name, lift, foot]] of T.frames.entries()) {
    const f = frames[k];
    await gripEnds(state, f.id, lift, foot);
    await retried(state, lift, 'part', 'take', hc[k], f.id); await wait(1500);
    for (const step of D.frames[k]) { const [verb, ...rest] = step.split(' '); await retried(state, lift, 'carry', verb, hc[k], ...rest); await wait(7000); }
    await retried(state, lift, 'carry', 'set-down', hc[k]); await wait(3000); await shot(`${name}-where-it-lay`);
    for (const w of [lift, foot]) await asked(state, w, 'carry', 'leave', hc[k]);
    out.frames.push(name);
  }
  for (const w of [back, front]) await asked(state, w, 'carry', 'leave', bc);
  await wait(2000); await shot('taken-down');
  return out;
}
/** The first third on the page (all of it after the setup gate). Its checks: every command but the beam's put accepted (a
 *  refusal for a moment asked again), no page error; the put's answer and the oracle on the first frame's crew are measured. */
async function firstThird({ state, page, paths, signal, check, arm, root }) {
  const T = SCENE.third, wait = ms => delay(ms, signal);
  // a put refused for a moment (edit.body-stale, then part.not-held, attempt 13's rehearsal) is asked again; any other answer is kept
  const putAsked = async (...words) => { let a; for (let i = 0; i < 5; i++) { a = await asked(state, ...words); if (a.ok === true || !/^(edit\.body-stale|part\.not-held)$/.test(a.code ?? '')) return a; await wait(1500); } return a; };
  const shot = async step => { await page.screenshot({ path: join(paths.dir, step + '.png') }); (state.steps ??= []).push({ step, at: new Date().toISOString() }); };
  check('candidate-arm', arm === 'candidate');
  const manifest = await verifyAssets(state, check);
  const bay = (await find(state, T.bay)).id, frames = []; for (const [name] of T.frames) frames.push(await find(state, name));
  const beam = await find(state, T.beam[0]);
  await setupGate(state, page, signal);
  check('setup-page-errors', state.pageErrors.length === 0, state.pageErrors.join('\n'));
  try {
    // the joists laid across the bay under their slots before the frames go up: a joist cannot yet be brought into a
    // closed bay (a design question on the frontier lane's list); each crew lays its own, turned square to its slot
    const js = [];
    if (T.joists?.under) {
      for (const name of T.joists.names) js.push(await find(state, name));
      await Promise.all(T.joists.crews.map(async ([a, b, idx], n) => {
        await wait(n * 3000);
        const jc = await crewOf(state, a, b);
        for (const i of idx) {
          await gripEnds(state, js[i].id, a, b);
          await retried(state, a, 'part', 'take', jc, js[i].id);
          await retried(state, a, 'carry', 'to', jc, T.joists.turnAt[i]); await wait(6000);
          await retried(state, a, 'carry', 'turn', jc, T.joists.turn); await wait(5000);
          await retried(state, a, 'carry', 'to', jc, T.joists.under[i]); await wait(5000);
          await retried(state, a, 'carry', 'set-down', jc); await wait(2500);
        }
        for (const who of [a, b]) await cli(state, who, 'carry', 'leave', jc);
      }));
      await shot('joists-laid-under-their-slots');
    }
    let leave; const left = new Promise(ok => { leave = ok; }); const crews = [];
    await Promise.all(T.frames.map(async ([name, lift, foot, place, away, slot], k) => {
      const frame = frames[k];
      await gripEnds(state, frame.id, lift, foot);
      // attempt 16: the second pair, at its ends before the first left, was out of reach of its grips at the take; it
      // comes to its ends again once the first frame has gone
      if (k) { await left; await gripEnds(state, frame.id, lift, foot); }
      const crew = crews[k] = await crewOf(state, lift, foot);
      if (!k) { state.crew = crew; await watchBeam({ state, page, check, beam: frame, manifest, root, carriers: [lift, foot] }); }
      await retried(state, lift, 'part', 'take', crew, frame.id); if (!k) setTimeout(leave, 6000);
      const stations = () => Promise.all([gripAt(state, lift, frame.id, 'top'), gripAt(state, foot, frame.id, 'foot')]);
      if (Array.isArray(place)) {
        // carried lying from the pile, turned to its slot's heading and set down with its foot at the slot (#5268)
        for (const step of place) { const [verb, ...rest] = step.split(' '); await retried(state, lift, 'carry', verb, crew, ...rest); await wait(7000); }
        await retried(state, lift, 'carry', 'set-down', crew); await wait(3000); await shot(`${name}-at-its-slot-lying`);
      } else {
        await retried(state, lift, 'carry', 'to', crew, place); await wait(12000);
        await retried(state, lift, 'carry', 'set-down', crew); await wait(2500); if (k) await shot('frames-set-down-at-their-places');
        await stations(); await wait(800);
        await retried(state, lift, 'part', 'lower', crew, frame.id, ...(slot ? ['toward', away] : [])); await wait(9000); if (k) await shot('frames-laid-down');
      }
      // raised into its slot (#5268); a raise the world turns back lies again and is asked again, at most three times
      for (let n = 1; n <= 3; n++) {
        await stations(); await wait(800);
        await retried(state, lift, 'part', 'raise', crew, frame.id, ...(slot ? [bay, slot] : [])); await wait(3000); await shot(`${name}-raise-${n}-part-way`); await wait(6500);
        if (!slot) break;
        // attempt 25: on a busy page run a raise can still be on its way after 9.5 s (part.held), and the world can turn
        // its end back (edit.body-stale: the frame lies again where it lay); so wait for it to end, in its slot or on the
        // ground (`object`'s `in`), up to 40 s, and raise it again only when it lies on the ground
        let ended = null;
        for (let i = 0; i < 80 && !ended; i++) { const o = await asked(state, lift, 'object', frame.id); const at = String(o.in ?? ''); if (at.startsWith(T.bay)) ended = 'in-slot'; else if (/^ground/.test(at)) ended = 'turned-back'; else await wait(500); }
        (state.raises ??= []).push({ name, n, ended: ended ?? 'still-held-after-40-s' });
        if (ended !== 'turned-back') break;
        await wait(1500);
      }
    }));
    await shot('frames-raised-and-held'); await phase(state, page, 'frames-held');
    const [, back, front, mouth, slot] = T.beam, bc = await crewOf(state, back, front);
    // attempt 19: the beam's carriers walk from the camp to its ends for longer than a refused take is asked again
    await gripEnds(state, beam.id, back, front); await wait(12000);
    await retried(state, back, 'part', 'take', bc, beam.id); await wait(1000); await shot('beam-taken');
    await retried(state, back, 'carry', 'to', bc, mouth); await wait(1500); await shot('beam-at-the-mouth');
    const put = await putAsked(back, 'part', 'put', bc, bay, slot); await wait(2500); await shot('beam-put-answered');
    let put2 = null, leaves = []; const puts = [];
    // the further beams, each from the pile by its ways (east of the bay round its north side) into its slot
    for (const [i, [name2, ways, slot2]] of (put.ok === true ? T.more ?? [] : []).entries()) {
      const beam2 = await find(state, name2);
      await gripEnds(state, beam2.id, back, front);
      await retried(state, back, 'part', 'take', bc, beam2.id); await wait(1000); await shot(`beam-${i + 2}-taken`);
      for (const w of ways) await retried(state, back, 'carry', 'to', bc, w);
      put2 = await putAsked(back, 'part', 'put', bc, bay, slot2); await wait(2500); await shot(`beam-${i + 2}-put-answered`);
      puts.push({ slot: slot2, ok: put2.ok === true, code: put2.code ?? null, detail: put2.detail ?? null });
      if (put2.ok !== true) break;
    }
    {
      if (put2?.ok === true) {
        for (const [k, [, lift, foot]] of T.frames.entries()) for (const who of [lift, foot]) leaves.push({ who, ...(await asked(state, who, 'carry', 'leave', crews[k])) });
        await wait(3000); await shot('holders-let-go'); await wait(3000); await shot('bay-stands');
        if (T.teardown && leaves.every(l => l.ok === true)) state.takeDown = await takeDown({ state, page, T, bay, frames, bc, wait, shot });
        if (T.climb && leaves.every(l => l.ok === true)) state.climbs = [await climbed(state, page, T.climb.who, frames.find(f => f.name === T.climb.frame).id, bay, 'climb')];
        // the joists across the high beams, by three crews at once, each a few seconds behind the one before
        if (T.joists && leaves.every(l => l.ok === true)) {
          if (!js.length) for (const name of T.joists.names) js.push(await find(state, name));
          await Promise.all(T.joists.crews.map(async ([a, b, idx], n) => {
            await wait(n * 3000);
            const jc = a === back ? bc : await crewOf(state, a, b); // the beam crew carries on as it is
            for (const i of idx) {
              await gripEnds(state, js[i].id, a, b);
              await retried(state, a, 'part', 'take', jc, js[i].id); await wait(1500);
              // laid under its slot: put from where it is taken; else carried to the slot by the client's approach
              if (!T.joists.under) { await retried(state, a, 'carry', 'to', jc, bay, T.joists.slots[i]); await wait(3000); }
              const r = await putAsked(a, 'part', 'put', jc, bay, T.joists.slots[i]);
              (state.joistPuts ??= []).push({ slot: T.joists.slots[i], ok: r.ok === true, code: r.code ?? null, detail: r.detail ?? null });
              if (r.ok !== true) break; // refused: this crew keeps it and stops; the survey records the answer
            }
          }));
          await wait(2500); await shot('joists-seated');
        }
      }
    }
    check('no-page-errors', state.pageErrors.length === 0, state.pageErrors.join('\n'));
    const observer = await page.evaluate(() => { const o = window.__carryContactObserver; return o ? { counts: o.counts, failures: o.failures.length, failedWitnesses: o.failedWitnesses.length } : null; });
    save(state, 'survey-measurement.json', { note: 'The contact oracle on the first frame\'s crew, and the beam put\'s answer: measurements, not checks of this scene.', observer, watch: state.watch ?? null, beamPut: { ok: put.ok === true, code: put.code ?? null, detail: put.detail ?? null },
      shortWalks: state.shortWalks ?? [], puts, joistPuts: state.joistPuts ?? [], beam2Put: put2 && { ok: put2.ok === true, code: put2.code ?? null, detail: put2.detail ?? null }, leaves: leaves.map(l => ({ who: l.who, ok: l.ok === true, code: l.code ?? null, detail: l.detail ?? null })), raises: state.raises ?? [], climbs: state.climbs ?? [], takeDown: state.takeDown ?? null });
  } finally { save(state, 'carry-phases.json', { survey: true, steps: state.steps ?? [], phases: state.phases ?? [] }); }
}
/** `who` walks to `target` (`act <id> --wait`), four shots on the way, its drawn position sampled; where it ends. */
async function walked(state, page, who, target, tag) {
  const wait = ms => delay(ms, state.signal), shot = async step => { await page.screenshot({ path: join(state.paths.dir, step + '.png') }); (state.steps ??= []).push({ step, at: new Date().toISOString() }); };
  const record = { who, target };
  const going = (async () => { const a = await asked(state, who, 'act', target, '--wait'); record.phase = a.phase ?? null; record.code = a.code ?? null; })();
  const shots = (async () => { for (let i = 1; i <= 4; i++) { await wait(1500); await shot(`${tag}-${i}`); } })();
  record.samples = await sampled(state, page, who, going); await shots;
  record.room = (await asked(state, who, 'look')).room ?? null; record.step = biggestStep(record.samples);
  await wait(1500); await shot(`${tag}-there`);
  return record;
}
/** The deck walk on the page (all of it after the setup gate). Its checks: the creator's batch accepted, no page error;
 *  each move's answer and the bodies' drawn positions are measured. */
async function deckWalk({ state, page, paths, signal, check, arm }) {
  const D = SCENE.deckwalk, wait = ms => delay(ms, signal);
  const shot = async step => { await page.screenshot({ path: join(paths.dir, step + '.png') }); (state.steps ??= []).push({ step, at: new Date().toISOString() }); };
  check('candidate-arm', arm === 'candidate');
  await verifyAssets(state, check);
  const bay = (await find(state, D.bay)).id, entry = JSON.parse(readFileSync(join(state.recipe.checkout, SCENE.entry)));
  await setupGate(state, page, signal);
  check('setup-page-errors', state.pageErrors.length === 0, state.pageErrors.join('\n'));
  const out = { batch: null, moves: [] };
  try {
    const slots = Object.entries(entry.slots);
    const ops = slots.map(([name, slot], k) => ({ op: 'place', name: k + 1, kind: slot.kinds[0], in: bay, slot: k + 1, title: `built ${name.replace(/_/g, ' ')}` }));
    const placed = await state.god('batch', JSON.stringify(ops));
    out.batch = { ok: placed.ok === true, code: placed.code ?? null, detail: placed.detail ?? null, slots: slots.map(([name]) => name) };
    check('creator-batch-accepted', placed.ok === true, JSON.stringify(out.batch));
    await wait(3000); await shot('creator-placed-the-deck-bay');
    const part = name => placed.names[String(slots.findIndex(([n]) => n === name) + 1)];
    const ground = (await cli(state, D.walker, 'object', bay)).parent;
    // the batch reaches a Soul's own copy a moment after it is accepted (rehearsal w3: inspect.unknown-id at once)
    const places = async id => { let o; for (let i = 0; i < 20; i++) { o = await asked(state, D.walker, 'object', id); if (o.ok === true) break; await wait(1000); } if (o.ok !== true) throw Error('carry-proof.object ' + id + ' ' + (o.code ?? '')); return { name: o.name, places: o.places ?? [], ways_up: o.ways_up ?? null }; };
    out.stair = await places(part('stair')); out.sheets = [await places(part('s1')), await places(part('s2'))];
    out.moves.push(await walked(state, page, D.walker, out.sheets[0].places[0].id, 'up-the-stair-onto-sheet-1'));
    out.moves.push(await walked(state, page, D.walker, out.sheets[1].places[0].id, 'across-to-sheet-2'));
    out.moves.push(await walked(state, page, D.walker, ground, 'back-down-onto-the-ground'));
    out.climb = await climbed(state, page, D.climber, part('upright_a'), bay, 'climb');
    check('no-page-errors', state.pageErrors.length === 0, state.pageErrors.join('\n'));
  } finally {
    save(state, 'survey-measurement.json', { note: 'The deck walk on a creator-placed bay: each move\'s answer and the bodies\' drawn positions, measurements.', ...out });
    save(state, 'carry-phases.json', { survey: true, steps: state.steps ?? [], phases: [] });
  }
}
/** Crews of four and six (N5): each crew's carry, every command accepted (a refusal for a moment asked again), no page
 *  error. */
async function crewsSurvey({ state, page, paths, signal, check, arm }) {
  const wait = ms => delay(ms, signal), shot = async step => { await page.screenshot({ path: join(paths.dir, step + '.png') }); (state.steps ??= []).push({ step, at: new Date().toISOString() }); };
  check('candidate-arm', arm === 'candidate'); await verifyAssets(state, check);
  for (const C of SCENE.crews) await find(state, C.load);
  await setupGate(state, page, signal);
  check('setup-page-errors', state.pageErrors.length === 0, state.pageErrors.join('\n'));
  const out = [];
  try {
    for (const C of SCENE.crews) out.push(await crewCarry(state, page, C, `crew-of-${2 + C.sides.length}`, { wait, shot }));
    check('no-page-errors', state.pageErrors.length === 0, state.pageErrors.join('\n'));
  } finally { save(state, 'survey-measurement.json', { note: 'Crews of four and six: each carry\'s crew and load.', crews: out, shortWalks: state.shortWalks ?? [] }); save(state, 'carry-phases.json', { survey: true, steps: state.steps ?? [], phases: [] }); }
}
/** Six Souls seat one rack beam (N5): the bay's frames held, its low beams seated, the holders let go, then a crew of
 *  six seats a beam. Every command accepted (a refusal for a moment asked again), no page error; the seat measured. */
async function sixBeamSurvey({ state, page, paths, signal, check, arm, root }) {
  const S = SCENE.sixbeam, wait = ms => delay(ms, signal), shot = async step => { await page.screenshot({ path: join(paths.dir, step + '.png') }); (state.steps ??= []).push({ step, at: new Date().toISOString() }); };
  check('candidate-arm', arm === 'candidate'); const manifest = await verifyAssets(state, check);
  const bay = (await find(state, S.bay)).id, frames = []; for (const [name] of S.frames) frames.push(await find(state, name));
  await setupGate(state, page, signal);
  check('setup-page-errors', state.pageErrors.length === 0, state.pageErrors.join('\n'));
  const out = {};
  try {
    const holds = [];
    for (const [k, [name, a, b, slot]] of S.frames.entries()) {
      await gripEnds(state, frames[k].id, a, b);
      const c = await crewOf(state, a, b); holds.push([c, a, b]);
      await retried(state, a, 'part', 'take', c, frames[k].id); await wait(1500);
      await retried(state, a, 'carry', 'to', c, bay, slot); await wait(9000);
      await retried(state, a, 'part', 'put', c, bay, slot); await wait(2000); await shot(`${name}-in-${slot}`);
    }
    const [x, y, beams] = S.beams, bc = await crewOf(state, x, y);
    for (const [name, ways, slot] of beams) {
      const beam = await find(state, name);
      await Promise.all([gripAt(state, x, beam.id, 'front'), gripAt(state, y, beam.id, 'back')]);
      await retried(state, x, 'part', 'take', bc, beam.id); await wait(1500);
      for (const w of ways) { await retried(state, x, 'carry', 'to', bc, w); await wait(6000); }
      await retried(state, x, 'part', 'put', bc, bay, slot); await wait(2500); await shot(`${name}-in-${slot}`);
    }
    for (const [c, a, b] of holds) for (const w of [a, b]) await cli(state, w, 'carry', 'leave', c);
    for (const w of [x, y]) await cli(state, w, 'carry', 'leave', bc);
    await wait(2000); await shot('bay-stands');
    const X = S.six, load = await find(state, X.load);
    await Promise.all([gripAt(state, X.front, load.id, 'front'), gripAt(state, X.back, load.id, 'back'),
      ...X.sides.map(([w, side, n]) => retried(state, w, 'carry', 'grip', load.id, side, String(n)))]);
    const others = [X.back, ...X.sides.map(s => s[0])];
    const crew = state.crew = (await cli(state, X.front, 'carry', 'offer', ...others.map(w => state.bodies[w]))).crew;
    for (const w of others) await cli(state, w, 'carry', 'accept', crew);
    await retried(state, X.front, 'part', 'take', crew, load.id); await wait(2000); await shot('six-take-the-beam');
    await retried(state, X.front, 'carry', 'to', crew, X.mouth); await wait(12000); await shot('six-at-the-mouth');
    const put = await asked(state, X.front, 'part', 'put', crew, bay, X.slot); await wait(4000); await shot('six-seat-the-beam');
    out.put = { ok: put.ok === true, code: put.code ?? null, detail: put.detail ?? null };
    for (const w of [X.front, ...others]) await asked(state, w, 'carry', 'leave', crew);
    await wait(2000); await shot('seated');
    check('no-page-errors', state.pageErrors.length === 0, state.pageErrors.join('\n'));
  } finally {
    save(state, 'survey-measurement.json', { note: 'Six Souls seat one rack beam: the put\'s answer, measured.', ...out, shortWalks: state.shortWalks ?? [] });
    save(state, 'carry-phases.json', { survey: true, steps: state.steps ?? [], phases: [] });
  }
}
/** A load carried by two as a survey: taken, walked its legs, set down. Its checks: every command accepted, no page error;
 *  the contact oracle on its crew is a measurement. */
async function carrySurvey({ state, page, paths, signal, check, arm, root }) {
  const C = SCENE.carry, wait = ms => delay(ms, signal);
  const shot = async step => { await page.screenshot({ path: join(paths.dir, step + '.png') }); (state.steps ??= []).push({ step, at: new Date().toISOString() }); };
  check('candidate-arm', arm === 'candidate');
  const manifest = await verifyAssets(state, check);
  const load = await find(state, C.load);
  await setupGate(state, page, signal);
  check('setup-page-errors', state.pageErrors.length === 0, state.pageErrors.join('\n'));
  try {
    state.crew = await crewOf(state, C.back, C.front);
    await gripEnds(state, load.id, C.back, C.front);
    await watchBeam({ state, page, check, beam: load, manifest, root, carriers: [C.back, C.front] });
    await retried(state, C.back, 'part', 'take', state.crew, load.id); await wait(2000); await shot('taken'); await phase(state, page, 'take');
    for (const [i, [to, ms]] of C.legs.entries()) { await retried(state, C.back, 'carry', 'to', state.crew, to); await wait(ms); await shot(`leg-${i + 1}`); await phase(state, page, `leg-${i + 1}`); }
    await retried(state, C.back, 'carry', 'set-down', state.crew); await wait(3000); await shot('set-down'); await phase(state, page, 'set-down');
    check('no-page-errors', state.pageErrors.length === 0, state.pageErrors.join('\n'));
    const observer = await page.evaluate(() => { const o = window.__carryContactObserver; return o ? { counts: o.counts, failures: o.failures.length, failedWitnesses: o.failedWitnesses.length } : null; });
    save(state, 'survey-measurement.json', { note: 'The contact oracle on the crew: a measurement, not a check of this scene.', observer, watch: state.watch ?? null });
  } finally { save(state, 'carry-phases.json', { survey: true, steps: state.steps ?? [], phases: state.phases ?? [] }); }
}
/** A crew of any size (N5): each to its place (the front and the back at the load's ends, each side carrier beside its
 *  grip), the front offers the rest, who accept in order; lifted (a loose load) or taken (a part), its legs, set down. */
async function crewCarry(state, page, C, tag, { wait, shot }) {
  const load = await find(state, C.load), out = { load: C.load, size: 2 + (C.sides?.length ?? 0) };
  await Promise.all([gripAt(state, C.front, load.id, 'front'), gripAt(state, C.back, load.id, 'back'),
    ...(C.sides ?? []).map(([w, side, n]) => retried(state, w, 'carry', 'grip', load.id, side, String(n)))]);
  const others = [C.back, ...(C.sides ?? []).map(s => s[0])];
  const crew = (await cli(state, C.front, 'carry', 'offer', ...others.map(w => state.bodies[w]))).crew;
  for (const w of others) await cli(state, w, 'carry', 'accept', crew);
  await retried(state, C.front, ...(C.take ? ['part', 'take', crew, load.id] : ['carry', 'lift', crew, load.id])); await wait(2500); await shot(`${tag}-lifted`);
  for (const [i, [to, ms]] of C.legs.entries()) { await retried(state, C.front, 'carry', 'to', crew, to); await wait(ms); await shot(`${tag}-leg-${i + 1}`); }
  await retried(state, C.front, 'carry', 'set-down', crew); await wait(3000); await shot(`${tag}-set-down`);
  for (const w of [C.front, ...others]) await asked(state, w, 'carry', 'leave', crew);
  return { ...out, crew };
}
/** The contact observer on the beam's crew, as the beam scene installs it. A survey measures: failing to install is recorded, not thrown. */
async function watchBeam({ state, page, check, beam, manifest, root, carriers = SCENE.build?.carriers }) {
  try {
    state.load = beam;
    await page.waitForFunction(({ load, crew }) => window.__soulsCarry?.evidence?.[load] && window.__soulsCarry.contactStates.some(s => s.crew === crew && s.members?.length === 2), { load: native(beam.id), crew: native(state.crew) }, { timeout: 6000 });
    const scene = await page.evaluate(() => ({ frame: window.__soulsEntity.gameFrame(), carry: window.__soulsCarry, viewport: { width: innerWidth, height: innerHeight, touch: navigator.maxTouchPoints } }));
    const node = scene.carry.evidence[native(beam.id)].frames[0].record, bytes = readFileSync(join(root, SCENE.entry)), entry = JSON.parse(bytes);
    const binding = { crew: native(state.crew), load: { native: native(beam.id), entity: layerDraws(node) && node.origin ? node.origin : entityId(node.id), kind: beam.kind, entrySha256: hash(bytes) },
      bodies: carriers.map(who => { const seat = state.seats[who], shown = scene.frame.souls.filter(s => s.id === seat.soul); if (shown.length !== 1) throw Error('carry-proof.body-mapping'); return { native: native(state.bodies[who]), soul: seat.soul, entity: shown[0].entityId }; }) };
    check('desktop-input', scene.viewport.touch === 0 && scene.viewport.width === 1440 && scene.viewport.height === 1000);
    const kitURL = Object.keys(state.loaded).find(path => /\/people-kit-[^/]+\.js$/.test(path)); check('production-kit-loaded', !!kitURL);
    await installContactObserver(page, { kitURL, binding, entry, source: manifest.sourceHead }, { record: (stage, detail) => diagnostic(state, stage, detail) });
    save(state, 'carry-binding.json', binding);
    await page.evaluate(() => { window.__carryContactObserver.active = true; });
    state.watch = { installed: true };
  } catch (error) { state.watch = { installed: false, error: String(error.message ?? error) }; diagnostic(state, 'survey-watch-unavailable', state.watch); }
}
export default async function ({ page, paths, signal, fixture, check, expectHttp, arm }) {
  const state = states.get(fixture.dir), root = state.recipe.checkout;
  // This is a published optional client document route, not a waived asset/stream/measurement failure.
  expectHttp('/safety.md', 404, 'Optional standalone client documentation is not routed by the old-page front door.');
  const snapshot = async label => writeFileSync(join(paths.dir, `accessibility-before-${label}.yml`), await page.locator('body').ariaSnapshot(), { flag: 'wx' });
  const url = new URL(page.url()); url.search = SCENE.view;
  await page.goto(url.href, { waitUntil: 'domcontentloaded' });
  await page.waitForFunction(n => window.__soulsEntity?.gameFrame().souls.length >= n && !document.querySelector('.viewer-arrival') && document.querySelector('.viewer-history[data-viewer-ready="true"]'), SCENE.who.length, { timeout: 30000 });
  await nativeCameraMode(page, 'manual', snapshot);
  if (SCENE.build) return bayBuild({ state, page, paths, signal, check, arm, root });
  if (SCENE.raise) return raiseSurvey({ state, page, paths, signal, check, arm, root });
  if (SCENE.third) return firstThird({ state, page, paths, signal, check, arm, root });
  if (SCENE.carry) return carrySurvey({ state, page, paths, signal, check, arm, root });
  if (SCENE.deckwalk) return deckWalk({ state, page, paths, signal, check, arm });
  if (SCENE.sixbeam) return sixBeamSurvey({ state, page, paths, signal, check, arm, root });
  if (SCENE.crews) return crewsSurvey({ state, page, paths, signal, check, arm });
  await offer(state);
  if (arm === 'baseline') {
    const manifest = await verifyAssets(state, check);
    save(state, 'baseline-contact-limits.json', { source: manifest.sourceHead, contactStatus: 'UNPROVED', reason: 'Pre-carry source has no native contact observer feed; this arm records the same ordinary actions, not an active-contact pass.' });
    await setupGate(state, page, signal);
    check('baseline-no-page-errors', state.pageErrors.length === 0, state.pageErrors.join('\n'));
    await cli(state, 'ada', 'carry', 'lift', state.crew, SCENE.load);
    await delay(SCENE.liftMs, signal);
    await page.screenshot({ path: join(paths.dir, 'first-lift.png') });
    await walk(state, page, paths, signal);
    await cli(state, 'ada', 'carry', 'set-down', state.crew);
    await delay(3000, signal);
    await Promise.all(['ada', 'bo'].map(who => cli(state, who, 'carry', 'leave', state.crew)));
    check('baseline-ordinary-lifecycle-only', state.pageErrors.length === 0, 'Native CLI accepted the matched baseline actions; no native-pair or load-clock certification is claimed.');
    return;
  }
  check('candidate-arm', arm === 'candidate');
  await page.waitForFunction(({ load, crew }) => window.__soulsCarry?.evidence?.[load] && window.__soulsCarry.contactStates.some(s => s.crew === crew && s.field === 'absent' && s.members?.length === 2), { load: native(state.load.id), crew: native(state.crew) }, { timeout: 15000 });
  const scene = await page.evaluate(() => ({ frame: window.__soulsEntity.gameFrame(), carry: window.__soulsCarry, viewport: { width: innerWidth, height: innerHeight, touch: navigator.maxTouchPoints } }));
  const node = scene.carry.evidence[native(state.load.id)].frames[0].record;
  const entryFile = join(root, SCENE.entry), bytes = readFileSync(entryFile), entry = JSON.parse(bytes);
  const binding = { crew: native(state.crew), load: { native: native(state.load.id), entity: layerDraws(node) && node.origin ? node.origin : entityId(node.id), kind: state.load.kind, entrySha256: hash(bytes) },
    bodies: Object.entries(state.seats).map(([who, seat]) => { const shown = scene.frame.souls.filter(s => s.id === seat.soul); if (shown.length !== 1) throw Error('carry-proof.body-mapping'); return { native: native(state.bodies[who]), soul: seat.soul, entity: shown[0].entityId }; }) };
  const manifest = await verifyAssets(state, check);
  check('desktop-input', scene.viewport.touch === 0 && scene.viewport.width === 1440 && scene.viewport.height === 1000);
  const kitURL = Object.keys(state.loaded).find(path => /\/people-kit-[^/]+\.js$/.test(path)); check('production-kit-loaded', !!kitURL);
  await installContactObserver(page, { kitURL, binding, entry, source: manifest.sourceHead }, { record: (stage, detail) => diagnostic(state, stage, detail), onFailure: () => failureExecution(state, page) });
  save(state, 'carry-binding.json', binding); save(state, 'carry-scene.json', scene);
  await setupGate(state, page, signal);
  check('setup-page-errors', state.pageErrors.length === 0, state.pageErrors.join('\n'));
  await page.evaluate(() => { window.__carryContactObserver.active = true; });
  const abort = new AbortController(), journeySignal = AbortSignal.any([signal, abort.signal]);
  state.signal = journeySignal;
  let checking = false;
  const monitor = setInterval(async () => {
    if (checking || abort.signal.aborted) return; checking = true;
    try { const o = await page.evaluate(() => { const o = window.__carryContactObserver; return o && { counts: o.counts, failures: o.failures, failedWitnesses: o.failedWitnesses }; }); // A failing frame fails the run at its end; the journey goes on, so one attempt shows every part that fails.
      if (wholeRunFailure(o, state.pageErrors) && !state.firstFailure) { state.firstFailure = { at: new Date().toISOString(), counts: o?.counts ?? null, pageErrors: state.pageErrors.length }; await page.screenshot({ path: join(paths.dir, 'first-failure.png') }); } }
    catch (error) { abort.abort(error); } finally { checking = false; }
  }, 50);
  const wait = async (predicate, ms) => { const until = Date.now() + ms; while (!await page.evaluate(predicate)) { journeySignal.throwIfAborted(); if (Date.now() > until) throw Error('carry-proof.draw-timeout'); await delay(50, journeySignal); } journeySignal.throwIfAborted(); };
  try {
    await cli(state, 'ada', 'carry', 'lift', state.crew, SCENE.load);
    await wait(() => { const c = window.__carryContactObserver.counts; return c['passed-native-pair'] > 0 || c['failed-native-pair'] > 0; }, 10000);
    await delay(SCENE.liftMs, journeySignal);
    await page.screenshot({ path: join(paths.dir, 'first-lift.png') }); console.log('FIRST_CONTACT ' + paths.dir);
    await phase(state, page, 'lift');
    // Two short legs keep both carriers whole in the reviewed view; loading, seating and larger crews remain separate.
    await walk(state, page, paths, journeySignal);
    await cli(state, 'ada', 'carry', 'set-down', state.crew);
    await wait(() => window.__carryContactObserver.samples.some(s => s.result.releaseComplete), 10000);
    await page.screenshot({ path: join(paths.dir, 'set-down.png') });
    await phase(state, page, 'set-down');
    await Promise.all(['ada', 'bo'].map(who => cli(state, who, 'carry', 'leave', state.crew)));
    const observer = await page.evaluate(() => { const o = window.__carryContactObserver; return { counts: o.counts, failures: o.failures, failedWitnesses: o.failedWitnesses }; });
    check('complete-contact-lifecycle', !wholeRunFailure(observer, state.pageErrors), JSON.stringify(observer));
    check('native-active-contacts-observed', observer.counts['passed-native-pair'] > 0);
  } finally { clearInterval(monitor); state.signal = signal; save(state, 'carry-phases.json', { firstFailure: state.firstFailure ?? null, phases: state.phases ?? [] }); }
}
