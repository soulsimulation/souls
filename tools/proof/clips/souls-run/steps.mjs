// Clip kit (#2283, PR #2292; 0.135 P6 on the new engine): in Eden 2026, admin's Soul Runa goes from where it stands to a
// room up a stair (the campus east hall's upper classroom), the camera following it (Ctrl+K, Enter) the whole way. The
// old kit ran (`--run`); a run is the new engine's G1 gait, not yet the client's, so Runa walks.
import { cast, walk } from '../_shared/cast.mjs';

await cast({ souls: [{ name: 'Runa', owner: 'admin' }] });
const TARGET = 'Classroom upstairs 1 in region-campus-east-hall';

export default async function steps(page, { mark }) {
  await page.waitForTimeout(2000);
  await page.keyboard.press('Control+k');
  await page.waitForTimeout(600);
  await page.keyboard.type('Runa', { delay: 120 });
  await page.waitForTimeout(500);
  await page.keyboard.press('Enter');
  mark('follow Runa');
  await page.waitForTimeout(3000);                        // the camera settles on Runa
  mark(`walk to ${TARGET}`);
  const r = await walk('Runa', TARGET);
  mark(r.ok !== false ? 'arrived' : 'act ended');
  await page.waitForTimeout(3000);                        // Runa upstairs, at rest
}
