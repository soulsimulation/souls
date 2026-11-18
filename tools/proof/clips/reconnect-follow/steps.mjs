// Clip kit (#2280): signed in as admin, who owns two Souls, follow another user's Soul from the search (Ctrl+K). The
// navbar keeps admin's Souls the whole time; before the fix the follow reconnected and they dropped out for a moment.
import { cast } from '../_shared/cast.mjs';

cast({ souls: [{ name: 'Ada', owner: 'admin' }, { name: 'Bo', owner: 'admin' }, { name: 'Mira', owner: 'mira' }] });

export default async function steps(page, { mark }) {
  await page.waitForTimeout(2500);                        // the navbar with admin's Souls, before the follow
  mark('navbar');
  await page.keyboard.press('Control+k');
  await page.waitForTimeout(700);
  await page.keyboard.type('Mira', { delay: 140 });
  await page.waitForTimeout(500);
  await page.keyboard.press('Enter');
  mark('follow Mira');
  await page.waitForTimeout(7000);                        // the camera on Mira; the navbar still lists Ada and Bo
  mark('after follow');
}
