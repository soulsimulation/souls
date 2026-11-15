// Setup shared by the ride clip kits (#1976, #1977): Souls made by cast() board a ride by its join offer before the page
// opens, so the take starts with them aboard; and a camera the steps drive on a ?shot=1 page (the world's own shotCamera,
// which only places the viewer's camera: it never moves a body).
import { spawnSync } from 'node:child_process';
import { join } from 'node:path';

const { CLIP_CHECKOUT = '.', CLIP_WORK } = process.env;
const EDEN = join(CLIP_CHECKOUT, 'tools/world-launcher/soul/eden.mjs');
const eden = (name, args, ms = 60_000) => spawnSync(process.execPath, [EDEN, ...args], { cwd: join(CLIP_WORK, `soul-${name.toLowerCase()}`), encoding: 'utf8', timeout: ms });

/** Each Soul acts `offer` (a ride's join); returns once all are aboard (posture riding), or throws after `limitS`. */
export function board(names, offer, limitS = 240) {
  for (const n of names) {
    let r;
    for (let i = 0; i < 20; i++) {                       // a world just up may not offer the ride yet
      r = eden(n, ['act', offer, '--json']);
      if (/"accepted": true/.test(r.stdout)) break;
      spawnSync('sleep', ['3']);
    }
    console.error(`kit: ${n} act ${offer}: ${(r.stdout || r.stderr).slice(0, 300)}`);
    if (!/"accepted": true/.test(r.stdout)) throw Error(`kit: ${n} could not join ${offer}`);
  }
  const t0 = Date.now(), aboard = new Set();
  let last = '';
  while (aboard.size < names.length) {
    if (Date.now() - t0 > limitS * 1000) throw Error(`kit: only ${[...aboard].join(', ') || 'nobody'} aboard after ${limitS} s; last wait: ${last.slice(0, 1500)}`);
    for (const n of names) { if (aboard.has(n)) continue; last = eden(n, ['wait', '3', '--json'], 20_000).stdout; if (/"posture": "riding"/.test(last)) aboard.add(n); }
  }
  console.error(`kit: ${names.join(', ')} aboard after ${Math.round((Date.now() - t0) / 1000)} s`);
}

/** Open the world as a ?shot=1 page (the camera holds exactly where shotCamera puts it) and wait for its scene. */
export async function shotPage(page, world) {
  await page.goto(`${world}?dev=1&shot=1`);
  await page.locator('canvas').first().waitFor({ state: 'visible', timeout: 60_000 });
  await page.waitForFunction(() => window.__soulsEntity?.shotCamera && window.__soulsEntity.transportFrame?.()?.entities, null, { timeout: 90_000 });
}

/** Hold the camera at world `eye`, looking at `at` (metres). Stops any tracking shot. */
export async function fixed(page, eye, at) {
  await page.evaluate(({ eye, at }) => { window.__rideCam = (window.__rideCam ?? 0) + 1; window.__soulsEntity.shotCamera(eye, at); }, { eye, at });
}

/** Drive the camera every frame round a carrier (its pose in the depicted frame, Core convention: +x = (cos yaw, sin yaw)):
 *  `dist` metres out at `from` radians from its +x, turning `rate` rad/s, the eye `eyeUp` and the look `atUp` over its floor.
 *  Runs in the page until the next fixed/orbit call replaces it. */
export async function orbit(page, carrier, { dist, from = 0, rate = 0, eyeUp = 1.5, atUp = 1 }) {
  await page.evaluate(({ carrier, dist, from, rate, eyeUp, atUp }) => {
    const E = window.__soulsEntity, t0 = performance.now(), run = (window.__rideCam = (window.__rideCam ?? 0) + 1);
    const step = () => {
      if (window.__rideCam !== run) return;
      const c = E.transportFrame()?.entities?.[carrier];
      if (c?.p) {
        const a = (c.yaw ?? 0) + from + rate * (performance.now() - t0) / 1000;
        try { E.shotCamera([c.p[0] + dist * Math.cos(a), c.p[1] + eyeUp, c.p[2] + dist * Math.sin(a)], [c.p[0], c.p[1] + atUp, c.p[2]]); } catch { /* the next frame */ }
      }
      requestAnimationFrame(step);
    };
    step();
  }, { carrier, dist, from, rate, eyeUp, atUp });
}

/** The carrier's pose in the depicted frame ({p, yaw}), or null. */
export const carrierPose = (page, carrier) => page.evaluate((id) => { const c = window.__soulsEntity.transportFrame()?.entities?.[id]; return c?.p ? { p: [...c.p], yaw: c.yaw ?? 0 } : null; }, carrier);
