// Clip kit (#1530, PR #1544; 0.135 P6 on the new engine): in Eden 2026, two of admin's Souls stand at the foot of the
// Tower House stair. Ana climbs to the top; Ben starts up a moment later, close behind her. The camera follows Ben
// (Ctrl+K, Enter) the whole way. Each walk's receipt is logged.
import { cast, walk } from '../_shared/cast.mjs';

await cast({ souls: [{ name: 'Ana', owner: 'admin' }, { name: 'Ben', owner: 'admin' }] });
const FOOT = 'eden-tower-house', TOP = 'Top room in eden-tower-house';
// before the page opens: both Souls walk to the stair's foot (not filmed)
await walk('Ana', FOOT);
await walk('Ben', FOOT);

export default async function steps(page, { mark }) {
  await page.waitForTimeout(2000);
  await page.keyboard.press('Control+k');
  await page.waitForTimeout(600);
  await page.keyboard.type('Ben', { delay: 120 });
  await page.waitForTimeout(500);
  await page.keyboard.press('Enter');
  mark('follow Ben, at the stair foot');
  await page.waitForTimeout(3000);
  mark('Ana climbs');
  const ana = walk('Ana', TOP);
  await page.waitForTimeout(1500);
  mark('Ben climbs behind her');
  const ben = walk('Ben', TOP);
  const [a, b] = await Promise.all([ana, ben]);
  mark(`Ana ${a.ok !== false ? 'arrived' : 'ended'}, Ben ${b.ok !== false ? 'arrived' : 'ended'}`);
  await page.waitForTimeout(3000);
}
