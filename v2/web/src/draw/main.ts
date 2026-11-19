// Engine v2's page (V5, #2714): plays one stream of V1's files and draws it. The address is the stream's directory,
// given as the page's `stream` parameter; it is read here and sent nowhere else. The status shows how far behind the
// world the picture is, and the clock's state.
import * as THREE from 'three';
import { FreeCamera } from '../camera/camera.ts';
import { CameraDirector } from '../camera/director.ts';
import { PlaybackClock, caughtUp } from '../clock/clock.ts';
import type { Pointer } from '../source/source.ts';
import { StreamSource } from '../source/stream.ts';
import { SocketSource } from '../source/socket.ts';
import { CrowdBodies, loadCrowd } from '../crowd/bodies.ts';
import { browserQuality } from './quality-tier.ts';
import { WorldView } from './world.ts';
import { support } from './support.ts';
import { pageThings } from '../things/page.ts';
import { HistoryPage, readMoment } from '../history/page.ts';
import { WorldSound } from '../sound/sound.ts';
import { pageSouls } from '../souls/page.ts';
import { arrive } from '../worlds/arrive.ts';

const canvas = document.getElementById('view') as HTMLCanvasElement;
const status = document.getElementById('status') as HTMLDivElement;
const address = new URLSearchParams(location.search).get('stream');
const moment = readMoment(location.hash); // V9: a link to a moment opens history
const q = new URLSearchParams(location.search), token = new URLSearchParams(location.hash.slice(1)).get('token'); // V13
if (token) window.history.replaceState(null, '', location.pathname + location.search); // the token leaves the address
const near = q.get('gateway') && token ? new SocketSource({ url: q.get('gateway')!, token, follow: q.get('follow') ?? '' }) : null;

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
scene.add(new THREE.HemisphereLight(0xffffff, 0x556644, 1.6));
const sun = new THREE.DirectionalLight(0xffffff, 1.4);
// Shadows from the sun over the near part of the view (buildings, trees, things and the nearest bodies: V6's level 0),
// in a square of SHADOW m each side of where the camera looks, which follows it.
const SUN = new THREE.Vector3(300, 500, 200).normalize().multiplyScalar(400), SHADOW = 70;
renderer.shadowMap.enabled = true;
renderer.shadowMap.type = THREE.PCFShadowMap;
sun.castShadow = true;
sun.shadow.mapSize.set(2048, 2048);
sun.shadow.bias = -0.0004;
sun.shadow.normalBias = 0.04;
Object.assign(sun.shadow.camera, { left: -SHADOW, right: SHADOW, top: SHADOW, bottom: -SHADOW, near: 1, far: 1000 });
sun.shadow.camera.updateProjectionMatrix();
scene.add(sun, sun.target);
const cam = new FreeCamera(canvas);
const world = new WorldView();
scene.add(world.group);
const clock = new PlaybackClock();
const things = pageThings(scene, world, new URLSearchParams(location.search));
const souls = pageSouls(canvas, world, new URLSearchParams(location.search)); // W4: chips, status, speech, a Soul's page
const director = new CameraDirector(cam, canvas, world, souls, new URLSearchParams(location.search), moment !== null); // V20: broadcast, follow, find
Object.assign(globalThis, { v2: { renderer, scene, cam, director, world, things, souls, support: () => support(world, (id) => things.layer?.things.has(id) ?? true) } }); // for V8's measure and support.mjs
// Bodies are drawn as V6's crowd from the body files under the page's `bodies` directory; capsules if they don't load.
loadCrowd(new URLSearchParams(location.search).get('bodies') ?? './bodies/').then((c) => world.attach(new CrowdBodies(c)), (e) => console.warn('bodies stay capsules:', e));

// V21: the world heard, from the same parts and history the picture plays.
const where = (id: string, local?: [number, number, number]) => (world.nodes.has(id) ? (local ? new THREE.Vector3(...local).multiplyScalar(1e-6) : new THREE.Vector3()).applyMatrix4(world.frame(id)).toArray() : null);
const sound = new WorldSound({ where, kindOf: (id) => world.nodes.get(id)?.kind, heightAt: (x, z) => world.heightAt(x, z) });

let pointer: Pointer | null = null;
let newestTo: number | null = null;
let played = 0, hashes = 0, hashesEqual = 0, framed = false;
let error = '';

