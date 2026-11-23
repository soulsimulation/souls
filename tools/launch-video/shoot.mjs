#!/usr/bin/env node
// shoot.mjs — plan the camera for one shot of a recorded span of a new-engine world (#1963; 0.135 P3a). No browser, no
// world running, no model: it reads the world's folder.
//
//   node tools/launch-video/shoot.mjs --recording <scene dir> --out <shot.json> [--subjects ada,bo | --subjects auto]
//        [--from <seconds into the take>] [--seconds 10] [--aspect 0.8] [--moves track,orbit] [--framings medium,close]
//        [--pick <candidate id>] [--list] [--describe] [--pose x,y,z:x,y,z[:fov][>x,y,z:x,y,z[:fov]]]
//   node tools/launch-video/shoot.mjs --world <world folder> --from-us <µs> [--seconds 10] --out <shot.json> …
//   node tools/launch-video/shoot.mjs --page <a world's old page> --from-us <µs> [--seconds 10] --out <shot.json> …   (0.135 P7:
//        over the network, as soul.game serves a world: people from its public history, solids from its public stream)
//
// <scene dir> is what scene.mjs wrote (run.json: each Soul's body and when its take started; the world's folder beside
// it). --world names a world's folder instead (`worldd`'s: facts.json and history/), with the span's start in world µs.
// The world's solids come from its facts (`obstaclesOfFacts`, the boxes today's world model gives the same genesis), the
// people from its history (`placesIn`, the old page's own history worker); @souls/camera's pathfinder tries every move
// and writes the best as camera data (`mars-camera-track/1`) with the take ticks it belongs to (`souls-shot/1`), which
// capture.mjs --shot replays on the old page (`?track=`, a past range: the world must be up to serve its history).
// --pose: a fixed camera (eye:target), "pose>pose" eases from one to the other. --describe: who moves when, then stop.
// --subjects auto: the person who travels furthest in the window. --list prints every candidate and why the rest were
// rejected.
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { cameraScene, CAMERA_TRACK_SCHEMA, findPath, historyOfPlaces, obstaclesOfFacts, trackOf } from '../../packages/camera/src/index.ts';
import { heightAt } from '../../packages/ground/src/index.ts';
import { isMain } from '../lib/is-main.mjs';
import { pageSources, placesIn, thingsOf } from './v2-history.mjs';
import { closeViewers, streamViewer } from '../playtest/observer/new-engine/stream.mjs';

export const TICK_US = 50_000;
/** The page's key for a client id (`<scope>-<n>` → `<scope>.<n>`). */
const pageKey = (id) => String(id).replace(/-(\d+)$/, '.$1');

/** What a shot is made from: a scene dir (run.json + its world) or a world folder and a start. */
export function sourceOf({ recording = null, world = null, page = null, fromUs = null }) {
  // 0.135 P7: a world's page as soul.game serves it: its people from its public history, its solids from its public
  // stream, both over the network (no folder, so a live world's highlights can be planned)
  if (page) { if (!(fromUs > 0)) throw Error('--page needs --from-us <µs>'); return { page, startUs: fromUs, names: {} }; }
  if (recording) {
    const dir = resolve(recording), run = JSON.parse(readFileSync(join(dir, 'run.json'), 'utf8'));
    if (!run.take?.startedAtMs) throw Error(`${dir}/run.json has no take start (a scene recorded before 0.135 P3a)`);
    return { world: join(dir, 'world/world/world'), startUs: run.take.startedAtMs * 1000, names: Object.fromEntries(Object.entries(run.bodies ?? {}).map(([k, v]) => [k, pageKey(v)])) };
  }
  if (!world || !(fromUs > 0)) throw Error('--recording <scene dir>, --world <world folder> --from-us <µs>, or --page <a world\'s old page> --from-us <µs>');
  return { world: resolve(world), startUs: fromUs, names: {} };
}

