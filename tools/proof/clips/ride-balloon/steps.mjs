// Clip kit (#1977; 0.135 on the new engine): on eden-district, Ana and Ben board the festival balloon before the take,
// each by its `board` form through the new client, while it is home between laps; it lifts off on its course with them in
// the basket. The camera holds 3.2 m from the basket, first square on to its front rim (the riders face it), then circling
// it slowly at the riders' eye level, so every wall is seen with both riders' hands. Before the fix their hands and
// forearms passed through the front wall below the rim.
import { cast } from '../_shared/cast.mjs';
import { board, carrierPose, hold, orbit, shotPage } from '../_shared/ride.mjs';

const RIDERS = ['Ana', 'Ben'], RIDE = { name: 'festival-balloon', def: 'balloon' };
await cast({ souls: [{ name: 'Ana', owner: 'admin' }, { name: 'Ben', owner: 'ben' }] });
await board(RIDERS, RIDE.name);

export default async function steps(page, { mark, url }) {
  await shotPage(page, url);
  const first = await carrierPose(page, RIDE, 15_000);
  console.error(`kit: ${RIDE.name} first on the page at ${JSON.stringify(first)}; the layer's thing: ${JSON.stringify(await page.evaluate((k) => {
    const e = k ? window.__soulsEntity.layer?.model?.entities?.get(k) : null; return e ? { id: e.id, def: e.def, name: e.name, label: e.label } : null; }, first?.key ?? null))}`);
  await orbit(page, RIDE, { dist: 3.2, from: 0, eyeUp: 1.55, atUp: 1.0 });
  mark('the basket\'s front rim, square on');
  await hold(page, RIDE, 10_000);
  await orbit(page, RIDE, { dist: 3.2, from: 0, rate: 0.3, eyeUp: 1.55, atUp: 1.0 });
  mark('round the basket at eye level');
  await hold(page, RIDE, 34_000);
  await orbit(page, RIDE, { dist: 2.4, from: 0.5, eyeUp: 2.3, atUp: 1.0 });
  mark('from above the front rim');
  await hold(page, RIDE, 10_000);
}
