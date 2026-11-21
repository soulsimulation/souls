// Engine v2's page (V5, #2714): plays one stream of V1's files and draws it. The address is the stream's directory,
// given as the page's `stream` parameter; it is read here and sent nowhere else. The status shows how far behind the
// world the picture is, and the clock's state.
import * as THREE from 'three';
import { FreeCamera } from '../camera/camera.ts';
import { CameraDirector } from '../camera/director.ts';
import { ViewShots } from '../welcome/shots.ts';
import { PlaybackClock, caughtUp } from '../clock/clock.ts';
import { reconcileSnapshot, type Pointer } from '../source/source.ts';
import { StreamSource } from '../source/stream.ts';
import { localAddresses, worldAddress } from '../source/address.ts';
import { SocketSource, chooseFollow, exchange, type Session } from '../source/socket.ts';
import { browserSession, localTestSignIn } from '../source/signin.ts';
import { CrowdBodies, loadCrowd } from '../crowd/bodies.ts';
import { WorldHover } from '../crowd/hover.ts';
import { browserQuality } from './quality-tier.ts';
import { WorldView } from './world.ts';
import { support } from './support.ts';
import { pageThings } from '../things/page.ts';
import { rendererPictures } from '../things/standins.ts';
import { HistoryPage, readMoment, historyLocation } from '../history/page.ts';
import { WorldSound } from '../sound/sound.ts';
import { pageSouls } from '../souls/page.ts';
import { mountOwnerBox } from '../owner/box.ts';
import { arrive } from '../worlds/arrive.ts';
import { mountArrival } from '../arrival/card.ts';
import { WorldSky } from '../sky/sky.ts';
import { tickWater } from '../water/water.ts';
import { installNightLighting, nightPools, paintNightSources, setNightStrength } from './night.ts';
import { installCapture, shotSignal } from '../capture/capture.ts';
import { parseHour } from '../sky/hour.ts';
import { pageFx } from '../fx/page.ts';
import { mountFullscreen, startWakeLock } from './screen.ts';

installNightLighting(); // V19b: the lamps' night pools, before any lit material compiles

const canvas = document.getElementById('view') as HTMLCanvasElement;
const status = document.getElementById('status') as HTMLDivElement;
let addressError = '';
const installed = await worldAddress(location.href).catch(e => { addressError = String(e.message); return null; });
const address = installed?.stream ?? (addressError ? null : new URLSearchParams(location.search).get('stream'));
// C1 (#3365): `?world=<name>` names a placed world instead: its `views/world.json` (under `?worlds=`, default `./w/`)
// gives its stream's folder and its history's, both relative to the world's own folder.
const worldName = new URLSearchParams(location.search).get('world');
let worldHistory: string | null = installed?.history ?? null;
const moment = readMoment(location.hash); // V9: a link to a moment opens history
if (moment && installed && !addressError) {
  try { historyLocation(moment, location.href, installed); } catch (e) { addressError = e instanceof Error ? e.message : 'history-live-refused'; }
}
// V13/V13b/V13c: the owner's near-live view, from the web session alone: `directory` is the directory's origin,
// `gateway` the world's socket. The session is the provider's, its script loaded behind today's configuration
// (`signin.ts`; a fresh token asked of it each time), or `as=<test person>` on a local world. The session exchanges for
// a view token held in memory; no token is ever in the address.
const q = new URLSearchParams(location.search);
const signIn = async (): Promise<Session | null> => {
  const env = { document, href: location.href, global: globalThis as any, navigate: (u: string) => location.assign(u) };
  return browserSession(q.get('as') ?? undefined, env);
};
let near: SocketSource | null = null;

