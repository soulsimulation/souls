// Clip kit (#2383, part 1 of 2, part 2: doors-everywhere-bakery; 0.135 P6 on the new engine): in Eden 2026, the dome,
// whose outside doorways hold real doors, closed. The walk in starts far from it (review of #2397: a long walk is planned
// through the door from the start, not stopped short of it). Before the take, admin's Soul Clara walks to the bakery's
// front, about 55 m from the dome. On camera (Ctrl+K, Enter follows Clara) she walks from there into the dome, opening
// its door by hand and closing it behind her. (The old kit ran; a run is the new engine's G1 gait, not yet the client's.)
import { cast, walk } from '../_shared/cast.mjs';

await cast({ souls: [{ name: 'Clara', owner: 'admin' }] });
await walk('Clara', 'int-bakery');                            // off camera: the bakery's front, ~55 m from the dome

export default async function steps(page, { mark }) {
  await page.waitForTimeout(2000);
  await page.keyboard.press('Control+k');
  await page.waitForTimeout(600);
  await page.keyboard.type('Clara', { delay: 120 });
  await page.waitForTimeout(500);
  await page.keyboard.press('Enter');
  mark('follow Clara at the bakery front, ~55 m from the dome, its doors closed');
  await page.waitForTimeout(1500);
  mark('one walk from ~55 m away into the dome');
  await walk('Clara', 'eden-dome');
  mark('inside the dome, door closed behind');
  await page.waitForTimeout(1500);
}
