// Clip kit (#2280): signed in as admin (the world's owner, its god agent listening), type into the god box (Ctrl+G),
// reload the page, open the god box again: the typed draft is still there.
import { cast } from '../_shared/cast.mjs';

cast({ god: 'admin' });
const DRAFT = 'a ring of lanterns around the well';

export default async function steps(page, { mark }) {
  await page.waitForTimeout(1500);
  await page.keyboard.press('Control+g');
  await page.waitForTimeout(1200);
  await page.keyboard.type(DRAFT, { delay: 70 });
  mark('typed');
  await page.waitForTimeout(1500);
  await page.reload({ waitUntil: 'domcontentloaded' });
  mark('reload');
  await page.locator('canvas').first().waitFor({ state: 'visible', timeout: 60_000 });
  await page.waitForTimeout(6000);                        // the world back on screen
  await page.keyboard.press('Control+g');
  mark('god box again');
  await page.waitForFunction((t) => [...document.querySelectorAll('textarea, input')].some((e) => e.value === t), DRAFT, { timeout: 10_000 })
    .then(() => mark('draft kept'), () => mark('draft not seen'));
  await page.waitForTimeout(3000);
}