// The GL renderer's name, from a throwaway context, picks the tier before the real one is made (antialiasing is fixed
// at creation).
const probe = document.createElement('canvas').getContext('webgl2');
const info = probe?.getExtension('WEBGL_debug_renderer_info');
const quality = browserQuality(info ? String(probe!.getParameter(info.UNMASKED_RENDERER_WEBGL)) : null);
probe?.getExtension('WEBGL_lose_context')?.loseContext();
const renderer = new THREE.WebGLRenderer({ canvas, antialias: quality.antialias });
renderer.setPixelRatio(Math.min(devicePixelRatio, quality.maxPixelRatio));
const scene = new THREE.Scene();
scene.background = new THREE.Color(0xbcd3e6);
scene.fog = new THREE.Fog(0xbcd3e6, 300, 1200);
const hemi = new THREE.HemisphereLight(0xffffff, 0x556644, 1.6);
scene.add(hemi);
const sun = new THREE.DirectionalLight(0xffffff, 1.4);
// Shadows from the sun over the near part of the view (buildings, trees, things and the nearest bodies: V6's level 0),
// in a square of SHADOW m each side of where the camera looks, which follows it.
const SHADOW = 70;
renderer.shadowMap.enabled = true;
renderer.shadowMap.type = THREE.PCFShadowMap;
sun.castShadow = true;
sun.shadow.mapSize.set(2048, 2048);
sun.shadow.bias = -0.0004;
sun.shadow.normalBias = 0.04;
Object.assign(sun.shadow.camera, { left: -SHADOW, right: SHADOW, top: SHADOW, bottom: -SHADOW, near: 1, far: 1000 });
sun.shadow.camera.updateProjectionMatrix();
scene.add(sun, sun.target);
const sky = new WorldSky(scene, hemi, sun); // V19: sky, daylight and rain from the world node's record
sky.hour = parseHour(location.search); // #3795: `?hour=HH:MM`, the sky and its light only
const cam = new FreeCamera(canvas);
const world = new WorldView();
scene.add(world.group);
// #3603: the replica's courseAt, loaded on this thread only when a node with a course (a rowing punt) arrives.
world.onCourse = () => void import('replica').then(async (r) => { await r.default(); world.courseAt = r.courseAt; }, (e) => console.warn('courses stand still:', e));
const clock = new PlaybackClock();
const things = pageThings(scene, world, new URLSearchParams(location.search), rendererPictures(renderer)); // #3786: far stand-ins' pictures
const fx = pageFx(scene, world, things, q, quality.tier === 'phone'); // C8: flames, fountain water and steam
const souls = pageSouls(canvas, world, new URLSearchParams(location.search)); // W4: chips, status, speech, a Soul's page
const director = new CameraDirector(cam, canvas, world, souls, new URLSearchParams(location.search), moment !== null); // V20: broadcast, follow, find
director.shots = new ViewShots(renderer, scene, () => things.layer?.settled ?? true); // #3738: Explore's pictures, from this page's own draw
const hover = new WorldHover(canvas, () => cam.camera, { world, things: () => things.layer, name: (id) => souls.copy.souls.get(id)?.name ?? null, chipShown: (id) => souls.placed.some((p) => p.id === id) }); scene.add(hover.ring); // N-V20
Object.assign(globalThis, { v2: { renderer, scene, sky, cam, director, world, things, fx, souls, support: () => support(world, (id) => things.layer?.things.has(id) ?? true) } }); // for V8's measure and support.mjs
installCapture(globalThis as any, q, document); // G10: `shoot` names a place, Soul or thing and the camera goes there
const shot = shotSignal(q, globalThis as any); // #3795: `?shot`'s ready signal, as today's page gives it
// Bodies are drawn as V6's crowd from the body files under the page's `bodies` directory; capsules if they don't load.
loadCrowd(new URLSearchParams(location.search).get('bodies') ?? './assets/bodies/').then((c) => world.attach(new CrowdBodies(c)), (e) => console.warn('bodies stay capsules:', e));

// V21: the world heard, from the same parts and history the picture plays.
const where = (id: string, local?: [number, number, number]) => (world.nodes.has(id) ? (local ? new THREE.Vector3(...local).multiplyScalar(1e-6) : new THREE.Vector3()).applyMatrix4(world.frame(id)).toArray() : null);
const sound = new WorldSound({ where, kindOf: (id) => world.nodes.get(id)?.kind, heightAt: (x, z) => world.heightAt(x, z) });
// C1 (#3673): a Full screen toggle beside the sound switch, and the screen kept awake while the page is watched.
mountFullscreen(document.getElementById('sound-bar') ?? document.body);
startWakeLock();

let pointer: Pointer | null = null;
let newestTo: number | null = null;
let played = 0, hashes = 0, hashesEqual = 0, framed = false;
let error = addressError;

