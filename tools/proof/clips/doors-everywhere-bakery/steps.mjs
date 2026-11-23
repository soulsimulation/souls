// Clip kit (#2383, part 2 of 2, part 1: doors-everywhere; 0.135 P6 on the new engine): in Eden 2026, the bakery, whose
// outside doorway holds a real door, closed. The walk in starts far from it. Before the take, admin's Soul Clara walks
// to the bicycle by the dome, about 55 m from the bakery. On camera (Ctrl+K, Enter follows Clara) she walks from there
// into the bakery's shop, opening its door by hand and closing it behind her.
import { cast, walk } from '../_shared/cast.mjs';

await cast({ souls: [{ name: 'Clara', owner: 'admin' }] });
await walk('Clara', 'street-bicycle-bike-9');                           // off camera: the bicycle by the dome, ~55 m from the bakery

export default async function steps(page, { mark }) {
  await page.waitForTimeout(2000);
  await page.keyboard.press('Control+k');
  await page.waitForTimeout(600);
  await page.keyboard.type('Clara', { delay: 120 });
  await page.waitForTimeout(500);
  await page.keyboard.press('Enter');
  mark('follow Clara by the dome, ~55 m from the bakery, its door closed');
  await page.waitForTimeout(1500);
  mark('one walk from ~55 m away into the bakery shop');
  await walk('Clara', 'Shop in int-bakery');
  mark('inside the bakery, door closed behind');
  await page.waitForTimeout(1500);
}
