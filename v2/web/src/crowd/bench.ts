// The crowd's bench page (V6, #2715): 1,000 bodies on open ground, 400 walking at walking pace and 600 standing, the
// three body files of today's people, the camera placed so the whole crowd is in view at any aspect. Served by
// `vite` at /src/crowd/bench.html; `bench.mjs` drives it. Page parameters: `bodies` (the directory the body files are
// served from, default ./bodies/), `n` (bodies, 1000), `walking` (400), `seed`, and `kind`: one body kind someone
// authored (B13, #2744), the importer's `<name>.json` under `bodies`, drawn in place of today's three people; `area`,
// the ground per body (m², 2.5), so a smaller crowd can still reach the farthest level.
// `window.__crowd` reports readiness, the crowd's stats, the premise counts and the frame's own work time.
import * as THREE from 'three';
import { loadModel, type BakedModel } from './bake.ts';
import { BODIES, CLIPS, WALK_STRIDE, loadKind } from './bodies.ts';
import { Crowd } from './crowd.ts';
import { WorldSky } from '../sky/sky.ts';
import { WATER } from '../draw/drapes.ts';

const q = new URLSearchParams(location.search);
const base = q.get('bodies') ?? './bodies/';
const N = Number(q.get('n') ?? 1000), WALKING = Number(q.get('walking') ?? 400), KIND = q.get('kind'), AREA = Number(q.get('area') ?? 2.5);
let seed = Number(q.get('seed') ?? 7);
const rand = () => ((seed = (seed * 1664525 + 1013904223) >>> 0) / 2 ** 32);

type Probe = { ready: boolean; error?: string; stats?: () => unknown; premise?: unknown; work: number[]; on: boolean };
const probe: Probe = { ready: false, work: [], on: false };
(window as unknown as { __crowd: Probe }).__crowd = probe;

const canvas = document.getElementById('view') as HTMLCanvasElement;
const status = document.getElementById('status') as HTMLDivElement;
const renderer = new THREE.WebGLRenderer({ canvas, antialias: true });
renderer.setPixelRatio(Math.min(devicePixelRatio, 2));
renderer.shadowMap.enabled = true;
const scene = new THREE.Scene();
scene.background = new THREE.Color(0xbcd3e6);
const hemi = new THREE.HemisphereLight(0xffffff, 0x556644, 1.6);
scene.add(hemi);
const sun = new THREE.DirectionalLight(0xffffff, 1.6);
sun.castShadow = true;
sun.shadow.mapSize.set(2048, 2048);
scene.add(sun, sun.target);
const ground = new THREE.Mesh(new THREE.PlaneGeometry(400, 400).rotateX(-Math.PI / 2), new THREE.MeshLambertMaterial({ color: 0x7d9c63 }));
ground.receiveShadow = true;
scene.add(ground);
const camera = new THREE.PerspectiveCamera(50, 1, 0.5, 1000);
// V19 (#2763): `sky=1` adds the sky and rain of a dusk shower and a water area, drawn every frame as the page draws them.
const sky = q.get('sky') ? new WorldSky(scene, hemi, sun) : null;
sky?.apply([{ sky: { 60: 86_400, 61: 0, 62: [[0, 0]], 75: 'souls:rain', 76: 90, 77: 60, 78: 30 } }]);
if (sky) scene.add(new THREE.Mesh(new THREE.PlaneGeometry(60, 30).rotateX(-Math.PI / 2).translate(0, 0.05, -25), new THREE.MeshLambertMaterial({ color: WATER })));

// The crowd fills the ground the camera sees: a sector about the camera's foot, from NEAR m out to `far` (about
// `area` m² a body), as wide as the view. The camera is raised and tilted so the sector's near and far edges meet the
// bottom and top of the view, so every body is in view at any aspect and some are near enough for level 0.
const NEAR = 4;
const sector = { half: 0, far: 0 };
const place = () => {
  const w = innerWidth, h = innerHeight;
  renderer.setSize(w, h, false);
  camera.aspect = w / h;
  const halfV = THREE.MathUtils.degToRad(camera.fov / 2);
  sector.half = Math.atan(Math.tan(halfV) * camera.aspect) * 0.85;
  sector.far = Math.sqrt((N * AREA) / sector.half + NEAR * NEAR);
  // Height whose rays to NEAR and to 1.03 × far are the view's height apart.
  let lo = 0.5, hi = Math.sqrt(NEAR * sector.far * 1.03); // the lower of the two heights: the difference rises to here
  for (let k = 0; k < 60; k++) {
    const mid = (lo + hi) / 2;
    if (Math.atan(mid / NEAR) - Math.atan(mid / (sector.far * 1.03)) < 2 * halfV * 0.92) lo = mid;
    else hi = mid;
  }
  const pitch = (Math.atan(lo / NEAR) + Math.atan(lo / (sector.far * 1.03))) / 2;
  camera.position.set(0, lo, 0);
  camera.lookAt(0, lo - Math.tan(pitch) * 10, -10);
  camera.updateProjectionMatrix();
  // Shadows only reach level 0, so the shadow camera covers the sector's near part.
  const near = new THREE.Vector3(0, 0, -14);
  sun.target.position.copy(near);
  sun.position.copy(near).add(new THREE.Vector3(30, 60, 20));
  Object.assign(sun.shadow.camera, { left: -20, right: 20, top: 20, bottom: -20, near: 1, far: 200 });
  sun.shadow.camera.updateProjectionMatrix();
};
addEventListener('resize', place);
place();

