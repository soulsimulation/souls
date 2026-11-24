// Setup shared by the ride clip kits (#1976, #1977; 0.135 on the new engine): Souls made by cast() board a ride by its
// `board` form before the page opens, so the take starts with them aboard; and a camera the steps drive on a ?shot=1 page
// (the world's own shotCamera, which only places the viewer's camera: it never moves a body).
// On the new engine a ride is a thing on a course (a balloon): it takes riders only while it is home, between laps, and
// the page carries it in its takes keyed by the page's own id for the thing, its name as the label (K4, bridge.ts things()).
import { find, soul } from './cast.mjs';

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** Each Soul walks to what its copy finds for `words`, then acts its `board` form until it is aboard: a ride away on its
 *  course refuses (`boarding-frame-away`) until it is home again. Returns the ride's id once all are aboard, or throws
 *  after `limitS` or on any other refusal five times over (more than one lap: a rider aboard rides the lap, and the next waits for the ride to come home). */
export async function board(names, words, limitS = 600) {
  const ride = await find(names[0], words);
  if (!ride) throw Error(`kit: nothing found for "${words}"`);
  console.error(`kit: ${words} is ${ride.id} (${ride.kind})`);
  for (const n of names) {
    const r = await soul(n).cli('act', ride.id, '--wait');
    console.error(`kit: ${n} walk to ${words}: ${JSON.stringify(r.receipt?.answers?.at(-1) ?? r).slice(0, 300)}`);
  }
  const t0 = Date.now(), aboard = new Set(), last = {}, same = {};
  while (aboard.size < names.length) {
    if (Date.now() - t0 > limitS * 1000) throw Error(`kit: only ${[...aboard].join(', ') || 'nobody'} aboard ${words} after ${limitS} s; last answers ${JSON.stringify(last)}`);
    for (const n of names) {
      if (aboard.has(n)) continue;
      const r = await soul(n).cli('act', `board:${ride.id}`, '--wait'), a = r.receipt?.answers?.at(-1) ?? {};
      const said = a.reason ?? a.answer ?? r.code ?? r.raw ?? 'no answer';
      if (said !== last[n]) console.error(`kit: ${n} board ${words}: ${said} after ${Math.round((Date.now() - t0) / 1000)} s`);
      same[n] = said === last[n] ? (same[n] ?? 0) + 1 : 0;
      last[n] = said;
      // only a ride away on its course is waited for; any other refusal five times over is the kit's failure
      if (said !== 'boarding-frame-away' && same[n] >= 5) throw Error(`kit: ${n} cannot board ${words}: ${JSON.stringify(r).slice(0, 600)}`);
      if (r.ok && a.answer !== 'refused') aboard.add(n);
    }
    if (aboard.size < names.length) await sleep(1500);
  }
  console.error(`kit: ${names.join(', ')} aboard ${words} after ${Math.round((Date.now() - t0) / 1000)} s`);
  return ride.id;
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

/** Drive the camera every frame round a carrier (its pose in the depicted frame; found by the page's id for it or by its
 *  name, the take's label): `dist` metres out at `from` radians from its +x, turning `rate` rad/s, the eye `eyeUp` and the
 *  look `atUp` over its floor. Runs in the page until the next fixed/orbit call replaces it. */
export async function orbit(page, carrier, { dist, from = 0, rate = 0, eyeUp = 1.5, atUp = 1 }) {
  await page.evaluate(({ carrier, dist, from, rate, eyeUp, atUp }) => {
    const E = window.__soulsEntity, t0 = performance.now(), run = (window.__rideCam = (window.__rideCam ?? 0) + 1);
    const step = () => {
      if (window.__rideCam !== run) return;
      const all = E.transportFrame()?.entities ?? {};
      const c = all[carrier] ?? Object.values(all).find((e) => e?.label === carrier);
      if (c?.p) {
        const a = (c.yaw ?? 0) + from + rate * (performance.now() - t0) / 1000;
        try { E.shotCamera([c.p[0] + dist * Math.cos(a), c.p[1] + eyeUp, c.p[2] + dist * Math.sin(a)], [c.p[0], c.p[1] + atUp, c.p[2]]); } catch { /* the next frame */ }
      }
      requestAnimationFrame(step);
    };
    step();
  }, { carrier, dist, from, rate, eyeUp, atUp });
}

/** Wait until the page carries `carrier` (by id or name); → its pose in the depicted frame ({p, yaw}), or null. */
export async function carrierPose(page, carrier, ms = 30_000) {
  const until = Date.now() + ms;
  for (;;) {
    const c = await page.evaluate((id) => {
      const all = window.__soulsEntity.transportFrame()?.entities ?? {};
      const e = all[id] ?? Object.values(all).find((x) => x?.label === id);
      return e?.p ? { p: [...e.p], yaw: e.yaw ?? 0 } : null;
    }, carrier);
    if (c || Date.now() > until) return c;
    await page.waitForTimeout(250);
  }
}
