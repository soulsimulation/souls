// Engine v2's page (V5, #2714): plays one stream of V1's files and draws it. The address is the stream's directory,
// given as the page's `stream` parameter; it is read here and sent nowhere else. The status shows how far behind the
// world the picture is, and the clock's state.
import * as THREE from 'three';
import { FreeCamera } from '../camera/camera.ts';
import { PlaybackClock } from '../clock/clock.ts';
import type { Pointer } from '../source/source.ts';
import { StreamSource } from '../source/stream.ts';
import { CrowdBodies, loadCrowd } from '../crowd/bodies.ts';
import { browserQuality } from './quality-tier.ts';
import { WorldView } from './world.ts';

const canvas = document.getElementById('view') as HTMLCanvasElement;
const status = document.getElementById('status') as HTMLDivElement;
const address = new URLSearchParams(location.search).get('stream');

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
sun.position.set(300, 500, 200);
scene.add(sun);
const cam = new FreeCamera(canvas);
const world = new WorldView();
scene.add(world.group);
const clock = new PlaybackClock();
// Bodies are drawn as V6's crowd from the body files under the page's `bodies` directory; capsules if they don't load.
loadCrowd(new URLSearchParams(location.search).get('bodies') ?? './bodies/').then((c) => world.attach(new CrowdBodies(c)), (e) => console.warn('bodies stay capsules:', e));

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

if (!address) status.textContent = 'no stream: open this page with ?stream=<the stream directory>';
else new StreamSource(address).start({
  pointer: (p) => (pointer = p),
  part: (p) => {
    world.apply(p.nodes, p.removed, p.samples);
    newestTo = p.to;
    played++;
    if (p.hash !== null) (hashes++, p.hash && hashesEqual++);
  },
  error: (m) => (error = m),
});

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
  cam.update(Math.min(100, dt));
  const worldNow = pointer ? pointer.anchorWorld + (Date.now() - pointer.anchorWallMs) * 1000 : null;
  const t = worldNow === null ? null : clock.step(dt, worldNow, newestTo);
  let drawn = 0;
  if (t !== null) {
    drawn = world.draw(t, cam.camera);
    if (!framed && drawn > 0) {
      framed = true;
      cam.setExtent(world.extent);
      const at = world.crowd(t);
      if (at) cam.look(at, 0.6, -0.6, 55);
    }
  }
  renderer.render(scene, cam.camera);
  if (!address) return;
  status.textContent = t === null || worldNow === null
    ? `waiting for the stream${error ? `\n${error}` : ''}`
    : `behind the world  ${secs(worldNow - t)} s   (${clock.state}, ×${clock.rate.toFixed(3)})\n`
      + `world time        ${clockText(t)}\n`
      + `parts played      ${played}   hashes equal ${hashesEqual}/${hashes}\n`
      + `bodies drawn      ${drawn}   frames a second ${fps.toFixed(0)}`
      + (error ? `\n${error}` : '');
});