async function main() {
  const t0 = performance.now();
  const models: BakedModel[] = KIND ? (await loadKind(base, KIND)).models : await Promise.all(BODIES.map(([name, mesh, clips]) => loadModel(name, base + mesh, base + clips, CLIPS)));
  const bakeMs = performance.now() - t0;
  const crowd = new Crowd(models, N);
  scene.add(crowd.group);
  const idle = crowd.clip(0, 'Idle'), walk = crowd.clip(0, 'Walk');
  // Bodies at polar places about the camera's foot (r, θ; θ 0 straight ahead). Walkers, at 1.1 to 1.6 m/s, go either
  // to and fro along their ray or across the sector along their arc, turning at its edges; the rest stand, facing anywhere.
  const r = new Float32Array(N), th = new Float32Array(N), vel = new Float32Array(N), across = new Uint8Array(N);
  const at = (b: number) => {
    crowd.x[b] = Math.sin(th[b]) * r[b];
    crowd.z[b] = -Math.cos(th[b]) * r[b];
  };
  for (let i = 0; i < N; i++) {
    const b = crowd.add(i % models.length);
    r[b] = Math.sqrt(NEAR * NEAR + rand() * (sector.far ** 2 - NEAR * NEAR));
    th[b] = (rand() * 2 - 1) * sector.half;
    at(b);
    if (i < WALKING) {
      vel[b] = (1.1 + rand() * 0.5) * (rand() < 0.5 ? 1 : -1);
      across[b] = i % 2;
      crowd.clipA[b] = walk;
      crowd.rateA[b] = Math.abs(vel[b]) / WALK_STRIDE;
    } else {
      crowd.yaw[b] = rand() * Math.PI * 2;
      crowd.clipA[b] = idle;
      crowd.rateA[b] = 1 / models[i % models.length].clips[idle].seconds;
    }
    crowd.phaseA[b] = rand();
  }
  probe.premise = {
    bakeMs: Math.round(bakeMs),
    models: models.map((m) => ({ name: m.name, bones: m.bones, materials: m.materials, triangles: m.triangles, height: +m.height.toFixed(2), clips: m.clips.map((c) => `${c.name} ${c.frames}`) })),
  };
  probe.stats = () => ({ ...crowd.stats, gl: { calls: renderer.info.render.calls, triangles: renderer.info.render.triangles, geometries: renderer.info.memory.geometries, textures: renderer.info.memory.textures } });
  let last = performance.now(), fps = 60;
  renderer.setAnimationLoop((now) => {
    const w0 = performance.now();
    const dt = Math.min(0.1, (now - last) / 1000);
    fps = fps * 0.95 + (1 / Math.max(0.001, dt)) * 0.05;
    last = now;
    for (let b = 0; b < WALKING; b++) {
      if (across[b]) {
        th[b] += (vel[b] * dt) / r[b];
        if (Math.abs(th[b]) > sector.half) (th[b] = Math.sign(th[b]) * sector.half), (vel[b] = -vel[b]);
      } else {
        r[b] += vel[b] * dt;
        if (r[b] < NEAR || r[b] > sector.far) (r[b] = Math.min(sector.far, Math.max(NEAR, r[b]))), (vel[b] = -vel[b]);
      }
      at(b);
      // Heading: along the ray (outward is θ's direction) or along the arc (θ increasing turns clockwise seen from above).
      crowd.yaw[b] = across[b] ? Math.PI - th[b] - (vel[b] > 0 ? Math.PI / 2 : -Math.PI / 2) : (vel[b] > 0 ? Math.PI - th[b] : -th[b]);
    }
    crowd.step(dt);
    crowd.draw(camera);
    sky?.update(19.5 * 3_600_000_000 + now * 1000, camera);
    renderer.render(scene, camera);
    if (probe.on) probe.work.push(performance.now() - w0);
    const s = crowd.stats;
    status.textContent = `bodies ${s.bodies}   in view ${s.visible}   walking ${WALKING}\n`
      + `levels ${s.byLevel.join(' / ')}   crowd draws ${s.draws}   all draws ${renderer.info.render.calls}\n`
      + `frames a second ${fps.toFixed(0)}`;
  });
  probe.ready = true;
}

main().catch((e) => {
  probe.error = String(e?.stack ?? e);
  status.textContent = `failed: ${probe.error}`;
});
