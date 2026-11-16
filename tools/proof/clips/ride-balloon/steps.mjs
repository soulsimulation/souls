// Clip kit (#1977): on eden-district, Ana and Ben board the festival balloon (both seats) before the take; it lifts off five
// seconds after the basket is full. The camera holds 3.2 m from the basket, first square on to its front rim (the riders
// face it), then circling it slowly at the riders' eye level, so every wall is seen with both riders' hands. Before the fix
// their hands and forearms passed through the front wall below the rim.
import { cast } from '../_shared/cast.mjs';
import { board, orbit, shotPage } from '../_shared/ride.mjs';

const RIDERS = ['Ana', 'Ben'], CARRIER = 'festival-balloon';
cast({ souls: [{ name: 'Ana', owner: 'admin' }, { name: 'Ben', owner: 'ben' }] });
board(RIDERS, `object:ride-${CARRIER}:join`);

export default async function steps(page, { mark }) {
  await shotPage(page, process.env.CLIP_WORLD);
  await orbit(page, CARRIER, { dist: 3.2, from: 0, eyeUp: 1.55, atUp: 1.0 });
  mark('the basket\'s front rim, square on');
  await page.waitForTimeout(12_000);
  await orbit(page, CARRIER, { dist: 3.2, from: 0, rate: 0.3, eyeUp: 1.55, atUp: 1.0 });
  mark('round the basket at eye level');
  await page.waitForTimeout(42_000);
  await orbit(page, CARRIER, { dist: 2.4, from: 0.5, eyeUp: 2.3, atUp: 1.0 });
  mark('from above the front rim');
  await page.waitForTimeout(12_000);
}
