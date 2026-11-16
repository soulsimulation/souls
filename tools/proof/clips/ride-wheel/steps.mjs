// Clip kit (#1976): on eden-district, Ana and Ben board the ferris wheel (region-seaside-resort.ferris-wheel, the core
// wheel) before the take; the car leaves five seconds after it is full and goes round once (75 s). The camera watches the
// lap three ways: a wide three-quarter view of the whole wheel, side on (along the wheel's plane) and close on the car.
// Before the fix the car went round a smaller, lower circle about 4 m in front of the wheel, attached to nothing.
import { cast } from '../_shared/cast.mjs';
import { board, carrierPose, fixed, orbit, shotPage } from '../_shared/ride.mjs';

const RIDERS = ['Ana', 'Ben'], CARRIER = 'region-seaside-resort.ferris-wheel';
// the wheel as the template places it (worlds/templates/eden-district.json): at x 12, z 46, turned 0.3 rad; its front is
// (sin 0.3, cos 0.3) (a god thing turns by rotation.y = +yaw); the core wheel's hub is 8.6 m up
const WHEEL = [12, 46], YAW = 0.3, HUB = 8.6, FRONT = [Math.sin(YAW), Math.cos(YAW)], ACROSS = [Math.cos(YAW), -Math.sin(YAW)];
cast({ souls: [{ name: 'Ana', owner: 'admin' }, { name: 'Ben', owner: 'ben' }] });
board(RIDERS, `object:ride-${CARRIER}:join`);

const view = (ground, front, across, dist, up) => ({
  eye: [WHEEL[0] + (FRONT[0] * front + ACROSS[0] * across) * dist, ground + up, WHEEL[1] + (FRONT[1] * front + ACROSS[1] * across) * dist],
  at: [WHEEL[0], ground + HUB - 1, WHEEL[1]] });

export default async function steps(page, { mark }) {
  await shotPage(page, process.env.CLIP_WORLD);
  let car = null;
  for (let i = 0; i < 40 && !car; i++) { car = await carrierPose(page, CARRIER); if (!car) await page.waitForTimeout(250); }
  // the ground under the wheel, from the car's home (riders board it on the ground in front of the wheel)
  const home = await page.evaluate((id) => window.__soulsEntity.transportFrame()?.entities?.[id]?.carrier?.home ?? null, CARRIER);
  const ground = home?.[1] ?? car?.p[1] ?? 0;
  console.error(`kit: car ${JSON.stringify(car)} home ${JSON.stringify(home)}`);
  let v = view(ground, 0.8, 0.6, 30, 8);
  await fixed(page, v.eye, v.at);
  mark('the whole wheel, three-quarter');
  await page.waitForTimeout(24_000);
  v = view(ground, 0.12, 0.99, 26, 9);
  await fixed(page, v.eye, v.at);
  mark('side on, along the wheel\'s plane');
  await page.waitForTimeout(20_000);
  // close on the car, from in front and to one side, a little above (Core: the car's +x faces into the wheel)
  await orbit(page, CARRIER, { dist: 6, from: Math.PI + 0.7, eyeUp: 2.6, atUp: 0.9 });
  mark('close on the car');
  await page.waitForTimeout(28_000);
}