const resize = () => {
  renderer.setSize(innerWidth, innerHeight, false);
  cam.resize(innerWidth, innerHeight);
};
addEventListener('resize', resize);
resize();
cam.look(new THREE.Vector3(0, 0, 0), 0.6, -0.7, 300);

const worldName = new URLSearchParams(location.search).get('world');
const firstFrame = arrive(worldName, status);
const live = (address: string) => new StreamSource(address).start({
  pointer: (p) => (pointer = p),
  part: (p) => {
    world.apply(p.nodes, p.removed, p.samples);
    things.apply(p.nodes, p.removed);
    sound.part(p.nodes, p.removed, p.samples, p.happened ?? []);
    souls.apply(p);
    director.part(p);
    newestTo = p.to;
    played++;
    if (p.hash !== null) (hashes++, p.hash && hashesEqual++);
  },
  error: (m) => (error = m),
});
let history = moment && new HistoryPage(moment, cam, {
  apply: (n, r, s, h) => (world.apply(n, r, s), things.apply(n, r), sound.part(n, r, s, h ?? [])), live, root: () => [...world.nodes.values()].find((n) => !n.parent)?.id ?? null,
  frame: (id) => (world.nodes.has(id) ? world.frame(id) : null),
});
if (history) (framed = true), Object.assign(globalThis, { v2: { ...(globalThis as any).v2, history, clock } });
else if (!address) worldName || (status.textContent = 'no stream: open this page with ?stream=<the stream directory>');
else (live(address), near?.start({ pointer: () => {}, part: (p) => world.apply([], [], p.samples), error: (m) => (error = m) }));

const secs = (us: number) => (us / 1e6).toFixed(2);
const clockText = (us: number) => {
  const s = Math.floor(us / 1e6);
  return `${String(Math.floor(s / 60)).padStart(2, '0')}:${String(s % 60).padStart(2, '0')}`;
};
let last = performance.now(), fps = 60;
renderer.setAnimationLoop((now) => {
  // A hidden tab stops frames; on return the clock cuts (a jump of more than 20 s) rather than playing fast.
  const dt = now - last;
  fps = fps * 0.95 + (1000 / Math.max(1, dt)) * 0.05;
  last = now;
  things.update(cam.camera.position);
  // The shadow's square moves in whole texels, so standing shadows don't shimmer as the camera moves.
  const texel = (2 * SHADOW) / sun.shadow.mapSize.x, at = cam.controls.target;
  sun.target.position.set(Math.round(at.x / texel) * texel, at.y, Math.round(at.z / texel) * texel);
  sun.position.copy(sun.target.position).add(SUN);
  const worldNow = pointer ? pointer.anchorWorld + (Date.now() - pointer.anchorWallMs) * 1000 : null;
  const t = history ? history.step(dt, worldNow, newestTo) : worldNow === null ? null : (near ?? clock).step(dt, worldNow, caughtUp(newestTo, pointer?.quietUntil));
  director.update(Math.min(100, dt), t);
  const ck = near?.clock ?? clock;
  if (history?.live) (clock.t = t), (status.textContent = ''), (history = null);
  let drawn = 0;
  if (t !== null) {
    drawn = world.draw(t, cam.camera);
    if (!framed && drawn > 0) {
      framed = true;
      firstFrame();
      cam.setExtent(world.extent);
      const at = world.crowd(t);
      if (at) cam.look(at, 0.6, -0.6, 55);
    }
  }
  renderer.render(scene, cam.camera);
  const c = cam.camera, fwd = c.getWorldDirection(new THREE.Vector3());
  sound.frame(t, { pos: c.position.toArray(), forward: fwd.toArray(), up: c.up.toArray() });
  if (t !== null) souls.draw(t, cam.camera);
  if (history) return void (status.textContent = `${history.status()}\nbodies drawn      ${drawn}   frames a second ${fps.toFixed(0)}`);
  if (!address && !moment) return;
  status.textContent = t === null || worldNow === null
    ? `waiting for the stream${error ? `\n${error}` : ''}`
    : `behind the world  ${secs(worldNow - t)} s   (${ck.state}, ×${ck.rate.toFixed(3)})\n`
      + (near?.grant?.asked ? `view lowered to   ${near.grant.level} (asked ${near.grant.asked}: ${near.grant.reason})\n` : '')
      + `world time        ${clockText(t)}\n`
      + `parts played      ${played}   hashes equal ${hashesEqual}/${hashes}\n`
      + `bodies drawn      ${drawn}   frames a second ${fps.toFixed(0)}`
      + (error ? `\n${error}` : '');
});
