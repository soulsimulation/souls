// Clip kit (#2282, PR #2284; 0.135 P6 on the new engine): in Eden 2026, the classroom's south doorway holds a door,
// closed, swinging outward. Before the take, admin's Soul Clara walks to the street bench a few metres outside that
// door. On camera (Ctrl+K, Enter follows Clara) she walks into the classroom: she opens the door outward by hand, walks
// through and closes it behind her; then she walks back out to the bench the same way. Places by their words in Clara's
// own copy (`find`), acts through the new client.
import { cast, walk } from '../_shared/cast.mjs';

await cast({ souls: [{ name: 'Clara', owner: 'admin' }] });
const OUT = 'street-bench-1';
await walk('Clara', OUT);                                 // off camera: to the bench outside the door

export default async function steps(page, { mark }) {
  await page.waitForTimeout(2000);
  await page.keyboard.press('Control+k');
  await page.waitForTimeout(600);
  await page.keyboard.type('Clara', { delay: 120 });
  await page.waitForTimeout(500);
  await page.keyboard.press('Enter');
  mark('follow Clara, outside the classroom door (closed)');
  await page.waitForTimeout(3500);
  mark('walk into the classroom');
  await walk('Clara', 'Classroom in eden-classroom-1');
  mark('inside, door closed behind');
  await page.waitForTimeout(3000);
  mark('walk back out to the bench');
  await walk('Clara', OUT);
  mark('outside, door closed behind');
  await page.waitForTimeout(3000);
}
