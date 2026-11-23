// Clip kit (#1530, PR #1544; 0.135 P6 on the new engine): in Eden 2026, two of admin's Souls stand at the foot of the
// Tower House stair. Ana climbs to the top; Bram starts up a moment later, close behind her. The camera follows Bram
// (Ctrl+K, Enter) the whole way. Each walk's receipt is logged. (Ben is Bram here: on the new engine's page "Ben" finds the benches first.)
import { cast, walk } from '../_shared/cast.mjs';

await cast({ souls: [{ name: 'Ana', owner: 'admin' }, { name: 'Bram', owner: 'admin' }] });
const FOOT = 'eden-tower-house', TOP = 'Top room in eden-tower-house';
// before the page opens: both Souls walk to the stair's foot (not filmed)
await walk('Ana', FOOT);
await walk('Bram', FOOT);

export default async function steps(page, { mark }) {
  await page.waitForTimeout(2000);
  await page.keyboard.press('Control+k');
  await page.waitForTimeout(600);
  await page.keyboard.type('Bram', { delay: 120 });
  await page.waitForTimeout(500);
  await page.keyboard.press('Enter');
  mark('follow Bram, at the stair foot');
  await page.waitForTimeout(3000);
  mark('Ana climbs');
  const ana = walk('Ana', TOP);
  await page.waitForTimeout(1500);
  mark('Bram climbs behind her');
  const ben = walk('Bram', TOP);
  const [a, b] = await Promise.all([ana, ben]);
  mark(`Ana ${a.ok !== false ? 'arrived' : 'ended'}, Bram ${b.ok !== false ? 'arrived' : 'ended'}`);
  await page.waitForTimeout(3000);
}
