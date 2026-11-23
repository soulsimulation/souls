#!/usr/bin/env node
// scene.mjs — stage a scene on a throwaway world of the new engine and record it on the old page, in one command
// (#1963; 0.135 P3). Gene: tests, proofs, promotional clips and a Soul's highlights all rest on this.
//
//   node tools/launch-video/scene.mjs <scene.json> [--out .local/launch-video] [--keep] [--size 1280x720] [--headed]
//
// 1. The world: tools/playtest/arena/new-engine/old-page.mjs brings up the old page (apps/web) on a new-engine world of
//    the scene's genesis (a committed template, or the scene's own file), with `world.add`'s things placed in it before
//    it starts. Fake minds, loopback, everything under <out>/; it is thrown away afterwards (--keep leaves it up).
// 2. The Souls: each is paired as tools/playtest/arena/new-engine/seat.mjs pairs one, and joins.
// 3. `setup` runs before the take (walk them where the scene opens); then the take starts and each beat runs at its
//    second, one command of the new client's thin command (`v2/client/src/cli/souls.mjs`) per Soul, exactly as an agent
//    would. No model runs, and nothing reaches into the world another way.
// 4. The take: capture.mjs records the canvas and the game's sound, uncut and at real speed, from the scene's camera:
//    `{"follow": "<soul>"}`, `{"fixed": {position, target, fov}}`, or `{"path": [{at, position, target, fov}, …]}`
//    (metres in the world's frame; a path's poses are eased between, its last held), recorded as the scene plays; or
//    `{"plan": {"subjects"?: ["ada"], "moves"?: [...], "framings"?: [...]}}`: the scene plays, @souls/camera's
//    pathfinder plans the best move around the world's solids from its history (shoot.mjs), and the take replays the
//    scene's span on the page from its first tick at ×1 with that camera. No camera: the page's own (Broadcast).
//
// scene/2:
//   { "name", "seconds", "hour"?: "HH:MM", "size"?: "1280x720",
//     "world": { "template": "worlds/templates/<name>.json" | "<file>", "add"?: [<god ops, as a template's batch>] },
//     "souls": [{ "id": "ada" }],
//     "setup"?: [{ "souls": ["ada"] | "*", "do": ["act", "?bench", "--wait"] }],
//     "beats": [{ "at": 0, "souls": ["ada", "bo"] | "*", "do": ["say", "hello"], "stagger"?: 1.5 }],
//     "camera"?: { "follow": "ada" } | { "fixed": {…} } | { "path": [{…}] } | { "plan": {…} } }
// In a command, "?<words>" is the first thing the Soul's own copy finds for those words (`find`), so a scene carries no
// ids, which differ from world to world, and "@<soul>" is that Soul's body.
//
// Known limits: things are placed before the world starts (`world.add`, in both the engine's world and the page's
// scenery); a thing placed or moved while it runs is not drawn on the old page until it draws things from the stream
// (0.135 K4, W2). A joined Soul starts at the world's entry, which in hello-hamlet is inside a cottage: `setup` walks
// it out.
//
// Written to <out>/<name>/: the clip (<name>.mp4) and its sidecar, run.json (the scene, each Soul's body, every command
// and its answer), the world's folder and logs. Never commit them.
import { mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { isMain } from '../lib/is-main.mjs';
import { REPO_ROOT } from '../lib/paths.mjs';
import { startOldPage } from '../playtest/arena/new-engine/old-page.mjs';
import { pairSeat } from '../playtest/arena/new-engine/seat.mjs';
import { capture } from './capture.mjs';
import { shoot } from './shoot.mjs';

const sleep = (s) => new Promise((ok) => setTimeout(ok, s * 1000));

/** Every problem with a scene, as strings (empty when valid). */
export function checkScene(scene) {
  const errs = [], ids = (scene?.souls ?? []).map((s) => s?.id);
  if (!/^[a-z0-9][a-z0-9-]{0,40}$/.test(scene?.name ?? '')) errs.push('name: lowercase letters, digits, dashes');
  if (!(scene?.seconds > 0)) errs.push('seconds: the take\'s length');
  if (typeof scene?.world?.template !== 'string') errs.push('world.template: a template file');
  if (!ids.length || !ids.every((id) => /^[a-z][a-z0-9-]{0,31}$/.test(id ?? ''))) errs.push('souls[].id: lowercase letters, digits, dashes');
  for (const [k, list] of [['setup', scene?.setup ?? []], ['beats', scene?.beats ?? []]]) list.forEach((b, i) => {
    if (b.souls !== '*' && !(Array.isArray(b.souls) && b.souls.every((id) => ids.includes(id)))) errs.push(`${k}[${i}].souls: "*" or ids of the scene's Souls`);
    if (!Array.isArray(b.do) || !b.do.length || !b.do.every((w) => typeof w === 'string')) errs.push(`${k}[${i}].do: a command's words`);
    if (k === 'beats' && !(b.at >= 0)) errs.push(`beats[${i}].at: seconds into the take`);
  });
  const c = scene?.camera;
  const plan = c?.plan && typeof c.plan === 'object' && (c.plan.subjects === undefined || (Array.isArray(c.plan.subjects) && c.plan.subjects.every((id) => ids.includes(id))));
  if (c && !((typeof c.follow === 'string' && ids.includes(c.follow)) || pose(c.fixed) || (Array.isArray(c.path) && c.path.length && c.path.every((p) => pose(p) && p.at >= 0)) || plan)) errs.push('camera: {follow: <soul>}, {fixed: {position, target, fov}}, {path: [{at, position, target, fov}]} or {plan: {subjects?, moves?, framings?}}');
  return errs;
}
const vec = (v) => Array.isArray(v) && v.length === 3 && v.every(Number.isFinite);
const pose = (p) => !!p && vec(p.position) && vec(p.target) && (p.fov === undefined || p.fov > 0);

/** A fixed pose or a keyframed path as a live `souls-shot/1` track (30 samples a second, eased between keyframes). */
export function cameraShot(camera, seconds, aspect) {
  const keys = camera.fixed ? [{ at: 0, ...camera.fixed }] : [...camera.path].sort((a, b) => a.at - b.at);
  const hz = 30, n = Math.max(1, Math.ceil(seconds * hz)), samples = [];
  const ease = (u) => u * u * (3 - 2 * u);
  for (let i = 0; i <= n; i++) {
    const t = i / hz, k = keys.findIndex((p) => p.at > t), b = k < 0 ? keys.at(-1) : keys[k], a = k <= 0 ? b : keys[k - 1];
    const u = a === b ? 0 : ease((t - a.at) / (b.at - a.at)), l = (p, q) => p.map((x, j) => x + (q[j] - x) * u);
    samples.push({ t, position: l(a.position, b.position), target: l(a.target, b.target), fov: (a.fov ?? 45) + ((b.fov ?? 45) - (a.fov ?? 45)) * u, key: 'desired', cut: false, valid: true, readability: 1 });
  }
  return { schema: 'souls-shot/1', live: true, seconds, aspect, move: camera.fixed ? 'fixed' : 'path', track: { schema: 'mars-camera-track/1', hz, duration: seconds, samples } };
}

/** A command's words with "?<words>" found in the Soul's own copy and "@<soul>" as that Soul's body. */
export async function bind(seat, words, bodies) {
  const out = [];
  for (const w of words) {
    if (w.startsWith('@') && bodies[w.slice(1)]) out.push(bodies[w.slice(1)]);
    else if (w.startsWith('?')) {
      const found = ((await seat.cli('find', ...w.slice(1).split(/\s+/))).found ?? []).find((r) => !r.kind?.startsWith('souls:body'));
      if (!found) throw Error(`nothing found for "${w}"`);
      out.push(found.id);
    } else out.push(w);
  }
  return out;
}

export async function stage(scene, { out, keep = false, size = null, headed = false, log = (s) => console.error(`scene: ${s}`) }) {
  const errs = checkScene(scene);
  if (errs.length) throw Error(`scene: ${errs.join('; ')}`);
  const dir = resolve(out, scene.name);
  // a throwaway world each time: an earlier run's world, Souls and logs go first
  for (const d of ['world', 'seats']) rmSync(join(dir, d), { recursive: true, force: true });
  mkdirSync(dir, { recursive: true });
  const run = { scene, startedAt: new Date().toISOString(), bodies: {}, commands: [] };
  const save = () => writeFileSync(join(dir, 'run.json'), JSON.stringify(run, null, 1));
  const world = await startOldPage({ template: scene.world.template, add: scene.world.add ?? [], dir: join(dir, 'world'), log });
  const seats = {};
  try {
    log(`old page ${world.page}`);
    for (const s of scene.souls) {
      seats[s.id] = await pairSeat({ world: world.world, dir: join(dir, 'seats'), label: s.id });
      run.bodies[s.id] = (await seats[s.id].join()).body;
      log(`${s.id}: ${seats[s.id].soul}, body ${run.bodies[s.id]}`);
    }
    const doOne = async (id, words, at) => {
      try { const w = await bind(seats[id], words, run.bodies); const answer = await seats[id].cli(...w); run.commands.push({ at, soul: id, words: w, answer }); }
      catch (e) { run.commands.push({ at, soul: id, words, error: e.message }); log(`${id} ${words.join(' ')}: ${e.message}`); }
    };
    const whoOf = (b) => (b.souls === '*' ? scene.souls.map((s) => s.id) : b.souls);
    for (const b of scene.setup ?? []) await Promise.all(whoOf(b).map((id) => doOne(id, b.do, 'setup')));
    save();
    const [w, h] = (size ?? scene.size ?? '1280x720').split('x').map(Number);
    const camera = scene.camera ?? null;
    let t0 = null;
    const beats = [];
    const play = () => {
      t0 = Date.now();
      for (const b of scene.beats ?? []) whoOf(b).forEach((id, i) => beats.push(sleep(b.at + i * (b.stagger ?? 0)).then(() => doOne(id, b.do, (Date.now() - t0) / 1000))));
    };
    const take = { url: world.page, out: join(dir, `${scene.name}.mp4`), seconds: scene.seconds, size: `${w}x${h}`, hour: scene.hour ?? '12:00', headed, log };
    let sidecar, planned = null;
    if (camera?.plan) {
      // a planned camera: the scene plays first, then its span is planned from the world's history (shoot.mjs, the
      // pathfinder) and replayed on the page from its first tick at the world's own speed
      play(); await sleep(scene.seconds); await Promise.all(beats);
      run.take = { startedAtMs: t0, seconds: scene.seconds }; save();
      await sleep(3);
      const p = camera.plan;
      planned = (await shoot({ recording: dir, from: 0, seconds: scene.seconds, aspect: w / h, subjects: p.subjects ?? null, moves: p.moves, framings: p.framings, log })).shot;
      writeFileSync(join(dir, `${scene.name}.shot.json`), JSON.stringify(planned));
      sidecar = await capture({ ...take, shot: planned });
    } else {
      sidecar = await capture({ ...take, shot: camera && !camera.follow ? cameraShot(camera, scene.seconds, w / h) : null, follow: camera?.follow ? seats[camera.follow].soul : null, onPlay: play });
      await Promise.all(beats);
    }
    run.take = { file: `${scene.name}.mp4`, startedAtMs: t0, seconds: sidecar.seconds, gpu: sidecar.gpu, fps: sidecar.pacing?.fps ?? null, camera: camera ? Object.keys(camera)[0] : 'page', ...(planned ? { move: planned.move, score: planned.score } : {}) };
    save();
    return { dir, clip: join(dir, `${scene.name}.mp4`), run, sidecar, world };
  } finally {
    for (const s of Object.values(seats)) await s.stop();
    if (!keep) await world.stop();
  }
}

if (isMain(import.meta.url)) {
  const arg = (k, d) => { const i = process.argv.indexOf(`--${k}`); return i >= 0 ? process.argv[i + 1] : d; };
  const file = process.argv[2];
  if (!file || file.startsWith('--')) { console.error(readFileSync(new URL(import.meta.url), 'utf8').split('\n').slice(1, 40).map((l) => l.replace(/^\/\/ ?/, '')).join('\n')); process.exit(2); }
  const scene = JSON.parse(readFileSync(resolve(file), 'utf8'));
  const r = await stage(scene, { out: arg('out', join(REPO_ROOT, '.local/launch-video')), keep: process.argv.includes('--keep'), size: arg('size', null), headed: process.argv.includes('--headed') });
  console.log(JSON.stringify({ clip: r.clip, run: join(r.dir, 'run.json'), seconds: r.sidecar.seconds, fps: r.sidecar.pacing?.fps, gpu: r.sidecar.gpu, camera: r.run.take.camera, commands: r.run.commands.length, errors: r.run.commands.filter((c) => c.error).length }));
  if (!process.argv.includes('--keep')) process.exit(0);
  console.error(`scene: kept: ${r.world.page} (Ctrl-C stops it)`);
  const quit = async () => { await r.world.stop(); process.exit(0); };
  process.on('SIGINT', quit); process.on('SIGTERM', quit);
}
