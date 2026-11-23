// Clip kit (#2434; 0.135 P6 on the new engine): in Eden 2026, one walk from far away into an upstairs room behind two
// closed doors. The townhouse canal-west-home-3 has a real door in every doorway: its front door and, on the first floor,
// the bedroom's door. Before the take, admin's Soul Clara goes up to the landing, shuts the bedroom door by hand, goes out
// to the front step and shuts the front door by hand, and walks to the bakery's front, about 45 m away. On camera (Ctrl+K,
// Enter follows Clara) one walk takes her from there through the front door, up the stairs and through the bedroom door,
// opening each by hand and closing it behind her.
import { actOn, cast, walk } from '../_shared/cast.mjs';

await cast({ souls: [{ name: 'Clara', owner: 'admin' }] });
// off camera: up to the landing, the bedroom door shut by hand, then out, the front door shut, and to the bakery's front
await walk('Clara', 'canal-west-home-3');
await actOn('Clara', 'close', 'canal-west-home-3-door-3');
await walk('Clara', 'canal-west-home-3-door-1');
await actOn('Clara', 'close', 'canal-west-home-3-door-1');
await walk('Clara', 'int-bakery');

export default async function steps(page, { mark }) {
  await page.waitForTimeout(2000);
  await page.keyboard.press('Control+k');
  await page.waitForTimeout(600);
  await page.keyboard.type('Clara', { delay: 120 });
  await page.waitForTimeout(500);
  await page.keyboard.press('Enter');
  mark('follow Clara at the bakery front, ~45 m from the townhouse, both doors closed');
  await page.waitForTimeout(1500);
  mark('one walk into the townhouse (its rooms carry no names on the new engine yet, so not the bedroom by name)');
  await walk('Clara', 'canal-west-home-3');
  mark('in the townhouse, the front door closed behind');
  await page.waitForTimeout(2500);
}
