// V19 (#2763) Step 0 and A2, end to end: a local world with today's sky (`worldd gateway-link --www --sky`, built by
// `cargo build -p worldd`) starts at 19:59:57 on a day whose 18:00–20:00 slot rains (seed 8); the page's stream worker
// (worker.ts, with the WASM replica from v2/tools/ci.sh) reads E6's fields off the world node, and the page's sky draws
// rain until 20:00 and none after, at the world times the page's clock draws. Then a fresh copy replays the same files
// after the world has stopped and draws the same rain at the same moments. No browser here.
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { registerHooks } from 'node:module';
import { tmpdir } from 'node:os';
import { dirname, join, normalize, resolve } from 'node:path';
import { createInterface } from 'node:readline';
import { after, test } from 'node:test';
import { fileURLToPath, pathToFileURL } from 'node:url';
import * as THREE from 'three';
import { PlaybackClock, caughtUp } from '../clock/clock.ts';
import type { PartRec, Pointer } from '../source/source.ts';
import { WorldSky } from './sky.ts';

const v2 = resolve(dirname(fileURLToPath(import.meta.url)), '../../..');
const pkg = resolve(v2, process.env.V2_REPLICA_PKG ?? 'target/wasm-load/pkg');
const worldd = resolve(v2, 'target/debug/worldd');
for (const f of [join(pkg, 'replica.js'), worldd]) assert.ok(existsSync(f), `${f}: run v2/tools/ci.sh's wasm steps and cargo build -p worldd`);
const replicaUrl = pathToFileURL(join(pkg, 'replica.js')).href;
registerHooks({ resolve: (s, c, next) => (s === 'replica' ? { url: replicaUrl, shortCircuit: true } : next(s, c)) });

const work = mkdtempSync(join(tmpdir(), 'v2-sky-'));
const www = join(work, 'www');
const timers: ReturnType<typeof setInterval>[] = [];
let world: ReturnType<typeof spawn> | null = null;
after(() => {
  timers.forEach(clearInterval);
  world?.kill('SIGKILL');
  rmSync(work, { recursive: true, force: true });
});
const realSetInterval = globalThis.setInterval;
(globalThis as { setInterval: unknown }).setInterval = (f: () => void, ms: number) => {
  const t = realSetInterval(f, ms);
  timers.push(t);
  return t;
};
globalThis.fetch = (async (input: string | URL) => {
  const url = new URL(String(input));
  if (url.protocol === 'file:') return new Response(readFileSync(url), { headers: { 'content-type': 'application/wasm' } });
  const file = normalize(join(www, decodeURIComponent(url.pathname.slice(3))));
  if (!file.startsWith(www) || !existsSync(file)) return new Response(null, { status: 404 });
  return new Response(readFileSync(file));
}) as typeof fetch;
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** A worker of the page's stream, on its own copy (a fresh module instance), posting into `on`. */
async function page(stream: string, tag: string) {
  const parts: PartRec[] = [], errors: string[] = [];
  let pointer: Pointer | null = null;
  const self = { postMessage: (m: { t: string; p: never; message: string }) => (m.t === 'part' ? parts.push(m.p) : m.t === 'pointer' ? (pointer = m.p) : errors.push(m.message)), onmessage: null as null | ((e: unknown) => void) };
  (globalThis as { self?: unknown }).self = self;
  await import(`../source/worker.ts?${tag}`);
  self.onmessage!({ data: { stream } });
  return { parts, errors, pointer: () => pointer };
}

// The world's time is its clock's (µs since 1970): the calendar's origin puts its start at 19:59:57 local, UTC zone.
const START = Date.UTC(2026, 10, 18, 19, 59, 57) * 1000, TWENTY = Date.UTC(2026, 10, 18, 20) * 1000;
const scene = () => new WorldSky(new THREE.Scene(), new THREE.HemisphereLight(), new THREE.DirectionalLight(), false);
const cam = new THREE.PerspectiveCamera();