/** A fixed or eased pose ("x,y,z:x,y,z[:fov]" or "a>b") as a `souls-shot/1` range. */
export function poseShot(spec, { fromTick, seconds, aspect, subjects = [] }) {
  const [a, b = a] = spec.split('>').map((q) => q.split(':').map((v) => v.split(',').map(Number))), hz = 10, mix = (x, y, u) => x.map((v, i) => v + (y[i] - v) * u);
  const samples = Array.from({ length: Math.round(seconds * hz) + 1 }, (_, i) => { const u = i / (seconds * hz), e = u * u * u * (u * (u * 6 - 15) + 10); return { t: i / hz, position: mix(a[0], b[0], e), target: mix(a[1], b[1], e), fov: mix([a[2]?.[0] ?? 50], [b[2]?.[0] ?? a[2]?.[0] ?? 50], e)[0], key: 'desired', cut: false, valid: true, readability: 1 }; });
  return { schema: 'souls-shot/1', fromTick, toTick: fromTick + Math.round(seconds * 1e6 / TICK_US), dt: TICK_US / 1e6, aspect, subjects, move: 'fixed', track: { schema: CAMERA_TRACK_SCHEMA, hz, duration: seconds, samples } };
}

export async function shoot({ recording, world: worldDir, page = null, fromUs, from = null, seconds = 10, aspect = 0.8, subjects: asked = null, moves, framings, pick: pickId, pose, describe = false, list = false, log = console.log }) {
  const src = sourceOf({ recording, world: worldDir, page, fromUs });
  const span = Math.max(seconds, recording ? JSON.parse(readFileSync(join(resolve(recording), 'run.json'), 'utf8')).take.seconds ?? seconds : seconds);
  let obstacles, ground, historyAt;
  if (src.page) {
    const at = await pageSources(src.page);
    if (!at.history) throw Error(`${src.page} names no public history (v2History)`);
    const v = await streamViewer({ stream: at.stream });
    const ok = await v.until((x) => [...x.nodes.values()].some((n) => n.solids?.length), 60_000);
    if (!ok) { closeViewers(); throw Error(`no solids in ${at.stream}${v.errors.length ? `: ${v.errors[0].slice(0, 200)}` : ''}`); }
    obstacles = obstaclesOfFacts({ things: thingsOf(v.nodes) });
    closeViewers();
    historyAt = at.history;
  } else {
    const facts = JSON.parse(readFileSync(join(src.world, 'facts.json'), 'utf8')), recipe = JSON.parse(facts.ground.recipe);
    ground = (x, z) => heightAt(recipe, x, z);
    obstacles = obstaclesOfFacts(facts, ground);
    historyAt = join(src.world, 'history');
  }
  const scene = cameraScene(null, obstacles);
  const { places } = await placesIn({ history: historyAt, fromUs: src.startUs, toUs: src.startUs + span * 1e6 });
  const history = historyOfPlaces(places, { fromUs: src.startUs, toUs: src.startUs + span * 1e6, tickUs: TICK_US });
  const label = (id) => Object.keys(src.names).find((k) => src.names[k] === id) ?? id;
  const length = (history.toTick - history.fromTick) * history.dt;
  if (describe) {
    log(`recording ${length.toFixed(1)} s, ${history.ids.length} people, ${obstacles.length} solids`);
    for (const id of history.ids) {
      const s = history.sampler(), rows = [];
      for (let t = 0; t <= length; t += 2) { const p = s(t)[id]?.p; rows.push(p ? `${t}s ${p[0].toFixed(1)},${p[2].toFixed(1)}` : `${t}s -`); }
      log(`${label(id).padEnd(6)} ${rows.join(' | ')}`);
    }
    return null;
  }
  const travel = (id, f) => { const s = history.sampler(history.fromTick + f / history.dt); let d = 0, prev = null; for (let t = 0; t <= seconds; t += 0.5) { const p = s(t)[id]?.p; if (p && prev) d += Math.hypot(p[0] - prev[0], p[2] - prev[2]); prev = p ?? prev; } return d; };
  let subjects = asked?.map((id) => src.names[id] ?? id);
  if (!subjects || subjects[0] === 'auto') {
    let best = { d: -1 };
    for (const id of history.ids) for (let f = from ?? 0; f <= (from ?? Math.max(0, length - seconds)); f += 1) { const d = travel(id, f); if (d > best.d) best = { d, id, f }; }
    if (!best.id) throw Error('no people in this span');
    subjects = [best.id]; from ??= best.f;
  }
  from ??= 0;
  const fromTick = Math.round(history.fromTick + from / history.dt);
  if (pose) return { shot: poseShot(pose, { fromTick, seconds, aspect, subjects }), from };
  const t0 = performance.now();
  const result = findPath({ sampler: history.sampler(fromTick), scene, duration: seconds, subjects, aspect, moves, framings, ground });
  const ms = Math.round(performance.now() - t0);
  const row = (c) => `${c.id.padEnd(24)} ${c.score.toFixed(3)}  ${Object.entries(c.parts).map(([k, v]) => `${k} ${v.toFixed(2)}`).join('  ')}`;
  log(`span ${length.toFixed(1)} s, ${history.ids.length} people, ${obstacles.length} solids; shot ${from}–${from + seconds} s of ${subjects.map(label).join(', ')} at aspect ${aspect}; ${result.ranked.length} moves kept, ${result.rejected.length} rejected, ${ms} ms`);
  for (const c of list ? result.ranked : result.ranked.slice(0, 6)) log(row(c));
  if (list) for (const c of result.rejected) log(`${c.id.padEnd(24)} rejected  ${c.rejected}`);
  else { const why = {}; for (const c of result.rejected) { const k = c.rejected.split(':')[0]; why[k] = (why[k] ?? 0) + 1; } log(`rejected: ${JSON.stringify(why)}`); }
  const pick = pickId ? result.ranked.find((c) => c.id === pickId) : result.best;
  if (!pick) throw Object.assign(Error(pickId ? `no kept candidate ${pickId}` : 'camera.path-none: the world allows no continuous move for this shot'), { code: 2 });
  const T = pick.plan.report.temporal;
  return { from, shot: { schema: 'souls-shot/1', fromTick, toTick: fromTick + Math.round(seconds / history.dt), dt: history.dt, aspect, subjects, move: pick.id, score: +pick.score.toFixed(4), parts: pick.parts, motion: { maxAngVel: T.maxAngVel, maxLinVel: T.maxLinVel }, track: trackOf(pick) } };
}

if (isMain(import.meta.url)) {
  const arg = (k, d) => { const i = process.argv.indexOf(`--${k}`); return i >= 0 ? process.argv[i + 1] : d; };
  const list = (k) => arg(k)?.split(',').filter(Boolean), out = arg('out') ? resolve(arg('out')) : null;
  try {
    const r = await shoot({ recording: arg('recording'), world: arg('world'), page: arg('page'), fromUs: arg('from-us') ? Number(arg('from-us')) : null, from: arg('from') === undefined ? null : Number(arg('from')),
      seconds: Number(arg('seconds', 10)), aspect: Number(arg('aspect', 0.8)), subjects: list('subjects') ?? null, moves: list('moves'), framings: list('framings'), pick: arg('pick'), pose: arg('pose'),
      describe: process.argv.includes('--describe'), list: process.argv.includes('--list') });
    if (r && out) { mkdirSync(dirname(out), { recursive: true }); writeFileSync(out, JSON.stringify(r.shot)); console.log(`wrote ${r.shot.move} (${r.from}–${r.from + Number(arg('seconds', 10))} s) → ${out}`); }
    process.exit(0);
  } catch (e) { console.error(e.message); process.exit(e.code ?? 1); }
}
