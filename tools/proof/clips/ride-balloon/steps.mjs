// Clip kit (#1977; 0.135 on the new engine): on eden-district, Ana and Ben board the festival balloon before the take,
// each by its `board` form through the new client, while it is home between laps; it lifts off on its course with them in
// the basket. On camera (Ctrl+K, Enter follows Ana) the basket is seen with both riders' hands at its rim as it rises.
// Before the fix their hands and forearms passed through the front wall below the rim.
import { cast } from '../_shared/cast.mjs';
import { board, hold } from '../_shared/ride.mjs';

const RIDERS = ['Ana', 'Ben'], RIDE = { name: 'festival-balloon', def: 'balloon' };
await cast({ souls: [{ name: 'Ana', owner: 'admin' }, { name: 'Ben', owner: 'ben' }] });
await board(RIDERS, RIDE.name);

export default async function steps(page, { mark }) {
  await page.waitForTimeout(2000);
  await page.keyboard.press('Control+k');
  await page.waitForTimeout(600);
  await page.keyboard.type('Ana', { delay: 120 });
  await page.waitForTimeout(500);
  await page.keyboard.press('Enter');
  mark('follow Ana, in the basket');
  await hold(page, RIDE, 60_000);
}