const resize = () => {
  renderer.setSize(innerWidth, innerHeight, false);
  cam.resize(innerWidth, innerHeight);
};
addEventListener('resize', resize);
resize();
cam.look(new THREE.Vector3(0, 0, 0), 0.6, -0.7, 300);

const firstFrame = arrive(worldName, status);
// #3780: today's arrival card, the world's name on black and a light that grows with the stream, until the first frame.
const card = mountArrival(document, worldName ?? installed?.world ?? 'Souls', q.has('shot') || moment !== null);
let arrived = false, failedWith = '';
const live = (address: string) => new StreamSource(address).start({
  pointer: (p) => ((pointer = p), card.reach('pointer')),
  snapshot: (snapshot) => {
    card.reach('snapshot');
    const s = reconcileSnapshot(world.nodes.keys(), snapshot);
    world.apply(s.nodes, s.removed, []);
    sky.apply(s.nodes);
    things.apply(s.nodes, s.removed);
    fx?.apply(s.nodes, s.removed);
    sound.part(s.nodes, s.removed, [], []);
    souls.snapshot(s.nodes, s.removed);
  },
  part: (p) => {
    world.apply(p.nodes, p.removed, p.samples);
    sky.apply(p.nodes, p);
    things.apply(p.nodes, p.removed);
    fx?.apply(p.nodes, p.removed);
    sound.part(p.nodes, p.removed, p.samples, p.happened ?? []);
    souls.apply(p);
    director.part(p);
    card.reach('part');
    newestTo = p.to;
    played++;
    if (p.hash !== null) (hashes++, p.hash && hashesEqual++);
  },
  error: (m) => (error = m),
});
/** A placed world's stream and history folders, from its `world.json`. */
async function resolveWorld(name: string, root: string, get = fetch): Promise<{ stream: string; history: string }> {
  const base = new URL(`${root.replace(/\/?$/, '/')}${encodeURIComponent(name)}/`, location.href);
  const res = await get(new URL('views/world.json', base).href);
  if (!res.ok) throw new Error(`world ${name}: world.json ${res.status}`);
  const j = (await res.json()) as { stream?: string; history?: string };
  if (typeof j.stream !== 'string') throw new Error(`world ${name}: world.json names no stream`);
  return { stream: new URL(j.stream.replace(/\/?$/, '/'), base).href, history: new URL(j.history ?? 'history/', base).href };
}
let history = moment && !addressError ? new HistoryPage(moment, cam, {
  apply: (n, r, s, h) => (world.apply(n, r, s), sky.apply(n), things.apply(n, r), fx?.apply(n, r), sound.part(n, r, s, h ?? [])), live, root: () => [...world.nodes.values()].find((n) => !n.parent)?.id ?? null,
  frame: (id) => (world.nodes.has(id) ? world.frame(id) : null),
}, installed ?? undefined) : null;
if (history) (framed = true), Object.assign(globalThis, { v2: { ...(globalThis as any).v2, history, clock } });
else if (address && !addressError) {
  live(address);
  const { directory, gateway } = installed ?? localAddresses(location.href);
  const ownerIntent = q.has('follow') || (localTestSignIn(location.href) && (q.has('as') || q.has('directory')));
  if (directory && gateway && ownerIntent) signIn().then(async (session) => {
    if (!session) return;
    const g = await exchange(directory, session);
    const follow = chooseFollow(g.owned, q.get('follow'));
    if (!follow) return void (error = 'no view: the account has no Soul to follow');
    near = new SocketSource({ url: gateway, token: g.token, expires: g.expires, follow, renew: () => exchange(directory, session) });
    near.start({ pointer: () => {}, part: (p) => world.apply([], [], p.samples), error: (m) => (error = m) });
    (globalThis as any).v2.near = near;
    // W10: the owner writes to the followed Soul's agent from its page.
    const own = g.owned.find((o) => o.follow === follow);
    if (own) (globalThis as any).v2.box = mountOwnerBox(near, own.grant, () => `To ${souls.copy.souls.get(follow)?.name ?? 'your Soul'}'s agent`);
  }).catch((e) => (error = e instanceof Error ? e.message : 'no view'));
}
else if (worldName && !addressError) resolveWorld(worldName, new URLSearchParams(location.search).get('worlds') ?? './w/').then(
  (w) => ((worldHistory = w.history), Object.assign(globalThis, { v2: { ...(globalThis as any).v2, stream: w.stream, worldHistory } }), live(w.stream)),
  (e) => (error = String(e)),
);
else card.fail(status.textContent = addressError || 'no stream: open this page with ?stream=<the stream directory> or ?world=<name>');