test('Step 0 and A2: rain starts and stops with the weather effect, live and in replay', async () => {
  const sock = join(work, 'w.sock');
  const origin = START - Date.now() * 1000, CHANGE = TWENTY - origin;
  world = spawn(worldd, ['gateway-link', '--socket', sock, '--lineage', 'e6'.repeat(16), '--epoch', '1', '--log', join(work, 'log'), '--rooms', '1', '--bodies', '1', '--no-measures', '--www', www, '--sky', String(origin), '8'], { stdio: ['ignore', 'pipe', 'inherit'] });
  const streamDir = await new Promise<string>((ok, no) => {
    world!.once('exit', (c) => no(new Error(`worldd exited ${c}`)));
    createInterface({ input: world!.stdout! }).on('line', (l) => l.startsWith('stream ') && ok(l.slice(7)));
  });
  const stream = `http://local/s/${streamDir.replace(/\/?$/, '/')}`;

  // Live: the page's frame loop (main.ts): parts into the sky as they arrive, the sky drawn at the clock's time.
  const live = await page(stream, 'live');
  const sky = scene(), clock = new PlaybackClock();
  let applied = 0, last = Date.now();
  const drawn: [number, number][] = [];
  const end = Date.now() + 8000;
  while (Date.now() < end) {
    for (; applied < live.parts.length; applied++) sky.apply(live.parts[applied].nodes, live.parts[applied]);
    const p = live.pointer(), now = Date.now();
    const w = p ? p.anchorWorld + (now - p.anchorWallMs) * 1000 : null;
    const t = w === null ? null : clock.step(now - last, w, caughtUp(live.parts.at(-1)?.to ?? null, p?.quietUntil));
    last = now;
    // A frame before the first part is applied has no sky yet (the pointer can arrive first): the page draws its default
    // there, so only frames with the world node's sky count (the flake: an early dry frame before 20:00).
    if (t !== null && applied > 0) (sky.update(t, cam), drawn.push([t, sky.state.rain]));
    await sleep(16);
  }
  world.kill('SIGKILL');
  assert.deepEqual(live.errors, []);

  // Step 0: E6's fields in the live copy: the light, the weather and the time of each next change.
  const node = live.parts.flatMap((p) => p.nodes).find((n) => n.sky)!;
  assert.ok(node, 'the world node carries its sky');
  const first = sky.recordAt(-Infinity)!;
  console.log(`Step 0: world node ${node.kind}: light ${first.light} (next at local ${new Date((first.lightNext! + origin) / 1000).toISOString().slice(11, 19)}), weather ${first.weather} [${first.cloud}, ${first.rain}, ${first.wind}] (next at local ${new Date((first.weatherNext! + origin) / 1000).toISOString().slice(11, 19)})`);
  assert.equal(first.weather, 'souls:rain');
  assert.equal(first.weatherNext, CHANGE);
  assert.equal(sky.recordAt(CHANGE)!.weather, 'souls:cloudy');

  const before = drawn.filter(([t]) => t < CHANGE), afterwards = drawn.filter(([t]) => t >= CHANGE);
  assert.ok(before.length > 10 && afterwards.length > 10, `${before.length} frames before 20:00, ${afterwards.length} after`);
  assert.ok(before.every(([, r]) => r === 1), 'rain in every frame before the change');
  assert.ok(afterwards.every(([, r]) => r === 0), 'none in any frame from it');
  console.log(`A2 live: ${before.length} frames drawn before 20:00 all raining, ${afterwards.length} from 20:00 all dry (drawn ${((drawn[0][0] - CHANGE) / 1e6).toFixed(2)} to ${((drawn.at(-1)![0] - CHANGE) / 1e6).toFixed(2)} s about 20:00)`);

  // Replay: a fresh copy plays the same files after the world stopped, then draws the frames live drew.
  const again = await page(stream, 'replay');
  const until = Date.now() + 5000;
  while (Date.now() < until && again.parts.length < live.parts.length) await sleep(50);
  assert.equal(again.parts.length, live.parts.length);
  const replay = scene();
  for (const p of again.parts) replay.apply(p.nodes, p);
  const differ = drawn.filter(([t, r]) => (replay.update(t, cam), replay.state.rain !== r));
  assert.deepEqual(differ, []);
  console.log(`A2 replay: ${again.parts.length} parts replayed; the same rain in all ${drawn.length} frames`);
});