const secs = (us: number) => (us / 1e6).toFixed(2);
const clockText = (us: number) => {
  const s = Math.floor(us / 1e6);
  return `${String(Math.floor(s / 60)).padStart(2, '0')}:${String(s % 60).padStart(2, '0')}`;
};
let last = performance.now(), fps = 60, frames = 0;
renderer.setAnimationLoop((now) => {
  // A hidden tab stops frames; on return the clock cuts (a jump of more than 20 s) rather than playing fast.
  const dt = now - last;
  fps = fps * 0.95 + (1000 / Math.max(1, dt)) * 0.05;
  last = now;
  things.update(cam.camera.position);
  // The shadow's square moves in whole texels, so standing shadows don't shimmer as the camera moves.
  const texel = (2 * SHADOW) / sun.shadow.mapSize.x, at = cam.controls.target;
  sun.target.position.set(Math.round(at.x / texel) * texel, at.y, Math.round(at.z / texel) * texel);
  const worldNow = pointer ? pointer.anchorWorld + (Date.now() - pointer.anchorWallMs) * 1000 : null;
  const t = history ? history.step(dt, worldNow, caughtUp(newestTo, pointer?.quietUntil)) : worldNow === null ? null : (near ?? clock).step(dt, worldNow, caughtUp(newestTo, pointer?.quietUntil));
  director.update(Math.min(100, dt), t);
  sun.position.copy(sun.target.position).addScaledVector(sky.update(t ?? 0, cam.camera), 400);
  tickWater((t ?? 0) / 1e6);
  fx?.update(t === null ? null : t / 1e6, cam.camera.position);
  setNightStrength(sky.state.daylight);
  const pools = frames++ % 60 === 0 && things.layer ? nightPools(world, things.layer.opts.index, (id) => fx?.lit(id) ?? true) : null; // the lamps, once a second
  if (pools) paintNightSources(pools.sources, pools.bounds);
  const ck = near?.clock ?? clock;
  if (history?.live) (clock.t = t), (status.textContent = ''), (history = null);
  let drawn = 0;
  if (t !== null) {
    drawn = world.draw(t, cam.camera);
    things.follow(); // #3603: what rides a course, where it is now
    hover.update(now, t);
    if (!framed && drawn > 0) {
      framed = true;
      firstFrame();
      cam.setExtent(world.extent);
      const at = world.crowd(t);
      if (at) cam.look(at, 0.6, -0.6, 55);
    }
  }
  renderer.render(scene, cam.camera);
  shot.frame(t !== null && world.nodes.size > 0 && sky.recordAt(t) !== null && (things.layer?.settled ?? true)); // a world with no Souls draws no bodies, and is still ready
  if (!arrived && t !== null && world.nodes.size > 0) (arrived = true), card.reach('drawn');
  else if (!arrived && error && error !== failedWith) card.fail(failedWith = error);
  const c = cam.camera, fwd = c.getWorldDirection(new THREE.Vector3());
  sound.frame(t, { pos: c.position.toArray(), forward: fwd.toArray(), up: c.up.toArray() });
  if (t !== null) souls.draw(t, cam.camera);
  if (history) return void (status.textContent = `${history.status()}\nbodies drawn      ${drawn}   frames a second ${fps.toFixed(0)}`);
  if (!address && !moment && !worldName) return;
  status.textContent = t === null || worldNow === null
    ? `waiting for the stream${error ? `\n${error}` : ''}`
    : `behind the world  ${secs(worldNow - t)} s   (${ck.state}, ×${ck.rate.toFixed(3)})\n`
      + (near?.grant?.asked ? `view lowered to   ${near.grant.level} (asked ${near.grant.asked}: ${near.grant.reason})\n` : '')
      + `world time        ${clockText(t)}\n`
      + `parts played      ${played}   hashes equal ${hashesEqual}/${hashes}\n`
      + `bodies drawn      ${drawn}   frames a second ${fps.toFixed(0)}`
      + (error ? `\n${error}` : '');
});
